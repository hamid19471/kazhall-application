import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ObjectDeletionOrigin } from '../entities/object-deletion-job.entity';
import { ObjectStorageService } from './object-storage.service';

/**
 * ============================================================================
 * DELETING BYTES, DURABLY.
 *
 * THE DEFECT THIS REPLACES. Both deletion paths destroyed the only durable
 * reference to an object before the object was gone:
 *
 *     const removed = await storage.deleteObject(key);   // row already deleted
 *     if (!removed) logger.warn(`... it can be swept later ...`);
 *
 * That last sentence was FALSE, and it was the whole problem. Once the
 * `product_images` row was gone the key existed only in a local variable. A
 * failed `DeleteObject` left the bytes in the bucket with nothing anywhere
 * naming them: no row to find them from, no way to tell them apart from a live
 * object in a bucket listing, and no later sweep that could pick them up. The
 * leak was permanent, and the log line said the opposite.
 *
 * ---------------------------------------------------------------------------
 * THE HANDOFF IS ATOMIC
 * ---------------------------------------------------------------------------
 * {@link enqueue} runs INSIDE the caller's transaction — the same one that
 * deletes the image row. So there are exactly two possible outcomes:
 *
 *     row gone   AND job exists      (the delete will happen, eventually)
 *     row intact AND no job          (nothing happened at all)
 *
 * "row gone and key forgotten" is not representable. That is the property the
 * old code lacked, and no amount of retrying around the old shape could add
 * it, because the retry needs a name to retry ON.
 *
 * A PRODUCT EDIT IS NEVER BLOCKED BY STORAGE. Enqueueing is one INSERT against
 * a database the caller is already writing to; the store is not contacted
 * inside the transaction at all. If S3 is down, the edit still commits and the
 * bytes are removed later.
 *
 * ---------------------------------------------------------------------------
 * THE WORKER
 * ---------------------------------------------------------------------------
 * Claims due jobs with `FOR UPDATE SKIP LOCKED`, so two instances take
 * disjoint rows and neither waits on the other. Each attempt either:
 *
 *   succeeds  -> the row is DELETED (idempotently: a second worker deleting an
 *                already-deleted job affects zero rows and moves on),
 *   fails     -> `attempts` increments, `lastError` is recorded, and
 *                `nextAttemptAt` moves out by a capped exponential backoff.
 *                The KEY IS STILL THERE.
 *
 * Past the attempt ceiling a job becomes `abandoned` — terminal, and
 * deliberately NOT deleted. It is the only record that those bytes are
 * unreferenced and still present, so an operator can list them. Deleting it
 * would recreate the silent leak this service exists to remove.
 *
 * ---------------------------------------------------------------------------
 * A REFERENCED OBJECT IS NEVER DELETED
 * ---------------------------------------------------------------------------
 * Before every delete the worker re-checks that no `product_images` row still
 * names the key. The enqueue paths already guarantee it, but this is the one
 * check whose absence is unrecoverable: deleting an object a live product
 * displays cannot be undone, and jobs can outlive the reasoning that created
 * them. A job whose key has been re-referenced is dropped, not executed.
 * ============================================================================
 */

/** How many times to try before giving up and reporting. */
const MAX_ATTEMPTS = 10;
/** First retry delay; doubles each attempt. */
const BACKOFF_BASE_MS = 60_000;
/** Ceiling for the doubling, so a stuck job still retries hourly. */
const BACKOFF_MAX_MS = 3_600_000;
/** How often the worker looks for due jobs. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Jobs per pass. */
const DEFAULT_BATCH_SIZE = 25;

interface ClaimedJob {
  id: number;
  objectKey: string;
  attempts: number;
}

export interface DeletionPassOutcome {
  readonly claimed: number;
  readonly deleted: number;
  readonly retried: number;
  readonly abandoned: number;
  /** Jobs dropped because the key is referenced by a live image again. */
  readonly skippedReferenced: number;
}

export interface DeletionBacklog {
  readonly pending: number;
  readonly abandoned: number;
}

/**
 * `dataSource.query` returns `any`. A trailing `as T[]` on the call expression
 * is exactly the shape `@typescript-eslint/no-unnecessary-type-assertion`
 * removes on `--fix`, which silently leaves every caller untyped. A helper
 * whose RETURN TYPE is declared cannot be unwound that way, and it is the
 * pattern the inventory and POS services already use.
 */
async function rows<T>(run: Promise<unknown>): Promise<T[]> {
  const result = await run;
  return Array.isArray(result) ? (result as T[]) : [];
}

