import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { isValidCacheTtl } from './cache-ttl.js';
import { RedisConnection } from './redis.connection.js';

export type CacheValue =
  | string
  | number
  | boolean
  | null
  | CacheValue[]
  | { [key: string]: CacheValue };

/** 仅提供可降级的 JSON 业务缓存；强一致状态应直接复用共享 RedisConnection。 */
@Injectable()
export class CacheService {
  private readonly inFlight = new Map<string, Promise<CacheValue>>();
  private lastWarningAt = -Infinity;

  constructor(
    private readonly connection: RedisConnection,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CacheService.name);
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.validateKey(key);
    const client = this.connection.client;
    if (!client) return undefined;

    let value: string | null;
    try {
      value = await client.get(this.toRedisKey(key));
    } catch {
      this.warnCommandFailure();
      return undefined;
    }
    if (value === null) return undefined;

    try {
      const parsed: unknown = JSON.parse(value);
      return parsed as T;
    } catch {
      // 缓存损坏只影响命中率，读请求仍回源；不记录键和值，避免泄露业务信息。
      this.warnCommandFailure();
      return undefined;
    }
  }

  async set<T extends CacheValue>(key: string, value: T, ttl?: number): Promise<void> {
    this.validateKey(key);
    this.validateTtl(ttl);
    const effectiveTtl = ttl ?? this.connection.defaultTtl;
    this.validateTtl(effectiveTtl);
    if (value === undefined) throw new TypeError('缓存值不能是 undefined');

    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('缓存值必须可序列化为 JSON');

    const client = this.connection.client;
    if (!client) return;
    try {
      const result = await client.set(this.toRedisKey(key), serialized, 'PX', effectiveTtl);
      if (result !== 'OK') throw new Error('Redis 未确认缓存写入');
    } catch {
      this.warnCommandFailure();
      throw new Error('Redis 缓存命令执行失败');
    }
  }

  async del(key: string): Promise<void> {
    this.validateKey(key);
    const client = this.connection.client;
    if (!client) return;
    try {
      await client.del(this.toRedisKey(key));
    } catch {
      this.warnCommandFailure();
      throw new Error('Redis 缓存命令执行失败');
    }
  }

  async wrap<T extends CacheValue>(
    key: string,
    loader: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    this.validateKey(key);
    this.validateTtl(ttl);

    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const redisKey = this.toRedisKey(key);
    const pending = this.inFlight.get(redisKey);
    if (pending) return pending as Promise<T>;

    const loading = (async () => {
      const value = await loader();
      if (value === undefined) throw new TypeError('缓存值不能是 undefined');
      await this.set(key, value, ttl);
      return value;
    })().finally(() => this.inFlight.delete(redisKey));
    this.inFlight.set(redisKey, loading);
    return loading as Promise<T>;
  }

  private toRedisKey(key: string): string {
    return `${this.connection.keyPrefix}:${key}`;
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || key.trim().length === 0) throw new TypeError('缓存键不能为空');
  }

  private validateTtl(ttl: number | undefined): void {
    if (ttl !== undefined && !isValidCacheTtl(ttl)) {
      throw new RangeError('缓存 TTL 必须是 1 到 2147483647 的整数毫秒，省略时使用默认值');
    }
  }

  private warnCommandFailure(): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 30000) return;
    this.lastWarningAt = now;
    this.logger.warn('Redis cache command failed; repeated messages are rate limited');
  }
}
