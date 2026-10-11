import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { config } from '../config.js';
import { acceptWebSocket, sendWebSocketText } from './websocket.js';
import { db, pool } from '../db/client.js';
import {
  agentVersions,
  agents,
  capabilities,
  checkpoints,
  decisions,
  events,
  nodeMessages,
  modelProviders,
  models,
  plans,
  projects,
  sessions,
  tasks,
  tenantMembers,
  tenants,
  workflowEdges,
  workflowNodes,
  workflowRuns,
  workflowVersions,
  workflows,
} from '../db/schema.js';
import { OrviaError } from '../domain/errors.js';
import { assertRunTransition, assertTaskTransition, type RunStatus, type TaskStatus } from '../domain/state-machine.js';
import {
  assertProjectInTenant,
  authenticateUser,
  bootstrapTenancy,
  defaultTenantId,
  membershipsForUser,
  registerUser,
} from '../application/tenancy.js';
import { resolveAgentModel, resolveWorkflowNode } from '../application/model-resolver.js';
import { assertProjectCatalogKeys, collectCapabilityKeys, ensureTenantCapabilities, normalizeCapabilityKey, storedNodeCapabilityKeys, workflowNodeCapabilityKeys } from '../application/capabilities.js';
import { deleteAgentsByIds } from '../application/delete-agents.js';
import { assertWorkingDirectoryAllowed } from '../application/runtime-policy.js';
import { acceptanceLimit, acceptanceRuleLines, parseAcceptanceVerdict, type AcceptanceParty } from '../application/acceptance.js';
import { assertAcyclicGraph, graphIsComplete, selectRunnableTasks } from '../application/task-graph.js';
import { pickLatestTasksByKey, resumeFrontier } from '../application/resume-graph.js';
import {
  buildMysqlUrl,
  buildRedisUrl,
  maskSecret,
  parseMysqlUrl,
  parseRedisUrl,
  probeMysql,
  probePi,
  probeRedis,
  readLocalEnv,
  writeLocalEnv,
} from '../application/local-env.js';
import {
  allocateSequenceFolder,
  deleteInputFile,
  directoryExists,
  ensureDirectory,
  executionDirectory,
  executionStamp,
  folderBaseName,
  inputDirectory,
  isManagedWorkspace,
  listInputFiles,
  openDirectory,
  resolveWorkflowRoot,
  sequenceFolderName,
  listDeliverableNames,
  loopForNode,
  loopsFromDefinition,
  nodeDirectory,
  readDeliverableText,
  saveInputFile,
  validateLoops,
  withTerminals,
  writeResult,
  writeStartInput,
  writeTaskBrief,
} from '../application/workflow-workspace.js';
import {
  formatWorkflowVersionLabel,
  MAX_WORKFLOW_VERSIONS,
  nextWorkflowVersionSeq,
  versionsToPrune,
} from '../application/workflow-versions.js';
import { ensureTables, migrateCapabilitiesToTenant, repairEnums, repairSchema, schemaIntegrityIssues } from '../db/ensure-schema.js';
import { connectRedis, redisDisplayUrl, redisRuntime } from '../infrastructure/redis.js';
import { piRuntime } from '../runtime/pi-adapter.js';

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': config.webOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-orvia-tenant-id, x-orvia-filename',
  });
  response.end(JSON.stringify(payload));
}

function requireRunTransition(from: string, to: RunStatus): void {
  try {
    assertRunTransition(from as RunStatus, to);
  } catch {
    throw new OrviaError(`Workflow run cannot transition from ${from} to ${to}`, 'conflict', 409);
  }
}

function requireTaskTransition(from: string, to: TaskStatus): void {
  try {
    assertTaskTransition(from as TaskStatus, to);
  } catch {
    throw new OrviaError(`Task cannot transition from ${from} to ${to}`, 'conflict', 409);
  }
}

const eventClients = new Set<{ response: ServerResponse; projectId?: number }>();
const socketClients = new Set<{ socket: Duplex; projectId?: number }>();
const activeWorkflowSessions = new Map<number, Set<number>>();
const executingWorkflowRuns = new Set<number>();
const queuedWorkflowRuns = new Set<number>();
const activeNodeChats = new Set<string>();
const NODE_CHAT_LOCK_TTL_SECONDS = 180;

function nodeChatLockName(chatKey: string) {
  return `node-chat:${chatKey}`;
}

async function endNodeChat(chatKey: string): Promise<void> {
  activeNodeChats.delete(chatKey);
  await redisRuntime().releaseLock(nodeChatLockName(chatKey));
}

async function healStuckNodeChat(workflowId: number, nodeKey: string): Promise<void> {
  const chatKey = `${workflowId}:${nodeKey}`;
  // 本进程里还在回的，不要动；热重启后内存集合空了，DB/Redis 里的残留要清掉。
  if (activeNodeChats.has(chatKey)) return;
  const open = await db.select().from(nodeMessages)
    .where(and(
      eq(nodeMessages.workflowId, workflowId),
      eq(nodeMessages.nodeKey, nodeKey),
      inArray(nodeMessages.status, ['pending', 'streaming']),
    ));
  for (const row of open) {
    await db.update(nodeMessages).set({
      content: row.content.trim() || '回复中断，请再发一次',
      status: 'failed',
    }).where(eq(nodeMessages.id, row.id));
    if (row.sessionId) {
      await db.update(sessions).set({
        status: 'failed',
        outputJson: { error: '回复中断' },
        completedAt: new Date(),
      }).where(and(eq(sessions.id, row.sessionId), inArray(sessions.status, ['pending', 'running', 'paused'])));
    }
  }
  await redisRuntime().releaseLock(nodeChatLockName(chatKey));
}

async function beginNodeChat(workflowId: number, nodeKey: string): Promise<boolean> {
  const chatKey = `${workflowId}:${nodeKey}`;
  if (activeNodeChats.has(chatKey)) return false;
  await healStuckNodeChat(workflowId, nodeKey);
  if (!(await redisRuntime().acquireLock(nodeChatLockName(chatKey), NODE_CHAT_LOCK_TTL_SECONDS))) return false;
  activeNodeChats.add(chatKey);
  return true;
}

const queuedWorkflowRunModes = new Map<number, 'restart' | 'resume' | undefined>();

function scheduleWorkflowExecution(workflowRunId: number, mode?: 'restart' | 'resume'): 'started' | 'queued' {
  if (executingWorkflowRuns.has(workflowRunId)) {
    queuedWorkflowRuns.add(workflowRunId);
    queuedWorkflowRunModes.set(workflowRunId, mode);
    return 'queued';
  }
  executingWorkflowRuns.add(workflowRunId);
  void executeWorkflowRun(workflowRunId, mode)
    .catch(async (error) => {
      console.error('Workflow execution failed', error);
      const current = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
      if (!current || current.status !== 'running') return;
      const updated = await db.update(workflowRuns).set({
        status: 'failed',
        errorJson: { error: error instanceof Error ? error.message : 'Workflow execution failed' },
        completedAt: new Date(),
      }).where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, 'running')));
      if (updated[0].affectedRows === 1) await rememberRunStatus(workflowRunId, 'failed');
    })
    .finally(() => {
      executingWorkflowRuns.delete(workflowRunId);
      void redisRuntime().releaseLock(`run:${workflowRunId}`);
      if (queuedWorkflowRuns.delete(workflowRunId)) {
        const nextMode = queuedWorkflowRunModes.get(workflowRunId);
        queuedWorkflowRunModes.delete(workflowRunId);
        scheduleWorkflowExecution(workflowRunId, nextMode);
      }
    });
  return 'started';
}

function anyOf(...conditions: Array<SQL | undefined>): SQL | undefined {
  const present = conditions.filter((item): item is SQL => item !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return or(...present);
}

async function deleteWorkflowCascade(workflowId: number): Promise<void> {
  const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
  const runIds = runs.map((run) => run.id);
  for (const runId of runIds) {
    queuedWorkflowRuns.delete(runId);
    await stopActiveWorkflowSessions(runId);
  }
  const taskRows = runIds.length
    ? await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.workflowRunId, runIds))
    : [];
  const taskIds = taskRows.map((task) => task.id);
  const sessionRows = taskIds.length
    ? await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.taskId, taskIds))
    : [];
  const sessionIds = sessionRows.map((session) => session.id);
  const checkpointRows = runIds.length
    ? await db.select({ id: checkpoints.id }).from(checkpoints).where(inArray(checkpoints.workflowRunId, runIds))
    : [];
  const checkpointIds = checkpointRows.map((checkpoint) => checkpoint.id);
  const guidanceRows = await db.select({ sessionId: nodeMessages.sessionId }).from(nodeMessages).where(eq(nodeMessages.workflowId, workflowId));
  const guidanceSessionIds = guidanceRows.map((row) => row.sessionId).filter((id): id is number => typeof id === 'number');

  await db.transaction(async (tx) => {
    const eventFilter = anyOf(
      runIds.length ? inArray(events.workflowRunId, runIds) : undefined,
      taskIds.length ? inArray(events.taskId, taskIds) : undefined,
      sessionIds.length ? inArray(events.sessionId, sessionIds) : undefined,
      guidanceSessionIds.length ? inArray(events.sessionId, guidanceSessionIds) : undefined,
    );
    if (eventFilter) await tx.delete(events).where(eventFilter);
    const decisionFilter = anyOf(
      runIds.length ? inArray(decisions.workflowRunId, runIds) : undefined,
      checkpointIds.length ? inArray(decisions.checkpointId, checkpointIds) : undefined,
    );
    if (decisionFilter) await tx.delete(decisions).where(decisionFilter);
    if (runIds.length) await tx.delete(checkpoints).where(inArray(checkpoints.workflowRunId, runIds));
    if (taskIds.length) await tx.delete(sessions).where(inArray(sessions.taskId, taskIds));
    if (runIds.length) await tx.delete(tasks).where(inArray(tasks.workflowRunId, runIds));
    if (runIds.length) await tx.delete(plans).where(inArray(plans.workflowRunId, runIds));
    const ownedAgents = await tx.select({ id: agents.id }).from(agents).where(eq(agents.workflowId, workflowId));
    await deleteAgentsByIds(tx as unknown as typeof db, ownedAgents.map((agent) => agent.id));
    await tx.delete(nodeMessages).where(eq(nodeMessages.workflowId, workflowId));
    if (guidanceSessionIds.length) await tx.delete(sessions).where(inArray(sessions.id, guidanceSessionIds));
    await tx.delete(workflowEdges).where(eq(workflowEdges.workflowId, workflowId));
    await tx.delete(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
    await tx.delete(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
    await tx.delete(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
    await tx.delete(workflows).where(eq(workflows.id, workflowId));
  });
}

async function stopActiveWorkflowSessions(workflowRunId: number): Promise<void> {
  const sessionIds = [...(activeWorkflowSessions.get(workflowRunId) ?? [])];
  await Promise.all(sessionIds.map(async (sessionId) => {
    await piRuntime.stop(sessionId);
    await piRuntime.wait(sessionId);
  }));
  activeWorkflowSessions.delete(workflowRunId);
}

const heartbeat = setInterval(() => {
  const message = `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
  for (const client of eventClients) client.response.write(message);
  const frame = JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() });
  for (const client of socketClients) sendWebSocketText(client.socket, frame);
}, 15_000);
heartbeat.unref();

function broadcastEvent(event: unknown, projectId: number) {
  const message = `event: orvia.event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    if (client.projectId === undefined || client.projectId === projectId) {
      client.response.write(message);
    }
  }
  const frame = JSON.stringify(event);
  for (const client of socketClients) {
    if (client.projectId === undefined || client.projectId === projectId) {
      sendWebSocketText(client.socket, frame);
    }
  }
}

type NewEvent = typeof events.$inferInsert;

/** 流式执行碎片只给前端实时看，不落库，避免 ov_events 被刷爆 */
const EPHEMERAL_RUNTIME_TYPES = new Set(['stdout', 'stderr', 'thinking', 'activity']);
const EPHEMERAL_EVENT_TYPES = [...EPHEMERAL_RUNTIME_TYPES].map((type) => `runtime.pi.${type}`);
let ephemeralEventSeq = 0;

async function resolveEventVersionId(event: Pick<NewEvent, 'workflowVersionId' | 'workflowRunId'>): Promise<number | undefined> {
  if (event.workflowVersionId != null) return event.workflowVersionId;
  if (!event.workflowRunId) return undefined;
  const run = (await db.select({
    workflowVersionId: workflowRuns.workflowVersionId,
    workflowId: workflowRuns.workflowId,
  }).from(workflowRuns).where(eq(workflowRuns.id, event.workflowRunId)).limit(1))[0];
  if (run?.workflowVersionId != null) return run.workflowVersionId;
  if (!run?.workflowId) return undefined;
  const workflow = (await db.select({ currentVersionId: workflows.currentVersionId }).from(workflows).where(eq(workflows.id, run.workflowId)).limit(1))[0];
  return workflow?.currentVersionId ?? undefined;
}

async function broadcastEphemeralEvent(event: NewEvent) {
  // 不查库、不落库；只经 Redis 推给面板。id 用大基数递增，避免和库内自增 id 冲突
  ephemeralEventSeq += 1;
  const envelope = {
    id: 1_000_000_000 + ephemeralEventSeq,
    projectId: event.projectId,
    workflowRunId: event.workflowRunId ?? null,
    workflowVersionId: event.workflowVersionId ?? null,
    taskId: event.taskId ?? null,
    sessionId: event.sessionId ?? null,
    agentId: event.agentId ?? null,
    type: event.type,
    payload: event.payloadJson ?? null,
    occurredAt: new Date().toISOString(),
  };
  await redisRuntime().publish('orvia:events', JSON.stringify(envelope));
  return envelope;
}

async function persistAndBroadcastEvent(event: NewEvent) {
  const workflowVersionId = await resolveEventVersionId(event);
  const row = { ...event, workflowVersionId };
  const result = await db.insert(events).values(row);
  const envelope = {
    id: result[0].insertId,
    projectId: row.projectId,
    workflowRunId: row.workflowRunId ?? null,
    workflowVersionId: row.workflowVersionId ?? null,
    taskId: row.taskId ?? null,
    sessionId: row.sessionId ?? null,
    agentId: row.agentId ?? null,
    type: row.type,
    payload: row.payloadJson ?? null,
    occurredAt: new Date().toISOString(),
  };
  await redisRuntime().publish('orvia:events', JSON.stringify(envelope));
  return envelope;
}

async function emitRuntimeEvent(
  base: Omit<NewEvent, 'type' | 'payloadJson'>,
  runtimeType: string,
  payload: unknown,
) {
  const event = { ...base, type: `runtime.pi.${runtimeType}`, payloadJson: payload };
  try {
    if (EPHEMERAL_RUNTIME_TYPES.has(runtimeType)) {
      await broadcastEphemeralEvent(event);
      return;
    }
    await persistAndBroadcastEvent(event);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      type: 'runtime.event.emit_failed',
      runtimeType,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

const ACTIVE_RUN_STATUSES = ['running', 'paused', 'awaiting_decision'] as const;

function isActiveRunStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

async function deleteWorkflowVersionLogs(versionIds: number[]): Promise<void> {
  if (versionIds.length === 0) return;
  await db.delete(events).where(inArray(events.workflowVersionId, versionIds));
  await db.delete(nodeMessages).where(inArray(nodeMessages.workflowVersionId, versionIds));
}

async function pruneWorkflowVersions(workflowId: number): Promise<number[]> {
  const rows = await db.select({
    id: workflowVersions.id,
    seq: workflowVersions.seq,
  }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
  const doomed = versionsToPrune(rows, MAX_WORKFLOW_VERSIONS);
  const ids = doomed.map((row) => row.id);
  if (ids.length === 0) return [];
  await deleteWorkflowVersionLogs(ids);
  await db.update(workflowRuns).set({ workflowVersionId: null }).where(inArray(workflowRuns.workflowVersionId, ids));
  await db.delete(workflowVersions).where(inArray(workflowVersions.id, ids));
  return ids;
}

async function ensureLegacyWorkflowVersion(workflowId: number): Promise<typeof workflowVersions.$inferSelect | null> {
  const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
  if (!workflow || workflow.status !== 'published') return null;
  const existing = await db.select().from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.seq));
  if (existing[0]) {
    if (!workflow.currentVersionId) {
      await db.update(workflows).set({ currentVersionId: existing[0].id, version: existing[0].version }).where(eq(workflows.id, workflowId));
    }
    return existing[0];
  }
  const definitionJson = workflow.definitionJson ?? { nodes: [], edges: [] };
  const prepared = prepareWorkflowDefinition(definitionJson, false);
  if (prepared.definitionNodes.length === 0) return null;
  const seq = 1;
  const version = formatWorkflowVersionLabel(seq);
  const inserted = await db.insert(workflowVersions).values({
    workflowId,
    version,
    seq,
    name: workflow.name,
    definitionJson,
  });
  const versionId = inserted[0].insertId;
  await db.update(workflows).set({ version, currentVersionId: versionId }).where(eq(workflows.id, workflowId));
  const row = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId)).limit(1))[0];
  return row ?? null;
}

async function publishWorkflowVersion(workflowId: number, input: {
  name: string;
  definitionJson: unknown;
}): Promise<{ versionId: number; version: string; seq: number; pruned: number[] }> {
  const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
  if (!workflow) throw new OrviaError('Workflow not found', 'not_found', 404);
  const active = (await db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId)).limit(1))[0];
  if (active && isActiveRunStatus(active.status)) {
    throw new OrviaError('请先停止正在运行的 Run，再发布新版本', 'conflict', 409);
  }
  const prepared = prepareWorkflowDefinition(input.definitionJson, true);
  if (prepared.definitionNodes.length === 0) throw new OrviaError('请至少添加一个节点', 'validation', 400);
  await assertProjectCatalogKeys(workflow.projectId, prepared.nodeCapabilityLists.flat());
  const maxSeqRow = (await db.select({ seq: workflowVersions.seq }).from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.seq))
    .limit(1))[0];
  const seq = nextWorkflowVersionSeq(maxSeqRow?.seq);
  const version = formatWorkflowVersionLabel(seq);
  const definitionJson = input.definitionJson ?? { nodes: [], edges: [] };
  const created = await db.transaction(async (tx) => {
    const inserted = await tx.insert(workflowVersions).values({
      workflowId,
      version,
      seq,
      name: input.name,
      definitionJson,
    });
    const versionId = inserted[0].insertId;
    await tx.update(workflows).set({
      name: input.name,
      version,
      currentVersionId: versionId,
      definitionJson,
      status: 'published',
    }).where(eq(workflows.id, workflowId));
    await insertWorkflowGraph(tx, workflowId, prepared, true, true);
    await tx.update(workflowRuns).set({ workflowVersionId: versionId }).where(eq(workflowRuns.workflowId, workflowId));
    return versionId;
  });
  await managedWorkflowRoot(workflowId);
  const pruned = await pruneWorkflowVersions(workflowId);
  return { versionId: created, version, seq, pruned };
}

async function activateWorkflowVersion(workflowId: number, versionId: number): Promise<{ version: string }> {
  const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
  if (!workflow) throw new OrviaError('Workflow not found', 'not_found', 404);
  const active = (await db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId)).limit(1))[0];
  if (active && isActiveRunStatus(active.status)) {
    throw new OrviaError('请先停止 Run，才能切换历史版本', 'conflict', 409);
  }
  const snapshot = (await db.select().from(workflowVersions)
    .where(and(eq(workflowVersions.id, versionId), eq(workflowVersions.workflowId, workflowId)))
    .limit(1))[0];
  if (!snapshot) throw new OrviaError('版本不存在', 'not_found', 404);
  const prepared = prepareWorkflowDefinition(snapshot.definitionJson, true);
  await assertProjectCatalogKeys(workflow.projectId, prepared.nodeCapabilityLists.flat());
  await db.transaction(async (tx) => {
    await tx.update(workflows).set({
      name: snapshot.name,
      version: snapshot.version,
      currentVersionId: snapshot.id,
      definitionJson: snapshot.definitionJson,
      status: 'published',
    }).where(eq(workflows.id, workflowId));
    await insertWorkflowGraph(tx, workflowId, prepared, true, true);
    await tx.update(workflowRuns).set({ workflowVersionId: snapshot.id }).where(eq(workflowRuns.workflowId, workflowId));
  });
  await managedWorkflowRoot(workflowId);
  return { version: snapshot.version };
}

async function rememberRunStatus(workflowRunId: number, status: RunStatus, workflowId?: number) {
  const id = workflowId ?? (await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0]?.workflowId;
  if (id) await db.update(workflows).set({ runStatus: status }).where(eq(workflows.id, id));
}

async function finishRunIfStillRunning(workflowRunId: number, workflowId: number, status: 'completed' | 'failed', patch: { errorJson?: unknown; completedAt?: Date }) {
  const updated = await db.update(workflowRuns).set({ status, ...patch }).where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, 'running')));
  if (updated[0].affectedRows !== 1) return false;
  await rememberRunStatus(workflowRunId, status, workflowId);
  return true;
}

function dependsOnNodeIds(inputJson: unknown): number[] {
  const input = jsonObject(inputJson);
  return Array.isArray(input.dependsOnNodeIds) ? input.dependsOnNodeIds.map(Number).filter((id) => Number.isInteger(id)) : [];
}

async function workflowRunMatchesGraph(workflowRunId: number, workflowId: number): Promise<boolean> {
  const nodes = await db.select({ id: workflowNodes.id }).from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
  const taskRows = await db.select({ workflowNodeId: tasks.workflowNodeId, status: tasks.status }).from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  const live = taskRows.filter((task) => task.status !== 'cancelled');
  if (live.length !== nodes.length) return false;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<number>();
  for (const task of live) {
    if (!task.workflowNodeId || !nodeIds.has(task.workflowNodeId) || seen.has(task.workflowNodeId)) return false;
    seen.add(task.workflowNodeId);
  }
  return seen.size === nodeIds.size;
}

