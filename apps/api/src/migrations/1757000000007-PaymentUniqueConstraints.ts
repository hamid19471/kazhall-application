import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0007 — `payment` uniqueness guarantees (docs/ARCHITECTURE.md §2, §4).
 *
 * `uq_payment_one_success_per_order` is the structural block on
 * double-fulfilment: an order may accumulate any number of pending/failed
 * payment attempts, but at most ONE may ever reach `success`. Because it is a
 * partial unique index, the database — not application code — is what makes a
 * second confirmed payment for the same order impossible, including across
 * concurrent gateway callbacks for different attempts.
 *
 * `uq_payment_track_id` makes the gateway's trackId a real identity: a replayed
 * callback cannot create a second payment row for the same gateway
 * transaction. NULL trackIds (attempts that never reached the gateway) are
 * excluded.
 */
export class PaymentUniqueConstraints1757000000007 implements MigrationInterface {
  name = 'PaymentUniqueConstraints1757000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_one_success_per_order" ON "payment" ("orderId") WHERE status = 'success'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_track_id" ON "payment" ("track_id") WHERE "track_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_order_status" ON "payment" ("orderId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_payment_order_status"`);
    await queryRunner.query(`DROP INDEX "public"."uq_payment_track_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_payment_one_success_per_order"`,
    );
  }
}
