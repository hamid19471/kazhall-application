import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0008 — `product_variants.isActive` (workstream B, ratified into
 * docs/ARCHITECTURE.md section 4 by the lead).
 *
 * Variants are retired by DEACTIVATION, never by deletion: `order_items`
 * references `product_variants` and a receipt must stay reproducible, so a
 * deleted variant would either break history or (via ON DELETE SET NULL) erase
 * which SKU was actually sold. `isActive = false` removes the variant from the
 * catalogue while leaving every past line intact.
 *
 * Defaults to true so every pre-existing variant stays sellable.
 *
 * The `(productId, isActive)` index serves the only hot query shape there is:
 * "the sellable variants of this product".
 */
export class ProductVariantIsActive1757000000008 implements MigrationInterface {
  name = 'ProductVariantIsActive1757000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD "isActive" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_variant_product_active" ON "product_variants" ("productId", "isActive")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_variant_product_active"`);
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "isActive"`,
    );
  }
}