async function resumePausedTasks(workflowRunId: number) {
  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  const completedNodes = new Set(taskRows.filter((task) => task.status === 'completed' && task.workflowNodeId).map((task) => task.workflowNodeId as number));
  for (const task of taskRows) {
    if (task.status !== 'paused' && task.status !== 'running') continue;
    const ready = dependsOnNodeIds(task.inputJson).every((nodeId) => completedNodes.has(nodeId));
    await db.update(tasks).set({ status: ready ? 'pending' : 'blocked' }).where(eq(tasks.id, task.id));
    await db.update(sessions).set({ status: 'pending', outputJson: null, completedAt: null, startedAt: null }).where(and(eq(sessions.taskId, task.id), inArray(sessions.status, ['paused', 'running', 'failed'])));
  }
}

async function rebuildWorkflowRunGraph(workflowRunId: number, workflowId: number) {
  const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).orderBy(asc(workflowNodes.id));
  if (nodes.length === 0) throw new OrviaError('这个 Workflow 还没有节点', 'validation', 400);
  const edges = await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId)).orderBy(asc(workflowEdges.id));
  const projectId = await runProjectId(workflowRunId);
  const previousTaskIds = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workflowRunId, workflowRunId))).map((task) => task.id);
  const rebuilt = await db.transaction(async (tx) => {
    const oldPlans = await tx.select().from(plans).where(eq(plans.workflowRunId, workflowRunId)).orderBy(desc(plans.version));
    const version = (oldPlans[0]?.version ?? 0) + 1;
    await tx.update(plans).set({ status: 'superseded' }).where(and(eq(plans.workflowRunId, workflowRunId), eq(plans.status, 'active')));
    await tx.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.workflowRunId, workflowRunId));
    if (previousTaskIds.length > 0) {
      await tx.update(sessions).set({
        status: 'failed',
        completedAt: new Date(),
        outputJson: { error: 'Run restarted from the beginning' },
      }).where(and(inArray(sessions.taskId, previousTaskIds), inArray(sessions.status, ['pending', 'running', 'paused'])));
    }
    await tx.update(checkpoints).set({ status: 'superseded', resolvedAt: new Date() }).where(and(eq(checkpoints.workflowRunId, workflowRunId), eq(checkpoints.status, 'pending')));
    await tx.update(decisions).set({ status: 'superseded', resolvedAt: new Date() }).where(and(eq(decisions.workflowRunId, workflowRunId), eq(decisions.status, 'pending')));
    const currentInput = jsonObject((await tx.select({ inputJson: workflowRuns.inputJson }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0]?.inputJson);
    const keptInput = { ...currentInput };
    delete keptInput.executionId;
    delete keptInput.acceptanceRedos;
    delete keptInput.loopIterations;
    const planResult = await tx.insert(plans).values({
      workflowRunId,
      version,
      graphJson: { nodes: nodes.map((node) => node.id), edges: edges.map((edge) => ({ source: edge.sourceNodeId, target: edge.targetNodeId })) },
    });
    const planId = planResult[0].insertId;
    const planned = [];
    for (const node of nodes) {
      const depends = edges.filter((edge) => edge.targetNodeId === node.id).map((edge) => edge.sourceNodeId);
      const capabilities = storedNodeCapabilityKeys(node);
      if (capabilities.length === 0 && node.nodeType !== 'start' && node.nodeType !== 'end') throw new OrviaError(`请为 Agent「${node.name}」选择能力`, 'validation', 400);
      const nodeConfig = withoutLegacySkill(jsonObject(node.configJson));
      const inputJson: Record<string, unknown> = {
        ...nodeConfig,
        capabilities,
        capability: capabilities[0],
        workflowNodeId: node.id,
        nodeType: node.nodeType,
        dependsOnNodeIds: depends,
      };
      delete inputJson.skill;
      delete inputJson.acceptanceResult;
      delete inputJson.acceptanceHistory;
      delete inputJson.acceptanceWaived;
      delete inputJson.redoReason;
      delete inputJson.redoRound;
      delete inputJson.workspacePath;
      delete inputJson.prompt;
      const taskResult = await tx.insert(tasks).values({
        workflowRunId,
        planId,
        workflowNodeId: node.id,
        name: node.name,
        status: depends.length > 0 ? 'blocked' : 'pending',
        maxRetries: typeof nodeConfig.maxRetries === 'number' ? nodeConfig.maxRetries : 0,
        inputJson,
      });
      const taskId = taskResult[0].insertId;
      const sessionResult = await tx.insert(sessions).values({ taskId, runtime: 'pi', status: 'pending', inputJson });
      planned.push({ nodeId: node.id, taskId, sessionId: sessionResult[0].insertId, capabilities, nodeType: node.nodeType, dependsOnNodeIds: depends });
    }
    await tx.update(workflowRuns).set({
      currentPlanVersion: version,
      errorJson: null,
      completedAt: null,
      inputJson: { ...keptInput, acceptanceRedos: {}, loopIterations: {} },
    }).where(eq(workflowRuns.id, workflowRunId));
    return { planId, version, planned };
  });
  await persistAndBroadcastEvent({
    projectId,
    workflowRunId,
    type: 'workflow.planned',
    payloadJson: { planId: rebuilt.planId, version: rebuilt.version, nodeCount: rebuilt.planned.length, tasks: rebuilt.planned, rebuilt: true },
  });
}

function recordKey(value: unknown): string {
  const key = jsonObject(value).key;
  return typeof key === 'string' ? key.trim() : '';
}

async function resumeMatches(workflowRunId: number, workflowId: number) {
  const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).orderBy(asc(workflowNodes.id));
  const edges = await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId));
  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId)).orderBy(asc(tasks.id));
  const latestByKey = pickLatestTasksByKey(taskRows.map((task) => ({
    id: task.id,
    key: recordKey(task.inputJson),
    name: task.name,
    status: task.status,
    task,
  })));
  const seen = new Set<number>();
  const matches = nodes.map((node) => {
    const picked = latestByKey.get(recordKey(node.configJson));
    const task = picked?.task;
    if (!task || seen.has(task.id)) throw new OrviaError('Agent 已经改过，不能从暂停处继续。请选择从头开始。', 'validation', 409);
    seen.add(task.id);
    const depends = edges.filter((edge) => edge.targetNodeId === node.id).map((edge) => edge.sourceNodeId);
    return { node, task, depends };
  });
  if (matches.length === 0) throw new OrviaError('这个 Workflow 还没有节点', 'validation', 400);
  return matches;
}

async function assertResumePossible(workflowRunId: number, workflowId: number): Promise<string[]> {
  const pendingDecision = (await db.select({ id: decisions.id }).from(decisions)
    .where(and(eq(decisions.workflowRunId, workflowRunId), eq(decisions.status, 'pending')))
    .limit(1))[0];
  if (pendingDecision) {
    throw new OrviaError('当前在等待确认。请先在面板上处理待确认，或选择从头开始。', 'validation', 409);
  }
  const matches = await resumeMatches(workflowRunId, workflowId);
  const nodeInfos = matches.map((item) => ({
    key: recordKey(item.node.configJson) || `node-${item.node.id}`,
    name: item.node.name,
  }));
  const edgeInfos = (await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId))).flatMap((edge) => {
    const source = matches.find((item) => item.node.id === edge.sourceNodeId);
    const target = matches.find((item) => item.node.id === edge.targetNodeId);
    if (!source || !target) return [];
    return [{
      source: recordKey(source.node.configJson) || `node-${source.node.id}`,
      target: recordKey(target.node.configJson) || `node-${target.node.id}`,
    }];
  });
  const tasksByKey = new Map(matches.map((item) => {
    const key = recordKey(item.node.configJson) || `node-${item.node.id}`;
    return [key, { id: item.task.id, key, name: item.task.name, status: item.task.status }] as const;
  }));
  const frontier = resumeFrontier(nodeInfos, edgeInfos, tasksByKey);
  if (!frontier.ok) {
    if (frontier.reason === 'awaiting') {
      throw new OrviaError('当前在等待确认。请先在面板上处理待确认，或选择从头开始。', 'validation', 409);
    }
    if (frontier.reason === 'changed') {
      throw new OrviaError('Agent 已经改过，不能从暂停处继续。请选择从头开始。', 'validation', 409);
    }
    throw new OrviaError('当前没有暂停的 Agent，这次已经全部完成。请选择从头开始。', 'validation', 409);
  }
  return frontier.names;
}

async function resumeInterruptedTasks(workflowRunId: number, workflowId: number): Promise<void> {
  const names = await assertResumePossible(workflowRunId, workflowId);
  const matches = await resumeMatches(workflowRunId, workflowId);
  const byNode = new Map(matches.map((item) => [item.node.id, item]));
  for (const item of matches) {
    // Keep finished nodes as-is so「从当前节点继续」不会丢掉已完成产物
    if (item.task.status === 'completed') {
      await db.update(tasks).set({ workflowNodeId: item.node.id }).where(eq(tasks.id, item.task.id));
      continue;
    }
    const ready = item.depends.every((nodeId) => byNode.get(nodeId)?.task.status === 'completed');
    const capabilities = storedNodeCapabilityKeys(item.node);
    const previous = jsonObject(item.task.inputJson);
    const inputJson: Record<string, unknown> = {
      ...previous,
      ...withoutLegacySkill(jsonObject(item.node.configJson)),
      capabilities,
      capability: capabilities[0],
      workflowNodeId: item.node.id,
      nodeType: item.node.nodeType,
      dependsOnNodeIds: item.depends,
    };
    delete inputJson.skill;
    // Resume re-runs incomplete nodes; drop stale wait markers but keep redo context if any
    delete inputJson.acceptanceWaived;
    if (item.task.status === 'awaiting_decision' || item.task.status === 'cancelled' || item.task.status === 'failed') {
      delete inputJson.acceptanceResult;
    }
    await db.update(tasks).set({
      workflowNodeId: item.node.id,
      name: item.node.name,
      status: ready ? 'pending' : 'blocked',
      errorKind: null,
      outputJson: null,
      inputJson,
    }).where(eq(tasks.id, item.task.id));
    const session = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, item.task.id)).orderBy(desc(sessions.id)).limit(1))[0];
    if (session) {
      await db.update(sessions).set({
        status: 'pending',
        outputJson: null,
        completedAt: null,
        startedAt: null,
        inputJson,
      }).where(eq(sessions.id, session.id));
    } else {
      await db.insert(sessions).values({ taskId: item.task.id, runtime: 'pi', status: 'pending', inputJson });
    }
  }
  await persistAndBroadcastEvent({
    projectId: await runProjectId(workflowRunId),
    workflowRunId,
    type: 'workflow.resumed',
    payloadJson: { message: `从${names.join('、')}继续`, nodes: names },
  });
}

/** 图结构未变时也会复用旧 task；把节点上最新的校验配置同步进去，避免 maxRedos 仍停留在默认 3 */
async function syncTaskConfigsFromNodes(workflowRunId: number, workflowId: number): Promise<void> {
  const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  for (const task of taskRows) {
    if (!task.workflowNodeId || task.status === 'cancelled' || task.status === 'completed' || task.status === 'running') continue;
    const node = byId.get(task.workflowNodeId);
    if (!node) continue;
    const previous = jsonObject(task.inputJson);
    const config = withoutLegacySkill(jsonObject(node.configJson));
    const capabilities = storedNodeCapabilityKeys(node);
    const inputJson: Record<string, unknown> = {
      ...previous,
      ...config,
      capabilities,
      capability: capabilities[0],
      workflowNodeId: node.id,
      nodeType: node.nodeType,
      dependsOnNodeIds: previous.dependsOnNodeIds,
    };
    delete inputJson.skill;
    if (JSON.stringify(inputJson) === JSON.stringify(previous)) continue;
    await db.update(tasks).set({ name: node.name, inputJson }).where(eq(tasks.id, task.id));
    const session = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, task.id)).orderBy(desc(sessions.id)).limit(1))[0];
    if (session) await db.update(sessions).set({ inputJson }).where(eq(sessions.id, session.id));
  }
}

async function prepareWorkflowRunForExecution(workflowRunId: number, workflowId: number, status: string, mode?: 'restart' | 'resume') {
  if (mode === 'restart') {
    await rebuildWorkflowRunGraph(workflowRunId, workflowId);
    return;
  }
  if (mode === 'resume') {
    await resumeInterruptedTasks(workflowRunId, workflowId);
    return;
  }
  const matches = await workflowRunMatchesGraph(workflowRunId, workflowId);
  if (status === 'paused' && matches) {
    await syncTaskConfigsFromNodes(workflowRunId, workflowId);
    await resumePausedTasks(workflowRunId);
    return;
  }
  if (status === 'awaiting_decision' && matches) {
    await syncTaskConfigsFromNodes(workflowRunId, workflowId);
    await db.update(tasks).set({ status: 'pending' }).where(and(eq(tasks.workflowRunId, workflowRunId), eq(tasks.status, 'awaiting_decision')));
    return;
  }
  if (status === 'pending' && matches) {
    await syncTaskConfigsFromNodes(workflowRunId, workflowId);
    return;
  }
  await rebuildWorkflowRunGraph(workflowRunId, workflowId);
}

async function runInput(workflowRunId: number): Promise<Record<string, unknown>> {
  const row = (await db.select({ inputJson: workflowRuns.inputJson }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
  return jsonObject(row?.inputJson);
}

async function managedWorkflowRoot(workflowId: number): Promise<string> {
  const workflow = (await db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
  const resolved = await resolveWorkflowRoot(workflowId, workflow?.name ?? '');
  for (const move of resolved.moves) await rewriteStoredPaths(move.workflowId, move.from, move.to);
  return resolved.root;
}

function replacePathPrefix(value: unknown, from: string, to: string): unknown {
  const fromBoundary = from.endsWith(path.sep) ? from : `${from}${path.sep}`;
  const toBoundary = to.endsWith(path.sep) ? to : `${to}${path.sep}`;
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      if (item === from) return to;
      if (item.startsWith(fromBoundary)) return `${toBoundary}${item.slice(fromBoundary.length)}`;
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return visit(value);
}

async function rewriteStoredPaths(workflowId: number, from: string, to: string): Promise<void> {
  if (path.resolve(from) === path.resolve(to)) return;
  const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
  const runIds = runs.map((run) => run.id);
  if (runIds.length === 0) return;
  const taskRows = await db.select({ id: tasks.id, inputJson: tasks.inputJson, outputJson: tasks.outputJson }).from(tasks).where(inArray(tasks.workflowRunId, runIds));
  for (const task of taskRows) {
    const inputJson = replacePathPrefix(task.inputJson, from, to);
    const outputJson = replacePathPrefix(task.outputJson, from, to);
    if (JSON.stringify(inputJson) !== JSON.stringify(task.inputJson) || JSON.stringify(outputJson) !== JSON.stringify(task.outputJson)) {
      await db.update(tasks).set({ inputJson, outputJson }).where(eq(tasks.id, task.id));
    }
  }
  const taskIds = taskRows.map((task) => task.id);
  if (taskIds.length > 0) {
    const sessionRows = await db.select({ id: sessions.id, inputJson: sessions.inputJson, outputJson: sessions.outputJson }).from(sessions).where(inArray(sessions.taskId, taskIds));
    for (const session of sessionRows) {
      const inputJson = replacePathPrefix(session.inputJson, from, to);
      const outputJson = replacePathPrefix(session.outputJson, from, to);
      if (JSON.stringify(inputJson) !== JSON.stringify(session.inputJson) || JSON.stringify(outputJson) !== JSON.stringify(session.outputJson)) {
        await db.update(sessions).set({ inputJson, outputJson }).where(eq(sessions.id, session.id));
      }
    }
  }
  const eventRows = await db.select({ id: events.id, payloadJson: events.payloadJson }).from(events).where(inArray(events.workflowRunId, runIds));
  for (const event of eventRows) {
    const payloadJson = replacePathPrefix(event.payloadJson, from, to);
    if (JSON.stringify(payloadJson) !== JSON.stringify(event.payloadJson)) {
      await db.update(events).set({ payloadJson }).where(eq(events.id, event.id));
    }
  }
}

async function sequencedNodeFolder(workflowId: number, nodeName: string, workflowNodeId: number | null, fallbackKey: string): Promise<string> {
  const base = folderBaseName(nodeName, fallbackKey);
  const rows = await db.select({ id: workflowNodes.id, name: workflowNodes.name }).from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).orderBy(asc(workflowNodes.id));
  const same = rows.filter((row) => folderBaseName(row.name, `node-${row.id}`) === base);
  const index = same.findIndex((row) => row.id === workflowNodeId);
  if (index >= 0) return sequenceFolderName(base, index + 1, same.length);
  if (same.length === 0) return base;
  return sequenceFolderName(base, same.length + 1, same.length + 1);
}

async function ensureRunExecution(workflowRunId: number, workflowId: number, fresh: boolean): Promise<string> {
  const current = await runInput(workflowRunId);
  if (!fresh && typeof current.executionId === 'string' && current.executionId.trim()) return current.executionId;
  const root = await managedWorkflowRoot(workflowId);
  const allocated = await allocateSequenceFolder(path.join(root, 'executions'), executionStamp());
  for (const move of allocated.moves) await rewriteStoredPaths(workflowId, move.from, move.to);
  const executionId = allocated.name;
  const directory = executionDirectory(root, executionId);
  await ensureDirectory(directory);
  let inputJson: unknown = { ...current, executionId, loopIterations: fresh ? {} : jsonObject(current.loopIterations), ...(fresh ? { acceptanceRedos: {} } : {}) };
  for (const move of allocated.moves) inputJson = replacePathPrefix(inputJson, move.from, move.to);
  await db.update(workflowRuns).set({
    inputJson,
  }).where(eq(workflowRuns.id, workflowRunId));
  return executionId;
}

async function loopIteration(workflowRunId: number, workflowId: number, nodeKey: string): Promise<number> {
  const workflow = (await db.select({ definitionJson: workflows.definitionJson }).from(workflows).where(eq(workflows.id, workflowId)))[0];
  const loop = loopForNode(loopsFromDefinition(workflow?.definitionJson), nodeKey);
  if (!loop) return 1;
  const counts = jsonObject((await runInput(workflowRunId)).loopIterations);
  const current = Number(counts[loop.key] ?? 1);
  return Number.isInteger(current) && current > 0 ? current : 1;
}

async function upstreamText(workflowRunId: number, task: typeof tasks.$inferSelect): Promise<string> {
  const depends = dependsOnNodeIds(task.inputJson);
  if (depends.length === 0) return '';
  const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  const sections: string[] = [];
  for (const nodeId of depends) {
    const upstream = runTasks.find((item) => item.workflowNodeId === nodeId && item.status === 'completed');
    if (!upstream) continue;
    const output = jsonObject(upstream.outputJson);
    const text = typeof output.text === 'string' ? output.text : '';
    const directory = typeof output.workspacePath === 'string' ? output.workspacePath : '';
    sections.push(`### ${upstream.name}\n${text || '（没有文字结果）'}${directory ? `\n目录：${directory}` : ''}`);
  }
  return sections.join('\n\n');
}

async function nodeGuidanceText(workflowId: number, nodeKey: string): Promise<string> {
  const rows = await db.select().from(nodeMessages)
    .where(and(eq(nodeMessages.workflowId, workflowId), eq(nodeMessages.nodeKey, nodeKey)))
    .orderBy(asc(nodeMessages.id));
  return rows
    .filter((row) => row.status === 'completed' && row.content.trim())
    .map((row) => `${row.role === 'user' ? '用户' : 'Agent'}：${row.content.trim()}`)
    .join('\n');
}

async function latestNodeDirectory(workflowId: number, nodeKey: string): Promise<string | undefined> {
  const run = (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).limit(1))[0];
  if (!run) return undefined;
  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowRunId, run.id)).orderBy(asc(tasks.id));
  let directory = '';
  for (const task of taskRows) {
    const input = jsonObject(task.inputJson);
    if (input.key !== nodeKey) continue;
    const output = jsonObject(task.outputJson);
    const candidate = typeof output.workspacePath === 'string' ? output.workspacePath : typeof input.workspacePath === 'string' ? input.workspacePath : '';
    if (candidate && isManagedWorkspace(candidate)) directory = candidate;
  }
  return directory && await directoryExists(directory) ? directory : undefined;
}

