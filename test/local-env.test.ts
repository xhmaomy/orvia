import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMysqlUrl,
  buildRedisUrl,
  parseEnvFile,
  parseMysqlUrl,
  parseRedisUrl,
  serializeEnvFile,
} from '../src/application/local-env.js';

test('env file round-trips updates without dropping unrelated keys', () => {
  const previous = 'HOST=127.0.0.1\nDATABASE_URL=mysql://old\nWEB_ORIGIN=http://localhost:3000\n';
  const next = serializeEnvFile(previous, {
    DATABASE_URL: 'mysql://root:secret@127.0.0.1:3306/orvia',
    REDIS_URL: 'redis://:pass@127.0.0.1:6379',
  });
  const parsed = parseEnvFile(next);
  assert.equal(parsed.HOST, '127.0.0.1');
  assert.equal(parsed.WEB_ORIGIN, 'http://localhost:3000');
  assert.equal(parsed.DATABASE_URL, 'mysql://root:secret@127.0.0.1:3306/orvia');
  assert.equal(parsed.REDIS_URL, 'redis://:pass@127.0.0.1:6379');
});

test('mysql and redis urls encode passwords safely', () => {
  const mysql = buildMysqlUrl({
    host: '127.0.0.1',
    port: '3306',
    user: 'root',
    password: 'a@b#c',
    database: 'orvia',
  });
  assert.match(mysql, /a%40b%23c/);
  const parsed = parseMysqlUrl(mysql);
  assert.equal(parsed.password, 'a@b#c');
  assert.equal(parsed.database, 'orvia');

  const redis = buildRedisUrl({ host: '127.0.0.1', port: '6379', password: 'p@ss' });
  assert.equal(parseRedisUrl(redis).password, 'p@ss');
});
