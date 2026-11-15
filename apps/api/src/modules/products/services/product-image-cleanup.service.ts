import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ObjectStorageService } from 'src/common/storage/object-storage.service';
import { ObjectDeletionService } from 'src/common/storage/object-deletion.service';
import { ObjectDeletionOrigin } from 'src/common/entities/object-deletion-job.entity';

/**
 * ============================================================================
 * ABANDONED DETACHED UPLOADS.
 *
 * THE LEAK. Uploading is deliberately two-phase — `POST /products/uploadImage`
 * stores a DETACHED row, and it becomes part of a product only when its id
 * appears in a create/update. That is what lets the new-product form upload
 * pictures before the product exists. It also means every abandoned form
 * leaves rows with `productId IS NULL` and objects in the bucket that nothing
 * will ever reference: open the form, add four photos, change your mind, close
 * the tab. Nothing cleaned those up, and nothing could — before migration 0034
 * a row recorded neither the object it owned nor when it was written.
 *
 * ---------------------------------------------------------------------------
 * THIS IS OFF BY DEFAULT, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * The sweeper is complete and tested. It is disabled because the one number it
 * needs — how long a detached image may live before it is considered abandoned
 * — IS A BUSINESS DECISION NOBODY HAS MADE, and it is not a decision code
 * should invent. Too short and it deletes a photo from a form somebody left
 * open over lunch; the manager saves, and the product loses an image with no
 * error to explain it. Too long and the bucket grows.
 *
 * So `PRODUCT_IMAGE_CLEANUP_ENABLED` defaults to `false`, and enabling it
 * without `PRODUCT_IMAGE_ORPHAN_TTL_MS` is refused at boot rather than
 * defaulted. Until the owner picks a TTL the only cost is storage, which is
 * recoverable; the alternative is deleting somebody's work, which is not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROW IS DELETED BEFORE THE OBJECT
 * ---------------------------------------------------------------------------
 * The delete is CONDITIONAL and atomic:
 *
 *     DELETE FROM product_images
 *      WHERE id = $1 AND "productId" IS NULL
 *  RETURNING "objectKey"
 *
 * If it returns a row, that row is gone and can never be attached to a product
 * afterwards, so the object it named is unreachable and safe to remove. If it
 * returns nothing, somebody attached the image between the scan and the
 * delete — and the object is left strictly alone. The predicate is re-checked
 * inside the same statement that deletes, so there is no window between
 * deciding and acting.
 *
 * The other order — object first — would let exactly that race produce a
 * product displaying a broken image, which is the failure this service must
 * never cause. Leaving bytes behind is recoverable; deleting the bytes under a
 * live product is not.
 *
 * AN ATTACHED IMAGE IS NEVER TOUCHED. The scan filters on `productId IS NULL`,
 * the delete re-asserts it, and there is no code path here that can name a row
 * with a parent.
 *
 * IDEMPOTENT. Re-running deletes nothing the previous pass removed (the rows
 * are gone) and `DeleteObject` succeeds on a key that is already absent, so a
 * pass interrupted halfway is finished by the next one.
 * ============================================================================
 */

interface OrphanRow {
  id: string | number;
  objectKey: string | null;
}

export interface CleanupOutcome {
  /** Rows examined in this pass. */
  readonly scanned: number;
  /** Rows deleted. */
  readonly deletedRows: number;
  /** Objects removed from the bucket. */
  readonly deletedObjects: number;
  /** Rows that were attached between the scan and the delete, so left alone. */
  readonly skippedAttached: number;
  /**
   * Rows deleted whose object could not be removed IMMEDIATELY. Not a leak:
   * each one has a committed deletion job and is retried by the
   * object-deletion worker.
   */
  readonly orphanedObjects: number;
}