@Injectable()
export class ObjectDeletionService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ObjectDeletionService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  private readonly intervalMs: number;
  private readonly batchSize: number;
  readonly enabled: boolean;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: ObjectStorageService,
    config: ConfigService,
  ) {
    this.intervalMs =
      positiveInt(config.get<string>('OBJECT_DELETION_INTERVAL_MS')) ??
      DEFAULT_INTERVAL_MS;
    this.batchSize =
      positiveInt(config.get<string>('OBJECT_DELETION_BATCH_SIZE')) ??
      DEFAULT_BATCH_SIZE;
    /*
     * ON by default, unlike the orphan sweeper.
     *
     * These two services answer different questions. The sweeper DECIDES that
     * an image is abandoned, which needs a policy nobody has set. This worker
     * only finishes deletions somebody already decided on — an admin removed
     * an image, or a row insert failed — so switching it off would not be a
     * conservative default, it would be a guaranteed leak.
     */
    this.enabled =
      String(
        config.get<string>('OBJECT_DELETION_ENABLED') ?? 'true',
      ).toLowerCase() !== 'false';
  }

  // =========================================================================
  // Enqueue — always inside the caller's transaction
  // =========================================================================

  /**
   * Record that `objectKey` must be deleted.
   *
   * MUST be called with the `manager` of the transaction that removes the row
   * holding the key, so the handoff commits or rolls back with it.
   *
   * `ON CONFLICT` resets an existing job's schedule rather than inserting a
   * duplicate: a key can legitimately be enqueued again (an abandoned job
   * whose object is still there, a retry of a failed compensation), and two
   * rows for one key would only race each other.
   */
  async enqueue(
    manager: EntityManager,
    objectKey: string,
    origin: ObjectDeletionOrigin,
  ): Promise<void> {
    if (!objectKey) return;
    await manager.query(
      `INSERT INTO "object_deletion_jobs"
         ("objectKey", "status", "attempts", "nextAttemptAt", "origin")
       VALUES ($1, 'pending', 0, now(), $2)
       ON CONFLICT ("objectKey") DO UPDATE
          SET "status" = 'pending',
              "attempts" = 0,
              "lastError" = NULL,
              "nextAttemptAt" = now(),
              "origin" = EXCLUDED."origin",
              "updatedAt" = now()`,
      [objectKey, origin],
    );
  }

  /**
   * Enqueue in a transaction of its own.
   *
   * For the upload-compensation path, whose caller's transaction has already
   * failed: there is no transaction left to join, and the object is in the
   * bucket with no row naming it. See `ProductsService.upload`.
   */
  async enqueueStandalone(
    objectKey: string,
    origin: ObjectDeletionOrigin,
  ): Promise<boolean> {
    try {
      await this.dataSource.transaction((manager) =>
        this.enqueue(manager, objectKey, origin),
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Could not persist a deletion job for key=${objectKey}: ${describe(error)}. ` +
          `The object is in the bucket, unreferenced, and NOTHING now records ` +
          `that it should be removed — it must be reclaimed by a bucket ` +
          `lifecycle rule or by hand.`,
      );
      return false;
    }
  }

  // =========================================================================
  // The worker
  // =========================================================================

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'Object deletion worker is DISABLED (OBJECT_DELETION_ENABLED=false). ' +
          'Deletion jobs will accumulate and no bytes will be reclaimed.',
      );
      return;
    }
    this.timer = setInterval(() => {
      this.inFlight = this.runPass().catch((error) =>
        this.logger.error(`object deletion pass failed: ${describe(error)}`),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop the timer and wait for a pass already in flight — same reasoning as
   * the other sweepers: a pass that started just before shutdown would keep
   * querying a DataSource being destroyed, and in the integration suite that
   * surfaces as work leaking into the next spec file.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pass = this.inFlight;
    this.inFlight = null;
    if (pass) await pass;
  }

  /**
   * One pass. Public so tests — and a future admin route — can run it
   * deterministically instead of waiting for a timer.
   */
  async runPass(): Promise<DeletionPassOutcome> {
    let deleted = 0;
    let retried = 0;
    let abandoned = 0;
    let skippedReferenced = 0;

    const claimed = await this.claim();

    for (const job of claimed) {
      /*
       * THE GUARD THAT CANNOT BE SKIPPED. A job may outlive the reasoning that
       * created it; deleting an object a live product displays is not
       * recoverable by rerunning anything.
       */
      const stillReferenced = await this.isReferenced(job.objectKey);
      if (stillReferenced) {
        await this.finalise(job.id);
        skippedReferenced += 1;
        this.logger.warn(
          `Dropped deletion job ${job.id}: key=${job.objectKey} is referenced ` +
            `by a product image again. The object was NOT deleted.`,
        );
        continue;
      }

      let removed = false;
      let failure = '';
      try {
        removed = await this.storage.deleteObject(job.objectKey);
      } catch (error) {
        failure = describe(error);
      }

      if (removed) {
        await this.finalise(job.id);
        deleted += 1;
        continue;
      }

      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await this.abandon(
          job.id,
          attempts,
          failure || 'delete returned false',
        );
        abandoned += 1;
        this.logger.error(
          `Deletion job ${job.id} ABANDONED after ${attempts} attempts. ` +
            `key=${job.objectKey} is unreferenced and STILL PRESENT in the ` +
            `bucket. It is recorded in object_deletion_jobs with status ` +
            `'abandoned' and needs an operator.`,
        );
      } else {
        await this.reschedule(
          job.id,
          attempts,
          failure || 'delete returned false',
        );
        retried += 1;
      }
    }

    const outcome: DeletionPassOutcome = {
      claimed: claimed.length,
      deleted,
      retried,
      abandoned,
      skippedReferenced,
    };

    if (claimed.length > 0) {
      this.logger.log(
        `object deletion: claimed=${outcome.claimed} deleted=${outcome.deleted} ` +
          `retried=${outcome.retried} abandoned=${outcome.abandoned} ` +
          `skippedReferenced=${outcome.skippedReferenced}`,
      );
    }
    return outcome;
  }

  /**
   * The object for `objectKey` is gone; drop its job.
   *
   * For a caller that deleted the bytes itself immediately after committing —
   * the common, fast path — so the worker does not repeat work that is done.
   * Idempotent: a missing job is success.
   */
  async finaliseByKey(objectKey: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "object_deletion_jobs" WHERE "objectKey" = $1`,
      [objectKey],
    );
  }

  /** Pending and permanently failed counts, for operators. */
  async backlog(): Promise<DeletionBacklog> {
    const [row] = await rows<{ pending: number; abandoned: number }>(
      this.dataSource.query(
        `SELECT
           count(*) FILTER (WHERE "status" = 'pending')::int   AS pending,
           count(*) FILTER (WHERE "status" = 'abandoned')::int AS abandoned
         FROM "object_deletion_jobs"`,
      ),
    );
    return { pending: row?.pending ?? 0, abandoned: row?.abandoned ?? 0 };
  }

  /** Every permanently failed job, with its key. For an operator to act on. */
  async abandonedJobs(): Promise<
    Array<{
      id: number;
      objectKey: string;
      attempts: number;
      lastError: string | null;
    }>
  > {
    return rows<{
      id: number;
      objectKey: string;
      attempts: number;
      lastError: string | null;
    }>(
      this.dataSource.query(
        `SELECT "id", "objectKey", "attempts", "lastError"
           FROM "object_deletion_jobs"
          WHERE "status" = 'abandoned'
          ORDER BY "updatedAt" DESC`,
      ),
    );
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Claim a batch.
   *
   * `FOR UPDATE SKIP LOCKED` inside a short transaction, and the claimed rows
   * are pushed out of the due window before the transaction commits. Two
   * workers therefore take DISJOINT sets — the second skips rows the first has
   * locked rather than blocking on them — and a row cannot be claimed twice
   * even if the first worker dies mid-pass, because its transaction rolls back
   * and the row becomes due again.
   */
  private async claim(): Promise<ClaimedJob[]> {
    return this.dataSource.transaction(async (manager) => {
      const claimed = await rows<ClaimedJob>(
        manager.query(
          `SELECT "id", "objectKey", "attempts"
             FROM "object_deletion_jobs"
            WHERE "status" = 'pending'
              AND "nextAttemptAt" <= now()
            ORDER BY "nextAttemptAt" ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [this.batchSize],
        ),
      );

      if (claimed.length > 0) {
        // Hold them out of the due window for one backoff step, so a crash
        // between claiming and finishing does not spin.
        await manager.query(
          `UPDATE "object_deletion_jobs"
              SET "nextAttemptAt" = now() + ($2 || ' milliseconds')::interval,
                  "updatedAt" = now()
            WHERE "id" = ANY($1::int[])`,
          [claimed.map((job) => job.id), String(BACKOFF_BASE_MS)],
        );
      }
      return claimed;
    });
  }

  /** Is any product image still pointing at this key? */
  private async isReferenced(objectKey: string): Promise<boolean> {
    const referencing = await rows<{ exists: number }>(
      this.dataSource.query(
        `SELECT 1 AS exists FROM "product_images" WHERE "objectKey" = $1 LIMIT 1`,
        [objectKey],
      ),
    );
    return referencing.length > 0;
  }

  /**
   * The job is finished. Removing the row is idempotent: a concurrent worker
   * that already removed it affects zero rows, which is success, not an error.
   */
  private async finalise(id: number): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "object_deletion_jobs" WHERE "id" = $1`,
      [id],
    );
  }

  private async reschedule(
    id: number,
    attempts: number,
    error: string,
  ): Promise<void> {
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (attempts - 1),
      BACKOFF_MAX_MS,
    );
    await this.dataSource.query(
      `UPDATE "object_deletion_jobs"
          SET "attempts" = $2,
              "lastError" = $3,
              "nextAttemptAt" = now() + ($4 || ' milliseconds')::interval,
              "updatedAt" = now()
        WHERE "id" = $1 AND "status" = 'pending'`,
      [id, attempts, error.slice(0, 500), String(delay)],
    );
  }

  private async abandon(
    id: number,
    attempts: number,
    error: string,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE "object_deletion_jobs"
          SET "status" = 'abandoned',
              "attempts" = $2,
              "lastError" = $3,
              "updatedAt" = now()
        WHERE "id" = $1 AND "status" = 'pending'`,
      [id, attempts, error.slice(0, 500)],
    );
  }
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Non-sensitive one-liner; signature material stripped. */
function describe(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(
      /(AWS4-HMAC-SHA256|Signature=|Credential=|X-Amz-Signature=)[^\s&,]*/gi,
      '$1[redacted]',
    )
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}
