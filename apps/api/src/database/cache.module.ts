import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { CacheService, CatalogCacheService } from './cache.service';

@Global()
@Module({
  providers: [RedisService, CacheService, CatalogCacheService],
  exports: [RedisService, CacheService, CatalogCacheService],
})
export class CacheModule {}
