import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatWorkflowVersionLabel,
  nextWorkflowVersionSeq,
  versionsToPrune,
  MAX_WORKFLOW_VERSIONS,
} from '../src/application/workflow-versions.js';

test('version labels use seq and Beijing date stamp', () => {
  const label = formatWorkflowVersionLabel(2, new Date('2026-10-11T04:00:00.000Z'));
  assert.equal(label, 'v2-20261011');
});

test('next seq starts at 1 and increments from max', () => {
  assert.equal(nextWorkflowVersionSeq(undefined), 1);
  assert.equal(nextWorkflowVersionSeq(0), 1);
  assert.equal(nextWorkflowVersionSeq(7), 8);
});

test('prune keeps newest 30 by seq', () => {
  const rows = Array.from({ length: 32 }, (_, index) => ({ id: index + 1, seq: index + 1 }));
  const dropped = versionsToPrune(rows, MAX_WORKFLOW_VERSIONS);
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((row) => row.seq), [1, 2]);
  assert.equal(versionsToPrune(rows.slice(0, 30)).length, 0);
});
