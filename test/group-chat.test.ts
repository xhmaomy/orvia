import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dependenciesSatisfied,
  executionFocusKeys,
  focusTaskUpdates,
  handoffContent,
  mentionKeysFromText,
  routeGroupMessage,
  splitNodeAction,
  taskKeyInFocus,
} from '../src/application/group-chat.js';
import { selectRunnableTasks } from '../src/application/task-graph.js';

const nodes = [
  { key: 'start', name: '开始' },
  { key: 'write', name: '撰写' },
  { key: 'review', name: '复核' },
  { key: 'end', name: '结束' },
];

test('mentions only explicit @name and @all', () => {
  assert.deepEqual(mentionKeysFromText('请 overall 看一下 all 的情况', nodes), []);
  assert.deepEqual(mentionKeysFromText('@撰写 开始做', nodes), ['write']);
  assert.deepEqual(mentionKeysFromText('@all 看一下 @撰写', nodes), ['__all__', 'write']);
  assert.deepEqual(mentionKeysFromText('@不存在', nodes), []);
});

test('idle nodes reply themselves and the admin only covers nodes that are executing', () => {
  const chatableKeys = new Set(['write']);
  const checkpointKeys = new Set(['review']);
  const idle = routeGroupMessage({ mentionKeys: ['write'], chatableKeys, checkpointKeys, busyKeys: new Set() });
  assert.deepEqual(idle, { kind: 'direct', nodeKey: 'write' });
  const busy = routeGroupMessage({ mentionKeys: ['write'], chatableKeys, checkpointKeys, busyKeys: new Set(['write']) });
  assert.deepEqual(busy, { kind: 'busy', nodeKey: 'write' });
  const many = routeGroupMessage({ mentionKeys: ['write', 'review'], chatableKeys, checkpointKeys, busyKeys: new Set() });
  assert.deepEqual(many, {
    kind: 'broadcast',
    replies: [{ kind: 'direct', nodeKey: 'write' }, { kind: 'checkpoint', nodeKey: 'review' }],
    busyKeys: [],
  });
  const all = routeGroupMessage({ mentionKeys: ['__all__'], chatableKeys, checkpointKeys, busyKeys: new Set() });
  assert.deepEqual(all, {
    kind: 'broadcast',
    replies: [{ kind: 'direct', nodeKey: 'write' }, { kind: 'checkpoint', nodeKey: 'review' }],
    busyKeys: [],
  });
  const mixed = routeGroupMessage({ mentionKeys: ['__all__'], chatableKeys, checkpointKeys, busyKeys: new Set(['write']) });
  assert.deepEqual(mixed, {
    kind: 'broadcast',
    replies: [{ kind: 'checkpoint', nodeKey: 'review' }],
    busyKeys: ['write'],
  });
  const allBusy = routeGroupMessage({ mentionKeys: ['__all__'], chatableKeys, checkpointKeys, busyKeys: new Set(['write', 'review']) });
  assert.deepEqual(allBusy, { kind: 'conductor', nodeKeys: ['write', 'review'] });
  assert.deepEqual(routeGroupMessage({ mentionKeys: [], chatableKeys, checkpointKeys, busyKeys: new Set() }), { kind: 'save' });
  assert.deepEqual(routeGroupMessage({ mentionKeys: ['review'], chatableKeys, checkpointKeys, busyKeys: new Set() }), { kind: 'checkpoint', nodeKey: 'review' });
});

test('node action is stripped from the visible reply and defaults to chat', () => {
  assert.deepEqual(splitNodeAction('好的，我开始。\n{"action":"execute"}'), { visible: '好的，我开始。', action: 'execute' });
  assert.deepEqual(splitNodeAction('只是聊聊'), { visible: '只是聊聊', action: 'reply' });
  assert.equal(splitNodeAction('正文里有 {"action":"execute"} 但不是结尾').action, 'reply');
});

test('chat execution focus follows workflow edges from the mentioned node', () => {
  const keys = ['start', 'write', 'review', 'end', 'other'];
  const edges = [
    { source: 'start', target: 'write' },
    { source: 'write', target: 'review' },
    { source: 'review', target: 'end' },
    { source: 'start', target: 'other' },
  ];
  assert.deepEqual(executionFocusKeys(keys, edges, 'write').sort(), ['end', 'review', 'write']);
  assert.equal(dependenciesSatisfied('write', edges, new Set(['start'])), true);
  assert.equal(dependenciesSatisfied('write', edges, new Set()), false);
  assert.equal(taskKeyInFocus('other', executionFocusKeys(keys, edges, 'write')), false);
  assert.equal(taskKeyInFocus('review', null), true);
});

test('a serial chain started from chat runs the mentioned node before its downstream', () => {
  const keys = ['start', 'write', 'review'];
  const edges = [
    { source: 'start', target: 'write' },
    { source: 'write', target: 'review' },
  ];
  const focus = executionFocusKeys(keys, edges, 'write');
  const statuses = new Map([
    ['start', 'completed'],
    ['write', 'completed'],
    ['review', 'completed'],
  ]);
  const updates = focusTaskUpdates({ seedKey: 'write', seedStatus: 'completed', focusKeys: focus, edges, statuses });
  assert.equal(updates.get('write'), 'pending');
  assert.equal(updates.get('review'), 'blocked');
  assert.equal(updates.has('start'), false);

  const tasks = [
    { id: 1, workflowNodeId: 1, status: 'completed', inputJson: { key: 'start' } },
    { id: 2, workflowNodeId: 2, status: 'pending', inputJson: { key: 'write', dependsOnNodeIds: [1] } },
    { id: 3, workflowNodeId: 3, status: 'blocked', inputJson: { key: 'review', dependsOnNodeIds: [2] } },
    { id: 4, workflowNodeId: 4, status: 'pending', inputJson: { key: 'side' } },
  ];
  const ready = selectRunnableTasks(tasks).filter((task) => taskKeyInFocus(String((task.inputJson as { key: string }).key), focus));
  assert.deepEqual(ready.map((task) => task.id), [2]);
});

test('handoff message names the downstream nodes from the workflow edge', () => {
  assert.equal(handoffContent('稿子写好了', ['复核']), '稿子写好了\n@复核');
  assert.equal(handoffContent('结束', []), '结束');
});
