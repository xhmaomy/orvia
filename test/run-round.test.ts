import assert from 'node:assert/strict';
import test from 'node:test';
import { activePlanId, eventInCurrentRound } from '../web/lib/run-round.js';

test('the active plan of a run is the one the board should show', () => {
  const plans = [
    { id: 37, status: 'superseded', version: 21 },
    { id: 38, status: 'active', version: 22 },
  ];
  assert.equal(activePlanId([], plans), 38);
});

test('without an active plan the newest task plan wins', () => {
  const tasks = [
    { id: 1, planId: 37, status: 'cancelled' },
    { id: 2, planId: 38, status: 'pending' },
  ];
  assert.equal(activePlanId(tasks, []), 38);
  assert.equal(activePlanId([], []), null);
});

test('a return event of an earlier round does not belong to the current round', () => {
  // 从头开始后：旧轮次的退回事件带着旧 planId
  const current = { taskId: 200, planId: 38 };
  const older = { taskId: 199, planId: 37 };
  const liveTaskIds = new Set([200]);
  assert.equal(eventInCurrentRound(current, 38, liveTaskIds), true);
  assert.equal(eventInCurrentRound(older, 38, liveTaskIds), false);
});

test('a legacy event without planId only counts when its task is still live', () => {
  const liveTaskIds = new Set([200]);
  assert.equal(eventInCurrentRound({ taskId: 200 }, 38, liveTaskIds), true);
  assert.equal(eventInCurrentRound({ taskId: 199 }, 38, liveTaskIds), false);
});

test('every event is kept when the run has no plan information', () => {
  assert.equal(eventInCurrentRound({ taskId: 199 }, null, new Set()), true);
});
