import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAcyclicGraph, graphIsComplete, selectRunnableTask, selectRunnableTasks } from '../src/application/task-graph.js';

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

test('workflow graph rejects cycles and unknown nodes', () => {
  assert.doesNotThrow(() => assertAcyclicGraph(['a', 'b'], [{ source: 'a', target: 'b' }]));
  assert.throws(() => assertAcyclicGraph(['a', 'b'], [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
  ]));
  assert.throws(() => assertAcyclicGraph(['a'], [{ source: 'a', target: 'missing' }]));
});
