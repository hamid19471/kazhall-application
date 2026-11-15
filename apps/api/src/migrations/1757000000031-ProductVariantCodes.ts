import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0031 — «کد محصول» and «کد گونه». Business codes for products and variants.
 *
 * WHAT DID NOT EXIST BEFORE
 * -------------------------
 * Only `product_variants.sku`, which is the WAREHOUSE's string — often a
 * vendor's — and exists per variant, never per product family. There was no
 * identifier a shop assistant could read down a telephone for "that jacket",
 * and no stable identifier for a product at all.
 *
 * SKU IS NOT TOUCHED. Not renamed, not repurposed, not dropped. Two different
 * identifiers for two different jobs, in two columns.
 *
 * ---------------------------------------------------------------------------
 * THE FORMATS
 * ---------------------------------------------------------------------------
 *   product  KZ-P-000001
 *   variant  KZ-P-000001-V000001     — visibly contains its parent
 *
 * Charset A-Z 0-9 '-', hyphens only between alphanumeric runs. The CHECK
 * constraints below are written from `CODE_SQL_PATTERN` in
 * `src/common/catalogue/product-codes.ts`, and a unit test asserts that the
 * TypeScript regex and this SQL pattern accept and reject the same strings —
 * if they ever drift, the application either 500s on a row the database
 * refuses or writes a row it can never validate.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY-SAFE GENERATION — SEQUENCES, NOT max(id) + 1
 * ---------------------------------------------------------------------------
 * `product_code_seq` and `variant_code_seq` are ordinary PostgreSQL sequences.
 * `nextval` is atomic, non-transactional and correct across any number of API
 * instances — which is precisely why it is used instead of the three
 * alternatives the requirement rules out:
 *
 *   max(id) + 1        two concurrent readers get the same answer;
 *   timestamps         collide under load and leak business volume;
 *   in-process counter wrong the moment a second instance starts.
 *
 * `nextval` is NOT rolled back by a failed transaction, so abandoning a
 * generated code leaves a GAP. Gaps are accepted and documented: a code is an
 * identifier, not a count, and nothing reads meaning into its arithmetic. No
 * reservation-expiry subsystem is built to chase them.
 *
 * ---------------------------------------------------------------------------
 * THE BACKFILL, AND WHY THE SEQUENCES START WHERE THEY DO
 * ---------------------------------------------------------------------------
 * Existing rows are coded FROM THEIR PRIMARY KEY:
 *
 *   product 42        -> KZ-P-000042
 *   variant 7 of 42   -> KZ-P-000042-V000007
 *
 * Deterministic (re-running on the same data yields the same codes), unique by
 * construction (ids are unique), and related by construction.
 *
 * Both sequences are then `setval` to max(id) + 1 of their table. That is
 * load-bearing: without it the first generated product code would be
 * `KZ-P-000001`, which product 1 already holds, and the unique index would
 * turn an ordinary "generate a code" click into a 409 for as many clicks as
 * there are existing products.
 *
 * ---------------------------------------------------------------------------
 * IT REFUSES TO RUN ON A VARIANT WITH NO PARENT
 * ---------------------------------------------------------------------------
 * `product_variants."productId"` is NULLABLE in the baseline schema. A variant
 * with no parent CANNOT be given a code that derives from its parent's, and
 * inventing one (`ORPHAN-V000007`) would put a value in the column that
 * violates the relationship rule the application enforces everywhere else.
 * So the migration stops and lists the offending ids, exactly as 0025 does
 * for duplicate category titles. Nothing is auto-repaired: only a human knows
 * whether an orphan variant should be reattached or deleted.
 * ============================================================================
 */

/** Mirrors `CODE_SQL_PATTERN` in `src/common/catalogue/product-codes.ts`. */
const CODE_PATTERN = '^[A-Z0-9]+(-[A-Z0-9]+)*$';

const PRODUCT_CODE_MAX = 32;
const VARIANT_CODE_MAX = 64;

interface OrphanRow {
  id: number;
  sku: string | null;
}

export class ProductVariantCodes1757000000031 implements MigrationInterface {
  name = 'ProductVariantCodes1757000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------------
    // 1. GUARD: every variant must have a parent, or no related code exists.
    // -----------------------------------------------------------------------
    const orphans = (await queryRunner.query(
      `SELECT "id", "sku"
         FROM "product_variants"
        WHERE "productId" IS NULL
        ORDER BY "id"`,
    )) as OrphanRow[];

