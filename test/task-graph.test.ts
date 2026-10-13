import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertAcyclicGraph,
  graphIsComplete,
  plannedTaskStatus,
  reachableFromRoots,
  selectRunnableTask,
  selectRunnableTasks,
} from '../src/application/task-graph.js';

test('task graph releases a node only after all dependencies complete', () => {
  const tasks = [
    { id: 1, workflowNodeId: 10, status: 'completed', inputJson: {} },
    { id: 2, workflowNodeId: 20, status: 'blocked', inputJson: { dependsOnNodeIds: [10] } },
    { id: 3, workflowNodeId: 30, status: 'blocked', inputJson: { dependsOnNodeIds: [20] } },
  ];
  assert.equal(selectRunnableTask(tasks)?.id, 2);
  assert.equal(graphIsComplete(tasks), false);
});

test('task graph reports completion with completed and cancelled leaves', () => {
  assert.equal(graphIsComplete([
    { id: 1, workflowNodeId: 10, status: 'completed', inputJson: {} },
    { id: 2, workflowNodeId: 20, status: 'cancelled', inputJson: {} },
  ]), true);
});

test('ready tasks include every independent branch and honor task dependencies', () => {
  const tasks = [
    { id: 1, workflowNodeId: 10, status: 'pending', inputJson: {} },
    { id: 2, workflowNodeId: 20, status: 'pending', inputJson: {} },
    { id: 3, workflowNodeId: null, status: 'blocked', inputJson: { dependsOnTaskIds: [1] } },
  ];
  assert.deepEqual(selectRunnableTasks(tasks).map((task) => task.id), [1, 2]);
  tasks[0]!.status = 'completed';
  assert.deepEqual(selectRunnableTasks(tasks).map((task) => task.id), [2, 3]);
});

test('runnable tasks still resolve deps when workflowNodeId column was cleared after board save', () => {
  const tasks = [
    { id: 1, workflowNodeId: null, status: 'completed', inputJson: { workflowNodeId: 10, nodeType: 'start' } },
    { id: 2, workflowNodeId: null, status: 'pending', inputJson: { workflowNodeId: 20, nodeType: 'task', dependsOnNodeIds: [10] } },
    { id: 3, workflowNodeId: null, status: 'blocked', inputJson: { workflowNodeId: 30, nodeType: 'checkpoint', dependsOnNodeIds: [20] } },
  ];
  assert.deepEqual(selectRunnableTasks(tasks).map((task) => task.id), [2]);
});

test('workflow graph rejects cycles and unknown nodes', () => {
  assert.doesNotThrow(() => assertAcyclicGraph(['a', 'b'], [{ source: 'a', target: 'b' }]));
  assert.throws(() => assertAcyclicGraph(['a', 'b'], [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
  ]));
  assert.throws(() => assertAcyclicGraph(['a'], [{ source: 'a', target: 'missing' }]));
});

test('only nodes reachable from start can be planned to run', () => {
  const reachable = reachableFromRoots(
    [1, 2, 3, 4],
    [
      { source: 1, target: 2 },
      { source: 2, target: 3 },
    ],
    [1],
  );
  assert.deepEqual([...reachable].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(plannedTaskStatus(1, [], reachable), 'pending');
  assert.equal(plannedTaskStatus(2, [1], reachable), 'blocked');
  assert.equal(plannedTaskStatus(4, [], reachable), 'cancelled');
});
