import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from './redis.service';

// database/cache.service.ts
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redisService: RedisService) {}

  // get key
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redisService.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(
        `Cache read failed for key "${key}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  // set key
  async setJson(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.redisService.set(key, JSON.stringify(value), ttlSeconds);
    } catch (err) {
      this.logger.warn(
        `Cache write failed for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  // delete key
  async invalidate(key: string): Promise<void> {
    try {
      await this.redisService.del(key);
    } catch (err) {
      this.logger.warn(
        `Cache invalidation failed for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  // check exist key, if not esxist => request to database
  async getOrSet<T>(
    key: string,
    ttl: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.getJson<T>(key);
    if (cached !== null) return cached;
    const fresh = await loader();
    await this.setJson(key, fresh, ttl);
    return fresh;
  }

  // get current version
  async getVersion(namespace: string): Promise<number> {
    try {
      const raw = await this.redisService.get(`version:${namespace}`);
      /*
       * AN UNSET NAMESPACE IS VERSION 0, NOT 1 — and the difference is a bug
       * this used to have.
       *
       * `bumpVersion` is `INCR`, and `INCR` on a missing key yields 1. With an
       * unset default of 1, the FIRST invalidation after a boot (or after a
       * Redis flush) computed the same version before and after, so every
       * cached list page survived it. Exactly one invalidation was silently
       * lost, which is the hardest kind to notice: the second one works.
       *
       * It surfaced when the public listing's availability became
       * reservation-aware. A basket hold correctly published an invalidation,
       * correctly bumped the namespace — and the storefront refetched straight
       * back into the pre-reservation cached page, which looks precisely like a
       * broken realtime channel.
       */
      const parsed = raw === null || raw === undefined ? 0 : Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (err) {
      this.logger.warn(
        `Version read failed for "${namespace}": ${(err as Error).message}`,
      );
      return 0;
    }
  }

  // after create & update inc version
  async bumpVersion(namespace: string): Promise<void> {
    try {
      await this.redisService.incr(`version:${namespace}`);
    } catch (err) {
      this.logger.warn(
        `Version bump failed for "${namespace}": ${(err as Error).message}`,
      );
    }
  }
}

/** Cache namespaces used by the catalog (products / categories / attributes). */
export const CATALOG_NAMESPACES = {
  PRODUCTS: 'products',
  CATEGORIES: 'categories',
  ATTRIBUTES: 'attributes',
} as const;

/**
 * Canonical catalog cache keys. Everything the catalog caches goes through
 * these builders so that the invalidation paths below cannot drift from the
 * write paths.
 *
 * NOTE the deliberate absence of a key for "availability". Volatile stock is
 * NEVER stored in a long-TTL cached document -- see the comment on
 * `CatalogCacheService.invalidateVariantAvailability`.
 */
export const catalogKeys = {
  /** Versioned product list page. Query-shape hash keeps pages independent. */
  productList: (version: number, queryHash: string) =>
    `products:list:v${version}:${queryHash}`,
  /** Versioned public product detail document (static fields only). */
  productDetail: (version: number, id: number) =>
    `products:detail:v${version}:${id}`,
  /**
   * Legacy unversioned detail key written by the pre-fix implementation.
   * Kept only so that invalidation can positively delete stale documents that
   * may still be sitting in Redis from before the fix -- nothing writes it.
   */
  legacyProductDetail: (id: number) => `product:${id}`,
  categoryList: (version: number) => `categories:list:v${version}`,
  categoryDetail: (id: number) => `category:${id}`,
};

/**
 * Catalog-cache invalidation surface.
 *
 * This service exists so that workstreams that change stock (POS sale, online
 * fulfilment, admin adjust) can invalidate catalog reads WITHOUT importing the
 * products module -- and so that this file never has to import orders, cart or
 * inventory. Its only dependencies are `CacheService` and (optionally) the
 * TypeORM `DataSource`, which it uses for a single id-mapping query.
 *
 * It is provided by the `@Global()` `CacheModule`, so any module can inject it
 * with no module-graph edit.
 *
 * ---------------------------------------------------------------------------
 * STOCK IS NEVER SERVED FROM CACHE.
 *
 * The cached catalog documents contain the *static* product shape (title,
 * description, categories, images, variant identity/price/attributes). They do
 * NOT contain stock levels or availability. Availability is recomputed on every
 * request that exposes it, and it is labelled `indicative: true` in the
 * response, because between the catalog read and the customer pressing "add to
 * basket" any number of POS sales may have happened. The AUTHORITATIVE check
 * happens at basket / checkout / POS time inside the inventory transaction.
 *
 * Invalidation here therefore is not about correctness of stock (that is
 * guaranteed structurally by not caching it); it is about not showing a
 * customer an "out of stock" / "in stock" badge that is minutes stale.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class CatalogCacheService {
  private readonly logger = new Logger(CatalogCacheService.name);

  constructor(
    private readonly cacheService: CacheService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  /**
   * Call AFTER the stock-changing transaction has COMMITTED.
   *
   * Bumps the `products` namespace version (which retires every cached list
   * page and every versioned detail document in one atomic counter increment)
   * and additionally deletes the per-product detail keys for the products that
   * own the given variants, including the legacy unversioned `product:<id>`
   * key written by older builds.
   *
   * Never throws: a cache failure must not roll back or fail a committed sale.
   */
  async invalidateVariantAvailability(variantIds: number[]): Promise<void> {
    const ids = this.normalizeIds(variantIds);
    if (!ids.length) return;

    let productIds: number[] = [];
    try {
      if (this.dataSource?.isInitialized) {
        const rows: Array<{ productId: number | string | null }> =
          await this.dataSource.query(
            `SELECT DISTINCT "productId" AS "productId"
               FROM "product_variants"
              WHERE "id" = ANY($1::int[]) AND "productId" IS NOT NULL`,
            [ids],
          );
        productIds = this.normalizeIds(rows.map((r) => Number(r.productId)));
      }
    } catch (err) {
      this.logger.warn(
        `Could not map variant ids to product ids for invalidation: ${
          (err as Error).message
        }`,
      );
    }

    await this.invalidateProducts(productIds);
  }

  /**
   * Retire every cached catalog document for the given products (and every
   * cached list page, via the namespace version bump). Safe with an empty
   * array -- the version bump alone is enough to retire list pages.
   */
  async invalidateProducts(productIds: number[] = []): Promise<void> {
    const ids = this.normalizeIds(productIds);
    try {
      const versionBefore = await this.cacheService.getVersion(
        CATALOG_NAMESPACES.PRODUCTS,
      );
      await Promise.all(
        ids.flatMap((id) => [
          this.cacheService.invalidate(
            catalogKeys.productDetail(versionBefore, id),
          ),
          this.cacheService.invalidate(catalogKeys.legacyProductDetail(id)),
        ]),
      );
      await this.cacheService.bumpVersion(CATALOG_NAMESPACES.PRODUCTS);
    } catch (err) {
      this.logger.warn(
        `Catalog invalidation failed: ${(err as Error).message}`,
      );
    }
  }

  /** Retire every cached category document. */
  async invalidateCategories(categoryIds: number[] = []): Promise<void> {
    try {
      await Promise.all(
        this.normalizeIds(categoryIds).map((id) =>
          this.cacheService.invalidate(catalogKeys.categoryDetail(id)),
        ),
      );
      await this.cacheService.bumpVersion(CATALOG_NAMESPACES.CATEGORIES);
    } catch (err) {
      this.logger.warn(
        `Category invalidation failed: ${(err as Error).message}`,
      );
    }
  }

  private normalizeIds(ids: readonly (number | null | undefined)[]): number[] {
    return [
      ...new Set(
        (ids ?? []).filter(
          (id): id is number => typeof id === 'number' && Number.isInteger(id),
        ),
      ),
    ];
  }
}
