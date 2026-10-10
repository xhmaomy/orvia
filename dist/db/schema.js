import { datetime, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar, } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
const status = mysqlEnum('status', ['active', 'inactive', 'draft', 'published', 'archived']);
export const projects = mysqlTable('ov_projects', {
    id: int('id').autoincrement().primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description'),
    status: status.notNull().default('active'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const modelProviders = mysqlTable('ov_model_providers', {
    id: int('id').autoincrement().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    type: varchar('type', { length: 80 }).notNull(),
    baseUrl: varchar('base_url', { length: 500 }),
    configJson: json('config_json'),
    status: status.notNull().default('active'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
    nameUnique: uniqueIndex('model_providers_name_unique').on(table.name),
}));
export const models = mysqlTable('ov_models', {
    id: int('id').autoincrement().primaryKey(),
    providerId: int('provider_id').notNull().references(() => modelProviders.id),
    name: varchar('name', { length: 160 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    capabilitiesJson: json('capabilities_json'),
    contextWindow: int('context_window'),
    inputPrice: varchar('input_price', { length: 32 }),
    outputPrice: varchar('output_price', { length: 32 }),
    status: status.notNull().default('active'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
    providerModelUnique: uniqueIndex('models_provider_name_unique').on(table.providerId, table.name),
}));
export const agents = mysqlTable('ov_agents', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description'),
    capabilitiesJson: json('capabilities_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const agentVersions = mysqlTable('ov_agent_versions', {
    id: int('id').autoincrement().primaryKey(),
    agentId: int('agent_id').notNull().references(() => agents.id),
    version: varchar('version', { length: 40 }).notNull(),
    modelId: int('model_id').notNull().references(() => models.id),
    role: varchar('role', { length: 160 }).notNull(),
    mission: text('mission'),
    systemPrompt: text('system_prompt'),
    configJson: json('config_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
    agentVersionUnique: uniqueIndex('agent_versions_agent_version_unique').on(table.agentId, table.version),
}));
export const workflows = mysqlTable('ov_workflows', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    name: varchar('name', { length: 160 }).notNull(),
    version: varchar('version', { length: 40 }).notNull(),
    definitionJson: json('definition_json'),
    status: status.notNull().default('draft'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const workflowNodes = mysqlTable('ov_workflow_nodes', {
    id: int('id').autoincrement().primaryKey(),
    workflowId: int('workflow_id').notNull().references(() => workflows.id),
    name: varchar('name', { length: 160 }).notNull(),
    capability: varchar('capability', { length: 120 }).notNull(),
    skill: varchar('skill', { length: 120 }),
    nodeType: mysqlEnum('node_type', ['task', 'checkpoint']).notNull().default('task'),
    configJson: json('config_json'),
});
export const workflowEdges = mysqlTable('ov_workflow_edges', {
    id: int('id').autoincrement().primaryKey(),
    workflowId: int('workflow_id').notNull().references(() => workflows.id),
    sourceNodeId: int('source_node_id').notNull().references(() => workflowNodes.id),
    targetNodeId: int('target_node_id').notNull().references(() => workflowNodes.id),
    conditionJson: json('condition_json'),
}, (table) => ({
    edgeUnique: uniqueIndex('workflow_edges_unique').on(table.workflowId, table.sourceNodeId, table.targetNodeId),
}));
export const workflowRuns = mysqlTable('ov_workflow_runs', {
    id: int('id').autoincrement().primaryKey(),
    workflowId: int('workflow_id').notNull().references(() => workflows.id),
    status: mysqlEnum('run_status', ['pending', 'running', 'paused', 'awaiting_decision', 'completed', 'failed', 'cancelled']).notNull().default('pending'),
    currentPlanVersion: int('current_plan_version').notNull().default(1),
    idempotencyKey: varchar('idempotency_key', { length: 160 }),
    inputJson: json('input_json'),
    errorJson: json('error_json'),
    startedAt: datetime('started_at'),
    completedAt: datetime('completed_at'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
    idempotencyUnique: uniqueIndex('workflow_runs_idempotency_unique').on(table.idempotencyKey),
}));
export const plans = mysqlTable('ov_plans', {
    id: int('id').autoincrement().primaryKey(),
    workflowRunId: int('workflow_run_id').notNull().references(() => workflowRuns.id),
    version: int('version').notNull().default(1),
    status: mysqlEnum('plan_status', ['active', 'superseded', 'completed', 'failed']).notNull().default('active'),
    reason: text('reason'),
    graphJson: json('graph_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
    runVersionUnique: uniqueIndex('plans_run_version_unique').on(table.workflowRunId, table.version),
}));
export const tasks = mysqlTable('ov_tasks', {
    id: int('id').autoincrement().primaryKey(),
    workflowRunId: int('workflow_run_id').notNull().references(() => workflowRuns.id),
    planId: int('plan_id').references(() => plans.id),
    workflowNodeId: int('workflow_node_id').references(() => workflowNodes.id),
    agentId: int('agent_id').references(() => agents.id),
    name: varchar('name', { length: 200 }).notNull(),
    status: mysqlEnum('task_status', ['pending', 'blocked', 'running', 'paused', 'awaiting_decision', 'completed', 'failed', 'cancelled']).notNull().default('pending'),
    retryCount: int('retry_count').notNull().default(0),
    maxRetries: int('max_retries').notNull().default(0),
    errorKind: mysqlEnum('error_kind', ['retryable', 'human_required', 'terminal']),
    inputJson: json('input_json'),
    outputJson: json('output_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const sessions = mysqlTable('ov_sessions', {
    id: int('id').autoincrement().primaryKey(),
    taskId: int('task_id').references(() => tasks.id),
    agentId: int('agent_id').references(() => agents.id),
    contextType: mysqlEnum('session_context_type', ['workflow', 'chat']).notNull().default('workflow'),
    contextId: int('context_id'),
    runtime: varchar('runtime', { length: 80 }).notNull().default('pi'),
    status: mysqlEnum('session_status', ['pending', 'running', 'paused', 'completed', 'failed']).notNull().default('pending'),
    inputJson: json('input_json'),
    outputJson: json('output_json'),
    startedAt: datetime('started_at'),
    completedAt: datetime('completed_at'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
});
export const checkpoints = mysqlTable('ov_checkpoints', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    workflowRunId: int('workflow_run_id').notNull().references(() => workflowRuns.id),
    taskId: int('task_id').references(() => tasks.id),
    workflowNodeId: int('workflow_node_id').references(() => workflowNodes.id),
    title: varchar('title', { length: 200 }).notNull(),
    instructions: text('instructions'),
    status: mysqlEnum('checkpoint_status', ['pending', 'approved', 'changes_requested', 'rejected', 'overridden', 'superseded']).notNull().default('pending'),
    contextJson: json('context_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    resolvedAt: datetime('resolved_at'),
});
export const artifacts = mysqlTable('ov_artifacts', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
    taskId: int('task_id').references(() => tasks.id),
    sessionId: int('session_id').references(() => sessions.id),
    name: varchar('name', { length: 240 }).notNull(),
    kind: varchar('kind', { length: 80 }).notNull().default('text'),
    status: mysqlEnum('artifact_status', ['draft', 'ready', 'approved', 'rejected', 'archived']).notNull().default('ready'),
    currentVersion: int('current_version').notNull().default(1),
    metadataJson: json('metadata_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const artifactVersions = mysqlTable('ov_artifact_versions', {
    id: int('id').autoincrement().primaryKey(),
    artifactId: int('artifact_id').notNull().references(() => artifacts.id),
    version: int('version').notNull(),
    content: text('content').notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull().default('text/plain'),
    createdBy: varchar('created_by', { length: 80 }).notNull().default('agent'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
    artifactVersionUnique: uniqueIndex('artifact_versions_unique').on(table.artifactId, table.version),
}));
export const memories = mysqlTable('ov_memories', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    agentId: int('agent_id').references(() => agents.id),
    scope: mysqlEnum('memory_scope', ['project', 'agent']).notNull().default('project'),
    key: varchar('memory_key', { length: 180 }).notNull(),
    content: text('content').notNull(),
    metadataJson: json('metadata_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const chatThreads = mysqlTable('ov_chat_threads', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    agentId: int('agent_id').notNull().references(() => agents.id),
    title: varchar('title', { length: 200 }).notNull(),
    status: mysqlEnum('chat_status', ['active', 'archived']).notNull().default('active'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const chatMessages = mysqlTable('ov_chat_messages', {
    id: int('id').autoincrement().primaryKey(),
    threadId: int('thread_id').notNull().references(() => chatThreads.id),
    sessionId: int('session_id').references(() => sessions.id),
    role: mysqlEnum('chat_role', ['user', 'assistant', 'system']).notNull(),
    content: text('content').notNull(),
    status: mysqlEnum('message_status', ['pending', 'streaming', 'completed', 'failed']).notNull().default('completed'),
    metadataJson: json('metadata_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
});
export const permissionPolicies = mysqlTable('ov_permission_policies', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    agentId: int('agent_id').references(() => agents.id),
    name: varchar('name', { length: 160 }).notNull(),
    rulesJson: json('rules_json').notNull(),
    status: status.notNull().default('active'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const budgets = mysqlTable('ov_budgets', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
    limitUnits: int('limit_units').notNull(),
    usedUnits: int('used_units').notNull().default(0),
    status: mysqlEnum('budget_status', ['active', 'exhausted', 'closed']).notNull().default('active'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp('updated_at').default(sql `CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});
export const usageRecords = mysqlTable('ov_usage_records', {
    id: int('id').autoincrement().primaryKey(),
    budgetId: int('budget_id').references(() => budgets.id),
    workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
    taskId: int('task_id').references(() => tasks.id),
    agentId: int('agent_id').references(() => agents.id),
    units: int('units').notNull().default(1),
    metadataJson: json('metadata_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
});
export const events = mysqlTable('ov_events', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
    taskId: int('task_id').references(() => tasks.id),
    sessionId: int('session_id').references(() => sessions.id),
    agentId: int('agent_id').references(() => agents.id),
    type: varchar('type', { length: 120 }).notNull(),
    payloadJson: json('payload_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
});
export const decisions = mysqlTable('ov_decisions', {
    id: int('id').autoincrement().primaryKey(),
    projectId: int('project_id').notNull().references(() => projects.id),
    workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
    checkpointId: int('checkpoint_id').references(() => checkpoints.id),
    question: text('question').notNull(),
    decision: text('decision'),
    decidedBy: varchar('decided_by', { length: 80 }).notNull().default('human'),
    action: mysqlEnum('decision_action', ['approve', 'request_changes', 'reject', 'override', 'replan']),
    status: mysqlEnum('decision_status', ['pending', 'approved', 'changes_requested', 'rejected', 'overridden', 'superseded']).notNull().default('pending'),
    contextJson: json('context_json'),
    createdAt: timestamp('created_at').default(sql `CURRENT_TIMESTAMP`).notNull(),
    resolvedAt: datetime('resolved_at'),
});
