import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0009 — zone-aware MONEY EVENT timestamps on `orders`.
 *
 * WHY THIS EXISTS (what was wrong before).
 *
 * Every sales report ranged on ONE column, `orders."soldAt"`, for every figure
 * it produced. That made two documented rules impossible to honour at once:
 *
 *   1. `TOTALS_SEMANTICS.refundRule` promised "a return in October of a
 *      September sale reduces October, not September". Ranging the refund total
 *      on `soldAt` put that refund in SEPTEMBER — the exact opposite. Code and
 *      documentation contradicted each other and the documentation lost.
 *
 *   2. An ONLINE order's `soldAt` is stamped when the BASKET IS CHECKED OUT
 *      (OrdersService.create, status PENDING), not when the gateway confirms
 *      payment. Revenue was therefore attributed to the instant the customer
 *      clicked "pay", which can be a different local calendar day — or a
 *      different month — from the instant the money actually arrived.
 *
 * A reversal is a SECOND, LATER business event with its own date. It needs its
 * own column; there is no way to derive it from the sale's date.
 *
 *   orders."paidAt"      timestamptz NULL — the instant the money was TAKEN.
 *   orders."refundedAt"  timestamptz NULL — the instant the money was GIVEN BACK.
 *
 * `orders."voidedAt"` (migration 0003) already is the void event instant and is
 * already `timestamptz`, so voids need no new column — only consistent use.
 *
 * WHY NEW COLUMNS AND NOT `orders."paid_at"`. `paid_at` is `timestamp` WITHOUT
 * time zone, so it cannot express an instant on its own: reading it requires
 * knowing which zone the writer's clock was in, and the two writers disagree.
 * PaymentService writes it from the DATABASE clock (`now()`, cast with the
 * SESSION TimeZone — see payment.service.ts, which documents this deliberately)
 * while OrdersService.recordPosSale writes it from a JS `Date`, which the pg
 * driver serialises with the NODE process's offset and PostgreSQL then
 * discards. Report ranges are local calendar days converted to UTC instants by
 * `AT TIME ZONE`, which only works against a zone-aware column. `paid_at` is
 * left untouched for the payment code that owns it.
 *
 * ---------------------------------------------------------------------------
 * BACKFILL, AND WHAT IT CANNOT KNOW
 * ---------------------------------------------------------------------------
 *
 * `paidAt`
 *   POS rows      := "soldAt". EXACT, nothing invented: `recordPosSale` is the
 *                    only code path that creates a POS order and it writes
 *                    `soldAt` and `paid_at` from the same `now`, with status
 *                    PAID. A POS sale is paid at the till, at the instant it is
 *                    rung up. This is applied to POS rows in ANY status, because
 *                    a POS order that was later voided or refunded still HAD its
 *                    money taken at `soldAt`.
 *   ONLINE rows   := "paid_at" reinterpreted in the server's TimeZone, but only
 *                    where `paid_at IS NOT NULL`. `paid_at` on an online order
 *                    is written by exactly one statement — PaymentService's
 *                    confirmation UPDATE — so its presence means the gateway
 *                    confirmed. `current_setting('TimeZone')` is used rather
 *                    than a hard-coded 'UTC' because that is the same session
 *                    setting the original `now()::timestamp` cast used, whatever
 *                    the server was configured with.
 *   Everything else stays NULL. CANNOT KNOW: an online order whose status says
 *                    money was taken but whose `paid_at` is NULL (a manual data
 *                    fix, or a row predating migration 0003). Reports fall back
 *                    to `soldAt` for those rather than dropping them.
 *
 * `refundedAt`
 *   := the earliest `order_actions."createdAt"` for a `return`/`refund` action
 *      on that order. EXACT: that row is written inside the same transaction
 *      that flips the order to REFUNDED (OrdersService.reverseOrder), and
 *      `order_actions."createdAt"` is already `timestamptz`.
 *   CANNOT KNOW: an order sitting in status REFUNDED with no `return`/`refund`
 *      audit row — refunded before the audit table existed (migration 0002), or
 *      by a direct UPDATE. Those are left NULL ON PURPOSE rather than guessed
 *      from `soldAt`, which would recreate exactly the September/October bug
 *      this migration exists to fix. ReportsService counts them in a separate,
 *      clearly labelled `refundsWithUnknownEventDate` block so the money is
 *      never silently dropped, and includes them in an unranged (all-time)
 *      refund total, where no date is needed to place them.
 *
 * ---------------------------------------------------------------------------
 * WHY A TRIGGER MAINTAINS THESE GOING FORWARD
 * ---------------------------------------------------------------------------
 *
 * The two statements that would otherwise have to set these columns live in
 * files this workstream does not own (`PaymentService.verify`'s confirmation
 * UPDATE and `OrdersService.reverseOrder`). A backfilled column that no writer
 * maintains is worse than no column at all: it looks authoritative and silently
 * stops being true the moment the next order is paid. The trigger closes that
 * gap in the same file as the column it maintains, and is written so that an
 * application that later DOES set the column wins:
 *
 *   - it only ever fills a value that is still NULL, so an explicit write from
 *     any service (or a data import) is never overwritten;
 *   - it fires only on the TRANSITION INTO the state, so a legacy row moving
 *     `shipped -> delivered` is not back-stamped with a made-up payment date;
 *   - `refundedAt` is stamped on UPDATE ONLY. An INSERT that arrives already
 *     REFUNDED is a data import, not a refund event; `now()` would be a
 *     fabricated date, so the importer must supply the real one.
 */
