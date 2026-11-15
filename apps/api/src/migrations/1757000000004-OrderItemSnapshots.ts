import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0004 — `order_items` immutable line snapshots (docs/ARCHITECTURE.md §3, §4).
 *
 * A receipt must still be reproducible after the product is renamed, the
 * variant's SKU changes, or the product row is deleted (the productId /
 * variantId FKs are ON DELETE SET NULL).
 *
 * `productTitleSnapshot` is NOT NULL per the spec. It is added with a
 * transient DEFAULT '' so pre-existing rows satisfy the constraint, then the
 * default is dropped so every future INSERT must supply a real title.
 */
export class OrderItemSnapshots1757000000004 implements MigrationInterface {
  name = 'OrderItemSnapshots1757000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD "productTitleSnapshot" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ALTER COLUMN "productTitleSnapshot" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD "variantSkuSnapshot" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD "attributesSnapshot" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "attributesSnapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "variantSkuSnapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "productTitleSnapshot"`,
    );
  }
}