/** 1 hour. How often to sweep, not how old a row must be. */
const DEFAULT_INTERVAL_MS = 3_600_000;
/** Rows per pass. Bounded so one sweep cannot monopolise a connection. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * Normalise what TypeORM hands back from a `DELETE ... RETURNING`.
 *
 * It is NOT the rows. For a non-SELECT statement the postgres driver returns
 * `[rows, affectedCount]`, so `result[0]` is the row ARRAY and reading
 * `result[0].objectKey` yields `undefined` — which this service originally did.
 * The row was deleted, the key read as absent, and the object silently stayed
 * in the bucket forever: the exact leak the sweeper exists to close, reproduced
 * inside the sweeper. An integration test caught it because it asserted against
 * the real bucket rather than against the return value.
 *
 * Both shapes are accepted, because which one arrives depends on the driver and
 * on whether the statement is recognised as a SELECT.
 */
function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  const [first] = result as unknown[];
  if (Array.isArray(first)) return first as T[];
  return result as T[];
}

@Injectable()
export class ProductImageCleanupService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ProductImageCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  readonly enabled: boolean;
  readonly ttlMs: number | null;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: ObjectStorageService,
    private readonly objectDeletion: ObjectDeletionService,
    config: ConfigService,
  ) {
    const rawEnabled = config.get<string>('PRODUCT_IMAGE_CLEANUP_ENABLED');
    const wantsCleanup = String(rawEnabled ?? '').toLowerCase() === 'true';

    const rawTtl = config.get<string>('PRODUCT_IMAGE_ORPHAN_TTL_MS');
    const ttl = this.parsePositiveInt(rawTtl);

    if (wantsCleanup && ttl === null) {
      // Refused rather than defaulted: see the header. A TTL invented here
      // would be a deletion policy nobody approved.
      throw new Error(
        'PRODUCT_IMAGE_CLEANUP_ENABLED is true but PRODUCT_IMAGE_ORPHAN_TTL_MS ' +
          'is missing or not a positive integer — refusing to start.\n' +
          '  How long a detached, unattached image may live before it is ' +
          'deleted is a business decision and has no safe default. Set it ' +
          'explicitly (for example 86400000 for 24 hours) or leave cleanup off.',
      );
    }

    this.enabled = wantsCleanup;
    this.ttlMs = ttl;
    this.intervalMs =
      this.parsePositiveInt(
        config.get<string>('PRODUCT_IMAGE_CLEANUP_INTERVAL_MS'),
      ) ?? DEFAULT_INTERVAL_MS;
    this.batchSize =
      this.parsePositiveInt(
        config.get<string>('PRODUCT_IMAGE_CLEANUP_BATCH_SIZE'),
      ) ?? DEFAULT_BATCH_SIZE;
  }

  private parsePositiveInt(raw: string | undefined): number | null {
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Orphaned product-image cleanup is DISABLED. Detached images that are ' +
          'never attached to a product will accumulate. Enable it by setting ' +
          'PRODUCT_IMAGE_CLEANUP_ENABLED=true together with an explicit ' +
          'PRODUCT_IMAGE_ORPHAN_TTL_MS (a business decision — see the service ' +
          'header).',
      );
      return;
    }

    this.logger.log(
      `Orphaned product-image cleanup ENABLED [ttlMs=${this.ttlMs} ` +
        `intervalMs=${this.intervalMs} batch=${this.batchSize}]`,
    );
    this.timer = setInterval(() => {
      this.inFlight = this.sweep().catch((error) =>
        this.logger.error(
          `product image cleanup run failed: ${(error as Error).message}`,
        ),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop the timer and wait for a pass already in flight.
   *
   * Same reasoning as `FulfilmentRecoveryService`: a pass that started just
   * before shutdown would otherwise keep querying a DataSource being
   * destroyed, and in the integration suite that surfaces as work leaking into
   * the next spec file.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pass = this.inFlight;
    this.inFlight = null;
    if (pass) await pass;
  }

  /**
   * One pass. Public so a test — and an operator, through a future admin
   * route — can run it deterministically instead of waiting for a timer.
   *
   * `olderThanMs` overrides the configured TTL for that call. It exists for
   * tests, which cannot wait 24 hours, and it does not widen anything: the
   * `productId IS NULL` guard is unconditional.
   */
  async sweep(olderThanMs?: number): Promise<CleanupOutcome> {
    const ttl = olderThanMs ?? this.ttlMs;
    if (ttl === null || ttl === undefined) {
      throw new Error(
        'sweep() called with no TTL configured. Pass one explicitly or set ' +
          'PRODUCT_IMAGE_ORPHAN_TTL_MS.',
      );
    }

    const cutoff = new Date(Date.now() - ttl);

    const candidates = await this.dataSource.query<OrphanRow[]>(
      `SELECT "id", "objectKey"
         FROM "product_images"
        WHERE "productId" IS NULL
          AND "createdAt" < $1
        ORDER BY "createdAt" ASC
        LIMIT $2`,
      [cutoff.toISOString(), this.batchSize],
    );

    let deletedRows = 0;
    let deletedObjects = 0;
    let skippedAttached = 0;
    let orphanedObjects = 0;

    for (const candidate of candidates) {
      /*
       * Conditional delete. The `productId IS NULL` predicate is re-evaluated
       * HERE, in the statement that removes the row, so an image attached
       * since the scan above survives untouched.
       */
      /*
       * ONE TRANSACTION: destroy the row and take durable ownership of its
       * key. Previously the DELETE stood alone and the object was deleted
       * afterwards, so a failed `DeleteObject` left bytes nothing could name —
       * the row that held the key was already gone. The deletion job is the
       * tombstone that makes the failure a retry instead of a leak.
       */
      const key = await this.dataSource.transaction(async (manager) => {
        const deleted = returnedRows<{ objectKey: string | null }>(
          await manager.query(
            `DELETE FROM "product_images"
              WHERE "id" = $1 AND "productId" IS NULL
            RETURNING "objectKey"`,
            [candidate.id],
          ),
        );
        if (deleted.length === 0) return undefined;

        const objectKey = deleted[0]?.objectKey ?? null;
        if (objectKey) {
          await this.objectDeletion.enqueue(
            manager,
            objectKey,
            ObjectDeletionOrigin.ORPHAN_SWEEP,
          );
        }
        return objectKey ?? null;
      });

      if (key === undefined) {
        // Attached between the scan and the delete — left strictly alone.
        skippedAttached += 1;
        continue;
      }
      deletedRows += 1;

      if (key === null) {
        // A row from before migration 0034: it never recorded its object.
        // Guessing a key would risk deleting somebody else's bytes, so there
        // is nothing to enqueue and nothing to delete.
        continue;
      }

      /*
       * Best-effort immediate delete. The job is already committed, so a
       * failure here costs only latency: the object-deletion worker retries it
       * with backoff and reports it if it never succeeds.
       */
      const removed = await this.storage.deleteObject(key).catch(() => false);
      if (removed) {
        await this.objectDeletion.finaliseByKey(key).catch(() => undefined);
        deletedObjects += 1;
      } else {
        orphanedObjects += 1;
        this.logger.warn(
          `Deleted orphaned image row and could not immediately remove its ` +
            `object (key=${key}). A durable deletion job is committed for it; ` +
            `the object-deletion worker will retry.`,
        );
      }
    }

    const outcome: CleanupOutcome = {
      scanned: candidates.length,
      deletedRows,
      deletedObjects,
      skippedAttached,
      orphanedObjects,
    };

    if (deletedRows > 0 || skippedAttached > 0) {
      this.logger.log(
        `product image cleanup: scanned=${outcome.scanned} ` +
          `deletedRows=${outcome.deletedRows} deletedObjects=${outcome.deletedObjects} ` +
          `skippedAttached=${outcome.skippedAttached} orphanedObjects=${outcome.orphanedObjects}`,
      );
    }

    return outcome;
  }
}
