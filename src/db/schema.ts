import {
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

const status = mysqlEnum('status', ['active', 'inactive', 'draft', 'published', 'archived']);
const memberRole = mysqlEnum('member_role', ['owner', 'admin', 'member']);

export const tenants = mysqlTable('ov_tenants', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull(),
  status: status.notNull().default('active'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
  slugUnique: uniqueIndex('tenants_slug_unique').on(table.slug),
}));

export const users = mysqlTable('ov_users', {
  id: int('id').autoincrement().primaryKey(),
  email: varchar('email', { length: 190 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  status: status.notNull().default('active'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
  emailUnique: uniqueIndex('users_email_unique').on(table.email),
}));

export const tenantMembers = mysqlTable('ov_tenant_members', {
  id: int('id').autoincrement().primaryKey(),
  tenantId: int('tenant_id').notNull().references(() => tenants.id),
  userId: int('user_id').notNull().references(() => users.id),
  role: memberRole.notNull().default('member'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  membershipUnique: uniqueIndex('tenant_members_unique').on(table.tenantId, table.userId),
}));

export const projects = mysqlTable('ov_projects', {
  id: int('id').autoincrement().primaryKey(),
  tenantId: int('tenant_id').references(() => tenants.id),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  status: status.notNull().default('active'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});

export const modelProviders = mysqlTable('ov_model_providers', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  type: varchar('type', { length: 80 }).notNull(),
  baseUrl: varchar('base_url', { length: 500 }),
  configJson: json('config_json'),
  status: status.notNull().default('active'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
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
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
  providerModelUnique: uniqueIndex('models_provider_name_unique').on(table.providerId, table.name),
}));

export const capabilities = mysqlTable('ov_capabilities', {
  id: int('id').autoincrement().primaryKey(),
  tenantId: int('tenant_id').notNull().references(() => tenants.id),
  key: varchar('capability_key', { length: 120 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
  tenantKeyUnique: uniqueIndex('capabilities_tenant_key_unique').on(table.tenantId, table.key),
}));

export const skills = mysqlTable('ov_skills', {
  id: int('id').autoincrement().primaryKey(),
  tenantId: int('tenant_id').notNull().references(() => tenants.id),
  key: varchar('skill_key', { length: 120 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  kind: mysqlEnum('skill_kind', ['builtin', 'custom']).notNull().default('custom'),
  toolsJson: json('tools_json'),
  contentMd: text('content_md'),
  configJson: json('config_json'),
  status: status.notNull().default('active'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
  tenantKeyUnique: uniqueIndex('skills_tenant_key_unique').on(table.tenantId, table.key),
}));

export const agents = mysqlTable('ov_agents', {
  id: int('id').autoincrement().primaryKey(),
  projectId: int('project_id').notNull().references(() => projects.id),
  workflowId: int('workflow_id').references(() => workflows.id),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  capabilitiesJson: json('capabilities_json'),
  skillsJson: json('skills_json'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
}, (table) => ({
  workflowIdx: index('agents_workflow_id_idx').on(table.workflowId),
}));

export const agentVersions = mysqlTable('ov_agent_versions', {
  id: int('id').autoincrement().primaryKey(),
  agentId: int('agent_id').notNull().references(() => agents.id),
  version: varchar('version', { length: 40 }).notNull(),
  modelId: int('model_id').notNull().references(() => models.id),
  role: varchar('role', { length: 160 }).notNull(),
  mission: text('mission'),
  systemPrompt: text('system_prompt'),
  configJson: json('config_json'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  agentVersionUnique: uniqueIndex('agent_versions_agent_version_unique').on(table.agentId, table.version),
}));

export const workflows = mysqlTable('ov_workflows', {
  id: int('id').autoincrement().primaryKey(),
  projectId: int('project_id').notNull().references(() => projects.id),
  name: varchar('name', { length: 160 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  currentVersionId: int('current_version_id'),
  definitionJson: json('definition_json'),
  status: status.notNull().default('draft'),
  runStatus: mysqlEnum('run_status', ['pending', 'running', 'paused', 'awaiting_decision', 'completed', 'failed', 'cancelled']),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
});

export const workflowVersions = mysqlTable('ov_workflow_versions', {
  id: int('id').autoincrement().primaryKey(),
  workflowId: int('workflow_id').notNull().references(() => workflows.id),
  version: varchar('version', { length: 40 }).notNull(),
  seq: int('seq').notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  definitionJson: json('definition_json').notNull(),
  publishedAt: timestamp('published_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  versionUnique: uniqueIndex('workflow_versions_workflow_version_unique').on(table.workflowId, table.version),
  seqUnique: uniqueIndex('workflow_versions_workflow_seq_unique').on(table.workflowId, table.seq),
}));

export const workflowNodes = mysqlTable('ov_workflow_nodes', {
  id: int('id').autoincrement().primaryKey(),
  workflowId: int('workflow_id').notNull().references(() => workflows.id),
  name: varchar('name', { length: 160 }).notNull(),
  capability: varchar('capability', { length: 120 }).notNull(),
  skill: varchar('skill', { length: 120 }),
  capabilitiesJson: json('capabilities_json'),
  nodeType: mysqlEnum('node_type', ['task', 'checkpoint', 'start', 'end']).notNull().default('task'),
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
  workflowVersionId: int('workflow_version_id'),
  status: mysqlEnum('run_status', ['pending', 'running', 'paused', 'awaiting_decision', 'completed', 'failed', 'cancelled']).notNull().default('pending'),
  currentPlanVersion: int('current_plan_version').notNull().default(1),
  idempotencyKey: varchar('idempotency_key', { length: 160 }),
  inputJson: json('input_json'),
  errorJson: json('error_json'),
  startedAt: datetime('started_at'),
  completedAt: datetime('completed_at'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  workflowUnique: uniqueIndex('workflow_runs_workflow_unique').on(table.workflowId),
  idempotencyUnique: uniqueIndex('workflow_runs_idempotency_unique').on(table.idempotencyKey),
}));

export const plans = mysqlTable('ov_plans', {
  id: int('id').autoincrement().primaryKey(),
  workflowRunId: int('workflow_run_id').notNull().references(() => workflowRuns.id),
  version: int('version').notNull().default(1),
  status: mysqlEnum('plan_status', ['active', 'superseded', 'completed', 'failed']).notNull().default('active'),
  reason: text('reason'),
  graphJson: json('graph_json'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
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
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at').default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull(),
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
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
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
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  resolvedAt: datetime('resolved_at'),
});

export const nodeMessages = mysqlTable('ov_node_messages', {
  id: int('id').autoincrement().primaryKey(),
  workflowId: int('workflow_id').notNull().references(() => workflows.id),
  workflowVersionId: int('workflow_version_id'),
  nodeKey: varchar('node_key', { length: 160 }).notNull(),
  sessionId: int('session_id').references(() => sessions.id),
  role: mysqlEnum('node_message_role', ['user', 'assistant']).notNull(),
  content: text('content').notNull(),
  thinking: text('thinking'),
  status: mysqlEnum('node_message_status', ['pending', 'streaming', 'completed', 'failed']).notNull().default('completed'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  workflowNodeKey: index('node_messages_workflow_key').on(table.workflowId, table.nodeKey),
  nodeMessagesVersionIdx: index('node_messages_version_idx').on(table.workflowVersionId),
}));

export const events = mysqlTable('ov_events', {
  id: int('id').autoincrement().primaryKey(),
  projectId: int('project_id').notNull().references(() => projects.id),
  workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
  workflowVersionId: int('workflow_version_id'),
  taskId: int('task_id').references(() => tasks.id),
  sessionId: int('session_id').references(() => sessions.id),
  agentId: int('agent_id').references(() => agents.id),
  type: varchar('type', { length: 120 }).notNull(),
  payloadJson: json('payload_json'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  eventsVersionIdx: index('events_version_idx').on(table.workflowVersionId),
}));

export const decisions = mysqlTable('ov_decisions', {
  id: int('id').autoincrement().primaryKey(),
  projectId: int('project_id').notNull().references(() => projects.id),
  workflowRunId: int('workflow_run_id').references(() => workflowRuns.id),
  checkpointId: int('checkpoint_id').references(() => checkpoints.id),
  question: text('question').notNull(),
  decision: text('decision'),
  decidedBy: varchar('decided_by', { length: 80 }).notNull().default('human'),
  action: mysqlEnum('decision_action', ['approve', 'request_changes', 'reject', 'override', 'replan', 'repeat']),
  status: mysqlEnum('decision_status', ['pending', 'approved', 'changes_requested', 'rejected', 'overridden', 'superseded']).notNull().default('pending'),
  contextJson: json('context_json'),
  createdAt: timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  resolvedAt: datetime('resolved_at'),
});
