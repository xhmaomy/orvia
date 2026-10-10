import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseTableDefinitions } from '../src/db/ensure-schema.js';

test('startup table statements are idempotent ov_ creates and can repair missing columns', () => {
  const source = readFileSync(new URL('../src/db/ensure-schema.ts', import.meta.url), 'utf8');
  const names = [...source.matchAll(/CREATE TABLE IF NOT EXISTS (ov_[a-z_]+)/g)].map((match) => match[1]);
  assert.equal(names.length, 20);
  assert.equal(new Set(names).size, 20);
  assert.ok(names.includes('ov_projects'));
  assert.ok(names.includes('ov_capabilities'));
  assert.ok(names.includes('ov_tenants'));
  assert.ok(names.includes('ov_users'));
  assert.ok(names.includes('ov_tenant_members'));
  assert.ok(names.includes('ov_node_messages'));
  assert.ok(names.includes('ov_decisions'));
  assert.ok(names.includes('ov_checkpoints'));
  assert.ok(!names.includes('ov_alerts'));
  assert.ok(!names.includes('ov_artifacts'));
  assert.match(source, /DROP TABLE IF EXISTS \$\{table\}/);
  assert.match(source, /'ov_alerts'/);
  assert.match(source, /'ov_artifacts'/);
  assert.match(source, /export const requiredTableNames/);
  assert.match(source, /export const expectedTableShapes/);
  assert.match(source, /export async function repairSchema/);
  assert.match(source, /information_schema\.tables/);
  assert.match(source, /information_schema\.columns/);
  assert.match(source, /information_schema\.statistics/);
  assert.match(source, /information_schema\.referential_constraints/);
  assert.match(source, /ALTER TABLE \$\{table\.tableName\} ADD COLUMN/);
});

test('table parser extracts columns, unique indexes and foreign keys', () => {
  const parsed = parseTableDefinitions(`CREATE TABLE IF NOT EXISTS ov_workflow_edges (
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
  )`);
  assert.equal(parsed.tableName, 'ov_workflow_edges');
  assert.deepEqual(parsed.columns.map((column) => column.name), [
    'id',
    'workflow_id',
    'source_node_id',
    'target_node_id',
    'condition_json',
  ]);
  assert.deepEqual(parsed.indexes.map((index) => index.name), ['workflow_edges_unique']);
  assert.deepEqual(parsed.foreignKeys.map((key) => key.name), [
    'ov_workflow_edges_workflow_fk',
    'ov_workflow_edges_source_fk',
    'ov_workflow_edges_target_fk',
  ]);
});