    if (orphans.length > 0) {
      const listed = orphans
        .map((row) => `  #${row.id} sku=${JSON.stringify(row.sku)}`)
        .join('\n');
      throw new Error(
        `${this.name} REFUSES TO RUN.\n` +
          `${orphans.length} variant(s) have no parent product ` +
          `("productId" IS NULL), so no variant code can be derived from a ` +
          `product code that does not exist.\n${listed}\n` +
          `FIX BY HAND: reattach each variant to its product, or delete it if ` +
          `it is not in use, then run the migration again. This migration ` +
          `deliberately does not invent a code for an orphan — a made-up ` +
          `value would violate the parent/child rule the API enforces on ` +
          `every other path.`,
      );
    }

    // -----------------------------------------------------------------------
    // 2. Nullable columns first; NOT NULL is applied in step 6, after backfill.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "products"
         ADD COLUMN "productCode" character varying(${PRODUCT_CODE_MAX})`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         ADD COLUMN "variantCode" character varying(${VARIANT_CODE_MAX})`,
    );

    // -----------------------------------------------------------------------
    // 3. The allocators.
    // -----------------------------------------------------------------------
    await queryRunner.query(`CREATE SEQUENCE "product_code_seq" AS bigint`);
    await queryRunner.query(`CREATE SEQUENCE "variant_code_seq" AS bigint`);

    // -----------------------------------------------------------------------
    // 4. BACKFILL from the primary keys. Deterministic and unique.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "products"
          SET "productCode" = 'KZ-P-' || lpad("id"::text, 6, '0')
        WHERE "productCode" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "product_variants" v
          SET "variantCode" = p."productCode" || '-V' || lpad(v."id"::text, 6, '0')
         FROM "products" p
        WHERE p."id" = v."productId"
          AND v."variantCode" IS NULL`,
    );

    // -----------------------------------------------------------------------
    // 5. Move both sequences PAST every value the backfill consumed, so a
    //    generated code can never collide with a backfilled one.
    //    `setval(..., true)` means "this value is used; hand out the next one".
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `SELECT setval('product_code_seq',
                     COALESCE((SELECT max("id") FROM "products"), 0) + 1,
                     false)`,
    );
    await queryRunner.query(
      `SELECT setval('variant_code_seq',
                     COALESCE((SELECT max("id") FROM "product_variants"), 0) + 1,
                     false)`,
    );

    // -----------------------------------------------------------------------
    // 6. Now the columns can be mandatory.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "products" ALTER COLUMN "productCode" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ALTER COLUMN "variantCode" SET NOT NULL`,
    );

    // -----------------------------------------------------------------------
    // 7. The guarantees. The unique indexes are what make a duplicate
    //    IMPOSSIBLE; the service's pre-check only makes the refusal friendlier.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_products_product_code"
         ON "products" ("productCode")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_product_variants_variant_code"
         ON "product_variants" ("variantCode")`,
    );

    await queryRunner.query(
      `ALTER TABLE "products"
         ADD CONSTRAINT "ck_products_product_code_format"
         CHECK ("productCode" ~ '${CODE_PATTERN}')`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         ADD CONSTRAINT "ck_product_variants_variant_code_format"
         CHECK ("variantCode" ~ '${CODE_PATTERN}')`,
    );
  }

  /**
   * Drops everything `up()` added, in dependency order.
   *
   * The backfilled codes are discarded with their columns. That is the honest
   * inverse: before this migration the values did not exist, so there is
   * nothing to preserve them in. Re-running `up()` reproduces exactly the same
   * codes from the same primary keys, which is what makes up/down/up safe.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         DROP CONSTRAINT "ck_product_variants_variant_code_format"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products"
         DROP CONSTRAINT "ck_products_product_code_format"`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."uq_product_variants_variant_code"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_products_product_code"`);

    await queryRunner.query(`DROP SEQUENCE "variant_code_seq"`);
    await queryRunner.query(`DROP SEQUENCE "product_code_seq"`);

    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "variantCode"`,
    );
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "productCode"`);
  }
}
