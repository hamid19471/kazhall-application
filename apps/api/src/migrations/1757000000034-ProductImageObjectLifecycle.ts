import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0034 — give a product image an identity in STORAGE and an age.
 *
 * WHY
 * ---
 * `product_images` held one fact about the object it points at: a URL string.
 * That was enough to render a picture and not enough to do anything else.
 *
 *   DELETING was impossible. `applyImageContract` already deletes rows that a
 *     product update drops, and its own comment admitted the consequence:
 *     "(The MinIO object is intentionally left.)" Every removed image leaked
 *     its bytes forever, because nothing recorded which object the row owned.
 *     Parsing the key back out of the URL is not a substitute — the URL is
 *     built from `S3_PUBLIC_BASE_URL`, which an operator may repoint at a CDN
 *     at any time, and every historical row would then parse differently or
 *     not at all.
 *
 *   ORPHANS were invisible. The upload flow is deliberately two-phase: an
 *     image is stored DETACHED and becomes part of a product only when its id
 *     appears in a create/update. Anyone who uploads three photos and closes
 *     the tab leaves three rows with `productId IS NULL` and three objects.
 *     Without a timestamp there is no way to distinguish "abandoned last
 *     month" from "uploaded four seconds ago and about to be attached", so
 *     there was no safe sweep to write.
 *
 * WHAT
 * ----
 *   "objectKey"  the key inside the bucket, or NULL for a row written before
 *                this migration. NULLABLE ON PURPOSE — see below.
 *   "createdAt"  when the row was written.
 *
 * ---------------------------------------------------------------------------
 * WHY `objectKey` IS NULLABLE AND IS NOT BACKFILLED
 * ---------------------------------------------------------------------------
 * A key could be guessed for legacy rows by stripping a prefix off the URL.
 * That guess would be wrong in a way that DESTROYS DATA: the sweeper's whole
 * job is to delete the object a row names, so a key reconstructed from a
 * repointed public base would name either nothing or, worse, somebody else's
 * object. A NULL says "this row does not know its object", every deletion path
 * checks for it, and the object is left alone. Leaking bytes from a handful of
 * historical rows is recoverable by hand; deleting the wrong object is not.
 *
 * On this project that set is empty in practice — `product_images` has never
 * held a row on any environment, because uploading has been failing with a 500
 * since the feature was written. The column is nullable for correctness, not
 * because a large legacy set is expected.
 *
 * ---------------------------------------------------------------------------
 * `createdAt` ON EXISTING ROWS
 * ---------------------------------------------------------------------------
 * Backfilled to `now()` by the column default, which is a deliberate and safe
 * over-estimate of age: it makes every pre-existing row look freshly created,
 * so the orphan sweeper's TTL cannot delete one on the day this deploys. The
 * alternative — a NULL or an epoch timestamp — would make them look infinitely
 * old and put them first in line.
 *
 * ---------------------------------------------------------------------------
 * THE INDEX
 * ---------------------------------------------------------------------------
 * PARTIAL, on detached rows only (`WHERE "productId" IS NULL`). The sweeper
 * asks exactly one question — "which unattached rows are older than T" — and
 * an attached image is never an answer to it. A partial index stays small
 * regardless of how many images the catalogue accumulates, because the rows it
 * covers are by definition the transient ones.
 * ============================================================================
 */
export class ProductImageObjectLifecycle1757000000034 implements MigrationInterface {
  name = 'ProductImageObjectLifecycle1757000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_images"
         ADD COLUMN "objectKey" character varying(512)`,
    );

    await queryRunner.query(
      `ALTER TABLE "product_images"
         ADD COLUMN "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );

    /*
     * One object belongs to at most one row. Without this, a bug that reused a
     * key would let deleting one row delete the picture another row still
     * displays. Partial, because NULL means "unknown" and several legacy rows
     * may share that non-answer.
     */
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_product_images_object_key"
         ON "product_images" ("objectKey")
         WHERE "objectKey" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_product_images_detached_created_at"
         ON "product_images" ("createdAt")
         WHERE "productId" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_product_images_detached_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_product_images_object_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "createdAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "objectKey"`,
    );
  }
}
