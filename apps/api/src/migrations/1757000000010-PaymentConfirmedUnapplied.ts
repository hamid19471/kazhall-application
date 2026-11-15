import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0010 — honest states for money the gateway confirmed (FINDING E).
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `payment_status_enum` had no way to say "the gateway confirmed this money,
 * but this is not the payment that settled the order". So when a second
 * attempt was confirmed for an order another attempt had already paid — or
 * when the partial unique index `uq_payment_one_success_per_order` rejected the
 * second `success` — the service left that row in status `pending`. Real money
 * the gateway had taken was recorded as "not paid yet". Worse, `pending` is
 * exactly what `Start()` sweeps to `failed` after the reuse window, so the only
 * record of a real receipt was eventually overwritten with a lie.
 *
 * WHAT THIS MIGRATION ADDS
 * ------------------------
 *  1. `confirmed_unapplied` — a new terminal `payment_status_enum` member. The
 *     gateway confirmed the receipt; it did NOT settle its order. It is NOT
 *     `success`, so `uq_payment_one_success_per_order` still permits exactly one
 *     settling payment per order, and it is NOT `pending`, so no sweeper can
 *     erase it.
 *
 *  2. Reconciliation bookkeeping — `requires_reconciliation`,
 *     `reconciliation_reason`, `reconciled_at`, plus the two facts an operator
 *     needs to act on a receipt: the gateway's own `ref_number` and the amount
 *     the GATEWAY reports (`gateway_amount`, INTEGER RIAL, never rescaled).
 *     NO automatic financial action is taken anywhere — these columns exist so
 *     a human can find the money, not so the system can move it.
 *
 *  3. Re-verification bookkeeping — `reverify_attempts`, `last_reverified_at`,
 *     `next_reverify_at`. PaymentReverificationService re-asks the gateway
 *     about attempts that were left `pending`/`failed` WITH a `track_id`, which
 *     is how a receipt whose callback never arrived is discovered. The columns
 *     bound that sweep (capped exponential backoff, capped attempt count) so it
 *     can never hammer the gateway.
 *
 * The enum member is added by RECREATING the type rather than with
 * `ALTER TYPE ... ADD VALUE`: Postgres forbids using a value added by
 * `ADD VALUE` inside the same transaction, and this project's migration harness
 * runs every migration in one transaction (`runMigrations({transaction:'all'})`).
 * The two partial indexes on `status` are dropped and rebuilt around the type
 * swap because their stored predicates reference the old type.
 */
export class PaymentConfirmedUnapplied1757000000010 implements MigrationInterface {
  name = 'PaymentConfirmedUnapplied1757000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- swap the enum type -------------------------------------------------
    await queryRunner.query(
      `DROP INDEX "public"."uq_payment_one_success_per_order"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_payment_order_status"`);

    await queryRunner.query(
      `ALTER TYPE "public"."payment_status_enum" RENAME TO "payment_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_status_enum" AS ENUM('pending', 'success', 'failed', 'refunded', 'confirmed_unapplied')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "status" TYPE "public"."payment_status_enum" USING "status"::text::"public"."payment_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "public"."payment_status_enum_old"`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_one_success_per_order" ON "payment" ("orderId") WHERE status = 'success'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_order_status" ON "payment" ("orderId", "status")`,
    );

    // --- reconciliation bookkeeping ----------------------------------------
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "ref_number" character varying`,
    );
    // INTEGER RIAL, exactly like `amount`. Stored separately so a gateway that
    // reports a different figure than we asked for is VISIBLE instead of being
    // silently overwritten onto our own number.
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "gateway_amount" bigint`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "requires_reconciliation" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "reconciliation_reason" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "reconciled_at" TIMESTAMP`,
    );
    // A CHECK rather than a second enum type: the value set is small, it is
    // written only by this module, and a CHECK keeps `down()` trivial.
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "ck_payment_reconciliation_reason" CHECK (
         "reconciliation_reason" IS NULL OR "reconciliation_reason" IN (
           'duplicate_confirmed',
           'order_not_payable',
           'late_confirmation_unapplied',
           'late_confirmation_applied',
           'amount_mismatch'
         ))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_requires_reconciliation" ON "payment" ("orderId") WHERE "requires_reconciliation"`,
    );

    // --- re-verification bookkeeping ---------------------------------------
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "reverify_attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "last_reverified_at" TIMESTAMP WITH TIME ZONE`,
    );
    // timestamptz, not timestamp: this column is only ever compared against
    // `now()`. `payment.created_at` is a naive `timestamp`, and every comparison
    // against it has to be written in SQL to stay correct; a zone-aware column
    // removes that trap for the new scheduling code.
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "next_reverify_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_reverify_due" ON "payment" ("next_reverify_at") WHERE "track_id" IS NOT NULL AND status IN ('pending', 'failed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_payment_reverify_due"`);
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "next_reverify_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "last_reverified_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "reverify_attempts"`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."idx_payment_requires_reconciliation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "ck_payment_reconciliation_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "reconciled_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "reconciliation_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "requires_reconciliation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "gateway_amount"`,
    );
    await queryRunner.query(`ALTER TABLE "payment" DROP COLUMN "ref_number"`);

    // DATA LOSS, STATED PLAINLY: the pre-0010 schema cannot represent
    // "confirmed but not applied". Rolling back puts those rows back into the
    // exact state the old code left them in — `pending` — which is the defect
    // this migration exists to remove. Do not roll back a production database
    // that has any `confirmed_unapplied` row without exporting them first:
    //   SELECT * FROM payment WHERE status = 'confirmed_unapplied';
    await queryRunner.query(
      `DROP INDEX "public"."uq_payment_one_success_per_order"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_payment_order_status"`);
    await queryRunner.query(
      `UPDATE "payment" SET status = 'pending' WHERE status = 'confirmed_unapplied'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."payment_status_enum" RENAME TO "payment_status_enum_new"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_status_enum" AS ENUM('pending', 'success', 'failed', 'refunded')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "status" TYPE "public"."payment_status_enum" USING "status"::text::"public"."payment_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "public"."payment_status_enum_new"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_one_success_per_order" ON "payment" ("orderId") WHERE status = 'success'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_order_status" ON "payment" ("orderId", "status")`,
    );
  }
}
