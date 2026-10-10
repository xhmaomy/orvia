import { pool } from './client.js';
const statements = [
    `CREATE TABLE IF NOT EXISTS ov_projects (
    id int NOT NULL AUTO_INCREMENT,
    name varchar(160) NOT NULL,
    description text,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_model_providers (
    id int NOT NULL AUTO_INCREMENT,
    name varchar(120) NOT NULL,
    type varchar(80) NOT NULL,
    base_url varchar(500),
    config_json json,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY model_providers_name_unique (name)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_models (
    id int NOT NULL AUTO_INCREMENT,
    provider_id int NOT NULL,
    name varchar(160) NOT NULL,
    display_name varchar(200) NOT NULL,
    capabilities_json json,
    context_window int,
    input_price varchar(32),
    output_price varchar(32),
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY models_provider_name_unique (provider_id, name),
    CONSTRAINT ov_models_provider_fk FOREIGN KEY (provider_id) REFERENCES ov_model_providers (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_agents (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    name varchar(160) NOT NULL,
    description text,
    capabilities_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_agents_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_agent_versions (
    id int NOT NULL AUTO_INCREMENT,
    agent_id int NOT NULL,
    version varchar(40) NOT NULL,
    model_id int NOT NULL,
    role varchar(160) NOT NULL,
    mission text,
    system_prompt text,
    config_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY agent_versions_agent_version_unique (agent_id, version),
    CONSTRAINT ov_agent_versions_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id),
    CONSTRAINT ov_agent_versions_model_fk FOREIGN KEY (model_id) REFERENCES ov_models (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_workflows (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    name varchar(160) NOT NULL,
    version varchar(40) NOT NULL,
    definition_json json,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'draft',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_workflows_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_workflow_nodes (
    id int NOT NULL AUTO_INCREMENT,
    workflow_id int NOT NULL,
    name varchar(160) NOT NULL,
    capability varchar(120) NOT NULL,
    skill varchar(120),
    node_type enum('task','checkpoint') NOT NULL DEFAULT 'task',
    config_json json,
    PRIMARY KEY (id),
    CONSTRAINT ov_workflow_nodes_workflow_fk FOREIGN KEY (workflow_id) REFERENCES ov_workflows (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_workflow_edges (
    id int NOT NULL AUTO_INCREMENT,
    workflow_id int NOT NULL,
    source_node_id int NOT NULL,
    target_node_id int NOT NULL,
    condition_json json,
    PRIMARY KEY (id),
    UNIQUE KEY workflow_edges_unique (workflow_id, source_node_id, target_node_id),
    CONSTRAINT ov_workflow_edges_workflow_fk FOREIGN KEY (workflow_id) REFERENCES ov_workflows (id),
    CONSTRAINT ov_workflow_edges_source_fk FOREIGN KEY (source_node_id) REFERENCES ov_workflow_nodes (id),
    CONSTRAINT ov_workflow_edges_target_fk FOREIGN KEY (target_node_id) REFERENCES ov_workflow_nodes (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_workflow_runs (
    id int NOT NULL AUTO_INCREMENT,
    workflow_id int NOT NULL,
    run_status enum('pending','running','paused','awaiting_decision','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
    current_plan_version int NOT NULL DEFAULT 1,
    idempotency_key varchar(160),
    input_json json,
    error_json json,
    started_at datetime,
    completed_at datetime,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY workflow_runs_idempotency_unique (idempotency_key),
    CONSTRAINT ov_workflow_runs_workflow_fk FOREIGN KEY (workflow_id) REFERENCES ov_workflows (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_plans (
    id int NOT NULL AUTO_INCREMENT,
    workflow_run_id int NOT NULL,
    version int NOT NULL DEFAULT 1,
    plan_status enum('active','superseded','completed','failed') NOT NULL DEFAULT 'active',
    reason text,
    graph_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY plans_run_version_unique (workflow_run_id, version),
    CONSTRAINT ov_plans_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_tasks (
    id int NOT NULL AUTO_INCREMENT,
    workflow_run_id int NOT NULL,
    plan_id int,
    workflow_node_id int,
    agent_id int,
    name varchar(200) NOT NULL,
    task_status enum('pending','blocked','running','paused','awaiting_decision','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
    retry_count int NOT NULL DEFAULT 0,
    max_retries int NOT NULL DEFAULT 0,
    error_kind enum('retryable','human_required','terminal'),
    input_json json,
    output_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_tasks_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id),
    CONSTRAINT ov_tasks_plan_fk FOREIGN KEY (plan_id) REFERENCES ov_plans (id),
    CONSTRAINT ov_tasks_node_fk FOREIGN KEY (workflow_node_id) REFERENCES ov_workflow_nodes (id),
    CONSTRAINT ov_tasks_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_sessions (
    id int NOT NULL AUTO_INCREMENT,
    task_id int,
    agent_id int,
    session_context_type enum('workflow','chat') NOT NULL DEFAULT 'workflow',
    context_id int,
    runtime varchar(80) NOT NULL DEFAULT 'pi',
    session_status enum('pending','running','paused','completed','failed') NOT NULL DEFAULT 'pending',
    input_json json,
    output_json json,
    started_at datetime,
    completed_at datetime,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_sessions_task_fk FOREIGN KEY (task_id) REFERENCES ov_tasks (id),
    CONSTRAINT ov_sessions_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_checkpoints (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_run_id int NOT NULL,
    task_id int,
    workflow_node_id int,
    title varchar(200) NOT NULL,
    instructions text,
    checkpoint_status enum('pending','approved','changes_requested','rejected','overridden','superseded') NOT NULL DEFAULT 'pending',
    context_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at datetime,
    PRIMARY KEY (id),
    CONSTRAINT ov_checkpoints_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_checkpoints_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id),
    CONSTRAINT ov_checkpoints_task_fk FOREIGN KEY (task_id) REFERENCES ov_tasks (id),
    CONSTRAINT ov_checkpoints_node_fk FOREIGN KEY (workflow_node_id) REFERENCES ov_workflow_nodes (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_artifacts (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_run_id int,
    task_id int,
    session_id int,
    name varchar(240) NOT NULL,
    kind varchar(80) NOT NULL DEFAULT 'text',
    artifact_status enum('draft','ready','approved','rejected','archived') NOT NULL DEFAULT 'ready',
    current_version int NOT NULL DEFAULT 1,
    metadata_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_artifacts_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_artifacts_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id),
    CONSTRAINT ov_artifacts_task_fk FOREIGN KEY (task_id) REFERENCES ov_tasks (id),
    CONSTRAINT ov_artifacts_session_fk FOREIGN KEY (session_id) REFERENCES ov_sessions (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_artifact_versions (
    id int NOT NULL AUTO_INCREMENT,
    artifact_id int NOT NULL,
    version int NOT NULL,
    content text NOT NULL,
    mime_type varchar(120) NOT NULL DEFAULT 'text/plain',
    created_by varchar(80) NOT NULL DEFAULT 'agent',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY artifact_versions_unique (artifact_id, version),
    CONSTRAINT ov_artifact_versions_artifact_fk FOREIGN KEY (artifact_id) REFERENCES ov_artifacts (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_memories (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    agent_id int,
    memory_scope enum('project','agent') NOT NULL DEFAULT 'project',
    memory_key varchar(180) NOT NULL,
    content text NOT NULL,
    metadata_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_memories_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_memories_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_chat_threads (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    agent_id int NOT NULL,
    title varchar(200) NOT NULL,
    chat_status enum('active','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_chat_threads_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_chat_threads_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_chat_messages (
    id int NOT NULL AUTO_INCREMENT,
    thread_id int NOT NULL,
    session_id int,
    chat_role enum('user','assistant','system') NOT NULL,
    content text NOT NULL,
    message_status enum('pending','streaming','completed','failed') NOT NULL DEFAULT 'completed',
    metadata_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_chat_messages_thread_fk FOREIGN KEY (thread_id) REFERENCES ov_chat_threads (id),
    CONSTRAINT ov_chat_messages_session_fk FOREIGN KEY (session_id) REFERENCES ov_sessions (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_permission_policies (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    agent_id int,
    name varchar(160) NOT NULL,
    rules_json json NOT NULL,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_permission_policies_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_permission_policies_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_budgets (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_run_id int,
    limit_units int NOT NULL,
    used_units int NOT NULL DEFAULT 0,
    budget_status enum('active','exhausted','closed') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_budgets_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_budgets_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_usage_records (
    id int NOT NULL AUTO_INCREMENT,
    budget_id int,
    workflow_run_id int,
    task_id int,
    agent_id int,
    units int NOT NULL DEFAULT 1,
    metadata_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_usage_records_budget_fk FOREIGN KEY (budget_id) REFERENCES ov_budgets (id),
    CONSTRAINT ov_usage_records_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id),
    CONSTRAINT ov_usage_records_task_fk FOREIGN KEY (task_id) REFERENCES ov_tasks (id),
    CONSTRAINT ov_usage_records_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_events (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_run_id int,
    task_id int,
    session_id int,
    agent_id int,
    type varchar(120) NOT NULL,
    payload_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_events_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_events_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id),
    CONSTRAINT ov_events_task_fk FOREIGN KEY (task_id) REFERENCES ov_tasks (id),
    CONSTRAINT ov_events_session_fk FOREIGN KEY (session_id) REFERENCES ov_sessions (id),
    CONSTRAINT ov_events_agent_fk FOREIGN KEY (agent_id) REFERENCES ov_agents (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_decisions (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_run_id int,
    checkpoint_id int,
    question text NOT NULL,
    decision text,
    decided_by varchar(80) NOT NULL DEFAULT 'human',
    decision_action enum('approve','request_changes','reject','override','replan'),
    decision_status enum('pending','approved','changes_requested','rejected','overridden','superseded') NOT NULL DEFAULT 'pending',
    context_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at datetime,
    PRIMARY KEY (id),
    CONSTRAINT ov_decisions_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_decisions_run_fk FOREIGN KEY (workflow_run_id) REFERENCES ov_workflow_runs (id),
    CONSTRAINT ov_decisions_checkpoint_fk FOREIGN KEY (checkpoint_id) REFERENCES ov_checkpoints (id)
  )`,
];
export const requiredTableNames = statements.map((statement) => {
    const match = statement.match(/^CREATE TABLE IF NOT EXISTS (ov_[a-z_]+)/);
    if (!match)
        throw new Error('Invalid table definition');
    return match[1];
});
export const expectedTableShapes = Object.fromEntries(statements.map((statement) => {
    const tableName = statement.match(/^CREATE TABLE IF NOT EXISTS (ov_[a-z_]+)/)?.[1];
    if (!tableName)
        throw new Error('Invalid table definition');
    const columns = [...statement.matchAll(/^\s{4}([a-z][a-z0-9_]*)\s+(?!KEY\b|CONSTRAINT\b)/gm)]
        .map((match) => match[1]);
    const indexes = [
        ...(statement.includes('PRIMARY KEY') ? ['PRIMARY'] : []),
        ...[...statement.matchAll(/^\s+(?:UNIQUE\s+)?KEY\s+([a-z0-9_]+)/gm)].map((match) => match[1]),
    ];
    const foreignKeys = [...statement.matchAll(/^\s+CONSTRAINT\s+([a-z0-9_]+)\s+FOREIGN KEY/gm)]
        .map((match) => match[1]);
    return [tableName, { columns, indexes, foreignKeys }];
}));
export function parseTableDefinitions(statement) {
    const tableName = statement.match(/^CREATE TABLE IF NOT EXISTS (ov_[a-z_]+)/)?.[1];
    if (!tableName)
        throw new Error('Invalid table definition');
    const columns = [];
    const indexes = [];
    const foreignKeys = [];
    for (const rawLine of statement.split('\n')) {
        const line = rawLine.replace(/,?\s*$/, '').trim();
        const column = line.match(/^([a-z][a-z0-9_]*)\s+(?!KEY\b|CONSTRAINT\b)(.+)$/);
        if (column && !line.startsWith('PRIMARY KEY') && !line.startsWith('UNIQUE KEY') && !line.startsWith('KEY ') && !line.startsWith('CONSTRAINT ')) {
            columns.push({ name: column[1], sql: `${column[1]} ${column[2]}` });
            continue;
        }
        const unique = line.match(/^(UNIQUE KEY)\s+([a-z0-9_]+)\s+(\(.+\))$/);
        if (unique) {
            indexes.push({ name: unique[2], sql: `${unique[1]} ${unique[2]} ${unique[3]}` });
            continue;
        }
        const key = line.match(/^KEY\s+([a-z0-9_]+)\s+(\(.+\))$/);
        if (key) {
            indexes.push({ name: key[1], sql: `KEY ${key[1]} ${key[2]}` });
            continue;
        }
        const foreignKey = line.match(/^(CONSTRAINT\s+([a-z0-9_]+)\s+FOREIGN KEY\s+\(.+\)\s+REFERENCES\s+ov_[a-z_]+\s+\(.+\))$/);
        if (foreignKey)
            foreignKeys.push({ name: foreignKey[2], sql: foreignKey[1] });
    }
    return { tableName, columns, indexes, foreignKeys };
}
export const tableDefinitions = statements.map(parseTableDefinitions);
export async function ensureTables() {
    for (const statement of statements) {
        await pool.query(statement);
    }
}
export async function repairSchema() {
    const issues = await schemaIntegrityIssues();
    const repaired = [];
    for (const table of tableDefinitions) {
        for (const column of table.columns) {
            const issue = `missing column ${table.tableName}.${column.name}`;
            if (!issues.includes(issue))
                continue;
            await pool.query(`ALTER TABLE ${table.tableName} ADD COLUMN ${column.sql}`);
            repaired.push(issue);
        }
        for (const index of table.indexes) {
            const issue = `missing index ${table.tableName}.${index.name}`;
            if (!issues.includes(issue))
                continue;
            await pool.query(`ALTER TABLE ${table.tableName} ADD ${index.sql}`);
            repaired.push(issue);
        }
        for (const foreignKey of table.foreignKeys) {
            const issue = `missing foreign key ${table.tableName}.${foreignKey.name}`;
            if (!issues.includes(issue))
                continue;
            await pool.query(`ALTER TABLE ${table.tableName} ADD ${foreignKey.sql}`);
            repaired.push(issue);
        }
    }
    return repaired;
}
export async function missingRequiredTables() {
    const placeholders = requiredTableNames.map(() => '?').join(', ');
    const [rows] = await pool.query(`SELECT table_name AS tableName
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`, requiredTableNames);
    const present = new Set(rows.map((row) => row.tableName));
    return requiredTableNames.filter((name) => !present.has(name));
}
export async function schemaIntegrityIssues() {
    const missingTables = await missingRequiredTables();
    const issues = missingTables.map((table) => `missing table ${table}`);
    const presentTables = requiredTableNames.filter((table) => !missingTables.includes(table));
    if (presentTables.length === 0)
        return issues;
    const placeholders = presentTables.map(() => '?').join(', ');
    const [columnRows] = await pool.query(`SELECT table_name AS tableName, column_name AS itemName
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`, presentTables);
    const [indexRows] = await pool.query(`SELECT DISTINCT table_name AS tableName, index_name AS itemName
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`, presentTables);
    const [foreignKeyRows] = await pool.query(`SELECT table_name AS tableName, constraint_name AS itemName
       FROM information_schema.referential_constraints
      WHERE constraint_schema = DATABASE() AND table_name IN (${placeholders})`, presentTables);
    const grouped = (rows) => {
        const values = new Map();
        for (const row of rows) {
            const items = values.get(row.tableName) ?? new Set();
            items.add(row.itemName);
            values.set(row.tableName, items);
        }
        return values;
    };
    const columns = grouped(columnRows);
    const indexes = grouped(indexRows);
    const foreignKeys = grouped(foreignKeyRows);
    for (const table of presentTables) {
        const expected = expectedTableShapes[table];
        if (!expected)
            continue;
        for (const column of expected.columns) {
            if (!columns.get(table)?.has(column))
                issues.push(`missing column ${table}.${column}`);
        }
        for (const index of expected.indexes) {
            if (!indexes.get(table)?.has(index))
                issues.push(`missing index ${table}.${index}`);
        }
        for (const foreignKey of expected.foreignKeys) {
            if (!foreignKeys.get(table)?.has(foreignKey))
                issues.push(`missing foreign key ${table}.${foreignKey}`);
        }
    }
    return issues;
}
