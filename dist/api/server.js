import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { acceptWebSocket, sendWebSocketText } from './websocket.js';
import { db, pool } from '../db/client.js';
import { agentVersions, agents, artifacts, artifactVersions, budgets, chatMessages, chatThreads, checkpoints, decisions, events, memories, modelProviders, models, permissionPolicies, plans, projects, sessions, tasks, workflowEdges, workflowNodes, workflowRuns, workflows, } from '../db/schema.js';
import { OrviaError } from '../domain/errors.js';
import { assertRunTransition, assertTaskTransition } from '../domain/state-machine.js';
import { reserveBudgetUnits } from '../application/budget-service.js';
import { resolveAgentModel } from '../application/model-resolver.js';
import { assertWorkingDirectoryAllowed } from '../application/runtime-policy.js';
import { assertAcyclicGraph, graphIsComplete, selectRunnableTasks } from '../application/task-graph.js';
import { ensureTables, repairSchema, schemaIntegrityIssues } from '../db/ensure-schema.js';
import { piRuntime } from '../runtime/pi-adapter.js';
function sendJson(response, status, payload) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': config.webOrigin,
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
    });
    response.end(JSON.stringify(payload));
}
function requireRunTransition(from, to) {
    try {
        assertRunTransition(from, to);
    }
    catch {
        throw new OrviaError(`Workflow run cannot transition from ${from} to ${to}`, 'conflict', 409);
    }
}
function requireTaskTransition(from, to) {
    try {
        assertTaskTransition(from, to);
    }
    catch {
        throw new OrviaError(`Task cannot transition from ${from} to ${to}`, 'conflict', 409);
    }
}
const eventClients = new Set();
const socketClients = new Set();
const activeWorkflowSessions = new Map();
const executingWorkflowRuns = new Set();
const queuedWorkflowRuns = new Set();
const activeChatThreads = new Set();
function scheduleWorkflowExecution(workflowRunId) {
    if (executingWorkflowRuns.has(workflowRunId)) {
        queuedWorkflowRuns.add(workflowRunId);
        return 'queued';
    }
    executingWorkflowRuns.add(workflowRunId);
    void executeWorkflowRun(workflowRunId)
        .catch(async (error) => {
        console.error('Workflow execution failed', error);
        await db.update(workflowRuns).set({
            status: 'failed',
            errorJson: { error: error instanceof Error ? error.message : 'Workflow execution failed' },
            completedAt: new Date(),
        }).where(eq(workflowRuns.id, workflowRunId));
    })
        .finally(() => {
        executingWorkflowRuns.delete(workflowRunId);
        if (queuedWorkflowRuns.delete(workflowRunId))
            scheduleWorkflowExecution(workflowRunId);
    });
    return 'started';
}
async function stopActiveWorkflowSessions(workflowRunId) {
    const sessionIds = [...(activeWorkflowSessions.get(workflowRunId) ?? [])];
    await Promise.all(sessionIds.map(async (sessionId) => {
        await piRuntime.stop(sessionId);
        await piRuntime.wait(sessionId);
    }));
    activeWorkflowSessions.delete(workflowRunId);
}
const heartbeat = setInterval(() => {
    const message = `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
    for (const client of eventClients)
        client.response.write(message);
    const frame = JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() });
    for (const client of socketClients)
        sendWebSocketText(client.socket, frame);
}, 15_000);
heartbeat.unref();
function broadcastEvent(event, projectId) {
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
async function persistAndBroadcastEvent(event) {
    const result = await db.insert(events).values(event);
    const envelope = {
        id: result[0].insertId,
        projectId: event.projectId,
        workflowRunId: event.workflowRunId ?? null,
        taskId: event.taskId ?? null,
        sessionId: event.sessionId ?? null,
        agentId: event.agentId ?? null,
        type: event.type,
        payload: event.payloadJson ?? null,
        occurredAt: new Date().toISOString(),
    };
    broadcastEvent(envelope, event.projectId);
    return envelope;
}
async function executeWorkflowRun(workflowRunId) {
    const runRows = await db
        .select({ projectId: workflows.projectId, status: workflowRuns.status })
        .from(workflowRuns)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
        .where(eq(workflowRuns.id, workflowRunId));
    const run = runRows[0];
    if (!run)
        throw new Error('Workflow run not found');
    if (run.status === 'completed' || run.status === 'cancelled') {
        return { status: run.status, completedTaskIds: [] };
    }
    const initialTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId));
    if (initialTasks.length === 0)
        throw new Error('Workflow run has no tasks');
    await db.update(workflowRuns).set({ status: 'running', startedAt: new Date(), errorJson: null }).where(eq(workflowRuns.id, workflowRunId));
    const completedTaskIds = initialTasks.filter((task) => task.status === 'completed').map((task) => task.id);
    while (true) {
        const currentRun = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
        if (!currentRun || currentRun.status === 'paused' || currentRun.status === 'awaiting_decision' || currentRun.status === 'cancelled') {
            return { status: currentRun?.status ?? 'failed', completedTaskIds };
        }
        const runTasks = await db.select().from(tasks)
            .where(eq(tasks.workflowRunId, workflowRunId))
            .orderBy(asc(tasks.id));
        if (graphIsComplete(runTasks)) {
            await db.update(plans).set({ status: 'completed' }).where(and(eq(plans.workflowRunId, workflowRunId), eq(plans.status, 'active')));
            await db.update(workflowRuns).set({ status: 'completed', completedAt: new Date() }).where(eq(workflowRuns.id, workflowRunId));
            await persistAndBroadcastEvent({ projectId: run.projectId, workflowRunId, type: 'workflow.completed', payloadJson: { completedTaskIds } });
            return { status: 'completed', completedTaskIds };
        }
        const ready = selectRunnableTasks(runTasks);
        const task = ready.find((candidate) => jsonObject(candidate.inputJson).nodeType === 'checkpoint') ?? ready[0];
        const parallelTasks = ready.filter((candidate) => jsonObject(candidate.inputJson).nodeType !== 'checkpoint');
        const checkpointReady = ready.some((candidate) => jsonObject(candidate.inputJson).nodeType === 'checkpoint');
        if (parallelTasks.length > 1 || (parallelTasks.length === 1 && checkpointReady)) {
            const outcomes = await Promise.all(parallelTasks.map((candidate) => executeAgentTask(run.projectId, workflowRunId, candidate)));
            const latestRun = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
            if (!latestRun || latestRun.status === 'paused' || latestRun.status === 'cancelled') {
                return { status: latestRun?.status ?? 'failed', completedTaskIds };
            }
            for (const outcome of outcomes) {
                if (outcome.status === 'completed')
                    completedTaskIds.push(outcome.taskId);
                if (outcome.status === 'failed') {
                    await db.update(workflowRuns).set({ status: 'failed', errorJson: outcome.output, completedAt: new Date() }).where(eq(workflowRuns.id, workflowRunId));
                    return { status: 'failed', completedTaskIds, failedTaskId: outcome.taskId };
                }
            }
            continue;
        }
        if (!task) {
            const failed = runTasks.find((candidate) => candidate.status === 'failed');
            const error = failed
                ? { error: `Task ${failed.id} failed`, failedTaskId: failed.id }
                : { error: 'Task graph is blocked by unsatisfied dependencies' };
            await db.update(workflowRuns).set({ status: 'failed', errorJson: error, completedAt: new Date() }).where(eq(workflowRuns.id, workflowRunId));
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
                const latestArtifact = (await db.select({ id: artifacts.id }).from(artifacts)
                    .where(eq(artifacts.workflowRunId, workflowRunId))
                    .orderBy(desc(artifacts.id)).limit(1))[0];
                const checkpointContext = { ...input, artifactId: latestArtifact?.id };
                const checkpointId = await db.transaction(async (tx) => {
                    const checkpointResult = await tx.insert(checkpoints).values({
                        projectId: run.projectId,
                        workflowRunId,
                        taskId: task.id,
                        workflowNodeId: task.workflowNodeId,
                        title: typeof input.title === 'string' ? input.title : task.name,
                        instructions: typeof input.instructions === 'string' ? input.instructions : undefined,
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
                await persistAndBroadcastEvent({ projectId: run.projectId, workflowRunId, taskId: task.id, type: 'checkpoint.pending', payloadJson: { checkpointId } });
                return { status: 'awaiting_decision', completedTaskIds, checkpointTaskId: task.id };
            }
            await db.transaction(async (tx) => {
                await tx.update(tasks).set({ status: 'awaiting_decision' }).where(eq(tasks.id, task.id));
                await tx.update(workflowRuns).set({ status: 'awaiting_decision' }).where(eq(workflowRuns.id, workflowRunId));
            });
            return { status: 'awaiting_decision', completedTaskIds, checkpointTaskId: task.id };
        }
        const single = await executeAgentTask(run.projectId, workflowRunId, task);
        const latestRun = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
        if (!latestRun || latestRun.status === 'paused' || latestRun.status === 'cancelled') {
            return { status: latestRun?.status ?? 'failed', completedTaskIds };
        }
        if (single.status === 'completed')
            completedTaskIds.push(task.id);
        if (single.status === 'failed') {
            await db.update(workflowRuns).set({ status: 'failed', errorJson: single.output, completedAt: new Date() }).where(eq(workflowRuns.id, workflowRunId));
            return { status: 'failed', completedTaskIds, failedTaskId: task.id };
        }
        continue;
    }
}
async function executeAgentTask(projectId, workflowRunId, task) {
    const input = jsonObject(task.inputJson);
    const session = (await db.select().from(sessions).where(eq(sessions.taskId, task.id)).orderBy(desc(sessions.id)).limit(1))[0];
    if (!session)
        return { status: 'failed', taskId: task.id, output: { error: `Task ${task.id} has no session` } };
    const sessionInput = { ...input, ...jsonObject(session.inputJson) };
    let resolved;
    try {
        resolved = await resolveAgentModel({
            projectId,
            workflowRunId,
            agentId: task.agentId ?? session.agentId ?? undefined,
            capability: normalizedText(sessionInput.capability),
            skill: normalizedText(sessionInput.skill),
        });
    }
    catch (error) {
        const payload = { error: error instanceof Error ? error.message : 'Agent resolution failed' };
        await db.update(tasks).set({ status: 'failed', errorKind: 'human_required', outputJson: payload }).where(eq(tasks.id, task.id));
        await db.update(sessions).set({ status: 'failed', outputJson: payload, completedAt: new Date() }).where(eq(sessions.id, session.id));
        return { status: 'failed', taskId: task.id, output: payload };
    }
    const agentId = resolved.agent.id;
    const provider = resolved.providerType;
    const model = `${provider}/${resolved.modelName}`;
    const scopedMemories = (await db.select().from(memories).where(eq(memories.projectId, projectId)).orderBy(asc(memories.id)))
        .filter((memory) => memory.agentId === null || memory.agentId === agentId);
    const memoryContext = scopedMemories.length > 0
        ? `Controlled memory:\n${scopedMemories.map((memory) => `${memory.key}: ${memory.content}`).join('\n')}\n\n`
        : '';
    const prompt = memoryContext + (typeof sessionInput.prompt === 'string' ? sessionInput.prompt : `Execute Orvia task: ${task.name}`);
    const systemPrompt = typeof sessionInput.systemPrompt === 'string' ? sessionInput.systemPrompt : resolved.systemPrompt ?? undefined;
    let workingDirectory;
    try {
        workingDirectory = assertWorkingDirectoryAllowed(typeof sessionInput.workingDirectory === 'string' ? sessionInput.workingDirectory : undefined, resolved.runtimePolicy);
        await reserveBudgetUnits({ projectId, workflowRunId, taskId: task.id, agentId });
    }
    catch (error) {
        const payload = { error: error instanceof Error ? error.message : 'Runtime policy or budget reservation failed' };
        await db.update(tasks).set({ status: 'failed', errorKind: 'human_required', outputJson: payload }).where(eq(tasks.id, task.id));
        await db.update(sessions).set({ status: 'failed', outputJson: payload, completedAt: new Date() }).where(eq(sessions.id, session.id));
        return { status: 'failed', taskId: task.id, output: payload };
    }
    const output = [];
    await db.update(tasks).set({ agentId, status: 'running' }).where(eq(tasks.id, task.id));
    await db.update(sessions).set({ agentId, status: 'running', startedAt: new Date() }).where(eq(sessions.id, session.id));
    const active = activeWorkflowSessions.get(workflowRunId) ?? new Set();
    active.add(session.id);
    activeWorkflowSessions.set(workflowRunId, active);
    await piRuntime.start({
        sessionId: session.id,
        taskId: task.id,
        prompt,
        systemPrompt,
        provider,
        model,
        workingDirectory,
        allowedTools: resolved.runtimePolicy.allowedTools,
        deniedTools: resolved.runtimePolicy.deniedTools,
        command: typeof sessionInput.command === 'string' ? sessionInput.command : undefined,
        onEvent: (runtimeEvent) => {
            if (runtimeEvent.type === 'stdout' && typeof runtimeEvent.payload === 'string')
                output.push(runtimeEvent.payload);
            void persistAndBroadcastEvent({
                projectId,
                workflowRunId,
                taskId: task.id,
                sessionId: session.id,
                agentId,
                type: `runtime.pi.${runtimeEvent.type}`,
                payloadJson: runtimeEvent.payload,
            });
        },
    });
    const completed = await piRuntime.wait(session.id);
    active.delete(session.id);
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
            if (!canRetry)
                return undefined;
            const retrySession = await tx.insert(sessions).values({ taskId: task.id, agentId, runtime: session.runtime, status: 'pending', inputJson: session.inputJson });
            return retrySession[0].insertId;
        });
        if (retrySessionId) {
            await persistAndBroadcastEvent({ projectId, workflowRunId, taskId: task.id, sessionId: retrySessionId, agentId, type: 'task.retry_scheduled', payloadJson: { attempt: task.retryCount + 1 } });
            return { status: 'retry', taskId: task.id, output: completed };
        }
        return { status: 'failed', taskId: task.id, output: completed };
    }
    const text = output.join('');
    const artifactId = await db.transaction(async (tx) => {
        await tx.update(tasks).set({ status: 'completed', outputJson: { ...completed, text } }).where(eq(tasks.id, task.id));
        await tx.update(sessions).set({ status: 'completed', outputJson: { ...completed, text }, completedAt: new Date() }).where(eq(sessions.id, session.id));
        const artifactResult = await tx.insert(artifacts).values({ projectId, workflowRunId, taskId: task.id, sessionId: session.id, name: `${task.name} output`, kind: 'runtime-output' });
        await tx.insert(artifactVersions).values({ artifactId: artifactResult[0].insertId, version: 1, content: text || JSON.stringify(completed), createdBy: `agent:${agentId}` });
        return artifactResult[0].insertId;
    });
    await persistAndBroadcastEvent({ projectId, workflowRunId, taskId: task.id, sessionId: session.id, agentId, type: 'artifact.created', payloadJson: { artifactId, version: 1 } });
    return { status: 'completed', taskId: task.id, output: completed };
}
async function replanWorkflowRun(workflowRunId, reason, definitionJson) {
    const run = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
    if (!run)
        throw new Error('Workflow run not found');
    await db.update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, workflowRunId));
    await stopActiveWorkflowSessions(workflowRunId);
    const definitionNodes = Array.isArray(definitionJson?.nodes) ? definitionJson.nodes : [];
    const definitionEdges = Array.isArray(definitionJson?.edges) ? definitionJson.edges : [];
    const nodeKeys = definitionNodes.map((node, index) => requiredString(jsonObject(node), 'key') ?? String(index));
    if (definitionNodes.length > 0) {
        try {
            assertAcyclicGraph(nodeKeys, definitionEdges.map((edge) => ({
                source: String(jsonObject(edge).source),
                target: String(jsonObject(edge).target),
            })));
        }
        catch (error) {
            throw new OrviaError(error instanceof Error ? error.message : 'Invalid replan graph', 'validation', 400);
        }
    }
    const replanned = await db.transaction(async (tx) => {
        const oldPlans = await tx.select().from(plans).where(eq(plans.workflowRunId, workflowRunId)).orderBy(desc(plans.version));
        const version = (oldPlans[0]?.version ?? run.currentPlanVersion) + 1;
        await tx.update(plans).set({ status: 'superseded' }).where(and(eq(plans.workflowRunId, workflowRunId), eq(plans.status, 'active')));
        const previousGraph = jsonObject(oldPlans[0]?.graphJson);
        const graphJson = definitionNodes.length > 0 ? { nodes: definitionNodes, edges: definitionEdges } : previousGraph;
        const newPlan = await tx.insert(plans).values({ workflowRunId, version, reason, graphJson });
        const planId = newPlan[0].insertId;
        const openStatuses = ['pending', 'blocked', 'paused', 'awaiting_decision', 'failed', 'running'];
        if (definitionNodes.length > 0) {
            await tx.update(tasks).set({ status: 'cancelled', errorKind: null }).where(and(eq(tasks.workflowRunId, workflowRunId), inArray(tasks.status, [...openStatuses])));
            const created = new Map();
            for (const [index, node] of definitionNodes.entries()) {
                const item = jsonObject(node);
                const nodeType = item.type === 'checkpoint' ? 'checkpoint' : 'task';
                const capability = requiredString(item, 'capability') ?? (nodeType === 'checkpoint' ? 'human_review' : undefined);
                if (!capability)
                    throw new OrviaError(`Replan node ${nodeKeys[index]} requires a capability`, 'validation', 400);
                const taskResult = await tx.insert(tasks).values({
                    workflowRunId,
                    planId,
                    name: requiredString(item, 'name') ?? `Node ${index + 1}`,
                    status: 'blocked',
                    maxRetries: typeof item.maxRetries === 'number' ? item.maxRetries : 0,
                    inputJson: { ...item, capability, nodeType, dependsOnTaskIds: [] },
                });
                const taskId = taskResult[0].insertId;
                created.set(nodeKeys[index] ?? String(index), taskId);
                await tx.insert(sessions).values({ taskId, runtime: 'pi', status: 'pending', inputJson: { ...item, capability, nodeType } });
            }
            for (const [index, node] of definitionNodes.entries()) {
                const key = nodeKeys[index] ?? String(index);
                const taskId = created.get(key);
                if (!taskId)
                    continue;
                const dependencyIds = definitionEdges
                    .map((edge) => jsonObject(edge))
                    .filter((edge) => String(edge.target) === key)
                    .map((edge) => created.get(String(edge.source)))
                    .filter((id) => typeof id === 'number');
                const item = jsonObject(node);
                await tx.update(tasks).set({
                    status: dependencyIds.length > 0 ? 'blocked' : 'pending',
                    inputJson: { ...item, capability: requiredString(item, 'capability') ?? (item.type === 'checkpoint' ? 'human_review' : undefined), nodeType: item.type === 'checkpoint' ? 'checkpoint' : 'task', dependsOnTaskIds: dependencyIds },
                }).where(eq(tasks.id, taskId));
            }
        }
        else {
            await tx.update(tasks).set({ planId, status: 'pending', errorKind: null })
                .where(and(eq(tasks.workflowRunId, workflowRunId), inArray(tasks.status, ['pending', 'blocked', 'paused', 'awaiting_decision', 'failed'])));
        }
        await tx.update(checkpoints).set({ status: 'superseded', resolvedAt: new Date() })
            .where(and(eq(checkpoints.workflowRunId, workflowRunId), eq(checkpoints.status, 'pending')));
        await tx.update(decisions).set({ status: 'superseded', resolvedAt: new Date() })
            .where(and(eq(decisions.workflowRunId, workflowRunId), eq(decisions.status, 'pending')));
        await tx.update(workflowRuns).set({ status: 'paused', currentPlanVersion: version, completedAt: null, errorJson: null }).where(eq(workflowRuns.id, workflowRunId));
        return { planId, version };
    });
    const { planId, version } = replanned;
    await persistAndBroadcastEvent({ projectId: (await runProjectId(workflowRunId)), workflowRunId, type: 'workflow.replanned', payloadJson: { reason, planId, version, replacedGraph: definitionNodes.length > 0 } });
    return { workflowRunId, status: 'paused', planId, version, reason };
}
async function runProjectId(workflowRunId) {
    const row = (await db.select({ projectId: workflows.projectId }).from(workflowRuns)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
        .where(eq(workflowRuns.id, workflowRunId)))[0];
    if (!row)
        throw new Error('Workflow run not found');
    return row.projectId;
}
async function executeChatMessage(threadId, prompt) {
    const thread = (await db.select().from(chatThreads).where(eq(chatThreads.id, threadId)))[0];
    if (!thread)
        throw new Error('Chat thread not found');
    const created = await db.transaction(async (tx) => {
        const userMessage = await tx.insert(chatMessages).values({ threadId, role: 'user', content: prompt });
        const assistantMessage = await tx.insert(chatMessages).values({ threadId, role: 'assistant', content: '', status: 'streaming' });
        const runtimeSession = await tx.insert(sessions).values({
            agentId: thread.agentId,
            contextType: 'chat',
            contextId: threadId,
            runtime: 'pi',
            status: 'pending',
            inputJson: { prompt },
        });
        const sessionId = runtimeSession[0].insertId;
        await tx.update(chatMessages).set({ sessionId }).where(eq(chatMessages.id, assistantMessage[0].insertId));
        return {
            userMessageId: userMessage[0].insertId,
            assistantMessageId: assistantMessage[0].insertId,
            sessionId,
        };
    });
    const { userMessageId, assistantMessageId, sessionId } = created;
    try {
        const resolved = await resolveAgentModel({ projectId: thread.projectId, agentId: thread.agentId });
        const scopedMemories = (await db.select().from(memories).where(eq(memories.projectId, thread.projectId)).orderBy(asc(memories.id)))
            .filter((memory) => memory.agentId === null || memory.agentId === thread.agentId);
        const runtimePrompt = scopedMemories.length > 0
            ? `Controlled memory:\n${scopedMemories.map((memory) => `${memory.key}: ${memory.content}`).join('\n')}\n\n${prompt}`
            : prompt;
        const workingDirectory = assertWorkingDirectoryAllowed(undefined, resolved.runtimePolicy);
        await reserveBudgetUnits({
            projectId: thread.projectId,
            agentId: thread.agentId,
            metadataJson: { threadId, sessionId },
        });
        const output = [];
        await db.update(sessions).set({ status: 'running', startedAt: new Date() }).where(eq(sessions.id, sessionId));
        await piRuntime.start({
            sessionId,
            taskId: 0,
            prompt: runtimePrompt,
            systemPrompt: resolved.systemPrompt ?? undefined,
            provider: resolved.providerType,
            model: `${resolved.providerType}/${resolved.modelName}`,
            workingDirectory,
            allowedTools: resolved.runtimePolicy.allowedTools,
            deniedTools: resolved.runtimePolicy.deniedTools,
            onEvent: (runtimeEvent) => {
                if (runtimeEvent.type === 'stdout' && typeof runtimeEvent.payload === 'string')
                    output.push(runtimeEvent.payload);
                void persistAndBroadcastEvent({
                    projectId: thread.projectId,
                    sessionId,
                    agentId: thread.agentId,
                    type: `chat.runtime.${runtimeEvent.type}`,
                    payloadJson: { threadId, messageId: assistantMessageId, data: runtimeEvent.payload },
                });
            },
        });
        const completed = await piRuntime.wait(sessionId);
        const content = output.join('');
        await db.transaction(async (tx) => {
            await tx.update(chatMessages).set({
                content: content || completed.message || '',
                status: completed.status === 'completed' ? 'completed' : 'failed',
            }).where(eq(chatMessages.id, assistantMessageId));
            await tx.update(sessions).set({
                status: completed.status,
                outputJson: { ...completed, text: content },
                completedAt: new Date(),
            }).where(eq(sessions.id, sessionId));
        });
        return { threadId, userMessageId, assistantMessageId, sessionId, status: completed.status };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Direct chat failed';
        await db.transaction(async (tx) => {
            await tx.update(chatMessages).set({ content: message, status: 'failed' }).where(eq(chatMessages.id, assistantMessageId));
            await tx.update(sessions).set({ status: 'failed', outputJson: { error: message }, completedAt: new Date() }).where(eq(sessions.id, sessionId));
        });
        await persistAndBroadcastEvent({ projectId: thread.projectId, sessionId, agentId: thread.agentId, type: 'chat.failed', payloadJson: { threadId, message } });
        return { threadId, userMessageId, assistantMessageId, sessionId, status: 'failed' };
    }
}
async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > config.maxBodyBytes)
            throw new OrviaError('Request body exceeds 1MB', 'validation', 413);
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new OrviaError('Request body must contain valid JSON', 'validation', 400);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new OrviaError('Request body must be a JSON object', 'validation', 400);
    }
    return parsed;
}
function requiredString(body, field) {
    const value = body[field];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function jsonObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function normalizedText(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}
function queryId(url, field) {
    const raw = url.searchParams.get(field);
    if (!raw)
        return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}
function presentedToken(request, url) {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer '))
        return header.slice(7).trim();
    const queryToken = url.searchParams.get('access_token');
    return queryToken && queryToken.trim() ? queryToken.trim() : undefined;
}
function authorize(request, url) {
    if (!config.apiToken)
        return true;
    return presentedToken(request, url) === config.apiToken;
}
function queryPage(url) {
    const rawLimit = Number(url.searchParams.get('limit') ?? 50);
    const rawOffset = Number(url.searchParams.get('offset') ?? 0);
    return {
        limit: Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50,
        offset: Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0,
    };
}
async function handler(request, response) {
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
                'access-control-allow-headers': 'content-type, authorization',
            });
            return response.end();
        }
        if (!authorize(request, url) && !(request.method === 'GET' && url.pathname === '/health')) {
            return sendJson(response, 401, { error: 'Unauthorized' });
        }
        if (request.method === 'GET' && url.pathname === '/health') {
            try {
                await pool.query('SELECT 1');
                const schemaIssues = await schemaIntegrityIssues();
                if (schemaIssues.length > 0) {
                    return sendJson(response, 503, { status: 'degraded', database: 'schema_incomplete', schemaIssues, runtime: 'pi', auth: config.apiToken ? 'required' : 'open', version: '0.1.0-revision3' });
                }
                return sendJson(response, 200, { status: 'ok', database: 'ok', runtime: 'pi', auth: config.apiToken ? 'required' : 'open', version: '0.1.0-revision3' });
            }
            catch (error) {
                return sendJson(response, 503, { status: 'degraded', database: 'error', runtime: 'pi', error: error instanceof Error ? error.message : 'Database unavailable' });
            }
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
            const result = await db.insert(modelProviders).values({
                name: body.name,
                type: body.type,
                baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
                configJson: body.configJson,
            });
            return sendJson(response, 201, { id: result[0].insertId, name: body.name, type: body.type });
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
        if (request.method === 'GET' && url.pathname === '/api/projects') {
            const rows = await db.select().from(projects).orderBy(asc(projects.name));
            return sendJson(response, 200, { data: rows });
        }
        if (request.method === 'POST' && url.pathname === '/api/projects') {
            const body = await readJson(request);
            const name = requiredString(body, 'name');
            if (!name)
                return sendJson(response, 400, { error: 'name is required' });
            const result = await db.insert(projects).values({
                name,
                description: typeof body.description === 'string' ? body.description : undefined,
            });
            return sendJson(response, 201, { id: result[0].insertId, name });
        }
        if (request.method === 'GET' && url.pathname === '/api/agents') {
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.name))
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
            const result = await db.insert(agents).values({
                projectId,
                name,
                description: typeof body.description === 'string' ? body.description : undefined,
                capabilitiesJson: body.capabilitiesJson,
            });
            return sendJson(response, 201, { id: result[0].insertId, projectId, name });
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
        if (request.method === 'GET' && url.pathname === '/api/model-resolver') {
            const projectId = queryId(url, 'projectId');
            if (!projectId)
                return sendJson(response, 400, { error: 'projectId is required' });
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
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(workflows).where(eq(workflows.projectId, projectId)).orderBy(asc(workflows.name))
                : await db.select().from(workflows).orderBy(asc(workflows.name));
            return sendJson(response, 200, { data: rows });
        }
        const workflowNodesMatch = url.pathname.match(/^\/api\/workflows\/(\d+)\/nodes$/);
        if (request.method === 'GET' && workflowNodesMatch) {
            const workflowId = Number(workflowNodesMatch[1]);
            const rows = await db.select().from(workflowNodes)
                .where(eq(workflowNodes.workflowId, workflowId))
                .orderBy(asc(workflowNodes.id));
            const edges = await db.select().from(workflowEdges)
                .where(eq(workflowEdges.workflowId, workflowId))
                .orderBy(asc(workflowEdges.id));
            return sendJson(response, 200, { data: rows, edges });
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
            const definition = jsonObject(body.definitionJson);
            const definitionNodes = Array.isArray(definition.nodes) ? definition.nodes : [];
            const definitionEdges = Array.isArray(definition.edges) ? definition.edges : [];
            const nodeKeys = definitionNodes.map((node, index) => requiredString(jsonObject(node), 'key') ?? String(index));
            try {
                assertAcyclicGraph(nodeKeys, definitionEdges.map((edge) => ({
                    source: String(jsonObject(edge).source),
                    target: String(jsonObject(edge).target),
                })));
            }
            catch (error) {
                return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid workflow graph' });
            }
            const created = await db.transaction(async (tx) => {
                const result = await tx.insert(workflows).values({
                    projectId,
                    name,
                    version,
                    definitionJson: body.definitionJson,
                    status: 'published',
                });
                const workflowId = result[0].insertId;
                const nodeIds = new Map();
                for (const [index, node] of definitionNodes.entries()) {
                    const item = jsonObject(node);
                    const nodeType = item.type === 'checkpoint' ? 'checkpoint' : 'task';
                    const capability = requiredString(item, 'capability') ?? (nodeType === 'checkpoint' ? 'human_review' : undefined);
                    if (!capability)
                        continue;
                    const nodeResult = await tx.insert(workflowNodes).values({
                        workflowId,
                        name: requiredString(item, 'name') ?? `Node ${index + 1}`,
                        capability,
                        skill: requiredString(item, 'skill'),
                        nodeType,
                        configJson: item,
                    });
                    nodeIds.set(requiredString(item, 'key') ?? String(index), nodeResult[0].insertId);
                }
                let edgeCount = 0;
                for (const edge of definitionEdges) {
                    const item = jsonObject(edge);
                    const sourceNodeId = nodeIds.get(String(item.source));
                    const targetNodeId = nodeIds.get(String(item.target));
                    if (!sourceNodeId || !targetNodeId)
                        continue;
                    await tx.insert(workflowEdges).values({ workflowId, sourceNodeId, targetNodeId, conditionJson: item.condition });
                    edgeCount += 1;
                }
                return { workflowId, nodeCount: nodeIds.size, edgeCount };
            });
            return sendJson(response, 201, { id: created.workflowId, projectId, name, version, nodeCount: created.nodeCount, edgeCount: created.edgeCount });
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
            if (!run)
                return sendJson(response, 404, { error: 'Workflow run not found' });
            const runTasks = await db.select().from(tasks).where(eq(tasks.workflowRunId, workflowRunId)).orderBy(asc(tasks.id));
            const runSessions = runTasks.length > 0
                ? await db.select().from(sessions).where(inArray(sessions.taskId, runTasks.map((task) => task.id))).orderBy(asc(sessions.id))
                : [];
            const [runPlans, runCheckpoints, runArtifacts, runDecisions, runEvents] = await Promise.all([
                db.select().from(plans).where(eq(plans.workflowRunId, workflowRunId)).orderBy(asc(plans.version)),
                db.select().from(checkpoints).where(eq(checkpoints.workflowRunId, workflowRunId)).orderBy(asc(checkpoints.id)),
                db.select().from(artifacts).where(eq(artifacts.workflowRunId, workflowRunId)).orderBy(asc(artifacts.id)),
                db.select().from(decisions).where(eq(decisions.workflowRunId, workflowRunId)).orderBy(asc(decisions.id)),
                db.select().from(events).where(eq(events.workflowRunId, workflowRunId)).orderBy(asc(events.id)),
            ]);
            return sendJson(response, 200, { data: { ...run, plans: runPlans, tasks: runTasks, sessions: runSessions, checkpoints: runCheckpoints, artifacts: runArtifacts, decisions: runDecisions, events: runEvents } });
        }
        if (request.method === 'POST' && url.pathname === '/api/workflow-runs') {
            const body = await readJson(request);
            const workflowId = typeof body.workflowId === 'number' ? body.workflowId : Number(body.workflowId);
            if (!Number.isInteger(workflowId) || workflowId < 1) {
                return sendJson(response, 400, { error: 'workflowId is required' });
            }
            const workflowRows = await db.select({ projectId: workflows.projectId }).from(workflows).where(eq(workflows.id, workflowId));
            const workflow = workflowRows[0];
            if (!workflow)
                return sendJson(response, 404, { error: 'Workflow not found' });
            const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).orderBy(asc(workflowNodes.id));
            if (nodes.length === 0)
                return sendJson(response, 400, { error: 'Workflow has no executable nodes' });
            const idempotencyKey = requiredString(body, 'idempotencyKey');
            if (idempotencyKey) {
                const existing = (await db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, idempotencyKey)).limit(1))[0];
                if (existing)
                    return sendJson(response, 200, { ...existing, idempotent: true });
            }
            const edges = await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId)).orderBy(asc(workflowEdges.id));
            const createdRun = await db.transaction(async (tx) => {
                const result = await tx.insert(workflowRuns).values({
                    workflowId,
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
                    const nodeConfig = jsonObject(node.configJson);
                    const inputJson = {
                        ...(jsonObject(body.inputJson)),
                        ...nodeConfig,
                        capability: node.capability,
                        skill: node.skill ?? undefined,
                        workflowNodeId: node.id,
                        nodeType: node.nodeType,
                        dependsOnNodeIds,
                    };
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
                    planned.push({ nodeId: node.id, taskId, sessionId: sessionResult[0].insertId, capability: node.capability, skill: node.skill, nodeType: node.nodeType, dependsOnNodeIds });
                }
                return { workflowRunId, planId, planned };
            });
            const { workflowRunId, planId, planned } = createdRun;
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
            if (!task)
                return sendJson(response, 404, { error: 'Task not found' });
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
            if (!session)
                return sendJson(response, 404, { error: 'Session not found' });
            const sessionEvents = await db.select().from(events).where(eq(events.sessionId, sessionId)).orderBy(asc(events.id));
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
                if (!task)
                    return sendJson(response, 404, { error: 'Task not found' });
                if (task.status !== 'failed' && task.status !== 'paused')
                    return sendJson(response, 409, { error: 'Only failed or paused tasks can be retried' });
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
                    await tx.update(workflowRuns).set({ status: 'paused', completedAt: null, errorJson: null }).where(eq(workflowRuns.id, task.workflowRunId));
                    return newSession[0].insertId;
                });
                return sendJson(response, 201, { id: taskId, status: 'pending', sessionId });
            }
            const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
            if (!task)
                return sendJson(response, 404, { error: 'Task not found' });
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
            if (!session)
                return sendJson(response, 404, { error: 'Session not found' });
            if (!session.taskId)
                return sendJson(response, 400, { error: 'Direct chat sessions are controlled through /api/chat/threads/:id/messages' });
            const workflowTaskId = session.taskId;
            if (action === 'start') {
                const latest = (await db.select({ id: sessions.id }).from(sessions)
                    .where(eq(sessions.taskId, workflowTaskId)).orderBy(desc(sessions.id)).limit(1))[0];
                if (latest?.id !== sessionId)
                    return sendJson(response, 409, { error: 'Only the latest task session can be started' });
                const task = (await db.select().from(tasks).where(eq(tasks.id, workflowTaskId)))[0];
                if (!task)
                    return sendJson(response, 404, { error: 'Task not found' });
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
            const run = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
            if (!run)
                return sendJson(response, 404, { error: 'Workflow run not found' });
            if (run.status !== 'pending' && run.status !== 'failed') {
                return sendJson(response, 409, { error: `Workflow run cannot execute from status ${run.status}` });
            }
            requireRunTransition(run.status, 'running');
            if (executingWorkflowRuns.has(workflowRunId)) {
                return sendJson(response, 409, { error: 'Workflow run is already executing', workflowRunId });
            }
            scheduleWorkflowExecution(workflowRunId);
            return sendJson(response, 202, { workflowRunId, status: 'accepted' });
        }
        const runActionMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/(pause|resume|replan)$/);
        if (request.method === 'POST' && runActionMatch) {
            const workflowRunId = Number(runActionMatch[1]);
            const action = runActionMatch[2];
            const run = (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0];
            if (!run)
                return sendJson(response, 404, { error: 'Workflow run not found' });
            if (action === 'replan') {
                if (run.status === 'completed' || run.status === 'cancelled') {
                    return sendJson(response, 409, { error: `Workflow run cannot be replanned from status ${run.status}` });
                }
                requireRunTransition(run.status, 'paused');
                const body = await readJson(request);
                const reason = requiredString(body, 'reason') ?? 'Human requested replan';
                const definition = body.definitionJson && typeof body.definitionJson === 'object' && !Array.isArray(body.definitionJson)
                    ? body.definitionJson
                    : undefined;
                const replanned = await replanWorkflowRun(workflowRunId, reason, definition);
                const execution = body.resume === false ? undefined : scheduleWorkflowExecution(workflowRunId);
                return sendJson(response, 200, { ...replanned, execution });
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
            if (action === 'resume' && activeSessionIds.length === 0)
                scheduleWorkflowExecution(workflowRunId);
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
        if (request.method === 'GET' && url.pathname === '/api/artifacts') {
            const projectId = queryId(url, 'projectId');
            const workflowRunId = queryId(url, 'workflowRunId');
            const { limit, offset } = queryPage(url);
            const rows = workflowRunId
                ? await db.select().from(artifacts).where(eq(artifacts.workflowRunId, workflowRunId)).orderBy(desc(artifacts.id)).limit(limit).offset(offset)
                : projectId
                    ? await db.select().from(artifacts).where(eq(artifacts.projectId, projectId)).orderBy(desc(artifacts.id)).limit(limit).offset(offset)
                    : await db.select().from(artifacts).orderBy(desc(artifacts.id)).limit(limit).offset(offset);
            return sendJson(response, 200, { data: rows, page: { limit, offset } });
        }
        if (request.method === 'POST' && url.pathname === '/api/artifacts') {
            const body = await readJson(request);
            const projectId = Number(body.projectId);
            const name = requiredString(body, 'name');
            const content = requiredString(body, 'content');
            if (!Number.isInteger(projectId) || projectId < 1 || !name || !content)
                return sendJson(response, 400, { error: 'projectId, name and content are required' });
            const artifact = await db.insert(artifacts).values({
                projectId,
                workflowRunId: body.workflowRunId === undefined ? undefined : Number(body.workflowRunId),
                taskId: body.taskId === undefined ? undefined : Number(body.taskId),
                sessionId: body.sessionId === undefined ? undefined : Number(body.sessionId),
                name,
                kind: requiredString(body, 'kind') ?? 'text',
                metadataJson: body.metadataJson,
            });
            await db.insert(artifactVersions).values({
                artifactId: artifact[0].insertId,
                version: 1,
                content,
                mimeType: requiredString(body, 'mimeType') ?? 'text/plain',
                createdBy: requiredString(body, 'createdBy') ?? 'human',
            });
            return sendJson(response, 201, { id: artifact[0].insertId, version: 1 });
        }
        const artifactDetailMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)$/);
        if (request.method === 'GET' && artifactDetailMatch) {
            const artifactId = Number(artifactDetailMatch[1]);
            const artifact = (await db.select().from(artifacts).where(eq(artifacts.id, artifactId)))[0];
            if (!artifact)
                return sendJson(response, 404, { error: 'Artifact not found' });
            const versions = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, artifactId)).orderBy(desc(artifactVersions.version));
            return sendJson(response, 200, { data: { ...artifact, versions } });
        }
        const artifactVersionMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)\/versions$/);
        if (request.method === 'POST' && artifactVersionMatch) {
            const artifactId = Number(artifactVersionMatch[1]);
            const body = await readJson(request);
            const content = requiredString(body, 'content');
            const artifact = (await db.select().from(artifacts).where(eq(artifacts.id, artifactId)))[0];
            if (!artifact || !content)
                return sendJson(response, artifact ? 400 : 404, { error: artifact ? 'content is required' : 'Artifact not found' });
            const version = artifact.currentVersion + 1;
            await db.insert(artifactVersions).values({ artifactId, version, content, mimeType: requiredString(body, 'mimeType') ?? 'text/plain', createdBy: requiredString(body, 'createdBy') ?? 'human' });
            await db.update(artifacts).set({ currentVersion: version }).where(eq(artifacts.id, artifactId));
            return sendJson(response, 201, { artifactId, version });
        }
        const artifactActionMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)\/(approve|reject|archive)$/);
        if (request.method === 'POST' && artifactActionMatch) {
            const artifactId = Number(artifactActionMatch[1]);
            const action = artifactActionMatch[2];
            const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'archived';
            await db.update(artifacts).set({ status }).where(eq(artifacts.id, artifactId));
            return sendJson(response, 200, { id: artifactId, status });
        }
        if (request.method === 'GET' && url.pathname === '/api/memories') {
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(memories).where(eq(memories.projectId, projectId)).orderBy(desc(memories.id))
                : await db.select().from(memories).orderBy(desc(memories.id));
            return sendJson(response, 200, { data: rows });
        }
        if (request.method === 'POST' && url.pathname === '/api/memories') {
            const body = await readJson(request);
            const projectId = Number(body.projectId);
            const key = requiredString(body, 'key');
            const content = requiredString(body, 'content');
            if (!Number.isInteger(projectId) || projectId < 1 || !key || !content)
                return sendJson(response, 400, { error: 'projectId, key and content are required' });
            const result = await db.insert(memories).values({
                projectId,
                agentId: body.agentId === undefined ? undefined : Number(body.agentId),
                scope: body.scope === 'agent' ? 'agent' : 'project',
                key,
                content,
                metadataJson: body.metadataJson,
            });
            return sendJson(response, 201, { id: result[0].insertId, projectId, key });
        }
        const memoryDetailMatch = url.pathname.match(/^\/api\/memories\/(\d+)$/);
        if ((request.method === 'PUT' || request.method === 'PATCH') && memoryDetailMatch) {
            const memoryId = Number(memoryDetailMatch[1]);
            const body = await readJson(request);
            const existing = (await db.select().from(memories).where(eq(memories.id, memoryId)))[0];
            if (!existing)
                return sendJson(response, 404, { error: 'Memory not found' });
            await db.update(memories).set({
                key: requiredString(body, 'key') ?? existing.key,
                content: requiredString(body, 'content') ?? existing.content,
                metadataJson: body.metadataJson ?? existing.metadataJson,
            }).where(eq(memories.id, memoryId));
            return sendJson(response, 200, { id: memoryId, status: 'updated' });
        }
        if (request.method === 'DELETE' && memoryDetailMatch) {
            const memoryId = Number(memoryDetailMatch[1]);
            await db.delete(memories).where(eq(memories.id, memoryId));
            return sendJson(response, 200, { id: memoryId, status: 'deleted' });
        }
        if (request.method === 'GET' && url.pathname === '/api/checkpoints') {
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(checkpoints).where(eq(checkpoints.projectId, projectId)).orderBy(desc(checkpoints.id))
                : await db.select().from(checkpoints).orderBy(desc(checkpoints.id));
            return sendJson(response, 200, { data: rows });
        }
        if (request.method === 'GET' && url.pathname === '/api/permission-policies') {
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(permissionPolicies).where(eq(permissionPolicies.projectId, projectId)).orderBy(asc(permissionPolicies.id))
                : await db.select().from(permissionPolicies).orderBy(asc(permissionPolicies.id));
            return sendJson(response, 200, { data: rows });
        }
        if (request.method === 'POST' && url.pathname === '/api/permission-policies') {
            const body = await readJson(request);
            const projectId = Number(body.projectId);
            const name = requiredString(body, 'name');
            if (!Number.isInteger(projectId) || projectId < 1 || !name || !body.rulesJson)
                return sendJson(response, 400, { error: 'projectId, name and rulesJson are required' });
            const result = await db.insert(permissionPolicies).values({ projectId, agentId: body.agentId === undefined ? undefined : Number(body.agentId), name, rulesJson: body.rulesJson });
            return sendJson(response, 201, { id: result[0].insertId, projectId, name });
        }
        if (request.method === 'GET' && url.pathname === '/api/budgets') {
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(budgets).where(eq(budgets.projectId, projectId)).orderBy(desc(budgets.id))
                : await db.select().from(budgets).orderBy(desc(budgets.id));
            return sendJson(response, 200, { data: rows });
        }
        if (request.method === 'POST' && url.pathname === '/api/budgets') {
            const body = await readJson(request);
            const projectId = Number(body.projectId);
            const limitUnits = Number(body.limitUnits);
            if (!Number.isInteger(projectId) || projectId < 1 || !Number.isInteger(limitUnits) || limitUnits < 1)
                return sendJson(response, 400, { error: 'projectId and positive limitUnits are required' });
            const result = await db.insert(budgets).values({ projectId, workflowRunId: body.workflowRunId === undefined ? undefined : Number(body.workflowRunId), limitUnits });
            return sendJson(response, 201, { id: result[0].insertId, projectId, limitUnits });
        }
        if (request.method === 'GET' && url.pathname === '/api/chat/threads') {
            const projectId = queryId(url, 'projectId');
            const rows = projectId
                ? await db.select().from(chatThreads).where(eq(chatThreads.projectId, projectId)).orderBy(desc(chatThreads.id))
                : await db.select().from(chatThreads).orderBy(desc(chatThreads.id));
            return sendJson(response, 200, { data: rows });
        }
        if (request.method === 'POST' && url.pathname === '/api/chat/threads') {
            const body = await readJson(request);
            const projectId = Number(body.projectId);
            const agentId = Number(body.agentId);
            const title = requiredString(body, 'title');
            if (!Number.isInteger(projectId) || projectId < 1 || !Number.isInteger(agentId) || agentId < 1 || !title)
                return sendJson(response, 400, { error: 'projectId, agentId and title are required' });
            const result = await db.insert(chatThreads).values({ projectId, agentId, title });
            return sendJson(response, 201, { id: result[0].insertId, projectId, agentId, title });
        }
        const chatThreadMatch = url.pathname.match(/^\/api\/chat\/threads\/(\d+)$/);
        if (request.method === 'GET' && chatThreadMatch) {
            const threadId = Number(chatThreadMatch[1]);
            const thread = (await db.select().from(chatThreads).where(eq(chatThreads.id, threadId)))[0];
            if (!thread)
                return sendJson(response, 404, { error: 'Chat thread not found' });
            const messages = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(asc(chatMessages.id));
            return sendJson(response, 200, { data: { ...thread, messages } });
        }
        const chatMessageMatch = url.pathname.match(/^\/api\/chat\/threads\/(\d+)\/messages$/);
        if (request.method === 'POST' && chatMessageMatch) {
            const threadId = Number(chatMessageMatch[1]);
            const body = await readJson(request);
            const content = requiredString(body, 'content');
            if (!content)
                return sendJson(response, 400, { error: 'content is required' });
            if (activeChatThreads.has(threadId)) {
                return sendJson(response, 409, { error: 'This chat thread already has a running message' });
            }
            activeChatThreads.add(threadId);
            void executeChatMessage(threadId, content)
                .catch((error) => console.error('Direct chat failed', error))
                .finally(() => activeChatThreads.delete(threadId));
            return sendJson(response, 202, { threadId, status: 'accepted' });
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
            }
            return sendJson(response, 201, { id: result[0].insertId, projectId, status: 'pending' });
        }
        const decisionMatch = url.pathname.match(/^\/api\/decisions\/(\d+)\/resolve$/);
        if (request.method === 'POST' && decisionMatch) {
            const decisionId = Number(decisionMatch[1]);
            const body = await readJson(request);
            const decision = requiredString(body, 'decision');
            const action = ['approve', 'request_changes', 'reject', 'override', 'replan'].includes(String(body.action))
                ? String(body.action)
                : body.status === 'rejected' ? 'reject' : 'approve';
            const status = action === 'approve' ? 'approved'
                : action === 'request_changes' || action === 'replan' ? 'changes_requested'
                    : action === 'override' ? 'overridden' : 'rejected';
            if (!decision)
                return sendJson(response, 400, { error: 'decision is required' });
            const row = (await db.select().from(decisions).where(eq(decisions.id, decisionId)))[0];
            if (!row)
                return sendJson(response, 404, { error: 'Decision not found' });
            if (row.status !== 'pending')
                return sendJson(response, 409, { error: 'Decision is already resolved' });
            const decisionContext = jsonObject(row.contextJson);
            const artifactId = Number(decisionContext.artifactId);
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
                                : action === 'request_changes' || action === 'replan' ? 'changes_requested' : 'rejected',
                        resolvedAt: new Date(),
                    }).where(eq(checkpoints.id, row.checkpointId));
                }
                if (Number.isInteger(artifactId) && artifactId > 0) {
                    await tx.update(artifacts).set({
                        status: action === 'approve' || action === 'override' ? 'approved'
                            : action === 'reject' ? 'rejected' : 'draft',
                    }).where(eq(artifacts.id, artifactId));
                }
            });
            if (row.workflowRunId) {
                if (action === 'replan' || action === 'request_changes') {
                    await replanWorkflowRun(row.workflowRunId, decision);
                    scheduleWorkflowExecution(row.workflowRunId);
                }
                else if (action === 'reject') {
                    queuedWorkflowRuns.delete(row.workflowRunId);
                    await db.update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, row.workflowRunId));
                    await stopActiveWorkflowSessions(row.workflowRunId);
                    await db.update(workflowRuns).set({ status: 'failed', errorJson: { decisionId, decision }, completedAt: new Date() }).where(eq(workflowRuns.id, row.workflowRunId));
                }
                else {
                    if (row.checkpointId) {
                        const checkpoint = (await db.select().from(checkpoints).where(eq(checkpoints.id, row.checkpointId)))[0];
                        if (checkpoint?.taskId)
                            await db.update(tasks).set({ status: 'completed', outputJson: { decisionId, action } }).where(eq(tasks.id, checkpoint.taskId));
                    }
                    await db.update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, row.workflowRunId));
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
            const artifactCount = projectId
                ? await db.select({ value: count() }).from(artifacts).where(eq(artifacts.projectId, projectId))
                : await db.select({ value: count() }).from(artifacts);
            const checkpointCount = projectId
                ? await db.select({ value: count() }).from(checkpoints).where(and(eq(checkpoints.projectId, projectId), eq(checkpoints.status, 'pending')))
                : await db.select({ value: count() }).from(checkpoints).where(eq(checkpoints.status, 'pending'));
            const recentEvents = projectId
                ? await db.select().from(events).where(eq(events.projectId, projectId)).orderBy(desc(events.id)).limit(20)
                : await db.select().from(events).orderBy(desc(events.id)).limit(20);
            return sendJson(response, 200, {
                projectId: projectId ?? null,
                counts: {
                    agents: Number(agentCount[0]?.value ?? 0),
                    workflows: Number(workflowCount[0]?.value ?? 0),
                    decisions: Number(pendingDecisionCount[0]?.value ?? 0),
                    events: Number(eventCount[0]?.value ?? 0),
                    artifacts: Number(artifactCount[0]?.value ?? 0),
                    checkpoints: Number(checkpointCount[0]?.value ?? 0),
                },
                recentEvents,
            });
        }
        return sendJson(response, 404, { error: 'Not found' });
    }
    catch (error) {
        console.error(JSON.stringify({ level: 'error', type: 'http.error', requestId, method: request.method, path: url.pathname, message: error instanceof Error ? error.message : String(error) }));
        if (error instanceof OrviaError) {
            return sendJson(response, error.statusCode, { error: error.message, kind: error.kind, details: error.details });
        }
        return sendJson(response, 500, { error: 'Internal server error' });
    }
}
async function recoverInterruptedExecutions() {
    const interruptedRuns = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.status, 'running'));
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
    }
}
const server = createServer(handler);
server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`);
    if (url.pathname !== '/api/events/ws') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
    }
    if (!authorize(request, url)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
    }
    if (!acceptWebSocket(request, socket))
        return;
    const projectId = queryId(url, 'projectId');
    const client = { socket, projectId };
    socketClients.add(client);
    sendWebSocketText(socket, JSON.stringify({ type: 'ready', projectId: projectId ?? null }));
    const remove = () => socketClients.delete(client);
    socket.on('close', remove);
    socket.on('error', remove);
    socket.on('end', remove);
});
async function startServer() {
    await ensureTables();
    await repairSchema();
    const schemaIssues = await schemaIntegrityIssues();
    if (schemaIssues.length > 0)
        throw new Error(`Database schema is incomplete: ${schemaIssues.join(', ')}`);
    await recoverInterruptedExecutions();
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
    if (shuttingDown)
        return;
    shuttingDown = true;
    clearInterval(heartbeat);
    await piRuntime.shutdown();
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
