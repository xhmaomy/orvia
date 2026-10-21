import { pool } from './client.js';
const statements = [
    `CREATE TABLE IF NOT EXISTS ov_tenants (
    id int NOT NULL AUTO_INCREMENT,
    name varchar(160) NOT NULL,
    slug varchar(80) NOT NULL,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY tenants_slug_unique (slug)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_users (
    id int NOT NULL AUTO_INCREMENT,
    email varchar(190) NOT NULL,
    name varchar(160) NOT NULL,
    password_hash varchar(255) NOT NULL,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY users_email_unique (email)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_tenant_members (
    id int NOT NULL AUTO_INCREMENT,
    tenant_id int NOT NULL,
    user_id int NOT NULL,
    member_role enum('owner','admin','member') NOT NULL DEFAULT 'member',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY tenant_members_unique (tenant_id, user_id),
    CONSTRAINT ov_tenant_members_tenant_fk FOREIGN KEY (tenant_id) REFERENCES ov_tenants (id),
    CONSTRAINT ov_tenant_members_user_fk FOREIGN KEY (user_id) REFERENCES ov_users (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_projects (
    id int NOT NULL AUTO_INCREMENT,
    tenant_id int,
    name varchar(160) NOT NULL,
    description text,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_projects_tenant_fk FOREIGN KEY (tenant_id) REFERENCES ov_tenants (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_capabilities (
    id int NOT NULL AUTO_INCREMENT,
    tenant_id int NOT NULL,
    capability_key varchar(120) NOT NULL,
    name varchar(160) NOT NULL,
    description text,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY capabilities_tenant_key_unique (tenant_id, capability_key),
    CONSTRAINT ov_capabilities_tenant_fk FOREIGN KEY (tenant_id) REFERENCES ov_tenants (id)
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
    `CREATE TABLE IF NOT EXISTS ov_workflows (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    name varchar(160) NOT NULL,
    version varchar(40) NOT NULL,
    current_version_id int,
    definition_json json,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'draft',
    run_status enum('pending','running','paused','awaiting_decision','completed','failed','cancelled'),
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT ov_workflows_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_workflow_versions (
    id int NOT NULL AUTO_INCREMENT,
    workflow_id int NOT NULL,
    version varchar(40) NOT NULL,
    seq int NOT NULL,
    name varchar(160) NOT NULL,
    definition_json json NOT NULL,
    published_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY workflow_versions_workflow_version_unique (workflow_id, version),
    UNIQUE KEY workflow_versions_workflow_seq_unique (workflow_id, seq),
    CONSTRAINT ov_workflow_versions_workflow_fk FOREIGN KEY (workflow_id) REFERENCES ov_workflows (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_skills (
    id int NOT NULL AUTO_INCREMENT,
    tenant_id int NOT NULL,
    skill_key varchar(120) NOT NULL,
    name varchar(160) NOT NULL,
    description text,
    skill_kind enum('builtin','custom') NOT NULL DEFAULT 'custom',
    tools_json json,
    content_md text,
    config_json json,
    status enum('active','inactive','draft','published','archived') NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY skills_tenant_key_unique (tenant_id, skill_key),
    CONSTRAINT ov_skills_tenant_fk FOREIGN KEY (tenant_id) REFERENCES ov_tenants (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_agents (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_id int,
    name varchar(160) NOT NULL,
    description text,
    capabilities_json json,
    skills_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY agents_workflow_id_idx (workflow_id),
    CONSTRAINT ov_agents_project_fk FOREIGN KEY (project_id) REFERENCES ov_projects (id),
    CONSTRAINT ov_agents_workflow_fk FOREIGN KEY (workflow_id) REFERENCES ov_workflows (id)
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
    `CREATE TABLE IF NOT EXISTS ov_workflow_nodes (
    id int NOT NULL AUTO_INCREMENT,
    workflow_id int NOT NULL,
    name varchar(160) NOT NULL,
    capability varchar(120) NOT NULL,
    skill varchar(120),
    capabilities_json json,
    node_type enum('task','checkpoint','start','end') NOT NULL DEFAULT 'task',
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
    workflow_version_id int,
    run_status enum('pending','running','paused','awaiting_decision','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
    current_plan_version int NOT NULL DEFAULT 1,
    idempotency_key varchar(160),
    input_json json,
    error_json json,
    started_at datetime,
    completed_at datetime,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY workflow_runs_workflow_unique (workflow_id),
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
    `CREATE TABLE IF NOT EXISTS ov_node_messages (
    id int NOT NULL AUTO_INCREMENT,
    workflow_id int NOT NULL,
    workflow_version_id int,
    node_key varchar(160) NOT NULL,
    session_id int,
    node_message_role enum('user','assistant') NOT NULL,
    content text NOT NULL,
    thinking text,
    node_message_status enum('pending','streaming','completed','failed') NOT NULL DEFAULT 'completed',
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY node_messages_workflow_key (workflow_id, node_key),
    KEY node_messages_version_idx (workflow_version_id),
    CONSTRAINT ov_node_messages_workflow_fk FOREIGN KEY (workflow_id) REFERENCES ov_workflows (id),
    CONSTRAINT ov_node_messages_session_fk FOREIGN KEY (session_id) REFERENCES ov_sessions (id)
  )`,
    `CREATE TABLE IF NOT EXISTS ov_events (
    id int NOT NULL AUTO_INCREMENT,
    project_id int NOT NULL,
    workflow_run_id int,
    workflow_version_id int,
    task_id int,
    session_id int,
    agent_id int,
    type varchar(120) NOT NULL,
    payload_json json,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY events_version_idx (workflow_version_id),
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
    decision_action enum('approve','request_changes','reject','override','replan','repeat'),
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
const retiredTables = [
    'ov_artifact_versions',
    'ov_artifacts',
    'ov_memories',
    'ov_chat_messages',
    'ov_chat_threads',
    'ov_usage_records',
    'ov_budgets',
    'ov_permission_policies',
    'ov_alerts',
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
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of retiredTables) {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
    for (const statement of statements) {
        await pool.query(statement);
    }
}
/** 能力目录从按项目改为按租户共享。 */
export async function migrateCapabilitiesToTenant() {
    const [tables] = await pool.query(`SELECT table_name AS tableName
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'ov_capabilities'`);
    if (tables.length === 0)
        return;
    const [columns] = await pool.query(`SELECT column_name AS columnName
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'ov_capabilities'`);
    const names = new Set(columns.map((row) => row.columnName));
    if (names.has('tenant_id') && !names.has('project_id')) {
        await pool.query(`
      DELETE c0 FROM ov_capabilities c0
      INNER JOIN ov_capabilities c1
        ON c0.capability_key = c1.capability_key
       AND c1.tenant_id = (SELECT id FROM ov_tenants ORDER BY id ASC LIMIT 1)
       WHERE c0.tenant_id IS NULL OR c0.tenant_id = 0
    `);
        await pool.query(`
      UPDATE ov_capabilities
         SET tenant_id = (SELECT id FROM ov_tenants ORDER BY id ASC LIMIT 1)
       WHERE tenant_id IS NULL OR tenant_id = 0
    `);
        return;
    }
    if (!names.has('project_id'))
        return;
    if (!names.has('tenant_id')) {
        await pool.query('ALTER TABLE ov_capabilities ADD COLUMN tenant_id int NULL');
    }
    await pool.query(`
    UPDATE ov_capabilities c
    INNER JOIN ov_projects p ON p.id = c.project_id
       SET c.tenant_id = p.tenant_id
     WHERE c.tenant_id IS NULL OR c.tenant_id = 0
  `);
    await pool.query(`
    UPDATE ov_capabilities
       SET tenant_id = (SELECT id FROM ov_tenants ORDER BY id ASC LIMIT 1)
     WHERE tenant_id IS NULL OR tenant_id = 0
  `);
    await pool.query(`
    DELETE c1 FROM ov_capabilities c1
    INNER JOIN ov_capabilities c2
      ON c1.tenant_id = c2.tenant_id
     AND c1.capability_key = c2.capability_key
     AND c1.id > c2.id
  `);
    const [fkRows] = await pool.query(`SELECT constraint_name AS constraintName
       FROM information_schema.referential_constraints
      WHERE constraint_schema = DATABASE() AND table_name = 'ov_capabilities'`);
    for (const row of fkRows) {
        await pool.query(`ALTER TABLE ov_capabilities DROP FOREIGN KEY \`${row.constraintName}\``);
    }
    const [indexRows] = await pool.query(`SELECT DISTINCT index_name AS indexName
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'ov_capabilities'
        AND index_name <> 'PRIMARY'`);
    for (const row of indexRows) {
        await pool.query(`ALTER TABLE ov_capabilities DROP INDEX \`${row.indexName}\``);
    }
    await pool.query('ALTER TABLE ov_capabilities DROP COLUMN project_id');
    await pool.query('ALTER TABLE ov_capabilities MODIFY tenant_id int NOT NULL');
    await pool.query('ALTER TABLE ov_capabilities ADD UNIQUE KEY capabilities_tenant_key_unique (tenant_id, capability_key)');
    await pool.query('ALTER TABLE ov_capabilities ADD CONSTRAINT ov_capabilities_tenant_fk FOREIGN KEY (tenant_id) REFERENCES ov_tenants (id)');
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
export async function repairEnums() {
    const alters = [
        ['ov_workflow_nodes', 'node_type', "enum('task','checkpoint','start','end') NOT NULL DEFAULT 'task'"],
        ['ov_decisions', 'decision_action', "enum('approve','request_changes','reject','override','replan','repeat')"],
    ];
    for (const [table, column, definition] of alters) {
        const [rows] = await pool.query(`SELECT COLUMN_TYPE AS columnType
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
        const current = rows[0]?.columnType ?? '';
        if (!current || current.includes("'start'") || current.includes("'repeat'"))
            continue;
        await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
    }
}
