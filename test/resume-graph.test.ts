import assert from 'node:assert/strict';
import test from 'node:test';
import { pickLatestTasksByKey, resumeFrontier } from '../src/application/resume-graph.js';

const nodes = [
  { key: 'start', name: '开始' },
  { key: 'a', name: '需求分析' },
  { key: 'b', name: '审核' },
  { key: 'end', name: '结束' },
];
const edges = [
  { source: 'start', target: 'a' },
  { source: 'a', target: 'b' },
  { source: 'b', target: 'end' },
];

test('resume prefers live tasks over cancelled copies after restart', () => {
  const map = pickLatestTasksByKey([
    { id: 1, key: 'a', name: '需求分析', status: 'cancelled' },
    { id: 2, key: 'a', name: '需求分析', status: 'completed' },
    { id: 3, key: 'b', name: '审核', status: 'cancelled' },
    { id: 4, key: 'b', name: '审核', status: 'pending' },
  ]);
  assert.equal(map.get('a')?.id, 2);
  assert.equal(map.get('b')?.id, 4);
});

test('single-node chain can resume from the stopped checker while keeping completed upstream', () => {
  const map = pickLatestTasksByKey([
    { id: 1, key: 'start', name: '开始', status: 'completed' },
    { id: 2, key: 'a', name: '需求分析', status: 'completed' },
    { id: 3, key: 'b', name: '审核', status: 'cancelled' },
    { id: 4, key: 'end', name: '结束', status: 'blocked' },
  ]);
  const frontier = resumeFrontier(nodes, edges, map);
  assert.equal(frontier.ok, true);
  if (!frontier.ok) return;
  assert.deepEqual(frontier.names, ['审核']);
});

test('resume is blocked while a node is awaiting confirmation', () => {
  const map = pickLatestTasksByKey([
    { id: 1, key: 'start', name: '开始', status: 'completed' },
    { id: 2, key: 'a', name: '需求分析', status: 'completed' },
    { id: 3, key: 'b', name: '审核', status: 'awaiting_decision' },
    { id: 4, key: 'end', name: '结束', status: 'blocked' },
  ]);
  assert.deepEqual(resumeFrontier(nodes, edges, map), { ok: false, reason: 'awaiting' });
});

test('resume is blocked when the graph already finished', () => {
  const map = pickLatestTasksByKey([
    { id: 1, key: 'start', name: '开始', status: 'completed' },
    { id: 2, key: 'a', name: '需求分析', status: 'completed' },
    { id: 3, key: 'b', name: '审核', status: 'completed' },
    { id: 4, key: 'end', name: '结束', status: 'completed' },
  ]);
  assert.deepEqual(resumeFrontier(nodes, edges, map), { ok: false, reason: 'done' });
});

test('resume detects graph changes', () => {
  const map = pickLatestTasksByKey([
    { id: 1, key: 'start', name: '开始', status: 'completed' },
    { id: 2, key: 'a', name: '需求分析', status: 'completed' },
  ]);
  assert.deepEqual(resumeFrontier(nodes, edges, map), { ok: false, reason: 'changed' });
});
