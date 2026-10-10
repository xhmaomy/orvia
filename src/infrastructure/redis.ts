import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export interface RedisRuntime {
  mode: 'redis' | 'embedded';
  status(): 'ok' | 'error';
  ping(): Promise<string>;
  acquireLock(name: string, ttlSeconds?: number): Promise<boolean>;
  releaseLock(name: string): Promise<void>;
  setSession(token: string, payload: unknown, ttlSeconds?: number): Promise<void>;
  getSession<T>(token: string): Promise<T | null>;
  deleteSession(token: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;
  close(): Promise<void>;
}

let runtime: RedisRuntime | undefined;

export function redisDisplayUrl(url = config.redisUrl): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || '127.0.0.1';
    const port = parsed.port || '6379';
    return parsed.password ? `redis://:*****@${host}:${port}` : `redis://${host}:${port}`;
  } catch {
    return 'redis://127.0.0.1:6379';
  }
}

export class EmbeddedRedis implements RedisRuntime {
  mode = 'embedded' as const;
  private readonly values = new Map<string, { value: string; expiresAt?: number }>();
  private readonly emitter = new EventEmitter();

  status(): 'ok' | 'error' {
    return 'ok';
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async acquireLock(name: string, ttlSeconds = 3600): Promise<boolean> {
    this.purge();
    const key = `lock:${name}`;
    if (this.values.has(key)) return false;
    this.values.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async releaseLock(name: string): Promise<void> {
    this.values.delete(`lock:${name}`);
  }

  async setSession(token: string, payload: unknown, ttlSeconds = 12 * 60 * 60): Promise<void> {
    this.values.set(`session:${token}`, {
      value: JSON.stringify(payload),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getSession<T>(token: string): Promise<T | null> {
    this.purge();
    const row = this.values.get(`session:${token}`);
    return row ? JSON.parse(row.value) as T : null;
  }

  async deleteSession(token: string): Promise<void> {
    this.values.delete(`session:${token}`);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.emitter.emit(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  async close(): Promise<void> {
    this.values.clear();
    this.emitter.removeAllListeners();
    if (runtime === this) runtime = undefined;
  }

  private purge(): void {
    const now = Date.now();
    for (const [key, row] of this.values) {
      if (row.expiresAt && row.expiresAt <= now) this.values.delete(key);
    }
  }
}

class IoredisRuntime implements RedisRuntime {
  mode = 'redis' as const;
  private healthy = true;

  constructor(
    private readonly client: Redis,
    private readonly subscriber: Redis,
  ) {
    client.on('error', () => { this.healthy = false; });
    client.on('ready', () => { this.healthy = true; });
  }

  status(): 'ok' | 'error' {
    return this.healthy ? 'ok' : 'error';
  }

  async ping(): Promise<string> {
    const result = await this.client.ping();
    this.healthy = true;
    return result;
  }

  async acquireLock(name: string, ttlSeconds = 3600): Promise<boolean> {
    const result = await this.client.set(`orvia:lock:${name}`, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(name: string): Promise<void> {
    await this.client.del(`orvia:lock:${name}`);
  }

  async setSession(token: string, payload: unknown, ttlSeconds = 12 * 60 * 60): Promise<void> {
    await this.client.set(`orvia:session:${token}`, JSON.stringify(payload), 'EX', ttlSeconds);
  }

  async getSession<T>(token: string): Promise<T | null> {
    const raw = await this.client.get(`orvia:session:${token}`);
    return raw ? JSON.parse(raw) as T : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.client.del(`orvia:session:${token}`);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    const listener = (incoming: string, payload: string) => {
      if (incoming === channel) handler(payload);
    };
    this.subscriber.on('message', listener);
    await this.subscriber.subscribe(channel);
    return async () => {
      this.subscriber.off('message', listener);
      await this.subscriber.unsubscribe(channel);
    };
  }

  async close(): Promise<void> {
    this.subscriber.disconnect();
    this.client.disconnect();
    if (runtime === this) runtime = undefined;
  }
}

export function redisRuntime(): RedisRuntime {
  if (!runtime) throw new Error('Redis is not connected');
  return runtime;
}

export function useEmbeddedRedis(): RedisRuntime {
  runtime = new EmbeddedRedis();
  return runtime;
}

export async function connectRedis(): Promise<RedisRuntime> {
  const url = config.redisUrl;
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    const subscriber = client.duplicate();
    subscriber.on('error', () => {});
    await subscriber.connect();
    runtime = new IoredisRuntime(client, subscriber);
    console.log(`Orvia Redis connected at ${redisDisplayUrl(url)}`);
    return runtime;
  } catch (error) {
    client.disconnect();
    throw new Error(
      `Redis is required. Start the local Redis at ${redisDisplayUrl(url)} (${error instanceof Error ? error.message : 'connection failed'}).`,
    );
  }
}