async function replyToNode(workflowId: number, nodeKey: string, content: string, assistantMessageId: number, sessionId: number): Promise<void> {
  const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
  const node = (await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)))
    .find((item) => recordKey(item.configJson) === nodeKey);
  if (!workflow || !node) throw new Error('节点不存在');
  const history = await nodeGuidanceText(workflowId, nodeKey);
  const directory = await latestNodeDirectory(workflowId, nodeKey);
  const config = jsonObject(node.configJson);
  const instruction = typeof config.instruction === 'string' ? config.instruction : '';
  const outputRequirement = typeof config.outputRequirement === 'string' ? config.outputRequirement : '';
  const run = (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).limit(1))[0];
  const resolved = await resolveWorkflowNode({
    projectId: workflow.projectId,
    workflowRunId: run?.id,
    name: node.name,
    capabilities: storedNodeCapabilityKeys(node),
  });
  const prompt = [
    `你是多 Agent 协作中的 Agent「${node.name}」。用户正在直接指导你，这些指导在之后和下游 Agent 协作时继续生效。`,
    instruction.trim() ? `任务说明：\n${instruction.trim()}` : '',
    outputRequirement.trim() ? `产出要求：\n${outputRequirement.trim()}` : '',
    directory
      ? '当前目录就是这个 Agent 的工作目录。按用户的指导调整这里的做法和产出，需要时直接修改目录里的文件。'
      : '这个 Agent 还没有自己的工作目录。只回复你理解的指导，以及执行时会怎么做。不要创建或修改文件。',
    history.trim() ? `对话：\n${history.trim()}\n\n请回复最后一条用户指导。` : `用户刚才说：\n${content}`,
  ].filter(Boolean).join('\n\n');
  const root = await managedWorkflowRoot(workflowId);
  const workingDirectory = directory ?? root;
  const output: string[] = [];
  const thinking: string[] = [];
  let activity = '';
  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  const remember = (content: string, thought: string) => {
    writes = writes.then(() => db.update(nodeMessages).set({
      content,
      thinking: thought || null,
      status: 'streaming',
    }).where(eq(nodeMessages.id, assistantMessageId)).then(() => undefined)).catch(() => undefined);
  };
  const flush = () => {
    flushTimer = undefined;
    if (closed) return;
    const answer = output.join('');
    const thought = thinking.join('');
    const liveThought = !answer.trim() && activity ? [thought, activity].filter(Boolean).join('\n') : thought;
    if (answer || liveThought) remember(answer, liveThought);
  };
  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, 80);
  };
  await db.update(sessions).set({ status: 'running', startedAt: new Date() }).where(eq(sessions.id, sessionId));
  await piRuntime.start({
    sessionId,
    taskId: 0,
    prompt,
    systemPrompt: resolved.systemPrompt,
    workingDirectory,
    allowedTools: directory ? resolved.runtimePolicy.allowedTools : [],
    deniedTools: directory ? resolved.runtimePolicy.deniedTools : undefined,
    onEvent: (runtimeEvent) => {
      if (runtimeEvent.type === 'thinking' && typeof runtimeEvent.payload === 'string') thinking.push(runtimeEvent.payload);
      if (runtimeEvent.type === 'stdout' && typeof runtimeEvent.payload === 'string') output.push(runtimeEvent.payload);
      if (runtimeEvent.type === 'activity' && typeof runtimeEvent.payload === 'string') activity = runtimeEvent.payload;
      scheduleFlush();
    },
  });
  const completed = await piRuntime.wait(sessionId);
  closed = true;
  if (flushTimer) clearTimeout(flushTimer);
  await writes;
  const text = output.join('').trim() || completed.message || '';
  const thought = thinking.join('').trim();
  const failed = completed.status !== 'completed';
  await db.update(nodeMessages).set({
    content: text || (failed ? 'Agent 没有回复' : activity ? '已按你的指导处理了这个 Agent 的文件。' : '已收到'),
    thinking: thought || null,
    status: failed ? 'failed' : 'completed',
  }).where(eq(nodeMessages.id, assistantMessageId));
  await db.update(sessions).set({
    status: failed ? 'failed' : 'completed',
    outputJson: { text },
    completedAt: new Date(),
  }).where(eq(sessions.id, sessionId));
}

async function prepareTaskWorkspace(workflowId: number, workflowRunId: number, task: typeof tasks.$inferSelect): Promise<void> {
  const input = jsonObject(task.inputJson);
  const nodeKey = typeof input.key === 'string' ? input.key : `task-${task.id}`;
  const executionId = await ensureRunExecution(workflowRunId, workflowId, false);
  const redoRound = Number(input.redoRound);
  const iteration = Math.max(await loopIteration(workflowRunId, workflowId, nodeKey), Number.isInteger(redoRound) && redoRound > 1 ? redoRound : 1);
  const directory = nodeDirectory(executionDirectory(await managedWorkflowRoot(workflowId), executionId), await sequencedNodeFolder(workflowId, task.name, task.workflowNodeId, nodeKey), iteration);
  const instruction = typeof input.instruction === 'string' ? input.instruction : '';
  const outputRequirement = typeof input.outputRequirement === 'string' ? input.outputRequirement : '';
  const redoReason = typeof input.redoReason === 'string' ? input.redoReason : '';
  const upstream = await upstreamText(workflowRunId, task);
  const guidance = await nodeGuidanceText(workflowId, nodeKey);
  await writeTaskBrief(directory, task.name, instruction, upstream, outputRequirement, guidance, redoReason);
  const prompt = [
    `你是多 Agent 协作中的 Agent「${task.name}」。`,
    instruction.trim() ? `任务说明：\n${instruction.trim()}` : '',
    outputRequirement.trim() ? `产出要求：\n${outputRequirement.trim()}\n请严格按这份产出要求完成，并把产出文件写在当前工作目录。` : '',
    redoReason.trim() ? `退回原因：\n${redoReason.trim()}\n请按这个原因重新完成。上一轮文件还留在原来的目录里。` : '',
    guidance.trim() ? `人工指导：\n${guidance.trim()}\n请按这些指导完成本 Agent 的工作。` : '',
    upstream.trim() ? `上游产物：\n${upstream.trim()}` : '',
    outputRequirement.trim() ? '' : '请在当前工作目录完成工作，并把可以交给下一个 Agent 的结论写清楚。',
  ].filter(Boolean).join('\n\n');
  const nextInput = { ...input, workspacePath: directory, prompt };
  task.inputJson = nextInput;
  await db.update(tasks).set({ inputJson: nextInput }).where(eq(tasks.id, task.id));
  await db.update(sessions).set({ inputJson: nextInput }).where(eq(sessions.taskId, task.id));
}

const NODE_STATUS_LABEL: Record<string, string> = {
  pending: '待处理', blocked: '等待上游', running: '进行中', paused: '已暂停',
  awaiting_decision: '等待确认', completed: '已完成', failed: '失败', cancelled: '已停止',
};

async function workflowRunSummary(workflowRunId: number) {
  const run = (await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
  const graphNodes = run ? await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, run.workflowId)) : [];
  const graphKeys = new Set(graphNodes.map((node) => recordKey(node.configJson)).filter(Boolean));
  const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId)).orderBy(asc(tasks.id));
  const latest = new Map<string, typeof tasks.$inferSelect>();
  const directories = new Map<string, string>();
  for (const task of runTasks) {
    const key = recordKey(task.inputJson) || `task-${task.id}`;
    if (graphKeys.size > 0 && !graphKeys.has(key)) continue;
    latest.set(key, task);
    const input = jsonObject(task.inputJson);
    const output = jsonObject(task.outputJson);
    const directory = typeof output.workspacePath === 'string' && output.workspacePath
      ? output.workspacePath
      : typeof input.workspacePath === 'string' ? input.workspacePath : '';
    if (directory) directories.set(key, directory);
  }
  const nodes = [];
  for (const task of [...latest.values()].sort((left, right) => left.id - right.id)) {
    const input = jsonObject(task.inputJson);
    const key = recordKey(input) || `task-${task.id}`;
    const directory = directories.get(key) ?? '';
    const names = directory && isManagedWorkspace(directory) ? await listDeliverableNames(directory) : [];
    nodes.push({
      key,
      name: task.name,
      status: task.status,
      files: names.map((name) => ({ name, path: path.join(directory, name) })),
    });
  }
  const order = new Map(graphNodes.map((node, index) => [recordKey(node.configJson), index]));
  nodes.sort((left, right) => (order.get(left.key) ?? 0) - (order.get(right.key) ?? 0));
  return nodes;
}

function summaryText(nodes: Array<{ name: string; status: string; files: Array<{ name: string }> }>): string {
  const lines = ['# 流程进度', ''];
  for (const node of nodes) {
    lines.push(`- ${node.name}：${NODE_STATUS_LABEL[node.status] ?? node.status}`);
    if (node.files.length === 0) lines.push('  - （没有产物文件）');
    for (const file of node.files) lines.push(`  - ${file.name}`);
  }
  return lines.join('\n');
}

async function completeBoundaryNode(workflowId: number, workflowRunId: number, task: typeof tasks.$inferSelect): Promise<void> {
  const input = jsonObject(task.inputJson);
  const nodeKey = typeof input.key === 'string' ? input.key : task.name;
  const root = await managedWorkflowRoot(workflowId);
  const executionId = await ensureRunExecution(workflowRunId, workflowId, false);
  const redoRound = Number(input.redoRound);
  const directory = nodeDirectory(executionDirectory(root, executionId), await sequencedNodeFolder(workflowId, task.name, task.workflowNodeId, nodeKey), Number.isInteger(redoRound) && redoRound > 1 ? redoRound : 1);
  let text = '';
  if (input.nodeType === 'start') {
    const requirement = typeof input.requirement === 'string' ? input.requirement : '';
    const files = await writeStartInput(directory, requirement, root);
    text = [requirement.trim() || '（没有填写需求描述）', files.length ? `上传文件：${files.join('、')}` : ''].filter(Boolean).join('\n');
  } else if (input.nodeType === 'end') {
    const nodes = (await workflowRunSummary(workflowRunId)).filter((node) => node.key !== nodeKey);
    text = summaryText(nodes);
    await writeResult(directory, text);
  } else {
    const upstream = await upstreamText(workflowRunId, task);
    text = upstream.trim() || '上游没有文字结果。';
    await writeResult(directory, text);
  }
  const output = { text, workspacePath: directory };
  await db.update(tasks).set({ status: 'completed', outputJson: output }).where(eq(tasks.id, task.id));
  await db.update(sessions).set({ status: 'completed', outputJson: output, completedAt: new Date() }).where(eq(sessions.taskId, task.id));
  await persistAndBroadcastEvent({
    projectId: await runProjectId(workflowRunId),
    workflowRunId,
    taskId: task.id,
    type: 'node.output',
    payloadJson: { name: task.name, nodeType: input.nodeType, workspacePath: directory, preview: text.slice(0, 500) },
  });
}

async function ensureWorkflowTerminals(workflowId: number): Promise<void> {
  const rows = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).orderBy(asc(workflowNodes.id));
  const storedEdges = await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId));
  const shaped = rows.map((node) => {
    const config = jsonObject(node.configJson);
    return {
      id: node.id,
      key: typeof config.key === 'string' ? config.key : `node-${node.id}`,
      name: node.name,
      type: storedNodeType(node.nodeType === 'start' || node.nodeType === 'end' || node.nodeType === 'checkpoint' ? node.nodeType : config.type),
      x: typeof config.x === 'number' ? config.x : 48,
      y: typeof config.y === 'number' ? config.y : 40,
    };
  });
  if (shaped.some((node) => node.type === 'start') && shaped.some((node) => node.type === 'end')) return;
  const edgePairs = storedEdges.flatMap((edge) => {
    const source = shaped.find((node) => node.id === edge.sourceNodeId);
    const target = shaped.find((node) => node.id === edge.targetNodeId);
    return source && target ? [{ source: source.key, target: target.key }] : [];
  });
  const next = withTerminals(shaped, edgePairs);
  const workflow = (await db.select({ definitionJson: workflows.definitionJson }).from(workflows).where(eq(workflows.id, workflowId)))[0];
  const definition = jsonObject(workflow?.definitionJson);
  const definitionNodes = Array.isArray(definition.nodes) ? [...definition.nodes] : [];
  const known = new Set(shaped.map((node) => node.key));
  const idByKey = new Map(shaped.map((node) => [node.key, node.id]));
  for (const node of next.nodes) {
    if (known.has(node.key)) continue;
    const config = { key: node.key, name: node.name, type: node.type, x: node.x, y: node.y, capabilities: [], requirement: '', instruction: '' };
    const inserted = await db.insert(workflowNodes).values({
      workflowId,
      name: node.name,
      capability: '',
      capabilitiesJson: [],
      nodeType: node.type,
      configJson: config,
    });
    idByKey.set(node.key, inserted[0].insertId);
    definitionNodes.push(config);
  }
  for (const edge of next.edges) {
    if (edgePairs.some((item) => item.source === edge.source && item.target === edge.target)) continue;
    const sourceNodeId = idByKey.get(edge.source);
    const targetNodeId = idByKey.get(edge.target);
    if (!sourceNodeId || !targetNodeId) continue;
    await db.insert(workflowEdges).values({ workflowId, sourceNodeId, targetNodeId });
  }
  await db.update(workflows).set({ definitionJson: { ...definition, nodes: definitionNodes, edges: next.edges } }).where(eq(workflows.id, workflowId));
}

async function repeatWorkflowLoop(workflowRunId: number, checkpointId: number | null): Promise<'repeated' | 'exhausted'> {
  if (!checkpointId) throw new OrviaError('这个决策没有对应的检查点', 'validation', 400);
  const checkpoint = (await db.select().from(checkpoints).where(eq(checkpoints.id, checkpointId)))[0];
  const task = checkpoint?.taskId ? (await db.select().from(tasks).where(eq(tasks.id, checkpoint.taskId)))[0] : undefined;
  if (!task) throw new OrviaError('这个决策没有对应的任务', 'validation', 400);
  const nodeKey = String(jsonObject(task.inputJson).key ?? '');
  const owner = (await db.select({
    workflowId: workflowRuns.workflowId,
    definitionJson: workflows.definitionJson,
    inputJson: workflowRuns.inputJson,
  }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).where(eq(workflowRuns.id, workflowRunId)))[0];
  if (!owner) throw new OrviaError('Workflow run not found', 'not_found', 404);
  const loop = loopForNode(loopsFromDefinition(owner.definitionJson), nodeKey);
  if (!loop) throw new OrviaError('这个复核节点不在循环里', 'validation', 400);
  const input = jsonObject(owner.inputJson);
  const counts = { ...jsonObject(input.loopIterations) };
  const current = Number(counts[loop.key] ?? 1);
  if (current >= loop.maxIterations) return 'exhausted';
  counts[loop.key] = current + 1;
  await db.update(workflowRuns).set({
    inputJson: { ...input, loopIterations: counts },
    status: 'running',
    completedAt: null,
    errorJson: null,
  }).where(eq(workflowRuns.id, workflowRunId));
  await rememberRunStatus(workflowRunId, 'running', owner.workflowId);
  const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  const live = runTasks.filter((item) => item.status !== 'cancelled');
  const byNode = new Map(live.map((item) => [item.workflowNodeId, item]));
  for (const item of live) {
    const key = String(jsonObject(item.inputJson).key ?? '');
    if (!loop.nodeKeys.includes(key)) continue;
    const ready = dependsOnNodeIds(item.inputJson).every((nodeId) => {
      const dependency = byNode.get(nodeId);
      if (!dependency) return false;
      const dependencyKey = String(jsonObject(dependency.inputJson).key ?? '');
      if (loop.nodeKeys.includes(dependencyKey)) return false;
      return dependency.status === 'completed';
    });
    await db.update(tasks).set({ status: ready ? 'pending' : 'blocked', errorKind: null, outputJson: null }).where(eq(tasks.id, item.id));
    await db.update(sessions).set({ status: 'pending', outputJson: null, completedAt: null, startedAt: null }).where(eq(sessions.taskId, item.id));
  }
  return 'repeated';
}

function acceptanceCounts(input: Record<string, unknown>): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const [checker, value] of Object.entries(jsonObject(input.acceptanceRedos))) {
    const row: Record<string, number> = {};
    for (const [provider, count] of Object.entries(jsonObject(value))) {
      const next = Number(count);
      if (Number.isInteger(next) && next > 0) row[provider] = next;
    }
    counts[checker] = row;
  }
  return counts;
}

function acceptanceHistoryEntries(input: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = input.acceptanceHistory;
  return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

async function saveAcceptanceResult(
  task: typeof tasks.$inferSelect,
  verdict: 'pass' | 'reject' | 'unclear',
  checked: string[],
  rule: string,
  body: string,
): Promise<void> {
  const label = verdict === 'pass' ? '合格' : verdict === 'reject' ? '不合格' : '待确认';
  const detail = [
    checked.length ? `检查了：${checked.join('、')}` : '',
    rule ? `规则：\n${rule}` : '',
    `判断：\n${body.trim() || (verdict === 'pass' ? '上游内容符合校验规则。' : '没有写出具体原因。')}`,
  ].filter(Boolean).join('\n\n');
  const entry = { verdict, label, detail, at: new Date().toISOString() };
  const current = jsonObject(task.inputJson);
  const input = {
    ...current,
    acceptanceResult: entry,
    acceptanceHistory: [...acceptanceHistoryEntries(current), entry],
  };
  task.inputJson = input;
  await db.update(tasks).set({ inputJson: input }).where(eq(tasks.id, task.id));
}

async function sendAcceptanceBack(
  projectId: number,
  workflowId: number,
  workflowRunId: number,
  checker: typeof tasks.$inferSelect,
  items: Array<{ taskId: number; key: string; name: string; nodeType: string; reason: string }>,
): Promise<void> {
  const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
  const input = await runInput(workflowRunId);
  const counts = acceptanceCounts(input);
  const checkerKey = recordKey(checker.inputJson) || `task-${checker.id}`;
  const checkerCounts = { ...(counts[checkerKey] ?? {}) };
  for (const item of items) {
    const provider = runTasks.find((task) => task.id === item.taskId);
    if (!provider) continue;
    const redos = (checkerCounts[item.key] ?? 0) + 1;
    checkerCounts[item.key] = redos;
    const providerInput = jsonObject(provider.inputJson);
    const node = nodes.find((entry) => recordKey(entry.configJson) === item.key);
    const nextInput: Record<string, unknown> = {
      ...providerInput,
      ...(node ? withoutLegacySkill(jsonObject(node.configJson)) : {}),
      dependsOnNodeIds: providerInput.dependsOnNodeIds,
      workflowNodeId: provider.workflowNodeId,
      nodeType: providerInput.nodeType ?? item.nodeType,
      redoReason: item.reason,
      redoRound: redos + 1,
    };
    delete nextInput.workspacePath;
    delete nextInput.prompt;
    delete nextInput.acceptanceWaived;
    await db.update(tasks).set({ status: 'pending', outputJson: null, errorKind: null, inputJson: nextInput }).where(eq(tasks.id, provider.id));
    const latest = (await db.select().from(sessions).where(eq(sessions.taskId, provider.id)).orderBy(desc(sessions.id)).limit(1))[0];
    if (latest) await db.update(sessions).set({ status: 'pending', inputJson: nextInput, outputJson: null, completedAt: null, startedAt: null }).where(eq(sessions.id, latest.id));
    else await db.insert(sessions).values({ taskId: provider.id, runtime: 'pi', status: 'pending', inputJson: nextInput });
  }
  counts[checkerKey] = checkerCounts;
  const checkerInput = { ...jsonObject(checker.inputJson) };
  delete checkerInput.acceptanceWaived;
  delete checkerInput.acceptanceResult;
  delete checkerInput.workspacePath;
  delete checkerInput.prompt;
  await db.update(tasks).set({ status: 'pending', inputJson: checkerInput }).where(eq(tasks.id, checker.id));
  await db.update(workflowRuns).set({ inputJson: { ...input, acceptanceRedos: counts } }).where(eq(workflowRuns.id, workflowRunId));
  await persistAndBroadcastEvent({
    projectId,
    workflowRunId,
    taskId: checker.id,
    type: 'acceptance.returned',
    payloadJson: {
      message: `「${checker.name}」判定不合格，已退回给${items.map((item) => item.name).join('、')}。${items.map((item) => `${item.name}：${item.reason}`).join(' ')}`,
      returns: items.map((item) => ({ key: item.key, name: item.name, reason: item.reason })),
    },
  });
}

async function pauseAcceptance(
  projectId: number,
  workflowRunId: number,
  checker: typeof tasks.$inferSelect,
  cause: 'limit' | 'start' | 'unclear',
  items: Array<{ taskId: number; key: string; name: string; nodeType: string; reason: string }>,
  text: string,
): Promise<void> {
  const reason = items.length ? items.map((item) => `${item.name}：${item.reason}`).join('\n') : text.trim();
  const names = items.map((item) => item.name).join('、') || '上游';
  const question = cause === 'limit'
    ? `「${checker.name}」已经把「${names}」退回多次，仍不合格。可以再做一次，或批准继续。\n${reason}`
    : cause === 'start'
      ? `「${checker.name}」判定「${names}」的内容不合格。请先修改内容，再点再做一次；也可以批准继续。\n${reason}`
      : `「${checker.name}」没有给出明确的合格或不合格。请批准继续，或再做一次。\n${text.trim()}`;
  await db.insert(decisions).values({
    projectId,
    workflowRunId,
    question,
    contextJson: { kind: 'acceptance', checkerTaskId: checker.id, checkerKey: recordKey(checker.inputJson), targets: items, cause },
  });
  await db.update(tasks).set({ status: 'awaiting_decision' }).where(eq(tasks.id, checker.id));
  await db.update(workflowRuns).set({ status: 'awaiting_decision' }).where(eq(workflowRuns.id, workflowRunId));
  await rememberRunStatus(workflowRunId, 'awaiting_decision');
  await persistAndBroadcastEvent({ projectId, workflowRunId, taskId: checker.id, type: 'acceptance.pending', payloadJson: { message: question } });
}

async function waiveAcceptance(checkerTaskId: number, note = ''): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, checkerTaskId)))[0];
  if (!task) return;
  const current = jsonObject(task.inputJson);
  const previous = jsonObject(current.acceptanceResult);
  const detail = [
    typeof previous.detail === 'string' && previous.detail.trim() ? previous.detail.trim() : '',
    note.trim() ? `人工批准：\n${note.trim()}` : '人工批准：已同意继续。',
  ].filter(Boolean).join('\n\n');
  const entry = { verdict: 'pass' as const, label: '合格', detail, at: new Date().toISOString() };
  const input = {
    ...current,
    acceptanceWaived: true,
    acceptanceResult: entry,
    acceptanceHistory: [...acceptanceHistoryEntries(current), entry],
  };
  await db.update(tasks).set({ status: 'pending', inputJson: input }).where(eq(tasks.id, task.id));
}

