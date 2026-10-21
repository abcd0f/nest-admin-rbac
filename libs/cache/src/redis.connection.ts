import type { RedisConfig } from '@app/config';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { redisConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

/** RedisModule 持有唯一连接；缓存与命令能力只复用此客户端，不各自创建或关闭连接。 */
@Injectable()
export class RedisConnection implements OnModuleInit, OnModuleDestroy {
  readonly client?: Redis;
  readonly keyPrefix: string;
  readonly defaultTtl: number;
  private connected = false;
  private shuttingDown = false;
  private shutdown?: Promise<void>;
  private warned = false;

  constructor(
    @Inject(redisConfig.KEY) config: RedisConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisConnection.name);
    this.keyPrefix = config.keyPrefix;
    this.defaultTtl = config.ttl;
    if (!config.enabled) return;
    this.client = new Redis({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      db: config.db,
      connectTimeout: config.connectTimeout,
      commandTimeout: config.commandTimeout,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      tls: config.tlsEnabled ? {} : undefined,
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      // 初次失败直接结束启动；运行期保留有上限的重连间隔，不排队业务请求。
      retryStrategy: (attempt) =>
        this.connected && !this.shuttingDown ? Math.min(config.retryDelay * attempt, 30000) : null,
    });
    this.client.on('ready', this.onReady);
    this.client.on('error', this.onUnavailable);
    this.client.on('close', this.onUnavailable);
  }

  get isReady(): boolean {
    return this.client?.status === 'ready';
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.connect();
    } catch {
      await this.onModuleDestroy();
      throw new Error('Redis 连接失败，请检查地址、凭据、TLS 与网络配置');
    }
  }

  onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.shutdown ??= this.close();
    return this.shutdown;
  }

  private async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      if (client.status === 'ready') await client.quit();
    } catch {
      this.logger.warn('Graceful Redis shutdown failed; forcing disconnect');
    } finally {
      client.disconnect();
      client.off('ready', this.onReady);
      client.off('error', this.onUnavailable);
      client.off('close', this.onUnavailable);
    }
  }

  private readonly onReady = (): void => {
    this.connected = true;
    this.warned = false;
    this.logger.info('Redis connection is ready');
  };

  private readonly onUnavailable = (): void => {
    if (!this.connected || this.shuttingDown || this.warned) return;
    this.warned = true;
    // 不记录客户端异常对象，它可能包含认证命令或服务端返回的敏感内容。
    this.logger.warn('Redis connection is unavailable');
  };
}
