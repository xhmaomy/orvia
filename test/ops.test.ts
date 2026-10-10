import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/application/password.js';
import { redisRuntime, useEmbeddedRedis } from '../src/infrastructure/redis.js';

test('password hashing round-trips and rejects a wrong password', async () => {
  const stored = await hashPassword('orvia-local');
  assert.equal(await verifyPassword('orvia-local', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
});

test('embedded redis lock, session and pub/sub work without a broker', async () => {
  const redis = useEmbeddedRedis();
  assert.equal(redis.mode, 'embedded');
  assert.equal(await redis.acquireLock('ops-test', 5), true);
  assert.equal(await redis.acquireLock('ops-test', 5), false);
  await redis.releaseLock('ops-test');
  await redis.setSession('tok', { userId: 1 }, 5);
  assert.deepEqual(await redis.getSession('tok'), { userId: 1 });
  const seen: string[] = [];
  const stop = await redis.subscribe('orvia:events', (message) => { seen.push(message); });
  await redis.publish('orvia:events', JSON.stringify({ type: 'workflow.failed' }));
  assert.deepEqual(seen.map((row) => JSON.parse(row).type), ['workflow.failed']);
  await stop();
  await redis.close();
  assert.throws(() => redisRuntime(), /Redis is not connected/);
});
