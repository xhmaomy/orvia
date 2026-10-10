import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { assertWorkingDirectoryAllowed, resolveRuntimePolicy } from '../src/application/runtime-policy.js';

test('runtime policy intersects tool allowlists and unions denylists', () => {
  const policy = resolveRuntimePolicy([
    { tools: { allow: ['read', 'grep', 'bash'], deny: ['bash'] } },
    { tools: { allow: ['read', 'bash'] }, allowedWorkingDirectories: ['/tmp/orvia'] },
  ]);

  assert.deepEqual(policy.allowedTools, ['read']);
  assert.deepEqual(policy.deniedTools, ['bash']);
  assert.deepEqual(policy.allowedWorkingDirectories, [path.resolve('/tmp/orvia')]);
});

test('runtime policy rejects working directories outside allowed roots', () => {
  const policy = resolveRuntimePolicy([{ allowedWorkingDirectories: ['/tmp/orvia'] }]);
  assert.equal(assertWorkingDirectoryAllowed('/tmp/orvia/project', policy), path.resolve('/tmp/orvia/project'));
  assert.throws(() => assertWorkingDirectoryAllowed('/tmp/other', policy), /not allowed/);
});
