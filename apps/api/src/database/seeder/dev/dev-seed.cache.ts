import { ConfigService } from '@nestjs/config';

import { CATALOG_NAMESPACES, CacheService } from 'src/database/cache.service';
import { RedisService } from 'src/database/redis.service';

/**
 * Invalidates the catalog cache after seeding.
 *
 * WHY THIS IS NOT OPTIONAL POLISH. The catalog list endpoints are
 * version-keyed in Redis: `GET /categories` answers from `categories:list:v<n>`
 * and only re-reads Postgres when `version:categories` moves. Every write path
 * in the application bumps that version, but this seeder writes to Postgres
 * directly — so against a Redis that is still warm from before the seed, the
 * API serves the OLD catalog and a reviewer sees an empty category list next to
 * a full products list. That was observed, not theorised.
 *
 * The bump goes through the application's own `CacheService` and namespace
 * constants rather than hand-written key strings, so it cannot drift from the
 * invalidation the live code performs.
 *
 * FAILURE IS NON-FATAL. Redis is a cache, not the record. If it is unreachable
 * the data is still correctly seeded, so this reports what happened and lets
 * the run succeed instead of failing a good seed over a warm cache.
 */
export async function invalidateCatalogCache(): Promise<string> {
  const redis = new RedisService(
    new ConfigService(process.env as Record<string, unknown>),
  );

  try {
    await redis.onModuleInit();
    const cache = new CacheService(redis);
    for (const namespace of Object.values(CATALOG_NAMESPACES)) {
      await cache.bumpVersion(namespace);
    }
    return `catalog cache invalidated (${Object.values(CATALOG_NAMESPACES).join(', ')})`;
  } catch (error) {
    return (
      `WARNING: could not invalidate the catalog cache — ` +
      `${error instanceof Error ? error.message : String(error)}. ` +
      `The data is seeded correctly, but a warm Redis may keep serving the ` +
      `previous catalog. Flush it or restart the API if the catalog looks stale.`
    );
  } finally {
    try {
      await (
        redis as unknown as { client?: { quit?: () => Promise<unknown> } }
      ).client?.quit?.();
    } catch {
      /* the process is exiting anyway */
    }
  }
}