export class OrderMoneyEventTimestamps1757000000009 implements MigrationInterface {
  name = 'OrderMoneyEventTimestamps1757000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "paidAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "refundedAt" TIMESTAMP WITH TIME ZONE`,
    );

    // ------------------------------------------------------------- backfill
    await queryRunner.query(
      `UPDATE "orders"
          SET "paidAt" = "soldAt"
        WHERE "paidAt" IS NULL
          AND "channel" = 'pos'
          AND "soldAt" IS NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "orders"
          SET "paidAt" = "paid_at" AT TIME ZONE current_setting('TimeZone')
        WHERE "paidAt" IS NULL
          AND "channel" = 'online'
          AND "paid_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "orders" o
          SET "refundedAt" = a."at"
         FROM (
           SELECT "orderId", MIN("createdAt") AS "at"
             FROM "order_actions"
            WHERE "action" IN ('return', 'refund')
            GROUP BY "orderId"
         ) a
        WHERE a."orderId" = o."id"
          AND o."refundedAt" IS NULL
          AND o."status" = 'refunded'`,
    );

    // ------------------------------------------------------------- trigger
    await queryRunner.query(`
      CREATE FUNCTION "orders_stamp_money_event_times"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        -- Money TAKEN. Only on the transition into PAID, never on a later
        -- status move, so a row that was already past PAID before this column
        -- existed is not given an invented payment date.
        IF NEW."paidAt" IS NULL
           AND NEW."status"::text = 'paid'
           AND (TG_OP = 'INSERT' OR OLD."status"::text IS DISTINCT FROM 'paid')
        THEN
          -- On INSERT the only writer is recordPosSale, which rings up an
          -- already-paid sale: the sale instant IS the payment instant.
          -- On UPDATE the only writer is the gateway confirmation, whose
          -- transaction timestamp is the instant the money arrived.
          NEW."paidAt" := CASE
            WHEN TG_OP = 'INSERT' THEN COALESCE(NEW."soldAt", now())
            ELSE now()
          END;
        END IF;

        -- Money GIVEN BACK. UPDATE only: see the header comment.
        IF TG_OP = 'UPDATE'
           AND NEW."refundedAt" IS NULL
           AND NEW."status"::text = 'refunded'
           AND OLD."status"::text IS DISTINCT FROM 'refunded'
        THEN
          NEW."refundedAt" := now();
        END IF;

        RETURN NEW;
      END;
      $fn$
    `);
    // `UPDATE OF "status"` keeps the trigger off every unrelated write to the
    // row (fulfilment state, order number, totals) instead of firing on all of
    // them and relying on the guards above.
    await queryRunner.query(
      `CREATE TRIGGER "trg_orders_stamp_money_event_times"
         BEFORE INSERT OR UPDATE OF "status" ON "orders"
         FOR EACH ROW EXECUTE FUNCTION "orders_stamp_money_event_times"()`,
    );

    // ------------------------------------------------------------- indexes
    // The revenue axis is COALESCE("paidAt", "soldAt") -- see ReportsService.
    // Indexing the expression, not the columns, is what lets a ranged summary
    // use an index instead of a sequential scan.
    await queryRunner.query(
      `CREATE INDEX "idx_orders_revenue_at" ON "orders" ((COALESCE("paidAt", "soldAt")))`,
    );
    // Partial: reversals are a small minority of rows and every query that
    // touches these columns already requires them to be non-NULL.
    await queryRunner.query(
      `CREATE INDEX "idx_orders_refunded_at" ON "orders" ("refundedAt") WHERE "refundedAt" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_voided_at" ON "orders" ("voidedAt") WHERE "voidedAt" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_orders_voided_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_refunded_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_revenue_at"`);
    await queryRunner.query(
      `DROP TRIGGER "trg_orders_stamp_money_event_times" ON "orders"`,
    );
    await queryRunner.query(`DROP FUNCTION "orders_stamp_money_event_times"()`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "refundedAt"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "paidAt"`);
  }
}
