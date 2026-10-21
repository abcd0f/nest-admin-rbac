export * from './cache.service.js';
export { RedisConnection } from './redis.connection.js';
// 旧名称指向同一个类，兼容既有调用方而不注册第二个 Nest 模块。
export { RedisModule as CacheModule, RedisModule } from './redis.module.js';
