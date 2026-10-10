import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('workflow replan auto-resumes unless resume is explicitly false', () => {
  const source = readFileSync(new URL('../src/api/server.ts', import.meta.url), 'utf8');
  assert.match(source, /body\.resume === false \? undefined : scheduleWorkflowExecution/);
  assert.match(source, /action === 'replan' \|\| action === 'request_changes'/);
  assert.match(source, /await db\.transaction\(async \(tx\) => \{/);
  assert.match(source, /inArray\(tasks\.status, \[\.\.\.openStatuses\]\)/);
  assert.match(source, /const openStatuses = \['pending', 'blocked', 'paused', 'awaiting_decision', 'failed', 'running'\]/);
  assert.match(source, /action === 'reject'/);
});
