import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentVersions, agents, modelProviders, models, projects, } from '../db/schema.js';
import { notFoundError } from '../domain/errors.js';
import { providerAdapter } from '../infrastructure/provider-adapter.js';
import { resolveRuntimePolicy } from './runtime-policy.js';
import { loadAgentSkills, runtimePolicyFromSkills } from './skills.js';
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
function requiredCapabilityKeys(input) {
    const source = Array.isArray(input.capabilities) ? input.capabilities : [input.capability, input.skill];
    return [...new Set(source.map((item) => normalized(item)).filter((item) => Boolean(item)))];
}
/** Orvia 里登记的 Provider type → Pi CLI 认的 provider id */
export function toPiProviderId(providerType) {
    const raw = providerType.trim().toLowerCase().replace(/[_\s]+/g, '-');
    const compact = raw.replace(/-/g, '');
    const aliases = {
        minimax: 'minimax-cn',
        minimaxcn: 'minimax-cn',
        'minimax-cn': 'minimax-cn',
        openai: 'openai',
        anthropic: 'anthropic',
        google: 'google',
        gemini: 'google',
        openrouter: 'openrouter',
    };
    return aliases[raw] ?? aliases[compact] ?? raw;
}
/** 按模型目录里的 modelId 解析出传给 Pi 的 provider/model */
export async function resolveModelById(modelId) {
    if (!Number.isInteger(modelId) || modelId < 1) {
        throw notFoundError('请为这个 Agent 节点选择模型');
    }
    const row = (await db.select({
        modelId: models.id,
        modelName: models.name,
        providerId: modelProviders.id,
        providerName: modelProviders.name,
        providerType: modelProviders.type,
        providerBaseUrl: modelProviders.baseUrl,
        providerConfig: modelProviders.configJson,
    }).from(models)
        .innerJoin(modelProviders, and(eq(modelProviders.id, models.providerId), eq(modelProviders.status, 'active')))
        .where(and(eq(models.id, modelId), eq(models.status, 'active')))
        .limit(1))[0];
    if (!row) {
        throw notFoundError(`模型 #${modelId} 不可用，请到「模型管理」检查 Provider/Model 是否仍有效`);
    }
    providerAdapter(row.providerType).validate({
        type: row.providerType.toLowerCase(),
        model: row.modelName,
        options: row.providerConfig && typeof row.providerConfig === 'object'
            ? row.providerConfig
            : undefined,
    });
    return {
        ...row,
        piProvider: toPiProviderId(row.providerType),
        piModel: row.modelName.trim(),
    };
}
/** 节点模型 → 启动 Pi 必须带齐的 provider/model/apiKey（禁止静默回退到 Pi 本机配置） */
export function piLaunchCredentials(model) {
    const apiKey = apiKeyFromProviderConfig(model.providerConfig);
    if (!apiKey) {
        throw notFoundError(`Provider「${model.providerName}」还没有 API Key。请到「模型管理」编辑该 Provider 并填写 API Key`);
    }
    if (!model.piProvider || !model.piModel) {
        throw notFoundError(`模型「${model.modelName}」缺少可用的 Provider/Model 标识`);
    }
    return { provider: model.piProvider, model: model.piModel, apiKey };
}
export function parseModelId(value) {
    const id = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isInteger(id) && id > 0 ? id : undefined;
}
export async function resolveAgentModel(input) {
    const required = requiredCapabilityKeys(input);
    const candidates = await db.select().from(agents)
        .where(input.agentId
        ? and(eq(agents.projectId, input.projectId), eq(agents.id, input.agentId))
        : eq(agents.projectId, input.projectId))
        .orderBy(asc(agents.id));
    const agent = candidates.find((candidate) => required.every((key) => includesCapability(candidate.capabilitiesJson, key)));
    if (!agent) {
        const caps = required.length ? required.join('、') : '未声明';
        throw notFoundError(`没有匹配能力「${caps}」且已绑定模型的 Agent。请先到「Agent」页创建 Agent，勾选相同能力，并绑定 Provider/Model`);
    }
    const version = (await db.select({
        agentVersionId: agentVersions.id,
        version: agentVersions.version,
        role: agentVersions.role,
        mission: agentVersions.mission,
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
    if (!version) {
        throw notFoundError(`Agent「${agent.name}」还没有可用版本或模型，请先到「Agent」页增加版本并绑定 Model`);
    }
    const project = (await db.select({ tenantId: projects.tenantId }).from(projects).where(eq(projects.id, input.projectId)).limit(1))[0];
    const skillRows = project?.tenantId
        ? await loadAgentSkills(agent.skillsJson, project.tenantId)
        : [];
    const runtimePolicy = skillRows.length > 0 ? runtimePolicyFromSkills(skillRows) : resolveRuntimePolicy([]);
    providerAdapter(version.providerType).validate({
        type: version.providerType.toLowerCase(),
        model: version.modelName,
        options: version.providerConfig && typeof version.providerConfig === 'object'
            ? version.providerConfig
            : undefined,
    });
    const systemPrompt = [
        version.systemPrompt?.trim() || `你是多 Agent 协作中的 Agent「${agent.name}」，角色是${version.role}。按任务要求完成本职工作，并把可以交给下一个 Agent 的结论写清楚。`,
        version.mission?.trim() ? `使命：${version.mission.trim()}` : '',
    ].filter(Boolean).join('\n\n');
    return {
        agent,
        runtimePolicy,
        skills: skillRows,
        ...version,
        systemPrompt,
        piProvider: toPiProviderId(version.providerType),
        piModel: version.modelName.trim(),
    };
}
/** 从 Provider 配置里取出可供 Pi 使用的 API Key（若有）。 */
export function apiKeyFromProviderConfig(providerConfig) {
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig))
        return undefined;
    const record = providerConfig;
    for (const key of ['apiKey', 'api_key', 'token', 'key']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
export function maskApiKey(apiKey) {
    const value = apiKey.trim();
    if (value.length <= 8)
        return '********';
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
/** 列表/编辑接口对外返回：不回传明文 key，只给是否已配置与脱敏值 */
export function publicProviderConfig(providerConfig) {
    const raw = providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)
        ? { ...providerConfig }
        : {};
    const apiKey = apiKeyFromProviderConfig(raw);
    delete raw.apiKey;
    delete raw.api_key;
    delete raw.token;
    delete raw.key;
    return {
        apiKeySet: Boolean(apiKey),
        apiKeyMasked: apiKey ? maskApiKey(apiKey) : '',
        configJson: Object.keys(raw).length ? raw : null,
    };
}
/** 把 apiKey 写进 Provider configJson；空字符串表示清除 */
export function withProviderApiKey(providerConfig, apiKey) {
    const base = providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)
        ? { ...providerConfig }
        : {};
    delete base.api_key;
    delete base.token;
    delete base.key;
    if (apiKey === undefined) {
        return Object.keys(base).length ? base : null;
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
        delete base.apiKey;
        return Object.keys(base).length ? base : null;
    }
    base.apiKey = trimmed;
    return base;
}
export async function resolveWorkflowNode(input) {
    void input.projectId;
    void input.workflowRunId;
    void input.capabilities;
    return {
        runtimePolicy: resolveRuntimePolicy([]),
        systemPrompt: `你是多 Agent 协作中的 Agent「${input.name}」。按任务要求完成本职工作，并把可以交给下一个 Agent 的结论写清楚。`,
    };
}
