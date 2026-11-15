import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0024 — `stock_movements.reasonText`, the human explanation beside the
 * machine reason.
 *
 * WHAT THIS CLOSES. `stock_movements.reason` is an enum (`pos_sale`,
 * `manual_adjustment`, …). It answers "what kind of movement was this" and it
 * is deliberately narrow, because every consumer of the ledger — the
 * reconciliation query, the movement filter, the fulfilment idempotency check —
 * branches on it. It cannot answer "why did someone decide the shelf held 12
 * rather than 40", and until now the sentence an administrator typed on
 * `POST /admin/inventory/variants/:id/adjust` reached only `admin_audit_log`.
 * That record is real and append-only, but it is reached through a DIFFERENT
 * screen and a DIFFERENT query, so the one place a stock-keeper actually reads
 * — the ledger — showed a −28 with no explanation next to it. This column puts
 * "why" beside "what" in one row.
 *
 * IT DOES NOT REPLACE `reason`. The enum stays exactly as it is and stays
 * mandatory: free text is not filterable, not comparable, and not something a
 * code path may branch on. `reasonText` is ADDITIVE and is only ever read by
 * humans.
 *
 * -------------------------------------------------------------------------
 * WHY THE COLUMN IS NULLABLE — two independent reasons, either sufficient.
 *
 * 1. MOST MOVEMENTS HAVE NO HUMAN AUTHOR. A POS sale, an online fulfilment, a
 *    cancellation restore and a return restore are written by the system as a
 *    consequence of an order, not by a person explaining a decision. There is
 *    no sentence to store, and NOT NULL would force one to be invented — which
 *    is precisely the failure mode this column exists to prevent. A machine-
 *    generated filler like "POS sale" would also be a lie of provenance: a
 *    reader cannot tell it from something a cashier actually typed.
 *
 * 2. EVERY ROW ALREADY IN THE TABLE PREDATES THE COLUMN. Their explanations,
 *    where they exist at all, are in `admin_audit_log` under action
 *    `stock.adjusted`. See the no-backfill note below.
 *
 * WHY THERE IS NO BACKFILL. It would be possible to join historical
 * `manual_adjustment` rows to `admin_audit_log` on (actor, variant, time) and
 * copy the sentence across. It is not done, for two reasons:
 *
 *   - THE JOIN IS A GUESS. The audit row is written AFTER the adjustment
 *     commits and outside its transaction (see `AdminInventoryController`), so
 *     there is no shared identifier — only a timestamp that is close. Two
 *     adjustments of the same variant by the same administrator in the same
 *     minute cannot be told apart, and attributing one operator's sentence to
 *     the other operator's movement is worse than attributing none.
 *   - `stock_movements` IS A LEDGER. Writing a value into a historical row
 *     that nobody wrote at the time it happened manufactures history. NULL on
 *     an old row is the truthful answer: "this row was written before the
 *     ledger could carry an explanation; look in `admin_audit_log`."
 *
 * Existing rows therefore stay valid and untouched, and the column's absence
 * of a value is never ambiguous: NULL means "no human sentence belongs here",
 * never "the sentence was lost".
 * -------------------------------------------------------------------------
 *
 * THE LENGTH CAP IS IN THE DATABASE, not only in the DTO.
 * `AdminAdjustStockDto.reason` validates 4–500 characters after trimming, so
 * `character varying(500)` is the same bound stated where it cannot be
 * bypassed — a future caller that reaches `InventoryService.adjustStock`
 * without passing through that DTO cannot put a novel in the ledger.
 *
 * THE CHECK CONSTRAINT FORBIDS A BLANK STRING. `''` and `'    '` are the two
 * values that would look like an explanation to `IS NOT NULL` while carrying
 * none, and a screen rendering "reason: ⟨nothing⟩" is worse than one rendering
 * no reason at all. The constraint is deliberately `>= 1` after `btrim` rather
 * than the DTO's `>= 4`: the older
 * `POST /products/variants/:id/stock/adjust` route has always accepted a
 * SHORTER optional reason, and turning a previously-valid request into a
 * database error (a 500, not a 400) would be a regression dressed as rigour.
 * The minimum that makes the value meaningful is enforced at the edge where a
 * violation can still be reported as a 400.
 */
export class StockMovementReasonText1757000000024 implements MigrationInterface {
  name = 'StockMovementReasonText1757000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD "reasonText" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ADD CONSTRAINT "chk_stock_movement_reason_text_not_blank"
         CHECK ("reasonText" IS NULL OR char_length(btrim("reasonText")) >= 1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The constraint is attached to the column, so dropping the column would
    // take it with it; it is dropped explicitly first so that a partial
    // application of `up()` (column added, constraint not) still reverses
    // cleanly rather than leaving a constraint whose column is gone.
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         DROP CONSTRAINT IF EXISTS "chk_stock_movement_reason_text_not_blank"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN "reasonText"`,
    );
  }
}
