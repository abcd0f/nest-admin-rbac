import { Module } from '@nestjs/common';
import { CacheService } from './cache.service.js';
import { RedisConnection } from './redis.connection.js';

/** 单一 Redis 能力模块：缓存与后续命令服务共用同一个连接生命周期。 */
@Module({
  providers: [RedisConnection, CacheService],
  exports: [RedisConnection, CacheService],
})
export class RedisModule {}
