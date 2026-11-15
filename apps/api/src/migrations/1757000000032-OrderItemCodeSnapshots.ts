import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0032 — «کد محصول» and «کد گونه» frozen onto sold lines.
 *
 * WHY THIS EXISTS
 * ---------------
 * `order_items` already keeps `productTitleSnapshot`, `variantSkuSnapshot` and
 * `attributesSnapshot` — written once at sale time and never rewritten —
 * because its `productId`/`variantId` foreign keys are `ON DELETE SET NULL`
 * and reports must stay renderable after a catalogue row is gone. The two new
 * codes join that set for the same reason, plus one the SKU does not have:
 *
 *   A CODE IS EDITABLE. Migration 0031 makes `productCode` and `variantCode`
 *   business identifiers a super_admin may retype at any time. Without a
 *   snapshot, correcting a typo in a product code would silently rewrite what
 *   every historical receipt and every past report says was sold — the exact
 *   failure the other three snapshot columns exist to prevent.
 *
 * With these columns, changing a code changes the CATALOGUE and never the
 * HISTORY, which is what lets the code be editable at all.
 *
 * ---------------------------------------------------------------------------
 * THE BACKFILL, AND WHERE IT HONESTLY STOPS
 * ---------------------------------------------------------------------------
 * Historical lines are filled by following the surviving foreign keys to the
 * codes 0031 assigned:
 *
 *   variantCodeSnapshot  <- product_variants."variantCode"  via "variantId"
 *   productCodeSnapshot  <- products."productCode"          via the variant's
 *                           parent, falling back to the line's own "productId"
 *
 * WHERE THE FOREIGN KEY IS ALREADY NULL, THE SNAPSHOT STAYS NULL. That is the
 * documented fallback, and it is deliberate: the catalogue row is gone, the
 * code was never recorded on the line, and there is no source of truth left.
 * Writing a placeholder — 'UNKNOWN', or a code reconstructed from the line's
 * title — would manufacture a business identifier that never existed and put
 * it on a receipt. A NULL says "not recorded", which is true.
 *
 * This is why BOTH columns stay NULLABLE rather than being tightened after
 * backfill. `variantSkuSnapshot` is nullable for exactly the same reason, and
 * its comment says so: "Nullable only for legacy rows." Every line written
 * from this deploy onward carries both codes, because the sale path supplies
 * them from rows it has already locked.
 *
 * The migration REPORTS what it could and could not fill, so the number is on
 * the deploy log rather than in somebody's assumption.
 * ============================================================================
 */

const PRODUCT_CODE_MAX = 32;
const VARIANT_CODE_MAX = 64;

interface CoverageRow {
  total: string;
  with_variant_code: string;
  with_product_code: string;
}

export class OrderItemCodeSnapshots1757000000032 implements MigrationInterface {
  name = 'OrderItemCodeSnapshots1757000000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items"
         ADD COLUMN "productCodeSnapshot" character varying(${PRODUCT_CODE_MAX})`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items"
         ADD COLUMN "variantCodeSnapshot" character varying(${VARIANT_CODE_MAX})`,
    );

    // -----------------------------------------------------------------------
    // Backfill through the surviving foreign keys. Lines whose variant row is
    // gone keep NULL — see the header.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "order_items" oi
          SET "variantCodeSnapshot" = v."variantCode"
         FROM "product_variants" v
        WHERE v."id" = oi."variantId"
          AND oi."variantCodeSnapshot" IS NULL`,
    );

    /*
     * The product code is reached through the VARIANT's parent first, because
     * that is the stronger link: `order_items."productId"` can point at a
     * different product than the variant's parent only if the catalogue was
     * edited in ways the current API forbids, and the variant is what was
     * actually sold.
     */
    await queryRunner.query(
      `UPDATE "order_items" oi
          SET "productCodeSnapshot" = p."productCode"
         FROM "product_variants" v
         JOIN "products" p ON p."id" = v."productId"
        WHERE v."id" = oi."variantId"
          AND oi."productCodeSnapshot" IS NULL`,
    );

    // Fallback for a line that lost its variant but kept its product.
    await queryRunner.query(
      `UPDATE "order_items" oi
          SET "productCodeSnapshot" = p."productCode"
         FROM "products" p
        WHERE p."id" = oi."productId"
          AND oi."productCodeSnapshot" IS NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_order_items_variant_code_snapshot"
         ON "order_items" ("variantCodeSnapshot")`,
    );

    // -----------------------------------------------------------------------
    // Report coverage honestly rather than claiming a complete backfill.
    // -----------------------------------------------------------------------
    const [coverage] = (await queryRunner.query(
      `SELECT count(*)::text AS total,
              count("variantCodeSnapshot")::text AS with_variant_code,
              count("productCodeSnapshot")::text AS with_product_code
         FROM "order_items"`,
    )) as CoverageRow[];

    const total = Number(coverage?.total ?? 0);
    const withVariant = Number(coverage?.with_variant_code ?? 0);
    const withProduct = Number(coverage?.with_product_code ?? 0);

    if (total > 0 && (withVariant < total || withProduct < total)) {
      console.warn(
        `[${this.name}] order_items backfill: ${withProduct}/${total} rows ` +
          `have a product code and ${withVariant}/${total} have a variant ` +
          `code. The remainder are historical lines whose catalogue row was ` +
          `already deleted ("productId"/"variantId" IS NULL); their codes ` +
          `were never recorded and are left NULL rather than invented.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_order_items_variant_code_snapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "variantCodeSnapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "productCodeSnapshot"`,
    );
  }
}
