import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0005 — `cart_items` soft removal (docs/ARCHITECTURE.md §4).
 *
 * A POS sale can revoke a customer's basket reservation. The line must survive
 * as an auditable record explaining *why* it changed, so lines are soft-removed
 * (`status='removed'`) rather than deleted.
 *
 * That breaks the old `UNIQUE(userId, productId, variantId)`: a soft-removed
 * line would permanently block the customer from re-adding the same product.
 * The plain unique constraint is therefore replaced by a PARTIAL unique index
 * scoped to `WHERE status = 'active'`.
 *
 * KNOWN CAVEAT (unchanged from the constraint it replaces): PostgreSQL treats
 * NULLs as distinct, so two active lines with a NULL "variantId" do not
 * conflict. Application code must keep enforcing single-line-per-product for
 * variant-less products.
 */
export class CartItemSoftRemoval1757000000005 implements MigrationInterface {
  name = 'CartItemSoftRemoval1757000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."cart_items_status_enum" AS ENUM('active', 'removed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD "status" "public"."cart_items_status_enum" NOT NULL DEFAULT 'active'`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD "lastChangeReason" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD "lastChangeAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD "lastChangeQtyDelta" integer`,
    );

    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "UQ_0b6d1659abfc7f1a86f789b94e2"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_cart_items_active_line" ON "cart_items" ("userId", "productId", "variantId") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_cart_items_active_user" ON "cart_items" ("userId") WHERE status = 'active'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_cart_items_active_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_cart_items_active_line"`);
    // Soft-removed rows would violate the restored plain unique constraint, so
    // collapse them away first — they only exist because of this migration.
    await queryRunner.query(
      `DELETE FROM "cart_items" WHERE "status" <> 'active'`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "UQ_0b6d1659abfc7f1a86f789b94e2" UNIQUE ("userId", "productId", "variantId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP COLUMN "lastChangeQtyDelta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP COLUMN "lastChangeAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP COLUMN "lastChangeReason"`,
    );
    await queryRunner.query(`ALTER TABLE "cart_items" DROP COLUMN "status"`);
    await queryRunner.query(`DROP TYPE "public"."cart_items_status_enum"`);
  }
}
