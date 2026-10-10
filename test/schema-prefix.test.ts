import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('database tables use the ov_ prefix', () => {
  const schema = readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8');
  const names = [...schema.matchAll(/mysqlTable\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(names.length > 0);
  assert.equal(names.every((name) => name.startsWith('ov_')), true);
});