async function reviewAcceptance(projectId: number, workflowId: number, workflowRunId: number, task: typeof tasks.$inferSelect) {
  const input = jsonObject(task.inputJson);
  const rules = acceptanceRuleLines(input.acceptanceRules ?? input.acceptanceRule);
  if (rules.length === 0 || input.acceptanceWaived === true) return null;
  const rule = rules.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
  const depends = dependsOnNodeIds(input);
  const providers = runTasks.flatMap((item) => {
    if (!item.workflowNodeId || !depends.includes(item.workflowNodeId) || item.status !== 'completed') return [];
    const providerInput = jsonObject(item.inputJson);
    const nodeType = typeof providerInput.nodeType === 'string' ? providerInput.nodeType : 'task';
    if (nodeType === 'end') return [];
    return [{ task: item, party: { key: recordKey(providerInput) || `task-${item.id}`, name: item.name, nodeType } satisfies AcceptanceParty }];
  });
  if (providers.length === 0) return null;
  await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, task.id));
  await persistAndBroadcastEvent({
    projectId,
    workflowRunId,
    taskId: task.id,
    type: 'acceptance.checking',
    payloadJson: { message: `「${task.name}」正在按校验规则检查${providers.map((item) => item.party.name).join('、')}` },
  });
  const sections: string[] = [];
  for (const item of providers) {
    const output = jsonObject(item.task.outputJson);
    const text = typeof output.text === 'string' ? output.text : '';
    const directory = typeof output.workspacePath === 'string' ? output.workspacePath : '';
    const files = directory && isManagedWorkspace(directory) ? await readDeliverableText(directory) : '';
    sections.push([
      `### ${item.party.name}`,
      `标识：${item.party.key}`,
      `类型：${item.party.nodeType === 'start' ? '开始' : 'Agent'}`,
      '交接说明：',
      text || '（没有文字结果）',
      files ? `文件原文：\n${files}` : '文件原文：（没有读到产出文件）',
    ].join('\n'));
  }
  const upstream = sections.join('\n\n');
  const prompt = [
    '你负责验收直接交给你的内容，不要修改文件。',
    '只根据文件原文判断。交接说明是摘要，摘要里提到的章节如果原文里没有，就算不合格。',
    `校验条件：下面每一条都表示不合格。满足任意一条，就判定不合格，并在原因里写明命中了第几条。\n${rule}`,
    `内容：\n${upstream}`,
    '只按下面格式回复。第一行必须是单独的「合格」或「不合格」。',
    '全部合格时写：',
    '合格',
    '依据：对照规则和文件原文，说明为什么合格',
    '合格时不要写出「不合格」这个词。',
    '有不合格时写：',
    '不合格',
    '退回：节点名称',
    '原因：命中了第几条，以及原文哪里不符合',
    '几份内容不合格就写几组退回和原因。节点名称必须和上面「###」标题完全一致。',
    `可退回的节点名称：${providers.map((item) => item.party.name).join('、')}`,
  ].join('\n');
  const root = await managedWorkflowRoot(workflowId);
  await ensureDirectory(root);
  const created = await db.insert(sessions).values({ taskId: task.id, runtime: 'pi', status: 'pending', inputJson: { acceptance: true } });
  const sessionId = created[0].insertId;
  const active = activeWorkflowSessions.get(workflowRunId) ?? new Set<number>();
  active.add(sessionId);
  activeWorkflowSessions.set(workflowRunId, active);
  const output: string[] = [];
  try {
    await piRuntime.start({
      sessionId,
      taskId: task.id,
      prompt,
      systemPrompt: '你只按不合格条件给出合格或不合格。满足任意一条就不合格。不要改文件，不要输出改写后的正文。',
      workingDirectory: root,
      allowedTools: [],
      onEvent: (event) => {
        if (event.type === 'stdout' && typeof event.payload === 'string') output.push(event.payload);
      },
    });
    const completed = await piRuntime.wait(sessionId);
    active.delete(sessionId);
    if ((await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0]?.status === 'cancelled') {
      await db.update(sessions).set({ status: 'failed', completedAt: new Date() }).where(eq(sessions.id, sessionId));
      return { status: 'cancelled' as const, taskId: task.id, output: completed };
    }
    const text = output.join('').trim();
    if (completed.status !== 'completed') {
      await db.update(sessions).set({ status: 'failed', outputJson: { text }, completedAt: new Date() }).where(eq(sessions.id, sessionId));
      await saveAcceptanceResult(task, 'unclear', providers.map((item) => item.party.name), rule, text || completed.message || '验收没有完成');
      await pauseAcceptance(projectId, workflowRunId, task, 'unclear', [], text || completed.message || '验收没有完成');
      return { status: 'awaiting' as const, taskId: task.id };
    }
    await db.update(sessions).set({ status: 'completed', outputJson: { text }, completedAt: new Date() }).where(eq(sessions.id, sessionId));
    const verdict = parseAcceptanceVerdict(text, providers.map((item) => item.party));
    const checked = providers.map((item) => item.party.name);
    if (verdict.kind === 'pass') {
      await saveAcceptanceResult(task, 'pass', checked, rule, text);
      await persistAndBroadcastEvent({ projectId, workflowRunId, taskId: task.id, type: 'acceptance.passed', payloadJson: { message: `「${task.name}」判定上游合格。验收回复：${text.slice(0, 200)}` } });
      return null;
    }
    if (verdict.kind === 'unclear') {
      await saveAcceptanceResult(task, 'unclear', checked, rule, text);
      await pauseAcceptance(projectId, workflowRunId, task, 'unclear', [], text);
      return { status: 'awaiting' as const, taskId: task.id };
    }
    const items = verdict.items.flatMap((item) => {
      const provider = providers.find((entry) => entry.party.key === item.party.key);
      return provider ? [{ taskId: provider.task.id, key: item.party.key, name: item.party.name, nodeType: item.party.nodeType, reason: item.reason }] : [];
    });
    const reasonText = items.map((item) => `${item.name}：${item.reason}`).join('\n') || text;
    if (items.some((item) => item.nodeType !== 'task')) {
      await saveAcceptanceResult(task, 'reject', checked, rule, `${reasonText}\n\n内容来自开始节点，已停下来等你处理。`);
      await pauseAcceptance(projectId, workflowRunId, task, 'start', items, text);
      return { status: 'awaiting' as const, taskId: task.id };
    }
    const checkerKey = recordKey(input) || `task-${task.id}`;
    const used = acceptanceCounts(await runInput(workflowRunId))[checkerKey] ?? {};
    // 以节点当前配置为准，避免复用旧 task 时仍按默认 3 次退回
    let configuredMaxRedos = input.maxRedos;
    if (task.workflowNodeId) {
      const node = (await db.select({ configJson: workflowNodes.configJson }).from(workflowNodes).where(eq(workflowNodes.id, task.workflowNodeId)).limit(1))[0];
      const fromNode = jsonObject(node?.configJson).maxRedos;
      if (fromNode !== undefined) configuredMaxRedos = fromNode;
    }
    const limit = acceptanceLimit(configuredMaxRedos);
    if (items.some((item) => (used[item.key] ?? 0) >= limit)) {
      await saveAcceptanceResult(task, 'reject', checked, rule, `${reasonText}\n\n已达到最多退回次数（${limit}），已停下来等你处理。`);
      await pauseAcceptance(projectId, workflowRunId, task, 'limit', items, text);
      return { status: 'awaiting' as const, taskId: task.id };
    }
    await saveAcceptanceResult(task, 'reject', checked, rule, reasonText);
    await sendAcceptanceBack(projectId, workflowId, workflowRunId, task, items);
    return { status: 'returned' as const, taskId: task.id };
  } catch (error) {
    active.delete(sessionId);
    const message = error instanceof Error ? error.message : '验收失败';
    await db.update(sessions).set({ status: 'failed', outputJson: { error: message }, completedAt: new Date() }).where(eq(sessions.id, sessionId));
    await saveAcceptanceResult(task, 'unclear', providers.map((item) => item.party.name), rule, message);
    await pauseAcceptance(projectId, workflowRunId, task, 'unclear', [], message);
    return { status: 'awaiting' as const, taskId: task.id };
  }
}

async function runWorkflowAgent(projectId: number, workflowId: number, workflowRunId: number, task: typeof tasks.$inferSelect) {
  const reviewed = await reviewAcceptance(projectId, workflowId, workflowRunId, task);
  if (reviewed) return reviewed;
  await prepareTaskWorkspace(workflowId, workflowRunId, task);
  return executeAgentTask(projectId, workflowRunId, task);
}

async function executeWorkflowRun(workflowRunId: number, mode?: 'restart' | 'resume') {
  const runRows = await db
    .select({ projectId: workflows.projectId, workflowId: workflows.id, status: workflowRuns.status })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, workflowRunId));
  const run = runRows[0];
  if (!run) throw new Error('Workflow run not found');
  if (run.status === 'running') return { status: 'running' as const, completedTaskIds: [] };
  await db.update(workflowRuns).set({ status: 'running', startedAt: new Date(), errorJson: null, completedAt: null }).where(eq(workflowRuns.id, workflowRunId));
  await rememberRunStatus(workflowRunId, 'running', run.workflowId);
  await prepareWorkflowRunForExecution(workflowRunId, run.workflowId, run.status, mode);
  const freshExecution = mode === 'restart' || (mode !== 'resume' && (run.status === 'cancelled' || run.status === 'failed' || run.status === 'completed'));
  await ensureRunExecution(workflowRunId, run.workflowId, freshExecution);

  const completedTaskIds: number[] = (await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.workflowRunId, workflowRunId)))
    .filter((task) => task.status === 'completed')
    .map((task) => task.id);
  while (true) {
    const currentRun = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
    if (!currentRun || currentRun.status === 'paused' || currentRun.status === 'awaiting_decision' || currentRun.status === 'cancelled') {
      return { status: currentRun?.status ?? 'failed', completedTaskIds };
    }

    const activePlan = (await db.select({ id: plans.id }).from(plans)
      .where(and(eq(plans.workflowRunId, workflowRunId), eq(plans.status, 'active')))
      .orderBy(desc(plans.version))
      .limit(1))[0];
    // Only the active plan's tasks participate in resume/restart scheduling — ignore cancelled copies from earlier plans
    const runTasks = activePlan
      ? await db.select().from(tasks).where(and(eq(tasks.workflowRunId, workflowRunId), eq(tasks.planId, activePlan.id))).orderBy(asc(tasks.id))
      : await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId)).orderBy(asc(tasks.id));
    if (graphIsComplete(runTasks)) {
      await db.update(plans).set({ status: 'completed' }).where(and(eq(plans.workflowRunId, workflowRunId), eq(plans.status, 'active')));
      if (!(await finishRunIfStillRunning(workflowRunId, run.workflowId, 'completed', { completedAt: new Date() }))) {
        return { status: 'cancelled' as const, completedTaskIds };
      }
      await persistAndBroadcastEvent({ projectId: run.projectId, workflowRunId, type: 'workflow.completed', payloadJson: { completedTaskIds } });
      return { status: 'completed', completedTaskIds };
    }

    const ready = selectRunnableTasks(runTasks);
    const structural = ready.find((candidate) => {
      const kind = jsonObject(candidate.inputJson).nodeType;
      return kind === 'start' || kind === 'end';
    });
    if (structural) {
      await completeBoundaryNode(run.workflowId, workflowRunId, structural);
      completedTaskIds.push(structural.id);
      continue;
    }
    const task = ready.find((candidate) => jsonObject(candidate.inputJson).nodeType === 'checkpoint') ?? ready[0];
    const parallelTasks = ready.filter((candidate) => jsonObject(candidate.inputJson).nodeType !== 'checkpoint');
    const checkpointReady = ready.some((candidate) => jsonObject(candidate.inputJson).nodeType === 'checkpoint');
    if (parallelTasks.length > 1 || (parallelTasks.length === 1 && checkpointReady)) {
      const outcomes = await Promise.all(parallelTasks.map((candidate) => runWorkflowAgent(run.projectId, run.workflowId, workflowRunId, candidate)));
      const latestRun = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
      if (!latestRun || latestRun.status === 'paused' || latestRun.status === 'awaiting_decision' || latestRun.status === 'cancelled') {
        return { status: latestRun?.status ?? 'failed', completedTaskIds };
      }
      let failed: { taskId: number; output: unknown } | undefined;
      for (const outcome of outcomes) {
        if (outcome.status === 'completed') completedTaskIds.push(outcome.taskId);
        if (outcome.status === 'awaiting') return { status: 'awaiting_decision' as const, completedTaskIds };
        if (outcome.status === 'failed') failed = { taskId: outcome.taskId, output: outcome.output };
      }
      if (failed) {
        if (!(await finishRunIfStillRunning(workflowRunId, run.workflowId, 'failed', { errorJson: failed.output, completedAt: new Date() }))) {
          return { status: 'cancelled' as const, completedTaskIds };
        }
        return { status: 'failed', completedTaskIds, failedTaskId: failed.taskId };
      }
      continue;
    }
    if (!task) {
      const failed = runTasks.find((candidate) => candidate.status === 'failed');
      const error = failed
        ? { error: `Task ${failed.id} failed`, failedTaskId: failed.id }
        : { error: 'Task graph is blocked by unsatisfied dependencies' };
      if (!(await finishRunIfStillRunning(workflowRunId, run.workflowId, 'failed', { errorJson: error, completedAt: new Date() }))) {
        return { status: 'cancelled' as const, completedTaskIds };
      }
      return { status: 'failed', completedTaskIds, ...error };
    }

    const input = jsonObject(task.inputJson);
    if (input.nodeType === 'checkpoint') {
      const existing = (await db.select().from(checkpoints)
        .where(and(eq(checkpoints.workflowRunId, workflowRunId), eq(checkpoints.taskId, task.id)))
        .orderBy(desc(checkpoints.id)).limit(1))[0];
      if (existing?.status === 'approved' || existing?.status === 'overridden') {
        await db.update(tasks).set({ status: 'completed', outputJson: { checkpointId: existing.id, status: existing.status } }).where(eq(tasks.id, task.id));
        completedTaskIds.push(task.id);
        continue;
      }
      if (!existing || existing.status === 'superseded' || existing.status === 'changes_requested' || existing.status === 'rejected') {
        const workflow = (await db.select({ definitionJson: workflows.definitionJson }).from(workflows).where(eq(workflows.id, run.workflowId)))[0];
        const loop = loopForNode(loopsFromDefinition(workflow?.definitionJson), typeof input.key === 'string' ? input.key : '');
        const loopIterationCount = loop ? await loopIteration(workflowRunId, run.workflowId, typeof input.key === 'string' ? input.key : '') : undefined;
        const checkpointContext = {
          ...input,
          ...(loop ? { loopKey: loop.key, loopIteration: loopIterationCount, maxIterations: loop.maxIterations } : {}),
        };
        const guidance = typeof input.key === 'string' ? await nodeGuidanceText(run.workflowId, input.key) : '';
        const checkpointInstructions = [
          typeof input.outputRequirement === 'string' && input.outputRequirement.trim()
            ? input.outputRequirement.trim()
            : typeof input.instructions === 'string' ? input.instructions.trim() : '',
          guidance.trim() ? `人工指导：\n${guidance.trim()}` : '',
        ].filter(Boolean).join('\n\n');
        const checkpointId = await db.transaction(async (tx) => {
          const checkpointResult = await tx.insert(checkpoints).values({
            projectId: run.projectId,
            workflowRunId,
            taskId: task.id,
            workflowNodeId: task.workflowNodeId,
            title: typeof input.title === 'string' ? input.title : task.name,
            instructions: checkpointInstructions || undefined,
            contextJson: checkpointContext,
          });
          const createdCheckpointId = checkpointResult[0].insertId;
          await tx.insert(decisions).values({
            projectId: run.projectId,
            workflowRunId,
            checkpointId: createdCheckpointId,
            question: typeof input.question === 'string' ? input.question : `Approve checkpoint: ${task.name}?`,
            contextJson: checkpointContext,
          });
          await tx.update(tasks).set({ status: 'awaiting_decision' }).where(eq(tasks.id, task.id));
          await tx.update(workflowRuns).set({ status: 'awaiting_decision' }).where(eq(workflowRuns.id, workflowRunId));
          return createdCheckpointId;
        });
        await rememberRunStatus(workflowRunId, 'awaiting_decision', run.workflowId);
        await persistAndBroadcastEvent({ projectId: run.projectId, workflowRunId, taskId: task.id, type: 'checkpoint.pending', payloadJson: { checkpointId } });
        return { status: 'awaiting_decision', completedTaskIds, checkpointTaskId: task.id };
      }
      await db.transaction(async (tx) => {
        await tx.update(tasks).set({ status: 'awaiting_decision' }).where(eq(tasks.id, task.id));
        await tx.update(workflowRuns).set({ status: 'awaiting_decision' }).where(eq(workflowRuns.id, workflowRunId));
      });
      await rememberRunStatus(workflowRunId, 'awaiting_decision', run.workflowId);
      return { status: 'awaiting_decision', completedTaskIds, checkpointTaskId: task.id };
    }

    const single = await runWorkflowAgent(run.projectId, run.workflowId, workflowRunId, task);
    if (single.status === 'awaiting') return { status: 'awaiting_decision' as const, completedTaskIds };
    if (single.status === 'returned' || single.status === 'retry') continue;
    const latestRun = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
    if (!latestRun || latestRun.status === 'paused' || latestRun.status === 'awaiting_decision' || latestRun.status === 'cancelled') {
      return { status: latestRun?.status ?? 'failed', completedTaskIds };
    }
    if (single.status === 'completed') completedTaskIds.push(task.id);
    if (single.status === 'failed') {
      if (!(await finishRunIfStillRunning(workflowRunId, run.workflowId, 'failed', { errorJson: single.output, completedAt: new Date() }))) {
        return { status: 'cancelled' as const, completedTaskIds };
      }
      return { status: 'failed', completedTaskIds, failedTaskId: task.id };
    }
    continue;
  }
}

async function executeAgentTask(projectId: number, workflowRunId: number, task: typeof tasks.$inferSelect) {
  const input = jsonObject(task.inputJson);
  const taskSessions = await db.select().from(sessions).where(eq(sessions.taskId, task.id)).orderBy(desc(sessions.id));
  const session = taskSessions.find((item) => item.status === 'pending') ?? taskSessions[0];
  if (!session) return { status: 'failed' as const, taskId: task.id, output: { error: `Task ${task.id} has no session` } };
  const sessionInput = { ...input, ...jsonObject(session.inputJson) };
  const explicitAgentId = task.agentId ?? session.agentId ?? undefined;
  let agentId: number | undefined;
  let runtimePolicy;
  let resolvedPrompt: string | undefined;
  try {
    if (explicitAgentId) {
      const matched = await resolveAgentModel({
        projectId,
        workflowRunId,
        agentId: explicitAgentId,
        ...(Array.isArray(sessionInput.capabilities)
          ? { capabilities: sessionInput.capabilities.filter((item): item is string => typeof item === 'string') }
          : {
              capability: normalizedText(sessionInput.capability),
              skill: normalizedText(sessionInput.skill),
            }),
      });
      agentId = matched.agent.id;
      runtimePolicy = matched.runtimePolicy;
      resolvedPrompt = matched.systemPrompt ?? undefined;
    } else {
      const capabilities = Array.isArray(sessionInput.capabilities)
        ? sessionInput.capabilities.filter((item): item is string => typeof item === 'string')
        : [normalizedText(sessionInput.capability), normalizedText(sessionInput.skill)].filter((item): item is string => Boolean(item));
      const nodeRuntime = await resolveWorkflowNode({ projectId, workflowRunId, name: task.name, capabilities });
      runtimePolicy = nodeRuntime.runtimePolicy;
      resolvedPrompt = nodeRuntime.systemPrompt;
    }
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : '节点执行准备失败' };
    await db.update(tasks).set({ status: 'failed', errorKind: 'human_required', outputJson: payload }).where(eq(tasks.id, task.id));
    await db.update(sessions).set({ status: 'failed', outputJson: payload, completedAt: new Date() }).where(eq(sessions.id, session.id));
    return { status: 'failed' as const, taskId: task.id, output: payload };
  }
  const prompt = typeof sessionInput.prompt === 'string' ? sessionInput.prompt : `Execute Orvia task: ${task.name}`;
  const systemPrompt = typeof sessionInput.systemPrompt === 'string' ? sessionInput.systemPrompt : resolvedPrompt;
  let workingDirectory: string;
  try {
    const managed = typeof sessionInput.workspacePath === 'string' ? sessionInput.workspacePath : undefined;
    workingDirectory = managed && isManagedWorkspace(managed)
      ? managed
      : assertWorkingDirectoryAllowed(
        typeof sessionInput.workingDirectory === 'string' ? sessionInput.workingDirectory : managed,
        runtimePolicy,
      );
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : '工作目录不可用' };
    await db.update(tasks).set({ status: 'failed', errorKind: 'human_required', outputJson: payload }).where(eq(tasks.id, task.id));
    await db.update(sessions).set({ status: 'failed', outputJson: payload, completedAt: new Date() }).where(eq(sessions.id, session.id));
    return { status: 'failed' as const, taskId: task.id, output: payload };
  }
  const output: string[] = [];
  await db.update(tasks).set({ agentId, status: 'running' }).where(eq(tasks.id, task.id));
  await db.update(sessions).set({ agentId, status: 'running', startedAt: new Date() }).where(eq(sessions.id, session.id));
  const active = activeWorkflowSessions.get(workflowRunId) ?? new Set<number>();
  active.add(session.id);
  activeWorkflowSessions.set(workflowRunId, active);
  await piRuntime.start({
    sessionId: session.id,
    taskId: task.id,
    prompt,
    systemPrompt,
    workingDirectory,
    allowedTools: runtimePolicy.allowedTools,
    deniedTools: runtimePolicy.deniedTools,
    command: typeof sessionInput.command === 'string' ? sessionInput.command : undefined,
    onEvent: (runtimeEvent) => {
      if (runtimeEvent.type === 'stdout' && typeof runtimeEvent.payload === 'string') output.push(runtimeEvent.payload);
      void emitRuntimeEvent(
        { projectId, workflowRunId, taskId: task.id, sessionId: session.id, agentId },
        runtimeEvent.type,
        runtimeEvent.payload,
      );
    },
  });
  const completed = await piRuntime.wait(session.id);
  active.delete(session.id);
  if ((await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0]?.status === 'cancelled') {
    return { status: 'cancelled' as const, taskId: task.id, output: completed };
  }
  if (completed.status !== 'completed') {
    const canRetry = task.retryCount < task.maxRetries;
    const retrySessionId = await db.transaction(async (tx) => {
      await tx.update(tasks).set({
        status: canRetry ? 'pending' : 'failed',
        retryCount: task.retryCount + 1,
        errorKind: canRetry ? 'retryable' : 'human_required',
        outputJson: completed,
      }).where(eq(tasks.id, task.id));
      await tx.update(sessions).set({ status: 'failed', outputJson: completed, completedAt: new Date() }).where(eq(sessions.id, session.id));
      if (!canRetry) return undefined;
      const retrySession = await tx.insert(sessions).values({ taskId: task.id, agentId, runtime: session.runtime, status: 'pending', inputJson: session.inputJson });
      return retrySession[0].insertId;
    });
    if (retrySessionId) {
      await persistAndBroadcastEvent({ projectId, workflowRunId, taskId: task.id, sessionId: retrySessionId, agentId, type: 'task.retry_scheduled', payloadJson: { attempt: task.retryCount + 1 } });
      return { status: 'retry' as const, taskId: task.id, output: completed };
    }
    return { status: 'failed' as const, taskId: task.id, output: completed };
  }
  const text = output.join('');
  if (typeof sessionInput.workspacePath === 'string' && isManagedWorkspace(sessionInput.workspacePath)) {
    await writeResult(sessionInput.workspacePath, text);
  }
  await db.transaction(async (tx) => {
    await tx.update(tasks).set({ status: 'completed', outputJson: { ...completed, text, workspacePath: sessionInput.workspacePath } }).where(eq(tasks.id, task.id));
    await tx.update(sessions).set({ status: 'completed', outputJson: { ...completed, text, workspacePath: sessionInput.workspacePath }, completedAt: new Date() }).where(eq(sessions.id, session.id));
  });
  await persistAndBroadcastEvent({ projectId, workflowRunId, taskId: task.id, sessionId: session.id, agentId, type: 'task.completed', payloadJson: { workspacePath: sessionInput.workspacePath } });
  return { status: 'completed' as const, taskId: task.id, output: completed };
}

