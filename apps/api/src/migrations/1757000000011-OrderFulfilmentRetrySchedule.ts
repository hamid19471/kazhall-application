import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0011 — fair, bounded fulfilment retry scheduling (FINDING F).
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `FulfilmentRecoveryService.recover()` selected its batch with
 *
 *     SELECT id FROM orders
 *      WHERE status = 'paid' AND "fulfillmentState" IN ('pending','awaiting_stock')
 *      ORDER BY id ASC LIMIT $batch
 *
 * There is no notion of "already tried recently" in that query, so orders that
 * can NEVER be fulfilled (an item discontinued, stock that will not return)
 * sit on the lowest ids forever and fill every single batch. A fulfillable
 * order created later is never reached — not "reached slowly", NEVER: the
 * query is deterministic and returns the same doomed head on every pass. That
 * is starvation, and the customer of the later order stays unfulfilled while
 * the worker reports healthy activity.
 *
 * WHAT THIS MIGRATION ADDS
 * ------------------------
 * Per-order retry bookkeeping so the worker can select only orders that are
 * DUE and rotate the queue instead of re-scanning its head:
 *
 *   "fulfillmentAttempts"      how many times phase 2 has been re-driven
 *   "fulfillmentLastAttemptAt" when the last attempt was leased
 *   "fulfillmentNextAttemptAt" when this order is next eligible (capped
 *                              exponential backoff, computed in SQL from the
 *                              DATABASE clock)
 *   "fulfillmentLastError"     last failure text, for operators
 *
 * BACKFILL / COMPATIBILITY: every column is nullable or defaulted, so rows
 * written by code that knows nothing about them (orders.service, the POS path,
 * the seeder) are correct by construction. `"fulfillmentNextAttemptAt" IS NULL`
 * MEANS "due now" — that is deliberately the state of every pre-existing row
 * and of every newly paid order, so nothing that was recoverable before this
 * migration becomes invisible after it.
 *
 * timestamptz, not timestamp: these two columns exist only to be compared with
 * `now()`. `orders.paid_at` is a naive `timestamp` and every comparison against
 * it has to be hand-written in SQL to avoid the client-offset trap documented
 * in PaymentService; a zone-aware column removes that trap entirely.
 *
 * NOTE FOR THE LEAD: `src/modules/orders/entities/order.entity.ts` is owned by
 * another workstream, so this migration is the ONLY definition of these
 * columns and the payment module reads/writes them in raw SQL. The entity
 * properties that must be added are listed in the workstream E/F report.
 */
export class OrderFulfilmentRetrySchedule1757000000011 implements MigrationInterface {
  name = 'OrderFulfilmentRetrySchedule1757000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "fulfillmentAttempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "fulfillmentLastAttemptAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "fulfillmentNextAttemptAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "fulfillmentLastError" character varying`,
    );

    // The worker's exact predicate: recoverable AND due. Partial so it stays
    // small however many finished orders the table accumulates; NULLS FIRST
    // ordering matches the "NULL means due now" convention above.
    await queryRunner.query(
      `CREATE INDEX "idx_orders_fulfillment_due" ON "orders" ("fulfillmentNextAttemptAt", "id")
         WHERE status = 'paid' AND "fulfillmentState" IN ('pending', 'awaiting_stock')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_orders_fulfillment_due"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "fulfillmentLastError"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "fulfillmentNextAttemptAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "fulfillmentLastAttemptAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "fulfillmentAttempts"`,
    );
  }
}
