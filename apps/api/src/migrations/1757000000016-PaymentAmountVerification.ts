import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0016 — an amount-discrepant receipt must not authorize fulfilment (FINDING 2).
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `PaymentService.runPhase1` computed an `amountMismatch` flag and then left it
 * out of the settle decision. A receipt whose gateway amount differed from the
 * amount we asked for still became `payment.status = 'success'`, flipped the
 * order to PAID with `fulfillmentState = 'pending'`, and phase 2 then consumed
 * stock and shipped the goods. The discrepancy WAS recorded
 * (`requires_reconciliation = true`, `reconciliation_reason = 'amount_mismatch'`)
 * — but recording a problem is not refusing to act on it, and by the time an
 * operator ran the reconciliation query the goods had left the building.
 *
 * The same expression was wrong a second time: `gatewayAmount === null` — the
 * gateway reporting no amount at all — evaluated to "no mismatch", so an
 * UNKNOWN amount was treated as PROVEN EQUALITY. `GatewayVerifyResult.amount`
 * is `number | null | undefined`, so that is a reachable state.
 *
 * WHAT THIS MIGRATION ADDS
 * ------------------------
 *  1. Two new `reconciliation_reason` values, so the three ways an amount can
 *     fail to check out are SEPARATE, QUERYABLE FACTS instead of one lump:
 *
 *       'amount_mismatch'  (already existed) both figures known, unequal
 *                                            — an over- or underpayment
 *       'amount_missing'   (NEW)             the gateway did not tell us
 *       'amount_invalid'   (NEW)             the gateway told us something
 *                                            unusable (not finite, negative,
 *                                            or not a whole Rial)
 *
 *     They need different operator responses — chase the customer's bank,
 *     chase the gateway's settlement report, chase the integration — so
 *     collapsing them would destroy the distinction an operator acts on.
 *
 *     `reconciliation_reason` is guarded by the CHECK constraint
 *     `ck_payment_reconciliation_reason` created in migration 0010, so new
 *     values REQUIRE that constraint to be rebuilt. It is dropped and recreated
 *     under the same name; a CHECK (rather than a second enum type) is exactly
 *     what makes that cheap, which is why 0010 chose one.
 *
 *  2. `gateway_amount_raw` — the gateway's figure VERBATIM, as text, for the
 *     `amount_invalid` case. `gateway_amount` is `bigint` and cannot hold
 *     `NaN`, `-1` or `2000000.5`; discarding the value would destroy the only
 *     evidence of what the gateway actually said. Bounded at 64 characters so
 *     an absurd payload cannot bloat the table.
 *
 * NO TABLE IS ADDED OR REMOVED — the application table count stays at 24
 * (`test/integration/smoke.int-spec.ts`). NO MONEY IS TOUCHED: nothing here
 * rescales, adjusts or reverses a stored amount, and no row's `status`,
 * `paid_at` or `amount` is rewritten. A confirmation is a fact, and this
 * migration does not edit facts.
 *
 * WHAT IS DELIBERATELY *NOT* ADDED
 * --------------------------------
 * A CHECK forbidding `status = 'success'` together with an amount-verification
 * reason would enforce the fix structurally, and it is tempting. It is NOT
 * added because rows written by the OLD code legitimately carry exactly that
 * combination, and the only ways to add the constraint would be to fail the
 * migration on real historical data or to rewrite those rows — i.e. to erase
 * the record of a confirmation, which this module never does. The invariant is
 * therefore enforced in code and documented on the entity and the enum instead.
 * Flagged as an owner decision: those legacy rows describe orders that were
 * fulfilled against an unverified receipt and need a human.
 */
export class PaymentAmountVerification1757000000016 implements MigrationInterface {
  name = 'PaymentAmountVerification1757000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment" ADD "gateway_amount_raw" character varying(64)`,
    );

    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "ck_payment_reconciliation_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "ck_payment_reconciliation_reason" CHECK (
         "reconciliation_reason" IS NULL OR "reconciliation_reason" IN (
           'duplicate_confirmed',
           'order_not_payable',
           'late_confirmation_unapplied',
           'late_confirmation_applied',
           'amount_mismatch',
           'amount_missing',
           'amount_invalid'
         ))`,
    );
  }

  /**
   * Reverses `up()` completely, and says plainly what cannot survive the trip.
   *
   * DATA LOSS, STATED PLAINLY — TWO KINDS:
   *
   *  1. The pre-0016 CHECK has no way to say `amount_missing` or
   *     `amount_invalid`. Re-adding it while such a row exists would abort the
   *     rollback, so those rows are NORMALISED to `amount_mismatch` — the
   *     nearest pre-0016 value, chosen because it keeps
   *     `requires_reconciliation = true` and therefore keeps the receipt
   *     VISIBLE to the operator reconciliation query. The receipt, its
   *     `status`, its `paid_at`, its `amount` and its `gateway_amount` are all
   *     untouched: no money is moved, invented or rescaled. Only the finer
   *     grained *label* is coarsened, and the row still reads as "the amount
   *     did not check out".
   *
   *  2. `gateway_amount_raw` is dropped with the column, so the verbatim text
   *     of an unusable gateway figure is gone for good.
   *
   * EXPORT BEFORE ROLLING BACK a database that has any such row:
   *
   *   SELECT id, "orderId", track_id, ref_number, amount, gateway_amount,
   *          gateway_amount_raw, paid_at, status::text, reconciliation_reason
   *     FROM payment
   *    WHERE reconciliation_reason IN ('amount_missing', 'amount_invalid')
   *       OR gateway_amount_raw IS NOT NULL;
   *
   * Note that rolling back ALSO restores the defective settle decision in the
   * application code that this schema supports, which is the far larger
   * problem: an amount-discrepant receipt would once again authorize fulfilment.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "payment"
          SET "reconciliation_reason" = 'amount_mismatch'
        WHERE "reconciliation_reason" IN ('amount_missing', 'amount_invalid')`,
    );

    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "ck_payment_reconciliation_reason"`,
    );
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
      `ALTER TABLE "payment" DROP COLUMN "gateway_amount_raw"`,
    );
  }
}
