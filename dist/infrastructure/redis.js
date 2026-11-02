import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { config } from '../config.js';
let runtime;
export function redisDisplayUrl(url = config.redisUrl) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname || '127.0.0.1';
        const port = parsed.port || '6379';
        return parsed.password ? `redis://:*****@${host}:${port}` : `redis://${host}:${port}`;
    }
    catch {
        return 'redis://127.0.0.1:6379';
    }
}
export class EmbeddedRedis {
    mode = 'embedded';
    values = new Map();
    emitter = new EventEmitter();
    status() {
        return 'ok';
    }
    async ping() {
        return 'PONG';
    }
    async acquireLock(name, ttlSeconds = 3600) {
        this.purge();
        const key = `lock:${name}`;
        if (this.values.has(key))
            return false;
        this.values.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 });
        return true;
    }
    async releaseLock(name) {
        this.values.delete(`lock:${name}`);
    }
    async setSession(token, payload, ttlSeconds = 12 * 60 * 60) {
        this.values.set(`session:${token}`, {
            value: JSON.stringify(payload),
            expiresAt: Date.now() + ttlSeconds * 1000,
        });
    }
    async getSession(token) {
        this.purge();
        const row = this.values.get(`session:${token}`);
        return row ? JSON.parse(row.value) : null;
    }
    async deleteSession(token) {
        this.values.delete(`session:${token}`);
    }
    async publish(channel, message) {
        this.emitter.emit(channel, message);
    }
    async subscribe(channel, handler) {
        this.emitter.on(channel, handler);
        return () => this.emitter.off(channel, handler);
    }
    async close() {
        this.values.clear();
        this.emitter.removeAllListeners();
        if (runtime === this)
            runtime = undefined;
    }
    purge() {
        const now = Date.now();
        for (const [key, row] of this.values) {
            if (row.expiresAt && row.expiresAt <= now)
                this.values.delete(key);
        }
    }
}
class IoredisRuntime {
    client;
    subscriber;
    mode = 'redis';
    healthy = true;
    lastErrorLog = 0;
    constructor(client, subscriber) {
        this.client = client;
        this.subscriber = subscriber;
        const markDown = (label, error) => {
            this.healthy = false;
            const now = Date.now();
            if (now - this.lastErrorLog < 5_000)
                return;
            this.lastErrorLog = now;
            console.error(`Orvia Redis ${label}: ${error.message}`);
        };
        client.on('error', (error) => { markDown('client', error); });
        client.on('ready', () => { this.healthy = true; });
        client.on('end', () => { this.healthy = false; });
        subscriber.on('error', (error) => { markDown('subscriber', error); });
        subscriber.on('ready', () => { this.healthy = true; });
    }
    status() {
        return this.healthy ? 'ok' : 'error';
    }
    async ping() {
        const result = await this.client.ping();
        this.healthy = true;
        return result;
    }
    async acquireLock(name, ttlSeconds = 3600) {
        const result = await this.client.set(`orvia:lock:${name}`, '1', 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    }
    async releaseLock(name) {
        await this.client.del(`orvia:lock:${name}`);
    }
    async setSession(token, payload, ttlSeconds = 12 * 60 * 60) {
        await this.client.set(`orvia:session:${token}`, JSON.stringify(payload), 'EX', ttlSeconds);
    }
    async getSession(token) {
        const raw = await this.client.get(`orvia:session:${token}`);
        return raw ? JSON.parse(raw) : null;
    }
    async deleteSession(token) {
        await this.client.del(`orvia:session:${token}`);
    }
    async publish(channel, message) {
        await this.client.publish(channel, message);
    }
    async subscribe(channel, handler) {
        const listener = (incoming, payload) => {
            if (incoming === channel)
                handler(payload);
        };
        this.subscriber.on('message', listener);
        await this.subscriber.subscribe(channel);
        return async () => {
            this.subscriber.off('message', listener);
            await this.subscriber.unsubscribe(channel);
        };
    }
    async close() {
        this.subscriber.disconnect();
        this.client.disconnect();
        if (runtime === this)
            runtime = undefined;
    }
}
function redisClientOptions() {
    return {
        lazyConnect: true,
        // 短时闪断时允许有限重试；长连接靠 retryStrategy 自动恢复
        maxRetriesPerRequest: 3,
        connectTimeout: 5_000,
        enableReadyCheck: true,
        // 旧配置 retryStrategy: () => null 会在一次断线后永不重连，长跑时容易误报「Redis 无法连接」
        retryStrategy(times) {
            return Math.min(times * 200, 5_000);
        },
    };
}
export function redisRuntime() {
    if (!runtime)
        throw new Error('Redis is not connected');
    return runtime;
}
export function useEmbeddedRedis() {
    runtime = new EmbeddedRedis();
    return runtime;
}
export async function connectRedis() {
    const url = config.redisUrl;
    const options = redisClientOptions();
    const client = new Redis(url, options);
    client.on('error', () => { });
    try {
        await client.connect();
        await client.ping();
        const subscriber = client.duplicate(options);
        subscriber.on('error', () => { });
        await subscriber.connect();
        runtime = new IoredisRuntime(client, subscriber);
        console.log(`Orvia Redis connected at ${redisDisplayUrl(url)}`);
        return runtime;
    }
    catch (error) {
        client.disconnect();
        throw new Error(`Redis is required. Start the local Redis at ${redisDisplayUrl(url)} (${error instanceof Error ? error.message : 'connection failed'}).`);
    }
}
