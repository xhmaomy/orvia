import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentVersions,
  agents,
  modelProviders,
  models,
} from '../db/schema.js';
import { notFoundError } from '../domain/errors.js';
import { providerAdapter } from '../infrastructure/provider-adapter.js';
import { resolveRuntimePolicy } from './runtime-policy.js';

function normalized(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

function includesCapability(value: unknown, required: string): boolean {
  if (Array.isArray(value)) return value.some((item) => normalized(item) === required);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return ['capabilities', 'skills', 'items'].some((key) => includesCapability(record[key], required));
  }
  return false;
}

function requiredCapabilityKeys(input: ResolveAgentInput): string[] {
  const source = Array.isArray(input.capabilities) ? input.capabilities : [input.capability, input.skill];
  return [...new Set(source.map((item) => normalized(item)).filter((item): item is string => Boolean(item)))];
}

export interface ResolveAgentInput {
  projectId: number;
  capabilities?: string[];
  capability?: string;
  skill?: string;
  agentId?: number;
  workflowRunId?: number;
}

export async function resolveAgentModel(input: ResolveAgentInput) {
  const required = requiredCapabilityKeys(input);
  const candidates = await db.select().from(agents)
    .where(input.agentId
      ? and(eq(agents.projectId, input.projectId), eq(agents.id, input.agentId))
      : eq(agents.projectId, input.projectId))
    .orderBy(asc(agents.id));

  const agent = candidates.find((candidate) => required.every((key) => includesCapability(candidate.capabilitiesJson, key)));
  if (!agent) throw notFoundError('No active Agent matches the requested capabilities');

  const version = (await db.select({
    agentVersionId: agentVersions.id,
    version: agentVersions.version,
    role: agentVersions.role,
    systemPrompt: agentVersions.systemPrompt,
    modelId: models.id,
    modelName: models.name,
    providerId: modelProviders.id,
    providerName: modelProviders.name,
    providerType: modelProviders.type,
    providerBaseUrl: modelProviders.baseUrl,
    providerConfig: modelProviders.configJson,
  }).from(agentVersions)
    .innerJoin(models, and(eq(models.id, agentVersions.modelId), eq(models.status, 'active')))
    .innerJoin(modelProviders, and(eq(modelProviders.id, models.providerId), eq(modelProviders.status, 'active')))
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(desc(agentVersions.id))
    .limit(1))[0];
  if (!version) throw notFoundError('Agent has no active Agent Version, Model and Provider');

  const runtimePolicy = resolveRuntimePolicy([]);
  providerAdapter(version.providerType).validate({
    type: version.providerType.toLowerCase(),
    model: version.modelName,
    options: version.providerConfig && typeof version.providerConfig === 'object'
      ? version.providerConfig as Record<string, unknown>
      : undefined,
  });
  return { agent, runtimePolicy, ...version };
}

export async function resolveWorkflowNode(input: { projectId: number; workflowRunId?: number; name: string; capabilities: string[] }) {
  void input.projectId;
  void input.workflowRunId;
  void input.capabilities;
  return {
    runtimePolicy: resolveRuntimePolicy([]),
    systemPrompt: `你是多 Agent 协作中的 Agent「${input.name}」。按任务要求完成本职工作，并把可以交给下一个 Agent 的结论写清楚。`,
  };
}