async function replanWorkflowRun(workflowRunId: number, reason: string, definitionJson?: Record<string, unknown>) {
  const run = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
  if (!run) throw new Error('Workflow run not found');
  await db.update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, workflowRunId));
  await stopActiveWorkflowSessions(workflowRunId);
  const definitionNodes = Array.isArray(definitionJson?.nodes) ? definitionJson.nodes : [];
  const definitionEdges = Array.isArray(definitionJson?.edges) ? definitionJson.edges : [];
  const nodeKeys = definitionNodes.map((node, index) => requiredString(jsonObject(node), 'key') ?? String(index));
  let nodeCapabilityLists: string[][] = [];
  if (definitionNodes.length > 0) {
    try {
      assertAcyclicGraph(nodeKeys, definitionEdges.map((edge) => ({
        source: String(jsonObject(edge).source),
        target: String(jsonObject(edge).target),
      })));
    } catch (error) {
      throw new OrviaError(error instanceof Error ? error.message : 'Invalid replan graph', 'validation', 400);
    }
    const workflow = (await db.select().from(workflows).where(eq(workflows.id, run.workflowId)))[0];
    if (!workflow) throw new OrviaError('Workflow not found', 'not_found', 404);
    nodeCapabilityLists = definitionNodes.map((node) => nodeCapabilityList(jsonObject(node)));
    await assertProjectCatalogKeys(workflow.projectId, nodeCapabilityLists.flat());
  }
  const replanned = await db.transaction(async (tx) => {
    const oldPlans = await tx.select().from(plans).where(eq(plans.workflowRunId, workflowRunId)).orderBy(desc(plans.version));
    const version = (oldPlans[0]?.version ?? run.currentPlanVersion) + 1;
    await tx.update(plans).set({ status: 'superseded' }).where(and(eq(plans.workflowRunId, workflowRunId), eq(plans.status, 'active')));
    const previousGraph = jsonObject(oldPlans[0]?.graphJson);
    const graphJson = definitionNodes.length > 0 ? { nodes: definitionNodes, edges: definitionEdges } : previousGraph;
    const newPlan = await tx.insert(plans).values({ workflowRunId, version, reason, graphJson });
    const planId = newPlan[0].insertId;
    const openStatuses = ['pending', 'blocked', 'paused', 'awaiting_decision', 'failed', 'running'] as const;
    if (definitionNodes.length > 0) {
      await tx.update(tasks).set({ status: 'cancelled', errorKind: null }).where(and(eq(tasks.workflowRunId, workflowRunId), inArray(tasks.status, [...openStatuses])));
      const created = new Map<string, number>();
      for (const [index, node] of definitionNodes.entries()) {
        const item = jsonObject(node);
        const nodeType = storedNodeType(item.type);
        const capabilities = nodeCapabilityLists[index] ?? nodeCapabilityList(item);
        const taskResult = await tx.insert(tasks).values({
          workflowRunId,
          planId,
          name: requiredString(item, 'name') ?? `Node ${index + 1}`,
          status: 'blocked',
          maxRetries: typeof item.maxRetries === 'number' ? item.maxRetries : 0,
          inputJson: { ...withoutLegacySkill(item), capabilities, capability: capabilities[0], nodeType, dependsOnTaskIds: [] },
        });
        const taskId = taskResult[0].insertId;
        created.set(nodeKeys[index] ?? String(index), taskId);
        await tx.insert(sessions).values({ taskId, runtime: 'pi', status: 'pending', inputJson: { ...withoutLegacySkill(item), capabilities, capability: capabilities[0], nodeType } });
      }
      for (const [index, node] of definitionNodes.entries()) {
        const key = nodeKeys[index] ?? String(index);
        const taskId = created.get(key);
        if (!taskId) continue;
        const dependencyIds = definitionEdges
          .map((edge) => jsonObject(edge))
          .filter((edge) => String(edge.target) === key)
          .map((edge) => created.get(String(edge.source)))
          .filter((id): id is number => typeof id === 'number');
        const item = jsonObject(node);
        const capabilities = nodeCapabilityLists[index] ?? nodeCapabilityList(item);
        await tx.update(tasks).set({
          status: dependencyIds.length > 0 ? 'blocked' : 'pending',
          inputJson: { ...withoutLegacySkill(item), capabilities, capability: capabilities[0], nodeType: storedNodeType(item.type), dependsOnTaskIds: dependencyIds },
        }).where(eq(tasks.id, taskId));
      }
    } else {
      await tx.update(tasks).set({ planId, status: 'pending', errorKind: null })
        .where(and(eq(tasks.workflowRunId, workflowRunId), inArray(tasks.status, [...openStatuses])));
    }
    await tx.update(checkpoints).set({ status: 'superseded', resolvedAt: new Date() })
      .where(and(eq(checkpoints.workflowRunId, workflowRunId), eq(checkpoints.status, 'pending')));
    await tx.update(decisions).set({ status: 'superseded', resolvedAt: new Date() })
      .where(and(eq(decisions.workflowRunId, workflowRunId), eq(decisions.status, 'pending')));
    await tx.update(workflowRuns).set({ status: 'paused', currentPlanVersion: version, completedAt: null, errorJson: null }).where(eq(workflowRuns.id, workflowRunId));
    return { planId, version };
  });
  const { planId, version } = replanned;
  await rememberRunStatus(workflowRunId, 'paused', run.workflowId);
  await persistAndBroadcastEvent({ projectId: (await runProjectId(workflowRunId)), workflowRunId, type: 'workflow.replanned', payloadJson: { reason, planId, version, replacedGraph: definitionNodes.length > 0 } });
  return { workflowRunId, status: 'paused' as const, planId, version, reason };
}

