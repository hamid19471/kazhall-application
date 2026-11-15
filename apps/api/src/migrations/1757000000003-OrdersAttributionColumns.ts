import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0003 — `orders` alterations from docs/ARCHITECTURE.md sections 3 and 4.
 *
 *   cashierUserId            FK users(id) ON DELETE RESTRICT — staff with sales
 *                            cannot be hard-deleted (section 3). Soft
 *                            deactivation via users.deactivatedAt (0006) is the
 *                            supported way to retire staff.
 *   cashierDisplaySnapshot   survives a later rename of the seller
 *   branchNameSnapshot       survives a later rename of the branch
 *   paymentMethod            cash | card_terminal | online_gateway | other
 *   orderNumber              human-facing receipt number, UNIQUE
 *   soldAt                   business sale instant used by the reports
 *   fulfillmentState         section 2 phase-2 recovery state machine
 *   voidedAt                 section 5 voidedTotal
 *   subtotal                 bigint Rial, pre-discount line total
 *
 * `orderNumber` is nullable so historical rows survive; the UNIQUE constraint
 * still permits many NULLs in PostgreSQL, which is exactly what we want until
 * every row has been numbered.
 */
export class OrdersAttributionColumns1757000000003 implements MigrationInterface {
  name = 'OrdersAttributionColumns1757000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."orders_paymentmethod_enum" AS ENUM('cash', 'card_terminal', 'online_gateway', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_fulfillmentstate_enum" AS ENUM('not_required', 'pending', 'fulfilled', 'awaiting_stock', 'failed')`,
    );

    await queryRunner.query(`ALTER TABLE "orders" ADD "cashierUserId" integer`);
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "cashierDisplaySnapshot" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "branchNameSnapshot" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "paymentMethod" "public"."orders_paymentmethod_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "orderNumber" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "soldAt" TIMESTAMP WITH TIME ZONE`,
    );
    // BACKFILL. Every report in section 5 ranges on `soldAt`; a NULL here means
    // the order is invisible to every date-ranged report forever. Existing rows
    // are attributed to when they were actually paid, falling back to when they
    // were created.
    await queryRunner.query(
      `UPDATE "orders" SET "soldAt" = COALESCE("paid_at", "created_at") WHERE "soldAt" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "fulfillmentState" "public"."orders_fulfillmentstate_enum" NOT NULL DEFAULT 'not_required'`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "voidedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "subtotal" bigint NOT NULL DEFAULT '0'`,
    );

    // DECISION (workstream A, migration owner): `soldAt` is NOT NULL with
    // DEFAULT now().
    //
    // A nullable `soldAt` has exactly one failure mode and it is silent: any
    // write path that forgets to set it drops the order out of every report in
    // section 5, with no error anywhere. NOT NULL removes that mode entirely,
    // and the DEFAULT means no write path can FAIL because of it either — an
    // INSERT that omits the column simply gets the creation instant, which is
    // then overwritten with the true sale instant by the POS commit or by
    // payment confirmation.
    //
    // Semantics: "the business instant this order is attributed to". Orders that
    // are cancelled or fail are excluded from grossSales by STATUS (section 5),
    // not by having no sale time, so defaulting to creation time cannot inflate
    // revenue.
    //
    // COORDINATION (workstream C): `Order.soldAt` must not be written as an
    // explicit `null`. Declare it `soldAt: Date` (or leave it `undefined` on
    // insert) — TypeORM omits an undefined property and the default applies,
    // but it sends a literal NULL for a null one, which this constraint rejects.
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "soldAt" SET DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "soldAt" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "uq_orders_order_number" UNIQUE ("orderNumber")`,
    );
    // RESTRICT, not SET NULL: seller attribution must never silently disappear.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_cashier_user" FOREIGN KEY ("cashierUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    // Reporting access paths (docs/ARCHITECTURE.md section 5).
    await queryRunner.query(
      `CREATE INDEX "idx_orders_cashier_sold_at" ON "orders" ("cashierUserId", "soldAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_branch_sold_at" ON "orders" ("branchId", "soldAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_status_sold_at" ON "orders" ("status", "soldAt")`,
    );
    // Drives FulfilmentRecoveryService's scan for stuck PAID orders.
    await queryRunner.query(
      `CREATE INDEX "idx_orders_recoverable_fulfillment" ON "orders" ("fulfillmentState") WHERE "fulfillmentState" IN ('pending', 'awaiting_stock')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_orders_recoverable_fulfillment"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_orders_status_sold_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_branch_sold_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_cashier_sold_at"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "fk_orders_cashier_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "uq_orders_order_number"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "subtotal"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "voidedAt"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "fulfillmentState"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "soldAt"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "orderNumber"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "paymentMethod"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "branchNameSnapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "cashierDisplaySnapshot"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "cashierUserId"`);
    await queryRunner.query(
      `DROP TYPE "public"."orders_fulfillmentstate_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."orders_paymentmethod_enum"`);
  }
}
