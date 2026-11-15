import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0035 — a durable record of "these bytes must go", so a failed delete is a
 * RETRY rather than a permanent leak.
 *
 * WHAT WAS WRONG
 * --------------
 * Both deletion paths destroyed the only durable reference to an object
 * BEFORE the object was gone:
 *
 *   detach   `applyImageContract` deleted the `product_images` row inside the
 *            transaction and the caller deleted the object after the commit.
 *   sweep    the orphan sweeper deleted the row (`DELETE ... RETURNING
 *            "objectKey"`) and then deleted the object.
 *
 * In both, the key lived only in a local variable once the row was gone. If
 * `DeleteObject` then failed — a network blip, a 500 from the store, expired
 * credentials — the object stayed in the bucket and NOTHING anywhere still
 * knew its name. The code logged that it "can be swept later"; that sentence
 * was false. There was no row to find it from, no listing that could tell it
 * apart from a live object, and the next sweeper pass could not see it.
 *
 * So cleanup was not idempotent in the way that matters: re-running it did not
 * finish the work a previous run had left undone, because the work had been
 * forgotten rather than left pending.
 *
 * WHAT THIS TABLE IS
 * ------------------
 * A tombstone that takes OWNERSHIP of the key in the same transaction that
 * destroys the row holding it. The handoff is atomic: either the image row is
 * gone and a deletion job exists, or neither happened. After that the object
 * has a durable name until it is actually deleted.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE AND NOT A QUEUE
 * ---------------------------------------------------------------------------
 * The work is already transactional with a PostgreSQL write. A real queue
 * would need its own delivery guarantee and a two-phase handoff to match what
 * one INSERT in the caller's transaction gives for free — and it would be a
 * new dependency and a new operational surface for a job that fires a handful
 * of times a day.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` gives multi-worker claiming without a
 * broker: two instances sweeping at once each take disjoint rows, and neither
 * waits on the other.
 *
 * ---------------------------------------------------------------------------
 * STATUSES
 * ---------------------------------------------------------------------------
 *   pending    to be attempted at or after `nextAttemptAt`.
 *   abandoned  TERMINAL. Repeated failure past the attempt ceiling. The row is
 *              KEPT, deliberately: it is the only record that these bytes are
 *              unreferenced and still present, and an operator needs to be
 *              able to list them. A deleted row would be a silent leak again.
 *
 * There is no `done`. A finished job's row is removed, because the fact it
 * records has stopped being true.
 *
 * ---------------------------------------------------------------------------
 * `objectKey` IS UNIQUE
 * ---------------------------------------------------------------------------
 * One object, at most one outstanding order to delete it. Two jobs for one key
 * would race: the first deletes, the second gets a success from S3's
 * idempotent delete and finalises — harmless here, but the uniqueness also
 * makes re-enqueueing safe (`ON CONFLICT` resets the schedule instead of
 * piling up duplicates after repeated failures).
 * ============================================================================
 */
export class ObjectDeletionJobs1757000000035 implements MigrationInterface {
  name = 'ObjectDeletionJobs1757000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."object_deletion_jobs_status_enum"
         AS ENUM('pending', 'abandoned')`,
    );

    await queryRunner.query(
      `CREATE TABLE "object_deletion_jobs" (
         "id" SERIAL NOT NULL,
         "objectKey" character varying(512) NOT NULL,
         "status" "public"."object_deletion_jobs_status_enum" NOT NULL DEFAULT 'pending',
         "attempts" integer NOT NULL DEFAULT 0,
         "lastError" character varying(500),
         "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "origin" character varying(32) NOT NULL,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "pk_object_deletion_jobs" PRIMARY KEY ("id"),
         CONSTRAINT "uq_object_deletion_jobs_object_key" UNIQUE ("objectKey"),
         CONSTRAINT "chk_object_deletion_jobs_attempts_non_negative"
           CHECK ("attempts" >= 0)
       )`,
    );

    /*
     * The claim query's index: pending rows, in due order. PARTIAL, because an
     * abandoned row is never claimed and including them would grow the index
     * with exactly the rows it must never return.
     */
    await queryRunner.query(
      `CREATE INDEX "idx_object_deletion_jobs_due"
         ON "object_deletion_jobs" ("nextAttemptAt")
         WHERE "status" = 'pending'`,
    );

    /*
     * Operator visibility: "what has permanently failed". Small by
     * construction — if it is ever large, that is the alert.
     */
    await queryRunner.query(
      `CREATE INDEX "idx_object_deletion_jobs_abandoned"
         ON "object_deletion_jobs" ("updatedAt")
         WHERE "status" = 'abandoned'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_object_deletion_jobs_abandoned"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_object_deletion_jobs_due"`,
    );
    await queryRunner.query(`DROP TABLE "object_deletion_jobs"`);
    await queryRunner.query(
      `DROP TYPE "public"."object_deletion_jobs_status_enum"`,
    );
  }
}
