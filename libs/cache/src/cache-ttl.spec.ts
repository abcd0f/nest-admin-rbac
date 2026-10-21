import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import type { RedisConnection } from './redis.connection.js';
import { describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service.js';
import { CacheModule, RedisModule } from './index.js';

type RedisCommands = Pick<Redis, 'get' | 'set' | 'del'>;

function createConnection(client?: Partial<RedisCommands>): RedisConnection {
  return {
    client,
    keyPrefix: 'test:cache',
    defaultTtl: 60000,
  } as unknown as RedisConnection;
}

function createLogger(): PinoLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    setContext: vi.fn(),
  } as unknown as PinoLogger;
}

function createCache(connection: RedisConnection, logger = createLogger()): CacheService {
  return new CacheService(connection, logger);
}

describe('ioredis 缓存服务', () => {
  it('兼容名称与唯一 RedisModule 是同一个模块类', () => {
    expect(CacheModule).toBe(RedisModule);
  });

  it('使用统一前缀、JSON 序列化和毫秒 PX TTL 写入', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const cache = createCache(createConnection({ set }));

    await cache.set('users:v1:42', { id: 42, roles: ['reader'] }, 1200);
    await cache.set('defaults', true);

    expect(set).toHaveBeenNthCalledWith(
      1,
      'test:cache:users:v1:42',
      '{"id":42,"roles":["reader"]}',
      'PX',
      1200,
    );
    expect(set).toHaveBeenNthCalledWith(2, 'test:cache:defaults', 'true', 'PX', 60000);
  });

  it('读取 JSON 值，未命中或损坏数据按缓存未命中处理', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce('{"enabled":true}')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('{invalid');
    const logger = createLogger();
    const cache = createCache(createConnection({ get }), logger);

    expect(await cache.get<{ enabled: boolean }>('settings')).toEqual({ enabled: true });
    expect(await cache.get('missing')).toBeUndefined();
    expect(await cache.get('corrupt')).toBeUndefined();
    expect(get).toHaveBeenCalledWith('test:cache:settings');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2147483648, '1000', null])(
    '拒绝非法 TTL：%s',
    async (value) => {
      const set = vi.fn();
      const cache = createCache(createConnection({ set }));
      const ttl = value as number;

      await expect(cache.set('key', 'value', ttl)).rejects.toThrow(RangeError);
      await expect(cache.wrap('key', async () => 'value', ttl)).rejects.toThrow(RangeError);
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('校验键名，关闭时读写降级且 wrap 仍返回 loader 结果', async () => {
    const cache = createCache(createConnection());
    const loader = vi.fn(async () => 'loaded');

    await expect(cache.get('  ')).rejects.toThrow('缓存键不能为空');
    await expect(cache.set('', 'value')).rejects.toThrow('缓存键不能为空');
    expect(await cache.get('disabled')).toBeUndefined();
    await cache.set('disabled', 'value');
    await cache.del('disabled');
    expect(await cache.wrap('disabled-wrap', loader)).toBe('loaded');
    expect(loader).toHaveBeenCalledOnce();
  });

  it('读命令失败按未命中处理，写入和删除失败向调用方报错', async () => {
    const logger = createLogger();
    const get = vi.fn().mockRejectedValue(new Error('private Redis details'));
    const set = vi.fn().mockRejectedValue(new Error('private Redis details'));
    const del = vi.fn().mockRejectedValue(new Error('private Redis details'));
    const cache = createCache(createConnection({ get, set, del }), logger);

    expect(await cache.get('read')).toBeUndefined();
    await expect(cache.set('write', 'value')).rejects.toThrow('Redis 缓存命令执行失败');
    await expect(cache.del('delete')).rejects.toThrow('Redis 缓存命令执行失败');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('wrap 对同一进程内的并发缺失请求合并 loader 并写入共享缓存', async () => {
    const values = new Map<string, string>();
    const get = vi.fn(async (key: string) => values.get(key) ?? null);
    const set = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    });
    const loader = vi.fn(async () => ({ id: 7 }));
    const cache = createCache(createConnection({ get, set }));

    const [first, second] = await Promise.all([
      cache.wrap('user:7', loader, 1000),
      cache.wrap('user:7', loader, 1000),
    ]);

    expect(first).toEqual({ id: 7 });
    expect(second).toEqual({ id: 7 });
    expect(loader).toHaveBeenCalledOnce();
    expect(await cache.wrap('user:7', loader, 1000)).toEqual({ id: 7 });
    expect(set).toHaveBeenCalledOnce();
  });
});
