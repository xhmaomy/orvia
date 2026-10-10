import { and, asc, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentVersions, agents, budgets, modelProviders, models, permissionPolicies, } from '../db/schema.js';
import { conflictError, notFoundError } from '../domain/errors.js';
import { providerAdapter } from '../infrastructure/provider-adapter.js';
import { resolveRuntimePolicy } from './runtime-policy.js';
function normalized(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}
function includesCapability(value, required) {
    if (Array.isArray(value))
        return value.some((item) => normalized(item) === required);
    if (value && typeof value === 'object') {
        const record = value;
        return ['capabilities', 'skills', 'items'].some((key) => includesCapability(record[key], required));
    }
    return false;
}
function permissionAllows(value, capability, skill) {
    if (!value || typeof value !== 'object')
        return true;
    const rules = value;
    const denied = (Array.isArray(rules.deny) ? rules.deny : [])
        .map(normalized)
        .filter((item) => Boolean(item));
    const required = [capability, skill].filter((item) => Boolean(item));
    if (required.some((item) => denied.includes(item)))
        return false;
    const allowed = (Array.isArray(rules.allow) ? rules.allow : [])
        .map(normalized)
        .filter((item) => Boolean(item));
    return allowed.length === 0 || required.every((item) => allowed.includes(item));
}
export async function resolveAgentModel(input) {
    const capability = normalized(input.capability);
    const skill = normalized(input.skill);
    const candidates = await db.select().from(agents)
        .where(input.agentId
        ? and(eq(agents.projectId, input.projectId), eq(agents.id, input.agentId))
        : eq(agents.projectId, input.projectId))
        .orderBy(asc(agents.id));
    const policies = await db.select().from(permissionPolicies)
        .where(and(eq(permissionPolicies.projectId, input.projectId), eq(permissionPolicies.status, 'active')))
        .orderBy(asc(permissionPolicies.id));
    const agent = candidates.find((candidate) => {
        const matches = (!capability || includesCapability(candidate.capabilitiesJson, capability))
            && (!skill || includesCapability(candidate.capabilitiesJson, skill));
        return matches && policies
            .filter((policy) => policy.agentId === null || policy.agentId === candidate.id)
            .every((policy) => permissionAllows(policy.rulesJson, capability, skill));
    });
    if (!agent)
        throw notFoundError('No active Agent matches the requested capability, skill and permission policies');
    const applicableBudgets = await db.select().from(budgets)
        .where(and(eq(budgets.projectId, input.projectId), ne(budgets.status, 'closed'), input.workflowRunId
        ? or(isNull(budgets.workflowRunId), eq(budgets.workflowRunId, input.workflowRunId))
        : isNull(budgets.workflowRunId)))
        .orderBy(asc(budgets.id));
    if (applicableBudgets.some((budget) => budget.usedUnits >= budget.limitUnits)) {
        throw conflictError('Applicable project or workflow budget is exhausted');
    }
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
    if (!version)
        throw notFoundError('Agent has no active Agent Version, Model and Provider');
    const runtimePolicy = resolveRuntimePolicy(policies
        .filter((policy) => policy.agentId === null || policy.agentId === agent.id)
        .map((policy) => policy.rulesJson));
    providerAdapter(version.providerType).validate({
        type: version.providerType.toLowerCase(),
        model: version.modelName,
        options: version.providerConfig && typeof version.providerConfig === 'object'
            ? version.providerConfig
            : undefined,
    });
    return { agent, runtimePolicy, ...version };
}
