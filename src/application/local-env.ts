import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { Redis } from 'ioredis';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const localEnvPath = path.join(rootDir, '.env');

export type EnvMap = Record<string, string>;

export function parseEnvFile(text: string): EnvMap {
  const values: EnvMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function serializeEnvFile(previous: string, updates: EnvMap): string {
  const keys = new Set(Object.keys(updates));
  const lines = previous.length ? previous.replace(/\r\n/g, '\n').split('\n') : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const index = trimmed.indexOf('=');
    if (index <= 0) return line;
    const key = trimmed.slice(0, index).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${escapeEnvValue(updates[key] ?? '')}`;
  });
  for (const key of keys) {
    if (seen.has(key)) continue;
    next.push(`${key}=${escapeEnvValue(updates[key] ?? '')}`);
  }
  const body = next.join('\n');
  return body.endsWith('\n') ? body : `${body}\n`;
}

function escapeEnvValue(value: string): string {
  if (!value) return '';
  if (/[\s#"']/.test(value) || value.includes('=')) return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return value;
}

export async function readLocalEnv(): Promise<EnvMap> {
  try {
    return parseEnvFile(await readFile(localEnvPath, 'utf8'));
  } catch {
    return {};
  }
}

export async function writeLocalEnv(updates: EnvMap): Promise<void> {
  let previous = '';
  try {
    previous = await readFile(localEnvPath, 'utf8');
  } catch {
    previous = '';
  }
  await writeFile(localEnvPath, serializeEnvFile(previous, updates), 'utf8');
}

export function maskSecret(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, value.length - 2))}${value.slice(-2)}`;
}

export function parseMysqlUrl(url: string): { host: string; port: string; user: string; password: string; database: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port || '3306',
      user: decodeURIComponent(parsed.username || 'root'),
      password: decodeURIComponent(parsed.password || ''),
      database: decodeURIComponent((parsed.pathname || '/').replace(/^\//, '') || 'orvia'),
    };
  } catch {
    return { host: '127.0.0.1', port: '3306', user: 'root', password: '', database: 'orvia' };
  }
}

export function buildMysqlUrl(input: { host: string; port: string; user: string; password: string; database: string }): string {
  const user = encodeURIComponent(input.user || 'root');
  const password = input.password ? `:${encodeURIComponent(input.password)}` : '';
  const host = input.host.trim() || '127.0.0.1';
  const port = input.port.trim() || '3306';
  const database = encodeURIComponent(input.database.trim() || 'orvia');
  return `mysql://${user}${password}@${host}:${port}/${database}?charset=utf8mb4&multipleStatements=true&timezone=%2B08%3A00`;
}

export function parseRedisUrl(url: string): { host: string; port: string; password: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port || '6379',
      password: decodeURIComponent(parsed.password || ''),
    };
  } catch {
    return { host: '127.0.0.1', port: '6379', password: '' };
  }
}

export function buildRedisUrl(input: { host: string; port: string; password: string }): string {
  const host = input.host.trim() || '127.0.0.1';
  const port = input.port.trim() || '6379';
  const password = input.password ? `:${encodeURIComponent(input.password)}@` : '';
  return `redis://${password}${host}:${port}`;
}

export async function probeMysql(url: string): Promise<{ status: 'ok' | 'error'; message: string; latencyMs: number }> {
  const started = Date.now();
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection(url);
    await connection.query('SELECT 1');
    return { status: 'ok', message: 'MySQL 可连接', latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'MySQL 连接失败', latencyMs: Date.now() - started };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

export async function probeRedis(url: string): Promise<{ status: 'ok' | 'error'; message: string; latencyMs: number }> {
  const started = Date.now();
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  try {
    if (typeof client.connect === 'function') await client.connect();
    const pong = await client.ping();
    return { status: pong === 'PONG' ? 'ok' : 'error', message: pong === 'PONG' ? 'Redis 可连接' : `意外响应：${pong}`, latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Redis 连接失败', latencyMs: Date.now() - started };
  } finally {
    try { await client.quit(); } catch { client.disconnect(); }
  }
}

export async function probePi(command: string): Promise<{ status: 'ok' | 'error'; command: string; version?: string; message: string }> {
  const cmd = command.trim() || 'pi';
  return await new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 'error', command: cmd, message: 'Pi 响应超时' });
    }, 5000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'error', command: cmd, message: error.message.includes('ENOENT') ? `找不到命令：${cmd}` : error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = (stdout || stderr).trim();
      if (code === 0) resolve({ status: 'ok', command: cmd, version: text.split(/\r?\n/)[0] || text, message: 'Pi 可用' });
      else resolve({ status: 'error', command: cmd, message: text || `Pi 退出码 ${code ?? 'unknown'}` });
    });
  });
}