async function runProjectId(workflowRunId: number): Promise<number> {
  const row = (await db.select({ projectId: workflows.projectId }).from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, workflowRunId)))[0];
  if (!row) throw new Error('Workflow run not found');
  return row.projectId;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > config.maxBodyBytes) throw new OrviaError('Request body exceeds 1MB', 'validation', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OrviaError('Request body must contain valid JSON', 'validation', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrviaError('Request body must be a JSON object', 'validation', 400);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function storedNodeType(type: unknown): 'task' | 'checkpoint' | 'start' | 'end' {
  if (type === 'checkpoint' || type === 'start' || type === 'end') return type;
  return 'task';
}

function nodeCapabilityList(item: Record<string, unknown>, requireCapabilities = true): string[] {
  if (item.type === 'start' || item.type === 'end') return [];
  const keys = workflowNodeCapabilityKeys(item);
  if (keys.length === 0) {
    if (!requireCapabilities) return [];
    const label = requiredString(item, 'name') ?? requiredString(item, 'key') ?? '未命名节点';
    throw new OrviaError(`请为 Agent「${label}」选择能力`, 'validation', 400);
  }
  return keys;
}

function prepareWorkflowDefinition(definitionJson: unknown, requireCapabilities: boolean) {
  const definition = jsonObject(definitionJson);
  const definitionNodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const definitionEdges = Array.isArray(definition.edges) ? definition.edges : [];
  const nodeCapabilityLists = definitionNodes.map((node) => nodeCapabilityList(jsonObject(node), requireCapabilities));
  const nodeKeys = definitionNodes.map((node, index) => requiredString(jsonObject(node), 'key') ?? String(index));
  try {
    assertAcyclicGraph(nodeKeys, definitionEdges.map((edge) => ({
      source: String(jsonObject(edge).source),
      target: String(jsonObject(edge).target),
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid workflow graph';
    throw new OrviaError(message.includes('acyclic') ? '连线不能绕回去。要重复执行请用「循环」，不要把线连回头' : message, 'validation', 400);
  }
  const loops = loopsFromDefinition(definition);
  const loopError = validateLoops(loops, definitionNodes.map((node) => {
    const item = jsonObject(node);
    return { key: requiredString(item, 'key') ?? '', type: storedNodeType(item.type) };
  }));
  if (loopError) throw new OrviaError(loopError, 'validation', 400);
  return { definitionNodes, definitionEdges, nodeCapabilityLists };
}

async function insertWorkflowGraph(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowId: number,
  prepared: ReturnType<typeof prepareWorkflowDefinition>,
  replace: boolean,
  fallbackName: boolean,
) {
  if (replace) {
    const existingNodes = await tx.select({ id: workflowNodes.id }).from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
    const nodeIds = existingNodes.map((node) => node.id);
    if (nodeIds.length > 0) {
      await tx.update(tasks).set({ workflowNodeId: null }).where(inArray(tasks.workflowNodeId, nodeIds));
      await tx.update(checkpoints).set({ workflowNodeId: null }).where(inArray(checkpoints.workflowNodeId, nodeIds));
    }
    await tx.delete(workflowEdges).where(eq(workflowEdges.workflowId, workflowId));
    await tx.delete(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
  }
  const nodeIds = new Map<string, number>();
  for (const [index, node] of prepared.definitionNodes.entries()) {
    const item = jsonObject(node);
    const capabilities = prepared.nodeCapabilityLists[index] ?? [];
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    const nodeResult = await tx.insert(workflowNodes).values({
      workflowId,
      name: rawName || (fallbackName ? `Node ${index + 1}` : ''),
      capability: capabilities[0] ?? '',
      skill: null,
      capabilitiesJson: capabilities,
      nodeType: storedNodeType(item.type),
      configJson: withoutLegacySkill(item),
    });
    nodeIds.set(requiredString(item, 'key') ?? String(index), nodeResult[0].insertId);
  }
  let edgeCount = 0;
  for (const edge of prepared.definitionEdges) {
    const item = jsonObject(edge);
    const sourceNodeId = nodeIds.get(String(item.source));
    const targetNodeId = nodeIds.get(String(item.target));
    if (!sourceNodeId || !targetNodeId) continue;
    await tx.insert(workflowEdges).values({ workflowId, sourceNodeId, targetNodeId, conditionJson: item.condition });
    edgeCount += 1;
  }
  return { nodeCount: nodeIds.size, edgeCount };
}

function withoutLegacySkill(item: Record<string, unknown>): Record<string, unknown> {
  const { skill: _skill, ...rest } = item;
  return rest;
}

function normalizedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

function queryId(url: URL, field: string): number | undefined {
  const raw = url.searchParams.get(field);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function presentedToken(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const queryToken = url.searchParams.get('access_token');
  return queryToken && queryToken.trim() ? queryToken.trim() : undefined;
}

type AuthContext = {
  mode: 'open' | 'service' | 'user';
  tenantId: number;
  userId?: number;
  email?: string;
  name?: string;
  role?: string;
};

type SessionPayload = {
  userId: number;
  email: string;
  name: string;
  tenantId: number;
  role: string;
};

function requestedTenantId(request: IncomingMessage): number | undefined {
  const raw = request.headers['x-orvia-tenant-id'];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function resolveAuth(request: IncomingMessage, url: URL): Promise<AuthContext | undefined> {
  const token = presentedToken(request, url);
  const fallbackTenantId = await defaultTenantId();
  if (token && config.apiToken && token === config.apiToken) {
    return { mode: 'service', tenantId: requestedTenantId(request) ?? fallbackTenantId };
  }
  if (token) {
    const session = await redisRuntime().getSession<SessionPayload>(token);
    if (!session) return undefined;
    const memberships = await membershipsForUser(session.userId);
    const requested = requestedTenantId(request) ?? session.tenantId;
    const membership = memberships.find((item) => item.tenantId === requested) ?? memberships[0];
    if (!membership) return undefined;
    return {
      mode: 'user',
      tenantId: membership.tenantId,
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: membership.role,
    };
  }
  if (!config.apiToken && config.nodeEnv !== 'production') {
    return { mode: 'open', tenantId: requestedTenantId(request) ?? fallbackTenantId };
  }
  return undefined;
}

function queryPage(url: URL) {
  const rawLimit = Number(url.searchParams.get('limit') ?? 50);
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  return {
    limit: Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50,
    offset: Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0,
  };
}

async function handler(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`);
  const requestId = typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : randomUUID();
  const startedAt = Date.now();
  response.setHeader('x-request-id', requestId);
  response.once('finish', () => {
    console.log(JSON.stringify({ level: 'info', type: 'http.request', requestId, method: request.method, path: url.pathname, status: response.statusCode, durationMs: Date.now() - startedAt }));
  });
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': config.webOrigin,
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-orvia-tenant-id, x-orvia-filename',
      });
      return response.end();
    }
    const publicPath = url.pathname === '/health'
      || url.pathname === '/api/auth/login'
      || url.pathname === '/api/auth/register';
    const auth = publicPath && url.pathname !== '/health' ? undefined : await resolveAuth(request, url).catch(() => undefined);
    if (!publicPath && !auth) {
      return sendJson(response, 401, { error: 'Unauthorized' });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        await pool.query('SELECT 1');
        const schemaIssues = await schemaIntegrityIssues();
        const redis = redisRuntime();
        const payload = {
          status: schemaIssues.length > 0 || redis.status() !== 'ok' ? 'degraded' : 'ok',
          database: schemaIssues.length > 0 ? 'schema_incomplete' : 'ok',
          schemaIssues: schemaIssues.length > 0 ? schemaIssues : undefined,
          redis: { status: redis.status(), url: redisDisplayUrl() },
          runtime: 'pi',
          auth: config.apiToken ? 'required' : 'open',
          version: '0.1.0-revision3',
        };
        return sendJson(response, schemaIssues.length > 0 || redis.status() !== 'ok' ? 503 : 200, payload);
      } catch (error) {
        return sendJson(response, 503, { status: 'degraded', database: 'error', runtime: 'pi', error: error instanceof Error ? error.message : 'Database unavailable' });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/system/settings') {
      const env = await readLocalEnv();
      const databaseUrl = env.DATABASE_URL || config.databaseUrl;
      const redisUrl = env.REDIS_URL || config.redisUrl;
      const piCommand = env.PI_COMMAND || config.piCommand;
      const mysql = parseMysqlUrl(databaseUrl);
      const redis = parseRedisUrl(redisUrl);
      const [piStatus, mysqlStatus, redisStatus] = await Promise.all([
        probePi(piCommand),
        probeMysql(databaseUrl),
        probeRedis(redisUrl),
      ]);
      return sendJson(response, 200, {
        storage: 'local-env',
        path: '.env',
        note: '连接信息只保存在本机 .env，不会写入数据库或 Git。',
        pi: {
          command: piCommand,
          status: piStatus.status,
          version: piStatus.version,
          message: piStatus.message,
        },
        mysql: {
          host: mysql.host,
          port: mysql.port,
          user: mysql.user,
          database: mysql.database,
          passwordSet: Boolean(mysql.password),
          passwordMasked: maskSecret(mysql.password),
          status: mysqlStatus.status,
          message: mysqlStatus.message,
          latencyMs: mysqlStatus.latencyMs,
        },
        redis: {
          host: redis.host,
          port: redis.port,
          passwordSet: Boolean(redis.password),
          passwordMasked: maskSecret(redis.password),
          displayUrl: redisDisplayUrl(redisUrl),
          status: redisStatus.status,
          message: redisStatus.message,
          latencyMs: redisStatus.latencyMs,
        },
      });
    }

    if (request.method === 'PUT' && url.pathname === '/api/system/settings') {
      const body = await readJson(request);
      const env = await readLocalEnv();
      const currentMysql = parseMysqlUrl(env.DATABASE_URL || config.databaseUrl);
      const currentRedis = parseRedisUrl(env.REDIS_URL || config.redisUrl);
      const mysqlPassword = typeof body.mysqlPassword === 'string'
        ? body.mysqlPassword
        : currentMysql.password;
      const redisPassword = typeof body.redisPassword === 'string'
        ? body.redisPassword
        : currentRedis.password;
      const mysqlUrl = buildMysqlUrl({
        host: typeof body.mysqlHost === 'string' ? body.mysqlHost : currentMysql.host,
        port: typeof body.mysqlPort === 'string' ? body.mysqlPort : currentMysql.port,
        user: typeof body.mysqlUser === 'string' ? body.mysqlUser : currentMysql.user,
        password: mysqlPassword,
        database: typeof body.mysqlDatabase === 'string' ? body.mysqlDatabase : currentMysql.database,
      });
      const redisUrl = buildRedisUrl({
        host: typeof body.redisHost === 'string' ? body.redisHost : currentRedis.host,
        port: typeof body.redisPort === 'string' ? body.redisPort : currentRedis.port,
        password: redisPassword,
      });
      const piCommand = typeof body.piCommand === 'string' && body.piCommand.trim()
        ? body.piCommand.trim()
        : (env.PI_COMMAND || config.piCommand);

      const [mysqlStatus, redisStatus, piStatus] = await Promise.all([
        probeMysql(mysqlUrl),
        probeRedis(redisUrl),
        probePi(piCommand),
      ]);
      if (mysqlStatus.status !== 'ok') {
        return sendJson(response, 400, { error: `MySQL 不可用：${mysqlStatus.message}`, mysql: mysqlStatus });
      }
      if (redisStatus.status !== 'ok') {
        return sendJson(response, 400, { error: `Redis 不可用：${redisStatus.message}`, redis: redisStatus });
      }

      await writeLocalEnv({
        DATABASE_URL: mysqlUrl,
        REDIS_URL: redisUrl,
        PI_COMMAND: piCommand,
      });
      process.env.DATABASE_URL = mysqlUrl;
      process.env.REDIS_URL = redisUrl;
      process.env.PI_COMMAND = piCommand;

      return sendJson(response, 200, {
        status: 'saved',
        storage: 'local-env',
        restartRequired: true,
        message: '已写入本机 .env。Pi 命令立即生效；MySQL / Redis 需重启 API 进程后完全切换。',
        pi: piStatus,
        mysql: mysqlStatus,
        redis: redisStatus,
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJson(request);
      const email = requiredString(body, 'email');
      const password = requiredString(body, 'password');
      if (!email || !password) return sendJson(response, 400, { error: 'email and password are required' });
      const authenticated = await authenticateUser(email, password);
      if (!authenticated || authenticated.memberships.length === 0) return sendJson(response, 401, { error: 'Invalid credentials' });
      const membership = authenticated.memberships[0]!;
      const token = randomBytes(24).toString('hex');
      await redisRuntime().setSession(token, {
        userId: authenticated.user.id,
        email: authenticated.user.email,
        name: authenticated.user.name,
        tenantId: membership.tenantId,
        role: membership.role,
      });
      return sendJson(response, 200, {
        token,
        user: { id: authenticated.user.id, email: authenticated.user.email, name: authenticated.user.name },
        tenants: authenticated.memberships,
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readJson(request);
      const email = requiredString(body, 'email');
      const password = requiredString(body, 'password');
      const name = requiredString(body, 'name') ?? email ?? '';
      if (!email || !password) return sendJson(response, 400, { error: 'email and password are required' });
      try {
        const created = await registerUser({
          email,
          password,
          name,
          tenantName: requiredString(body, 'tenantName'),
        });
        return sendJson(response, 201, created);
      } catch (error) {
        return sendJson(response, 409, { error: error instanceof Error ? error.message : 'Registration failed' });
      }
    }

    if (!auth) return sendJson(response, 401, { error: 'Unauthorized' });
    const scopedProjectId = queryId(url, 'projectId');
    if (scopedProjectId) {
      try {
        await assertProjectInTenant(scopedProjectId, auth.tenantId);
      } catch {
        return sendJson(response, 403, { error: 'Project is not in the current tenant' });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      if (auth.mode === 'user') {
        const tenantsForUser = await membershipsForUser(auth.userId!);
        return sendJson(response, 200, { mode: auth.mode, user: { id: auth.userId, email: auth.email, name: auth.name }, tenantId: auth.tenantId, tenants: tenantsForUser });
      }
      const tenant = (await db.select().from(tenants).where(eq(tenants.id, auth.tenantId)))[0];
      return sendJson(response, 200, { mode: auth.mode, tenantId: auth.tenantId, tenants: tenant ? [{ tenantId: tenant.id, name: tenant.name, slug: tenant.slug, role: 'owner' }] : [] });
    }

    if (request.method === 'GET' && url.pathname === '/api/tenants') {
      if (auth.mode === 'user' && auth.userId) {
        return sendJson(response, 200, { data: await membershipsForUser(auth.userId) });
      }
      const rows = await db.select().from(tenants).orderBy(asc(tenants.name));
      return sendJson(response, 200, { data: rows.map((row) => ({ tenantId: row.id, name: row.name, slug: row.slug, role: 'owner', status: row.status })) });
    }

    if (request.method === 'POST' && url.pathname === '/api/tenants') {
      const body = await readJson(request);
      const name = requiredString(body, 'name');
      if (!name) return sendJson(response, 400, { error: 'name is required' });
      if (auth.mode === 'user' && auth.role !== 'owner' && auth.role !== 'admin') {
        return sendJson(response, 403, { error: 'Only owner or admin can create a tenant' });
      }
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || `tenant-${Date.now()}`;
      const created = await db.insert(tenants).values({ name, slug });
      const tenantId = created[0].insertId;
      if (auth.userId) await db.insert(tenantMembers).values({ tenantId, userId: auth.userId, role: 'owner' });
      return sendJson(response, 201, { id: tenantId, name, slug });
    }

    if (request.method === 'GET' && url.pathname === '/metrics') {
      const projectCount = (await db.select({ value: count() }).from(projects).where(eq(projects.tenantId, auth.tenantId)))[0]?.value ?? 0;
      return sendJson(response, 200, {
        tenantId: auth.tenantId,
        redis: { status: redisRuntime().status(), url: redisDisplayUrl() },
        projects: projectCount,
        runtime: 'pi',
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/events/stream') {
      const projectId = queryId(url, 'projectId');
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': config.webOrigin,
      });
      response.write(`event: ready\ndata: ${JSON.stringify({ projectId: projectId ?? null })}\n\n`);
      const client = { response, projectId };
      eventClients.add(client);
      request.on('close', () => eventClients.delete(client));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/model-providers') {
      const rows = await db.select().from(modelProviders).orderBy(asc(modelProviders.name));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/model-providers') {
      const body = await readJson(request);
      if (typeof body.name !== 'string' || typeof body.type !== 'string') {
        return sendJson(response, 400, { error: 'name and type are required' });
      }
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        return sendJson(response, 400, { error: 'baseUrl must start with http:// or https://' });
      }
      const result = await db.insert(modelProviders).values({
        name: body.name,
        type: body.type,
        baseUrl: baseUrl || undefined,
        configJson: body.configJson,
      });
      return sendJson(response, 201, { id: result[0].insertId, name: body.name, type: body.type });
    }

    const providerDetailMatch = url.pathname.match(/^\/api\/model-providers\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && providerDetailMatch) {
      const providerId = Number(providerDetailMatch[1]);
      const body = await readJson(request);
      const existing = (await db.select().from(modelProviders).where(eq(modelProviders.id, providerId)))[0];
      if (!existing) return sendJson(response, 404, { error: 'Provider not found' });
      const name = requiredString(body, 'name') ?? existing.name;
      const type = requiredString(body, 'type') ?? existing.type;
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : existing.baseUrl ?? '';
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return sendJson(response, 400, { error: 'baseUrl must start with http:// or https://' });
      await db.update(modelProviders).set({ name, type, baseUrl: baseUrl || null }).where(eq(modelProviders.id, providerId));
      return sendJson(response, 200, { id: providerId, name, type, baseUrl: baseUrl || null });
    }

    if (request.method === 'GET' && url.pathname === '/api/models') {
      const providerId = url.searchParams.get('providerId');
      const rows = providerId
        ? await db.select().from(models).where(eq(models.providerId, Number(providerId))).orderBy(asc(models.displayName))
        : await db.select().from(models).orderBy(asc(models.displayName));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/models') {
      const body = await readJson(request);
      const providerId = typeof body.providerId === 'number' ? body.providerId : Number(body.providerId);
      const name = requiredString(body, 'name');
      const displayName = requiredString(body, 'displayName');
      if (!Number.isInteger(providerId) || providerId < 1 || !name) {
        return sendJson(response, 400, { error: 'providerId and name are required' });
      }
      const result = await db.insert(models).values({
        providerId,
        name,
        displayName: displayName ?? name,
        capabilitiesJson: body.capabilitiesJson,
        contextWindow: typeof body.contextWindow === 'number' ? body.contextWindow : undefined,
        inputPrice: typeof body.inputPrice === 'string' ? body.inputPrice : undefined,
        outputPrice: typeof body.outputPrice === 'string' ? body.outputPrice : undefined,
      });
      return sendJson(response, 201, { id: result[0].insertId, providerId, name, displayName });
    }

    const modelDetailMatch = url.pathname.match(/^\/api\/models\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && modelDetailMatch) {
      const modelId = Number(modelDetailMatch[1]);
      const body = await readJson(request);
      const existing = (await db.select().from(models).where(eq(models.id, modelId)))[0];
      if (!existing) return sendJson(response, 404, { error: 'Model not found' });
      const providerId = body.providerId === undefined ? existing.providerId : Number(body.providerId);
      const name = requiredString(body, 'name') ?? existing.name;
      const displayName = requiredString(body, 'displayName') ?? existing.displayName;
      if (!Number.isInteger(providerId) || providerId < 1 || !name || !displayName) {
        return sendJson(response, 400, { error: 'providerId, name and displayName are required' });
      }
      const provider = (await db.select().from(modelProviders).where(eq(modelProviders.id, providerId)))[0];
      if (!provider) return sendJson(response, 400, { error: 'Provider not found' });
      await db.update(models).set({ providerId, name, displayName }).where(eq(models.id, modelId));
      return sendJson(response, 200, { id: modelId, providerId, name, displayName });
    }

    if (request.method === 'GET' && url.pathname === '/api/projects') {
      const rows = await db.select({
        id: projects.id,
        tenantId: projects.tenantId,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        workflowCount: sql<number>`coalesce(count(${workflows.id}), 0)`.mapWith(Number),
      }).from(projects)
        .leftJoin(workflows, eq(workflows.projectId, projects.id))
        .where(eq(projects.tenantId, auth.tenantId))
        .groupBy(projects.id)
        .orderBy(desc(projects.createdAt), asc(projects.name));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/projects') {
      const body = await readJson(request);
      const name = requiredString(body, 'name');
      if (!name) return sendJson(response, 400, { error: 'name is required' });
      const result = await db.insert(projects).values({
        tenantId: auth.tenantId,
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
      });
      const projectId = result[0].insertId;
      await ensureTenantCapabilities(auth.tenantId);
      return sendJson(response, 201, { id: projectId, name, tenantId: auth.tenantId, workflowCount: 0 });
    }

    const projectDetailMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && projectDetailMatch) {
      const projectId = Number(projectDetailMatch[1]);
      const body = await readJson(request);
      const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
      if (!project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Project not found' });
      const name = requiredString(body, 'name');
      if (!name) return sendJson(response, 400, { error: 'name is required' });
      await db.update(projects).set({
        name,
        description: typeof body.description === 'string' ? body.description : project.description,
      }).where(eq(projects.id, projectId));
      return sendJson(response, 200, { id: projectId, name });
    }

    if (request.method === 'GET' && url.pathname === '/api/capabilities') {
      if (!auth) return sendJson(response, 401, { error: 'Unauthorized' });
      const rows = await ensureTenantCapabilities(auth.tenantId);
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/capabilities') {
      if (!auth) return sendJson(response, 401, { error: 'Unauthorized' });
      const body = await readJson(request);
      const key = typeof body.key === 'string' ? normalizeCapabilityKey(body.key) : undefined;
      const name = requiredString(body, 'name') ?? key;
      if (!key || !name) {
        return sendJson(response, 400, { error: '请填写合法的能力标识和中文名称' });
      }
      await ensureTenantCapabilities(auth.tenantId);
      const duplicate = (await db.select().from(capabilities).where(and(eq(capabilities.tenantId, auth.tenantId), eq(capabilities.key, key))))[0];
      if (duplicate) return sendJson(response, 400, { error: '这个能力标识已经在目录里' });
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const result = await db.insert(capabilities).values({ tenantId: auth.tenantId, key, name, description: description || null });
      return sendJson(response, 201, { id: result[0].insertId, tenantId: auth.tenantId, key, name });
    }

    const capabilityDetailMatch = url.pathname.match(/^\/api\/capabilities\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && capabilityDetailMatch) {
      if (!auth) return sendJson(response, 401, { error: 'Unauthorized' });
      const capabilityId = Number(capabilityDetailMatch[1]);
      const body = await readJson(request);
      const existing = (await db.select().from(capabilities).where(eq(capabilities.id, capabilityId)))[0];
      if (!existing || existing.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Capability not found' });
      const name = requiredString(body, 'name') ?? existing.name;
      if (!name) return sendJson(response, 400, { error: '请填写中文名称' });
      const description = typeof body.description === 'string' ? body.description.trim() : existing.description;
      await db.update(capabilities).set({ name, description: description || null }).where(eq(capabilities.id, capabilityId));
      return sendJson(response, 200, { id: capabilityId, key: existing.key, name });
    }

    if (request.method === 'GET' && url.pathname === '/api/agents') {
      const projectId = queryId(url, 'projectId');
      const workflowId = queryId(url, 'workflowId');
      const filters = [
        projectId ? eq(agents.projectId, projectId) : undefined,
        workflowId ? eq(agents.workflowId, workflowId) : undefined,
      ].filter((item): item is NonNullable<typeof item> => item !== undefined);
      const rows = filters.length
        ? await db.select().from(agents).where(and(...filters)).orderBy(asc(agents.name))
        : await db.select().from(agents).orderBy(asc(agents.name));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/agents') {
      const body = await readJson(request);
      const projectId = typeof body.projectId === 'number' ? body.projectId : Number(body.projectId);
      const name = requiredString(body, 'name');
      if (!Number.isInteger(projectId) || projectId < 1 || !name) {
        return sendJson(response, 400, { error: 'projectId and name are required' });
      }
      if (!auth) return sendJson(response, 401, { error: 'Unauthorized' });
      const project = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
      if (!project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Project not found' });
      let workflowId: number | null = null;
      if (body.workflowId !== undefined && body.workflowId !== null && body.workflowId !== '') {
        const parsed = typeof body.workflowId === 'number' ? body.workflowId : Number(body.workflowId);
        if (!Number.isInteger(parsed) || parsed < 1) return sendJson(response, 400, { error: 'workflowId is invalid' });
        const workflow = (await db.select().from(workflows).where(eq(workflows.id, parsed)))[0];
        if (!workflow || workflow.projectId !== projectId) {
          return sendJson(response, 400, { error: 'Workflow does not belong to this project' });
        }
        const workflowProject = (await db.select().from(projects).where(eq(projects.id, workflow.projectId)))[0];
        if (!workflowProject || workflowProject.tenantId !== auth.tenantId) {
          return sendJson(response, 404, { error: 'Workflow not found' });
        }
        workflowId = parsed;
      }
      const capabilityKeys = await assertProjectCatalogKeys(projectId, collectCapabilityKeys(body.capabilitiesJson));
      const result = await db.insert(agents).values({
        projectId,
        workflowId,
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        capabilitiesJson: capabilityKeys,
      });
      return sendJson(response, 201, { id: result[0].insertId, projectId, workflowId, name });
    }

    const agentDetailMatch = url.pathname.match(/^\/api\/agents\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && agentDetailMatch) {
      const agentId = Number(agentDetailMatch[1]);
      const body = await readJson(request);
      const existing = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
      if (!existing) return sendJson(response, 404, { error: 'Agent not found' });
      const project = (await db.select().from(projects).where(eq(projects.id, existing.projectId)))[0];
      if (!project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Agent not found' });
      const name = requiredString(body, 'name') ?? existing.name;
      if (!name) return sendJson(response, 400, { error: 'name is required' });
      const capabilityKeys = body.capabilitiesJson === undefined
        ? undefined
        : await assertProjectCatalogKeys(existing.projectId, collectCapabilityKeys(body.capabilitiesJson));
      await db.update(agents).set({
        name,
        capabilitiesJson: capabilityKeys === undefined ? existing.capabilitiesJson : capabilityKeys,
      }).where(eq(agents.id, agentId));
      return sendJson(response, 200, { id: agentId, name });
    }

    if (request.method === 'GET' && url.pathname === '/api/agent-versions') {
      const agentId = queryId(url, 'agentId');
      const rows = agentId
        ? await db.select().from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(asc(agentVersions.version))
        : await db.select().from(agentVersions).orderBy(asc(agentVersions.version));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/agent-versions') {
      const body = await readJson(request);
      const agentId = typeof body.agentId === 'number' ? body.agentId : Number(body.agentId);
      const modelId = typeof body.modelId === 'number' ? body.modelId : Number(body.modelId);
      const version = requiredString(body, 'version');
      const role = requiredString(body, 'role');
      if (!Number.isInteger(agentId) || agentId < 1 || !Number.isInteger(modelId) || modelId < 1 || !version || !role) {
        return sendJson(response, 400, { error: 'agentId, modelId, version and role are required' });
      }
      const result = await db.insert(agentVersions).values({
        agentId,
        modelId,
        version,
        role,
        mission: typeof body.mission === 'string' ? body.mission : undefined,
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
        configJson: body.configJson,
      });
      return sendJson(response, 201, { id: result[0].insertId, agentId, modelId, version });
    }

    const versionDetailMatch = url.pathname.match(/^\/api\/agent-versions\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && versionDetailMatch) {
      const versionId = Number(versionDetailMatch[1]);
      const body = await readJson(request);
      const existing = (await db.select().from(agentVersions).where(eq(agentVersions.id, versionId)))[0];
      if (!existing) return sendJson(response, 404, { error: 'Agent version not found' });
      const agent = (await db.select().from(agents).where(eq(agents.id, existing.agentId)))[0];
      const project = agent ? (await db.select().from(projects).where(eq(projects.id, agent.projectId)))[0] : undefined;
      if (!project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Agent version not found' });
      const modelId = body.modelId === undefined ? existing.modelId : Number(body.modelId);
      const version = requiredString(body, 'version') ?? existing.version;
      const role = requiredString(body, 'role') ?? existing.role;
      if (!Number.isInteger(modelId) || modelId < 1 || !version || !role) {
        return sendJson(response, 400, { error: 'modelId, version and role are required' });
      }
      const model = (await db.select().from(models).where(eq(models.id, modelId)))[0];
      if (!model) return sendJson(response, 400, { error: 'Model not found' });
      try {
        await db.update(agentVersions).set({
          modelId,
          version,
          role,
          mission: typeof body.mission === 'string' ? body.mission.trim() || null : existing.mission,
        }).where(eq(agentVersions.id, versionId));
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY') {
          return sendJson(response, 400, { error: '这个 Agent 已经有相同版本号' });
        }
        throw error;
      }
      return sendJson(response, 200, { id: versionId, modelId, version, role });
    }

    if (request.method === 'GET' && url.pathname === '/api/model-resolver') {
      const projectId = queryId(url, 'projectId');
      if (!projectId) return sendJson(response, 400, { error: 'projectId is required' });
      const rows = await db
        .select({
          agentId: agents.id,
          agentName: agents.name,
          agentVersionId: agentVersions.id,
          version: agentVersions.version,
          modelId: models.id,
          modelName: models.name,
          modelDisplayName: models.displayName,
          providerId: modelProviders.id,
          providerName: modelProviders.name,
          providerType: modelProviders.type,
        })
        .from(agents)
        .innerJoin(agentVersions, eq(agentVersions.agentId, agents.id))
        .innerJoin(models, eq(models.id, agentVersions.modelId))
        .innerJoin(modelProviders, eq(modelProviders.id, models.providerId))
        .where(eq(agents.projectId, projectId));
      return sendJson(response, 200, { data: rows, selection: 'agent-version-model-provider' });
    }

    if (request.method === 'GET' && url.pathname === '/api/workflows') {
      if (!auth) return sendJson(response, 401, { error: 'Unauthorized' });
      const projectId = queryId(url, 'projectId');
      const rows = await db.select({
        id: workflows.id,
        projectId: workflows.projectId,
        projectName: projects.name,
        name: workflows.name,
        version: workflows.version,
        definitionJson: workflows.definitionJson,
        status: workflows.status,
        runStatus: workflows.runStatus,
        currentVersionId: workflows.currentVersionId,
        createdAt: workflows.createdAt,
        updatedAt: workflows.updatedAt,
      }).from(workflows)
        .innerJoin(projects, eq(projects.id, workflows.projectId))
        .where(projectId
          ? and(eq(projects.tenantId, auth.tenantId), eq(workflows.projectId, projectId))
          : eq(projects.tenantId, auth.tenantId))
        .orderBy(desc(workflows.updatedAt), asc(workflows.name));
      return sendJson(response, 200, { data: rows });
    }

    const workflowFileReadMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/file$/);
    if (request.method === 'GET' && workflowFileReadMatch && auth) {
      const workflowId = Number(workflowFileReadMatch[1]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
      const project = workflow ? (await db.select().from(projects).where(eq(projects.id, workflow.projectId)))[0] : undefined;
      if (!workflow || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      const requested = url.searchParams.get('path') ?? '';
      const root = await managedWorkflowRoot(workflowId);
      const target = path.resolve(requested);
      const relative = path.relative(path.resolve(root), target);
      if (!requested || !isManagedWorkspace(target) || relative.startsWith('..') || path.isAbsolute(relative)) {
        return sendJson(response, 400, { error: '这个文件不在当前 Workflow 里' });
      }
      const name = path.basename(target);
      if (!/\.(md|txt|json|csv|log)$/i.test(name)) {
        return sendJson(response, 200, { name, binary: true, path: target });
      }
      const text = await readFile(target, 'utf8');
      return sendJson(response, 200, { name, text: text.slice(0, 200_000), path: target });
    }

    const workflowOpenMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/open$/);
    if (request.method === 'POST' && workflowOpenMatch && auth) {
      const workflowId = Number(workflowOpenMatch[1]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
      const project = workflow ? (await db.select().from(projects).where(eq(projects.id, workflow.projectId)))[0] : undefined;
      if (!workflow || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      try {
        const root = await managedWorkflowRoot(workflowId);
        const body = await readJson(request);
        const requested = typeof body.directory === 'string' ? body.directory.trim() : '';
        const target = requested ? path.resolve(requested) : root;
        const relative = path.relative(path.resolve(root), target);
        if (requested && (!isManagedWorkspace(target) || relative.startsWith('..') || path.isAbsolute(relative))) {
          return sendJson(response, 400, { error: '这个路径不在当前 Workflow 里' });
        }
        await openDirectory(target);
        return sendJson(response, 200, { root: target });
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法打开主目录';
        return sendJson(response, 500, { error: message });
      }
    }

    const workflowFileMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/files$/);
    if (workflowFileMatch && auth) {
      const workflowId = Number(workflowFileMatch[1]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
      const project = workflow ? (await db.select().from(projects).where(eq(projects.id, workflow.projectId)))[0] : undefined;
      if (!workflow || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      if (request.method === 'GET') {
        const root = await managedWorkflowRoot(workflowId);
        const files = await listInputFiles(root);
        return sendJson(response, 200, { directory: inputDirectory(root), root, files });
      }
      if (request.method === 'DELETE') {
        const name = url.searchParams.get('name') ?? '';
        if (!name) return sendJson(response, 400, { error: '请指定要删除的文件' });
        await deleteInputFile(await managedWorkflowRoot(workflowId), name);
        return sendJson(response, 200, { deleted: true });
      }
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += piece.length;
          if (size > 8_000_000) return sendJson(response, 413, { error: '文件不能超过 8MB' });
          chunks.push(piece);
        }
        const encoded = request.headers['x-orvia-filename'];
        const rawName = decodeURIComponent(typeof encoded === 'string' ? encoded : '需求文件');
        const root = await managedWorkflowRoot(workflowId);
        const name = await saveInputFile(root, rawName, Buffer.concat(chunks));
        return sendJson(response, 201, { name, directory: inputDirectory(root) });
      }
    }

    const nodeMessageMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/nodes\/([^/]+)\/messages$/);
    if (nodeMessageMatch && (request.method === 'GET' || request.method === 'POST')) {
      const workflowId = Number(nodeMessageMatch[1]);
      const nodeKey = decodeURIComponent(nodeMessageMatch[2]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      const node = (await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)))
        .find((item) => recordKey(item.configJson) === nodeKey);
      if (!node) return sendJson(response, 404, { error: '节点不存在' });
      if (node.nodeType === 'start' || node.nodeType === 'end') return sendJson(response, 400, { error: '开始和结束不参与对话' });
      if (request.method === 'GET') {
        await healStuckNodeChat(workflowId, nodeKey);
        const rows = await db.select().from(nodeMessages)
          .where(and(eq(nodeMessages.workflowId, workflowId), eq(nodeMessages.nodeKey, nodeKey)))
          .orderBy(asc(nodeMessages.id));
        return sendJson(response, 200, { data: rows });
      }
      const body = await readJson(request);
      const content = requiredString(body, 'content');
      if (!content) return sendJson(response, 400, { error: '请先写一句指导' });
      const chatKey = `${workflowId}:${nodeKey}`;
      if (!(await beginNodeChat(workflowId, nodeKey))) {
        return sendJson(response, 409, { error: '这个 Agent 正在回复，请稍候' });
      }
      let handedOff = false;
      try {
        const created = await db.transaction(async (tx) => {
          const owner = (await tx.select({ currentVersionId: workflows.currentVersionId }).from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
          const workflowVersionId = owner?.currentVersionId ?? undefined;
          await tx.insert(nodeMessages).values({ workflowId, workflowVersionId, nodeKey, role: 'user', content, status: 'completed' });
          const assistant = await tx.insert(nodeMessages).values({ workflowId, workflowVersionId, nodeKey, role: 'assistant', content: '', status: 'streaming' });
          const runtimeSession = await tx.insert(sessions).values({
            contextType: 'chat',
            contextId: workflowId,
            runtime: 'pi',
            status: 'pending',
            inputJson: { nodeKey, prompt: content },
          });
          const sessionId = runtimeSession[0].insertId;
          await tx.update(nodeMessages).set({ sessionId }).where(eq(nodeMessages.id, assistant[0].insertId));
          return { assistantMessageId: assistant[0].insertId, sessionId };
        });
        handedOff = true;
        void replyToNode(workflowId, nodeKey, content, created.assistantMessageId, created.sessionId)
          .catch(async (error) => {
            const message = error instanceof Error ? error.message : 'Agent 没有回复';
            await db.update(nodeMessages).set({ content: message, status: 'failed' }).where(eq(nodeMessages.id, created.assistantMessageId));
            await db.update(sessions).set({ status: 'failed', outputJson: { error: message }, completedAt: new Date() }).where(eq(sessions.id, created.sessionId));
          })
          .finally(() => { void endNodeChat(chatKey); });
        return sendJson(response, 202, { status: 'accepted' });
      } catch (error) {
        if (!handedOff) await endNodeChat(chatKey);
        throw error;
      }
    }

    const workflowNodesMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/nodes$/);
    if (request.method === 'GET' && workflowNodesMatch) {
      const workflowId = Number(workflowNodesMatch[1]);
      const running = (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.status, 'running'))).limit(1))[0];
      if (!running) await ensureWorkflowTerminals(workflowId);
      await ensureLegacyWorkflowVersion(workflowId).catch(() => undefined);
      const workflow = (await db.select({ name: workflows.name, definitionJson: workflows.definitionJson }).from(workflows).where(eq(workflows.id, workflowId)))[0];
      const rows = await db.select().from(workflowNodes)
        .where(eq(workflowNodes.workflowId, workflowId))
        .orderBy(asc(workflowNodes.id));
      const edges = await db.select().from(workflowEdges)
        .where(eq(workflowEdges.workflowId, workflowId))
        .orderBy(asc(workflowEdges.id));
      const root = await managedWorkflowRoot(workflowId);
      return sendJson(response, 200, { data: rows, edges, loops: loopsFromDefinition(workflow?.definitionJson), root });
    }

    const workflowVersionsMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/versions$/);
    if (request.method === 'GET' && workflowVersionsMatch) {
      const workflowId = Number(workflowVersionsMatch[1]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      const project = (await db.select().from(projects).where(eq(projects.id, workflow.projectId)).limit(1))[0];
      if (!auth || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      await ensureLegacyWorkflowVersion(workflowId).catch(() => undefined);
      const refreshed = (await db.select({ currentVersionId: workflows.currentVersionId, version: workflows.version }).from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
      const rows = await db.select({
        id: workflowVersions.id,
        version: workflowVersions.version,
        seq: workflowVersions.seq,
        name: workflowVersions.name,
        publishedAt: workflowVersions.publishedAt,
      }).from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        .orderBy(desc(workflowVersions.seq))
        .limit(MAX_WORKFLOW_VERSIONS);
      return sendJson(response, 200, {
        data: rows,
        currentVersionId: refreshed?.currentVersionId ?? null,
        currentVersion: refreshed?.version ?? workflow.version,
      });
    }

    const workflowPublishMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/publish$/);
    if (request.method === 'POST' && workflowPublishMatch) {
      const workflowId = Number(workflowPublishMatch[1]);
      const body = await readJson(request);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      const project = (await db.select().from(projects).where(eq(projects.id, workflow.projectId)).limit(1))[0];
      if (!auth || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      const name = requiredString(body, 'name') ?? workflow.name;
      const definitionJson = body.definitionJson === undefined ? workflow.definitionJson : body.definitionJson;
      try {
        const published = await publishWorkflowVersion(workflowId, { name, definitionJson });
        return sendJson(response, 200, {
          id: workflowId,
          name,
          version: published.version,
          versionId: published.versionId,
          seq: published.seq,
          status: 'published',
          pruned: published.pruned,
        });
      } catch (error) {
        if (error instanceof OrviaError) return sendJson(response, error.statusCode, { error: error.message });
        throw error;
      }
    }

    const workflowActivateMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/versions\/(\d+)\/activate$/);
    if (request.method === 'POST' && workflowActivateMatch) {
      const workflowId = Number(workflowActivateMatch[1]);
      const versionId = Number(workflowActivateMatch[2]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      const project = (await db.select().from(projects).where(eq(projects.id, workflow.projectId)).limit(1))[0];
      if (!auth || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      try {
        const activated = await activateWorkflowVersion(workflowId, versionId);
        return sendJson(response, 200, { id: workflowId, versionId, version: activated.version, status: 'activated' });
      } catch (error) {
        if (error instanceof OrviaError) return sendJson(response, error.statusCode, { error: error.message });
        throw error;
      }
    }

    const workflowDetailMatch = url.pathname.match(/^\/api\/workflows\/(\d+)$/);
    if ((request.method === 'PATCH' || request.method === 'PUT') && workflowDetailMatch) {
      const workflowId = Number(workflowDetailMatch[1]);
      const body = await readJson(request);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      const project = (await db.select().from(projects).where(eq(projects.id, workflow.projectId)))[0];
      if (!auth || !project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      const running = (await db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).limit(1))[0];
      // 仅运行中禁止改图；暂停/等待决策时仍可保存节点位置与大小
      if (running?.status === 'running') return sendJson(response, 409, { error: '请先停止正在运行的 Run，再修改 Agent' });
      // 发布请走 POST /publish；这里只保存当前工作副本，不写版本历史
      const name = requiredString(body, 'name') ?? workflow.name;
      const nextStatus = body.status === 'draft'
        ? 'draft'
        : (body.status === 'published' || workflow.status === 'published' ? 'published' : 'draft');
      const definitionJson = body.definitionJson === undefined ? workflow.definitionJson : body.definitionJson;
      const prepared = prepareWorkflowDefinition(definitionJson, nextStatus === 'published');
      if (nextStatus === 'published' && prepared.definitionNodes.length === 0) {
        return sendJson(response, 400, { error: '请至少添加一个节点' });
      }
      await assertProjectCatalogKeys(workflow.projectId, prepared.nodeCapabilityLists.flat());
      await db.transaction(async (tx) => {
        await tx.update(workflows).set({
          name,
          version: workflow.version,
          definitionJson,
          status: nextStatus,
        }).where(eq(workflows.id, workflowId));
        if (body.definitionJson !== undefined || nextStatus === 'published') {
          await insertWorkflowGraph(tx, workflowId, prepared, true, nextStatus === 'published');
        }
      });
      await managedWorkflowRoot(workflowId);
      return sendJson(response, 200, {
        id: workflowId,
        name,
        version: workflow.version,
        status: nextStatus,
        nodeCount: prepared.definitionNodes.length,
        edgeCount: prepared.definitionEdges.length,
      });
    }

    if (request.method === 'DELETE' && workflowDetailMatch) {
      const workflowId = Number(workflowDetailMatch[1]);
      const workflow = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      const project = (await db.select().from(projects).where(eq(projects.id, workflow.projectId)))[0];
      if (!project || project.tenantId !== auth.tenantId) return sendJson(response, 404, { error: 'Workflow not found' });
      await deleteWorkflowCascade(workflowId);
      return sendJson(response, 200, { id: workflowId, status: 'deleted' });
    }

    if (request.method === 'GET' && url.pathname === '/api/plans') {
      const workflowRunId = queryId(url, 'workflowRunId');
      const rows = workflowRunId
        ? await db.select().from(plans).where(eq(plans.workflowRunId, workflowRunId)).orderBy(desc(plans.version))
        : await db.select().from(plans).orderBy(desc(plans.id));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/workflows') {
      const body = await readJson(request);
      const projectId = typeof body.projectId === 'number' ? body.projectId : Number(body.projectId);
      const name = requiredString(body, 'name');
      const version = requiredString(body, 'version') ?? 'v1';
      if (!Number.isInteger(projectId) || projectId < 1 || !name) {
        return sendJson(response, 400, { error: 'projectId and name are required' });
      }
      const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
      if (!auth || !project || project.tenantId !== auth.tenantId) {
        return sendJson(response, 404, { error: 'Project not found' });
      }
      const status = body.status === 'draft' ? 'draft' : 'published';
      const prepared = prepareWorkflowDefinition(body.definitionJson, status === 'published');
      await assertProjectCatalogKeys(projectId, prepared.nodeCapabilityLists.flat());
      const created = await db.transaction(async (tx) => {
        const result = await tx.insert(workflows).values({
          projectId,
          name,
          version,
          definitionJson: body.definitionJson ?? { nodes: [], edges: [] },
          status,
        });
        const workflowId = result[0].insertId;
        const graph = await insertWorkflowGraph(tx, workflowId, prepared, false, status === 'published');
        return { workflowId, ...graph };
      });
      await ensureWorkflowTerminals(created.workflowId);
      const nodes = await db.select({ id: workflowNodes.id }).from(workflowNodes).where(eq(workflowNodes.workflowId, created.workflowId));
      const edges = await db.select({ id: workflowEdges.id }).from(workflowEdges).where(eq(workflowEdges.workflowId, created.workflowId));
      await managedWorkflowRoot(created.workflowId);
      return sendJson(response, 201, { id: created.workflowId, projectId, name, version, status, nodeCount: nodes.length, edgeCount: edges.length });
    }

    const workflowRunSummaryMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/summary$/);
    if (request.method === 'GET' && workflowRunSummaryMatch) {
      const workflowRunId = Number(workflowRunSummaryMatch[1]);
      const run = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
      if (!run) return sendJson(response, 404, { error: 'Workflow run not found' });
      return sendJson(response, 200, { nodes: await workflowRunSummary(workflowRunId) });
    }

    if (request.method === 'GET' && url.pathname === '/api/workflow-runs') {
      const workflowId = queryId(url, 'workflowId');
      const rows = workflowId
        ? await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).orderBy(asc(workflowRuns.id))
        : await db.select().from(workflowRuns).orderBy(asc(workflowRuns.id));
      return sendJson(response, 200, { data: rows });
    }

    const workflowRunDetailMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)$/);
    if (request.method === 'GET' && workflowRunDetailMatch) {
      const workflowRunId = Number(workflowRunDetailMatch[1]);
      const run = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
      if (!run) return sendJson(response, 404, { error: 'Workflow run not found' });
      const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId)).orderBy(asc(tasks.id));
      const runSessions = runTasks.length > 0
        ? await db.select().from(sessions).where(inArray(sessions.taskId, runTasks.map((task) => task.id))).orderBy(asc(sessions.id))
        : [];
      const [runPlans, runCheckpoints, runDecisions, runEvents] = await Promise.all([
        db.select().from(plans).where(eq(plans.workflowRunId, workflowRunId)).orderBy(asc(plans.version)),
        db.select().from(checkpoints).where(eq(checkpoints.workflowRunId, workflowRunId)).orderBy(asc(checkpoints.id)),
        db.select().from(decisions).where(eq(decisions.workflowRunId, workflowRunId)).orderBy(asc(decisions.id)),
        db.select().from(events).where(and(
          eq(events.workflowRunId, workflowRunId),
          notInArray(events.type, EPHEMERAL_EVENT_TYPES),
        )).orderBy(asc(events.id)),
      ]);
      return sendJson(response, 200, { data: { ...run, plans: runPlans, tasks: runTasks, sessions: runSessions, checkpoints: runCheckpoints, decisions: runDecisions, events: runEvents } });
    }

    if (request.method === 'POST' && url.pathname === '/api/workflow-runs') {
      const body = await readJson(request);
      const workflowId = typeof body.workflowId === 'number' ? body.workflowId : Number(body.workflowId);
      if (!Number.isInteger(workflowId) || workflowId < 1) {
        return sendJson(response, 400, { error: 'workflowId is required' });
      }
      const workflowRows = await db.select({
        projectId: workflows.projectId,
        currentVersionId: workflows.currentVersionId,
      }).from(workflows).where(eq(workflows.id, workflowId));
      const workflow = workflowRows[0];
      if (!workflow) return sendJson(response, 404, { error: 'Workflow not found' });
      await ensureLegacyWorkflowVersion(workflowId).catch(() => undefined);
      const versionOwner = (await db.select({ currentVersionId: workflows.currentVersionId }).from(workflows).where(eq(workflows.id, workflowId)).limit(1))[0];
      const workflowVersionId = versionOwner?.currentVersionId ?? workflow.currentVersionId ?? undefined;
      const existingRun = (await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).limit(1))[0];
      if (existingRun) {
        if (workflowVersionId && existingRun.workflowVersionId !== workflowVersionId) {
          await db.update(workflowRuns).set({ workflowVersionId }).where(eq(workflowRuns.id, existingRun.id));
        }
        return sendJson(response, 200, { id: existingRun.id, workflowId, status: existingRun.status, existing: true });
      }
      const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).orderBy(asc(workflowNodes.id));
      if (nodes.length === 0) return sendJson(response, 400, { error: 'Workflow has no executable nodes' });
      const idempotencyKey = requiredString(body, 'idempotencyKey');
      if (idempotencyKey) {
        const existing = (await db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, idempotencyKey)).limit(1))[0];
        if (existing) return sendJson(response, 200, { ...existing, idempotent: true });
      }
      const edges = await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId)).orderBy(asc(workflowEdges.id));
      const createdRun = await db.transaction(async (tx) => {
        const result = await tx.insert(workflowRuns).values({
          workflowId,
          workflowVersionId,
          status: 'pending',
          idempotencyKey,
          inputJson: body.inputJson,
        });
        const workflowRunId = result[0].insertId;
        const planResult = await tx.insert(plans).values({
          workflowRunId,
          version: 1,
          graphJson: { nodes: nodes.map((node) => node.id), edges: edges.map((edge) => ({ source: edge.sourceNodeId, target: edge.targetNodeId })) },
        });
        const planId = planResult[0].insertId;
        const planned = [];
        for (const node of nodes) {
          const dependsOnNodeIds = edges.filter((edge) => edge.targetNodeId === node.id).map((edge) => edge.sourceNodeId);
          const capabilities = storedNodeCapabilityKeys(node);
          if (capabilities.length === 0 && node.nodeType !== 'start' && node.nodeType !== 'end') throw new OrviaError(`请为 Agent「${node.name}」选择能力`, 'validation', 400);
          const nodeConfig = withoutLegacySkill(jsonObject(node.configJson));
          const inputJson: Record<string, unknown> = {
            ...(jsonObject(body.inputJson)),
            ...nodeConfig,
            capabilities,
            capability: capabilities[0],
            workflowNodeId: node.id,
            nodeType: node.nodeType,
            dependsOnNodeIds,
          };
          delete inputJson.skill;
          const taskResult = await tx.insert(tasks).values({
            workflowRunId,
            planId,
            workflowNodeId: node.id,
            name: node.name,
            status: dependsOnNodeIds.length > 0 ? 'blocked' : 'pending',
            maxRetries: typeof nodeConfig.maxRetries === 'number' ? nodeConfig.maxRetries : 0,
            inputJson,
          });
          const taskId = taskResult[0].insertId;
          const sessionResult = await tx.insert(sessions).values({
            taskId,
            runtime: 'pi',
            status: 'pending',
            inputJson,
          });
          planned.push({ nodeId: node.id, taskId, sessionId: sessionResult[0].insertId, capabilities, capability: capabilities[0], nodeType: node.nodeType, dependsOnNodeIds });
        }
        return { workflowRunId, planId, planned };
      });
      const { workflowRunId, planId, planned } = createdRun;
      await rememberRunStatus(workflowRunId, 'pending', workflowId);
      await persistAndBroadcastEvent({
        projectId: workflow.projectId,
        workflowRunId,
        type: 'workflow.planned',
        payloadJson: { planId, version: 1, nodeCount: planned.length, tasks: planned },
      });
      return sendJson(response, 201, { id: workflowRunId, workflowId, planId, status: 'pending', planned });
    }

    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      const workflowRunId = queryId(url, 'workflowRunId');
      const rows = workflowRunId
        ? await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId)).orderBy(asc(tasks.id))
        : await db.select().from(tasks).orderBy(asc(tasks.id));
      return sendJson(response, 200, { data: rows });
    }

    const taskDetailMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (request.method === 'GET' && taskDetailMatch) {
      const taskId = Number(taskDetailMatch[1]);
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
      if (!task) return sendJson(response, 404, { error: 'Task not found' });
      const taskSessions = await db.select().from(sessions).where(eq(sessions.taskId, taskId)).orderBy(asc(sessions.id));
      return sendJson(response, 200, { data: { ...task, sessions: taskSessions } });
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readJson(request);
      const workflowRunId = typeof body.workflowRunId === 'number' ? body.workflowRunId : Number(body.workflowRunId);
      const agentId = body.agentId === undefined ? undefined : Number(body.agentId);
      const validAgentId = Number.isInteger(agentId) && (agentId ?? 0) > 0 ? agentId : undefined;
      const name = requiredString(body, 'name');
      if (!Number.isInteger(workflowRunId) || workflowRunId < 1 || !name) {
        return sendJson(response, 400, { error: 'workflowRunId and name are required' });
      }
      const result = await db.insert(tasks).values({
        workflowRunId,
        agentId: validAgentId,
        name,
        inputJson: body.inputJson,
      });
      return sendJson(response, 201, { id: result[0].insertId, workflowRunId, name, status: 'pending' });
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const taskId = queryId(url, 'taskId');
      const rows = taskId
        ? await db.select().from(sessions).where(eq(sessions.taskId, taskId)).orderBy(asc(sessions.id))
        : await db.select().from(sessions).orderBy(asc(sessions.id));
      return sendJson(response, 200, { data: rows });
    }

    const sessionDetailMatch = url.pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (request.method === 'GET' && sessionDetailMatch) {
      const sessionId = Number(sessionDetailMatch[1]);
      const session = (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
      if (!session) return sendJson(response, 404, { error: 'Session not found' });
      const sessionEvents = await db.select().from(events).where(and(
        eq(events.sessionId, sessionId),
        notInArray(events.type, EPHEMERAL_EVENT_TYPES),
      )).orderBy(asc(events.id));
      return sendJson(response, 200, { data: { ...session, events: sessionEvents } });
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJson(request);
      const taskId = typeof body.taskId === 'number' ? body.taskId : Number(body.taskId);
      const agentId = body.agentId === undefined ? undefined : Number(body.agentId);
      const validAgentId = Number.isInteger(agentId) && (agentId ?? 0) > 0 ? agentId : undefined;
      if (!Number.isInteger(taskId) || taskId < 1) {
        return sendJson(response, 400, { error: 'taskId is required' });
      }
      const result = await db.insert(sessions).values({
        taskId,
        agentId: validAgentId,
        runtime: typeof body.runtime === 'string' ? body.runtime : 'pi',
        status: 'pending',
        inputJson: body.inputJson,
      });
      return sendJson(response, 201, { id: result[0].insertId, taskId, status: 'pending', runtime: body.runtime ?? 'pi' });
    }

    const taskActionMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/(pause|resume|retry)$/);
    if (request.method === 'POST' && taskActionMatch) {
      const taskId = Number(taskActionMatch[1]);
      const action = taskActionMatch[2];
      if (action === 'retry') {
        const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
        if (!task) return sendJson(response, 404, { error: 'Task not found' });
        if (task.status !== 'failed' && task.status !== 'paused') return sendJson(response, 409, { error: 'Only failed or paused tasks can be retried' });
        requireTaskTransition(task.status, 'pending');
        const previousSession = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)).orderBy(desc(sessions.id)).limit(1))[0];
        const sessionId = await db.transaction(async (tx) => {
          const newSession = await tx.insert(sessions).values({
            taskId,
            agentId: task.agentId,
            runtime: previousSession?.runtime ?? 'pi',
            status: 'pending',
            inputJson: previousSession?.inputJson ?? task.inputJson,
          });
          await tx.update(tasks).set({ status: 'pending', retryCount: task.retryCount + 1, errorKind: null }).where(eq(tasks.id, taskId));
          if (task.workflowRunId) await tx.update(workflowRuns).set({ status: 'paused', completedAt: null, errorJson: null }).where(eq(workflowRuns.id, task.workflowRunId));
          return newSession[0].insertId;
        });
        if (task.workflowRunId) await rememberRunStatus(task.workflowRunId, 'paused');
        return sendJson(response, 201, { id: taskId, status: 'pending', sessionId });
      }
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
      if (!task) return sendJson(response, 404, { error: 'Task not found' });
      const status = action === 'pause' ? 'paused' : 'running';
      requireTaskTransition(task.status, status);
      const taskSession = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId)).orderBy(desc(sessions.id)).limit(1))[0];
      if (taskSession) {
        const runtimeResult = action === 'pause'
          ? await piRuntime.pause(taskSession.id)
          : await piRuntime.resume(taskSession.id);
        if (runtimeResult.status === 'failed' && runtimeResult.message !== 'Pi process is not running') {
          return sendJson(response, 409, { id: taskId, status: 'failed', message: runtimeResult.message });
        }
        await db.update(sessions).set({ status: action === 'pause' ? 'paused' : 'running' }).where(eq(sessions.id, taskSession.id));
      }
      await db.update(tasks).set({ status }).where(eq(tasks.id, taskId));
      return sendJson(response, 200, { id: taskId, status });
    }

    const sessionActionMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/(start|pause|resume)$/);
    if (request.method === 'POST' && sessionActionMatch) {
      const sessionId = Number(sessionActionMatch[1]);
      const action = sessionActionMatch[2];
      const sessionRows = await db
        .select({
          sessionId: sessions.id,
          taskId: sessions.taskId,
          agentId: sessions.agentId,
          inputJson: sessions.inputJson,
          taskInputJson: tasks.inputJson,
          workflowRunId: workflowRuns.id,
          projectId: workflows.projectId,
          workflowId: workflows.id,
        })
        .from(sessions)
        .innerJoin(tasks, eq(tasks.id, sessions.taskId))
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
        .where(eq(sessions.id, sessionId));
      const session = sessionRows[0];
      if (!session) return sendJson(response, 404, { error: 'Session not found' });
      if (!session.taskId) return sendJson(response, 400, { error: 'Direct chat sessions are controlled through /api/chat/threads/:id/messages' });
      const workflowTaskId = session.taskId;
      if (action === 'start') {
        const latest = (await db.select({ id: sessions.id }).from(sessions)
          .where(eq(sessions.taskId, workflowTaskId)).orderBy(desc(sessions.id)).limit(1))[0];
        if (latest?.id !== sessionId) return sendJson(response, 409, { error: 'Only the latest task session can be started' });
        const task = (await db.select().from(tasks).where(eq(tasks.id, workflowTaskId)))[0];
        if (!task) return sendJson(response, 404, { error: 'Task not found' });
        if (!['pending', 'paused', 'failed'].includes(task.status)) {
          return sendJson(response, 409, { error: `Task cannot be started from status ${task.status}` });
        }
        const result = await executeAgentTask(session.projectId, session.workflowRunId, task);
        return sendJson(response, result.status === 'failed' ? 409 : 200, result);
      }
      const result = action === 'pause'
        ? await piRuntime.pause(sessionId)
        : await piRuntime.resume(sessionId);
      await db.update(sessions).set({
        status: result.status,
        startedAt: result.status === 'running' ? new Date() : undefined,
      }).where(eq(sessions.id, sessionId));
      await db.update(tasks).set({
        status: result.status === 'running' ? 'running' : result.status,
      }).where(eq(tasks.id, workflowTaskId));
      return sendJson(response, 200, result);
    }

    const executeRunMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/execute$/);
    if (request.method === 'POST' && executeRunMatch) {
      const workflowRunId = Number(executeRunMatch[1]);
      const run = (await db.select({ status: workflowRuns.status, workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
      if (!run) return sendJson(response, 404, { error: 'Workflow run not found' });
      if (run.status === 'running') {
        return sendJson(response, 409, { error: '当前 Run 正在运行，请先停止后再执行' });
      }
      const body = await readJson(request);
      const mode = body.mode === 'restart' || body.mode === 'resume' ? body.mode : undefined;
      if (!mode && run.status !== 'pending') {
        return sendJson(response, 400, { error: '请选择从头开始，或从当前暂停的 Agent 继续' });
      }
      if (mode === 'resume') {
        if (run.status === 'awaiting_decision') {
          return sendJson(response, 409, { error: '当前在等待确认。请先在面板上处理待确认，或选择从头开始。' });
        }
        await assertResumePossible(workflowRunId, run.workflowId);
      }
      requireRunTransition(run.status, 'running');
      if (executingWorkflowRuns.has(workflowRunId)) {
        return sendJson(response, 409, { error: '当前 Run 正在运行，请先停止后再执行' });
      }
      if (!(await redisRuntime().acquireLock(`run:${workflowRunId}`, 3600))) {
        return sendJson(response, 409, { error: '当前 Run 正在运行，请先停止后再执行' });
      }
      scheduleWorkflowExecution(workflowRunId, mode);
      return sendJson(response, 202, { workflowRunId, status: 'accepted' });
    }

    const runActionMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/(pause|resume|replan|stop)$/);
    if (request.method === 'POST' && runActionMatch) {
      const workflowRunId = Number(runActionMatch[1]);
      const action = runActionMatch[2];
      const run = (await db.select({ status: workflowRuns.status, workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
      if (!run) return sendJson(response, 404, { error: 'Workflow run not found' });
      if (action === 'replan') {
        if (run.status === 'completed' || run.status === 'cancelled') {
          return sendJson(response, 409, { error: `Workflow run cannot be replanned from status ${run.status}` });
        }
        requireRunTransition(run.status, 'paused');
        const body = await readJson(request);
        const reason = requiredString(body, 'reason') ?? 'Human requested replan';
        const definition = body.definitionJson && typeof body.definitionJson === 'object' && !Array.isArray(body.definitionJson)
          ? body.definitionJson as Record<string, unknown>
          : undefined;
        const replanned = await replanWorkflowRun(workflowRunId, reason, definition);
        const execution = body.resume === false ? undefined : scheduleWorkflowExecution(workflowRunId);
        return sendJson(response, 200, { ...replanned, execution });
      }
      if (action === 'stop') {
        if (!['pending', 'running', 'paused', 'awaiting_decision'].includes(run.status)) {
          return sendJson(response, 409, { error: `当前 Run 是「${run.status}」，只有待处理、运行中、已暂停或等待决策时可以停止` });
        }
        requireRunTransition(run.status, 'cancelled');
        await stopActiveWorkflowSessions(workflowRunId);
        const openTaskStatuses = ['pending', 'blocked', 'running', 'paused', 'awaiting_decision'] as const;
        const openTasks = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workflowRunId, workflowRunId), inArray(tasks.status, [...openTaskStatuses])));
        const openTaskIds = openTasks.map((task) => task.id);
        await db.transaction(async (tx) => {
          await tx.update(workflowRuns).set({ status: 'cancelled', completedAt: new Date() }).where(eq(workflowRuns.id, workflowRunId));
          await tx.update(workflows).set({ runStatus: 'cancelled' }).where(eq(workflows.id, run.workflowId));
          if (openTaskIds.length > 0) {
            await tx.update(tasks).set({ status: 'cancelled' }).where(inArray(tasks.id, openTaskIds));
            await tx.update(sessions).set({ status: 'failed', completedAt: new Date(), outputJson: { error: 'Run 已停止' } }).where(and(inArray(sessions.taskId, openTaskIds), inArray(sessions.status, ['pending', 'running', 'paused'])));
          }
          await tx.update(checkpoints).set({ status: 'superseded' }).where(and(eq(checkpoints.workflowRunId, workflowRunId), eq(checkpoints.status, 'pending')));
          await tx.update(decisions).set({ status: 'superseded', resolvedAt: new Date() }).where(and(eq(decisions.workflowRunId, workflowRunId), eq(decisions.status, 'pending')));
        });
        const workflow = (await db.select({ projectId: workflows.projectId }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).where(eq(workflowRuns.id, workflowRunId)))[0];
        if (workflow) {
          await persistAndBroadcastEvent({ projectId: workflow.projectId, workflowRunId, type: 'workflow.stopped', payloadJson: { status: 'cancelled' } });
        }
        return sendJson(response, 200, { id: workflowRunId, status: 'cancelled' });
      }
      if (action === 'pause' && run.status !== 'running') {
        return sendJson(response, 409, { error: `Workflow run cannot pause from status ${run.status}` });
      }
      if (action === 'resume' && run.status !== 'paused') {
        return sendJson(response, 409, {
          error: run.status === 'awaiting_decision'
            ? 'Resolve the pending decision instead of resuming this workflow run'
            : `Workflow run cannot resume from status ${run.status}`,
        });
      }
      const status = action === 'pause' ? 'paused' : 'running';
      requireRunTransition(run.status, status);
      const activeSessionIds = [...(activeWorkflowSessions.get(workflowRunId) ?? [])];
      for (const activeSessionId of activeSessionIds) {
        const runtimeResult = action === 'pause'
          ? await piRuntime.pause(activeSessionId)
          : await piRuntime.resume(activeSessionId);
        if (runtimeResult.status === 'failed' && runtimeResult.message !== 'Pi process is not running') {
          return sendJson(response, 409, { id: workflowRunId, status: 'failed', message: runtimeResult.message });
        }
      }
      await db.update(workflowRuns).set({ status }).where(eq(workflowRuns.id, workflowRunId));
      await rememberRunStatus(workflowRunId, status, run.workflowId);
      if (action === 'resume' && activeSessionIds.length === 0) scheduleWorkflowExecution(workflowRunId);
      return sendJson(response, 200, { id: workflowRunId, status });
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      const projectId = queryId(url, 'projectId');
      const { limit, offset } = queryPage(url);
      const rows = projectId
        ? await db.select().from(events).where(eq(events.projectId, projectId)).orderBy(desc(events.id)).limit(limit).offset(offset)
        : await db.select().from(events).orderBy(desc(events.id)).limit(limit).offset(offset);
      return sendJson(response, 200, { data: rows, page: { limit, offset } });
    }

    if (request.method === 'POST' && url.pathname === '/api/events') {
      const body = await readJson(request);
      const projectId = typeof body.projectId === 'number' ? body.projectId : Number(body.projectId);
      const type = requiredString(body, 'type');
      if (!Number.isInteger(projectId) || projectId < 1 || !type) {
        return sendJson(response, 400, { error: 'projectId and type are required' });
      }
      const result = await db.insert(events).values({
        projectId,
        workflowRunId: body.workflowRunId === undefined ? undefined : Number(body.workflowRunId),
        taskId: body.taskId === undefined ? undefined : Number(body.taskId),
        sessionId: body.sessionId === undefined ? undefined : Number(body.sessionId),
        agentId: body.agentId === undefined ? undefined : Number(body.agentId),
        type,
        payloadJson: body.payloadJson,
      });
      broadcastEvent({
        id: result[0].insertId,
        projectId,
        workflowRunId: body.workflowRunId,
        taskId: body.taskId,
        sessionId: body.sessionId,
        agentId: body.agentId,
        type,
        payload: body.payloadJson,
      }, projectId);
      return sendJson(response, 201, { id: result[0].insertId, projectId, type });
    }


    if (request.method === 'GET' && url.pathname === '/api/checkpoints') {
      const projectId = queryId(url, 'projectId');
      const rows = projectId
        ? await db.select().from(checkpoints).where(eq(checkpoints.projectId, projectId)).orderBy(desc(checkpoints.id))
        : await db.select().from(checkpoints).orderBy(desc(checkpoints.id));
      return sendJson(response, 200, { data: rows });
    }


    if (request.method === 'GET' && url.pathname === '/api/decisions') {
      const projectId = queryId(url, 'projectId');
      const rows = projectId
        ? await db.select().from(decisions).where(eq(decisions.projectId, projectId)).orderBy(asc(decisions.id))
        : await db.select().from(decisions).orderBy(asc(decisions.id));
      return sendJson(response, 200, { data: rows });
    }

    if (request.method === 'POST' && url.pathname === '/api/decisions') {
      const body = await readJson(request);
      const projectId = typeof body.projectId === 'number' ? body.projectId : Number(body.projectId);
      const question = requiredString(body, 'question');
      if (!Number.isInteger(projectId) || projectId < 1 || !question) {
        return sendJson(response, 400, { error: 'projectId and question are required' });
      }
      const result = await db.insert(decisions).values({
        projectId,
        workflowRunId: body.workflowRunId === undefined ? undefined : Number(body.workflowRunId),
        checkpointId: body.checkpointId === undefined ? undefined : Number(body.checkpointId),
        question,
        contextJson: body.contextJson,
      });
      const workflowRunId = body.workflowRunId === undefined ? undefined : Number(body.workflowRunId);
      if (workflowRunId && Number.isInteger(workflowRunId)) {
        for (const activeSessionId of activeWorkflowSessions.get(workflowRunId) ?? []) {
          await piRuntime.pause(activeSessionId);
        }
        await db.update(workflowRuns).set({ status: 'awaiting_decision' }).where(eq(workflowRuns.id, workflowRunId));
        await rememberRunStatus(workflowRunId, 'awaiting_decision');
      }
      return sendJson(response, 201, { id: result[0].insertId, projectId, status: 'pending' });
    }

    const decisionMatch = url.pathname.match(/^\/api\/decisions\/(\d+)\/resolve$/);
    if (request.method === 'POST' && decisionMatch) {
      const decisionId = Number(decisionMatch[1]);
      const body = await readJson(request);
      const decision = requiredString(body, 'decision');
      const action = ['approve', 'request_changes', 'reject', 'override', 'replan', 'repeat'].includes(String(body.action))
        ? String(body.action) as 'approve' | 'request_changes' | 'reject' | 'override' | 'replan' | 'repeat'
        : body.status === 'rejected' ? 'reject' : 'approve';
      const status = action === 'approve' ? 'approved'
        : action === 'request_changes' || action === 'replan' || action === 'repeat' ? 'changes_requested'
          : action === 'override' ? 'overridden' : 'rejected';
      if (!decision) return sendJson(response, 400, { error: 'decision is required' });
      const row = (await db.select().from(decisions).where(eq(decisions.id, decisionId)))[0];
      if (!row) return sendJson(response, 404, { error: 'Decision not found' });
      if (row.status !== 'pending') return sendJson(response, 409, { error: 'Decision is already resolved' });
      await db.transaction(async (tx) => {
        const claimed = await tx.update(decisions).set({ decision, action, status, resolvedAt: new Date() })
          .where(and(eq(decisions.id, decisionId), eq(decisions.status, 'pending')));
        if (claimed[0].affectedRows !== 1) {
          throw new OrviaError('Decision is already resolved', 'conflict', 409);
        }
        if (row.checkpointId) {
          await tx.update(checkpoints).set({
            status: action === 'approve' ? 'approved'
              : action === 'override' ? 'overridden'
                : action === 'request_changes' || action === 'replan' || action === 'repeat' ? 'changes_requested' : 'rejected',
            resolvedAt: new Date(),
          }).where(eq(checkpoints.id, row.checkpointId));
        }
      });
      if (row.workflowRunId) {
        const decisionContext = jsonObject(row.contextJson);
        if (decisionContext.kind === 'acceptance') {
          const checkerTaskId = Number(decisionContext.checkerTaskId);
          if (action === 'repeat') {
            const owner = (await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, row.workflowRunId)))[0];
            const checker = checkerTaskId ? (await db.select().from(tasks).where(eq(tasks.id, checkerTaskId)))[0] : undefined;
            const targets = Array.isArray(decisionContext.targets) ? decisionContext.targets : [];
            const items = targets.flatMap((item) => {
              const record = jsonObject(item);
              const taskId = Number(record.taskId);
              const key = typeof record.key === 'string' ? record.key : '';
              if (!taskId || !key) return [];
              return [{
                taskId,
                key,
                name: typeof record.name === 'string' ? record.name : key,
                nodeType: typeof record.nodeType === 'string' ? record.nodeType : 'task',
                reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason : decision,
              }];
            });
            if (owner && checker) await sendAcceptanceBack(row.projectId, owner.workflowId, row.workflowRunId, checker, items);
          } else if (action === 'approve' || action === 'override') {
            await waiveAcceptance(checkerTaskId, decision);
          } else {
            await db.update(workflowRuns).set({ status: 'failed', errorJson: { decisionId, decision }, completedAt: new Date() }).where(eq(workflowRuns.id, row.workflowRunId));
            await rememberRunStatus(row.workflowRunId, 'failed');
            await persistAndBroadcastEvent({ projectId: row.projectId, workflowRunId: row.workflowRunId, type: `decision.${action}`, payloadJson: { decisionId, decision } });
            return sendJson(response, 200, { id: decisionId, decision, action, status });
          }
          await db.update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, row.workflowRunId));
          await rememberRunStatus(row.workflowRunId, 'paused');
          scheduleWorkflowExecution(row.workflowRunId);
          await persistAndBroadcastEvent({ projectId: row.projectId, workflowRunId: row.workflowRunId, type: `decision.${action}`, payloadJson: { decisionId, decision } });
          return sendJson(response, 200, { id: decisionId, decision, action, status });
        }
        if (action === 'repeat') {
          const outcome = await repeatWorkflowLoop(row.workflowRunId, row.checkpointId);
          if (outcome === 'exhausted') {
            await db.update(workflowRuns).set({ status: 'failed', errorJson: { error: '循环次数已用尽' }, completedAt: new Date() }).where(eq(workflowRuns.id, row.workflowRunId));
            await rememberRunStatus(row.workflowRunId, 'failed');
          } else {
            scheduleWorkflowExecution(row.workflowRunId);
          }
        } else if (action === 'replan' || action === 'request_changes') {
          await replanWorkflowRun(row.workflowRunId, decision);
          scheduleWorkflowExecution(row.workflowRunId);
        } else if (action === 'reject') {
          queuedWorkflowRuns.delete(row.workflowRunId);
          await stopActiveWorkflowSessions(row.workflowRunId);
          const current = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, row.workflowRunId)))[0];
          if (current) requireRunTransition(current.status, 'failed');
          await db.update(workflowRuns).set({ status: 'failed', errorJson: { decisionId, decision }, completedAt: new Date() }).where(eq(workflowRuns.id, row.workflowRunId));
          await rememberRunStatus(row.workflowRunId, 'failed');
        } else {
          if (row.checkpointId) {
            const checkpoint = (await db.select().from(checkpoints).where(eq(checkpoints.id, row.checkpointId)))[0];
            if (checkpoint?.taskId) await db.update(tasks).set({ status: 'completed', outputJson: { decisionId, action } }).where(eq(tasks.id, checkpoint.taskId));
          }
          await db.update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, row.workflowRunId));
          await rememberRunStatus(row.workflowRunId, 'paused');
          scheduleWorkflowExecution(row.workflowRunId);
        }
        await persistAndBroadcastEvent({ projectId: row.projectId, workflowRunId: row.workflowRunId, type: `decision.${action}`, payloadJson: { decisionId, decision } });
      }
      return sendJson(response, 200, { id: decisionId, decision, action, status });
    }

    if (request.method === 'GET' && url.pathname === '/api/control-center') {
      const projectId = queryId(url, 'projectId');
      const agentCount = projectId
        ? await db.select({ value: count() }).from(agents).where(eq(agents.projectId, projectId))
        : await db.select({ value: count() }).from(agents);
      const workflowCount = projectId
        ? await db.select({ value: count() }).from(workflows).where(eq(workflows.projectId, projectId))
        : await db.select({ value: count() }).from(workflows);
      const pendingDecisionCount = projectId
        ? await db.select({ value: count() }).from(decisions).where(and(eq(decisions.projectId, projectId), eq(decisions.status, 'pending')))
        : await db.select({ value: count() }).from(decisions).where(eq(decisions.status, 'pending'));
      const eventCount = projectId
        ? await db.select({ value: count() }).from(events).where(eq(events.projectId, projectId))
        : await db.select({ value: count() }).from(events);
      const checkpointCount = projectId
        ? await db.select({ value: count() }).from(checkpoints).where(and(eq(checkpoints.projectId, projectId), eq(checkpoints.status, 'pending')))
        : await db.select({ value: count() }).from(checkpoints).where(eq(checkpoints.status, 'pending'));
      const recentEvents = projectId
        ? await db.select().from(events).where(and(eq(events.projectId, projectId), notInArray(events.type, EPHEMERAL_EVENT_TYPES))).orderBy(desc(events.id)).limit(20)
        : await db.select().from(events).where(notInArray(events.type, EPHEMERAL_EVENT_TYPES)).orderBy(desc(events.id)).limit(20);
      return sendJson(response, 200, {
        projectId: projectId ?? null,
        counts: {
          agents: Number(agentCount[0]?.value ?? 0),
          workflows: Number(workflowCount[0]?.value ?? 0),
          decisions: Number(pendingDecisionCount[0]?.value ?? 0),
          events: Number(eventCount[0]?.value ?? 0),
          checkpoints: Number(checkpointCount[0]?.value ?? 0),
        },
        recentEvents,
      });
    }

    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', type: 'http.error', requestId, method: request.method, path: url.pathname, message: error instanceof Error ? error.message : String(error) }));
    if (error instanceof OrviaError) {
      return sendJson(response, error.statusCode, { error: error.message, kind: error.kind, details: error.details });
    }
    return sendJson(response, 500, { error: 'Internal server error' });
  }
}

async function backfillWorkflowRunStatus() {
  const rows = await db.select({ workflowId: workflowRuns.workflowId, status: workflowRuns.status }).from(workflowRuns);
  for (const row of rows) {
    await db.update(workflows).set({ runStatus: row.status }).where(eq(workflows.id, row.workflowId));
  }
}

async function recoverInterruptedExecutions() {
  const interruptedRuns = await db.select({ id: workflowRuns.id, workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.status, 'running'));
  for (const run of interruptedRuns) {
    const runningTaskIds = (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workflowRunId, run.id), eq(tasks.status, 'running')))).map((task) => task.id);
    if (runningTaskIds.length > 0) {
      await db.update(sessions).set({
        status: 'failed',
        outputJson: { error: 'API process restarted while runtime session was active', recoverable: true },
        completedAt: new Date(),
      }).where(inArray(sessions.taskId, runningTaskIds));
    }
    await db.update(tasks).set({ status: 'paused', errorKind: 'human_required' }).where(and(eq(tasks.workflowRunId, run.id), eq(tasks.status, 'running')));
    await db.update(workflowRuns).set({ status: 'paused', errorJson: { reason: 'process_restart', recoverable: true } }).where(eq(workflowRuns.id, run.id));
    await db.update(workflows).set({ runStatus: 'paused' }).where(eq(workflows.id, run.workflowId));
    await redisRuntime().releaseLock(`run:${run.id}`);
  }
}

async function releaseIdleRunLocks() {
  const runs = await db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns);
  for (const run of runs) {
    if (run.status !== 'running') await redisRuntime().releaseLock(`run:${run.id}`);
  }
}

const server = createServer(handler);
server.on('upgrade', (request, socket) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`);
    if (url.pathname !== '/api/events/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const auth = await resolveAuth(request, url);
    if (!auth) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!acceptWebSocket(request, socket)) return;
    const projectId = queryId(url, 'projectId');
    if (projectId) {
      try {
        await assertProjectInTenant(projectId, auth.tenantId);
      } catch {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
    }
    const client = { socket, projectId };
    socketClients.add(client);
    sendWebSocketText(socket, JSON.stringify({ type: 'ready', projectId: projectId ?? null }));
    const remove = () => socketClients.delete(client);
    socket.on('close', remove);
    socket.on('error', remove);
    socket.on('end', remove);
  })();
});
async function startServer() {
  await ensureTables();
  await migrateCapabilitiesToTenant();
  await repairSchema();
  await repairEnums();
  await backfillWorkflowRunStatus();
  const schemaIssues = await schemaIntegrityIssues();
  if (schemaIssues.length > 0) throw new Error(`Database schema is incomplete: ${schemaIssues.join(', ')}`);
  await bootstrapTenancy();
  await ensureTenantCapabilities(await defaultTenantId());
  await connectRedis();
  await redisRuntime().subscribe('orvia:events', (message) => {
    const envelope = JSON.parse(message) as { projectId: number };
    broadcastEvent(envelope, envelope.projectId);
  });
  await recoverInterruptedExecutions();
  await releaseIdleRunLocks();
  server.listen(config.port, config.host, () => {
    console.log(`Orvia API listening at http://${config.host}:${config.port}`);
  });
}

void startServer().catch(async (error) => {
  console.error('Failed to start Orvia API', error);
  await pool.end();
  process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  await piRuntime.shutdown();
  await redisRuntime().close();
  for (const client of eventClients) {
    client.response.end();
  }
  eventClients.clear();
  for (const client of socketClients) {
    client.socket.end();
  }
  socketClients.clear();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
