import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertRunTransition,
  assertTaskTransition,
  canTransitionRun,
  canTransitionTask,
} from '../src/domain/state-machine.js';

test('workflow run state machine allows human checkpoint flow', () => {
  assert.equal(canTransitionRun('running', 'awaiting_decision'), true);
  assert.equal(canTransitionRun('awaiting_decision', 'running'), true);
  assert.equal(canTransitionRun('awaiting_decision', 'paused'), true);
  assert.equal(canTransitionRun('completed', 'running'), true);
  assert.equal(canTransitionRun('cancelled', 'running'), true);
  assert.equal(canTransitionRun('failed', 'running'), true);
  assert.doesNotThrow(() => assertRunTransition('paused', 'running'));
  assert.doesNotThrow(() => assertRunTransition('completed', 'running'));
  assert.doesNotThrow(() => assertRunTransition('cancelled', 'running'));
});

test('task state machine supports retry without reopening completed tasks', () => {
  assert.equal(canTransitionTask('failed', 'pending'), true);
  assert.equal(canTransitionTask('blocked', 'pending'), true);
  assert.equal(canTransitionTask('blocked', 'running'), true);
  assert.equal(canTransitionTask('paused', 'pending'), true);
  assert.equal(canTransitionTask('completed', 'pending'), false);
  assert.doesNotThrow(() => assertTaskTransition('running', 'awaiting_decision'));
  assert.throws(() => assertTaskTransition('completed', 'running'));
});
