import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0018 — MANUAL RECONCILIATION WITH AN ADMIN QUEUE (owner decision D-2).
 *
 * ==========================================================================
 * WHAT WAS MISSING
 * ==========================================================================
 * Every part of this system that discovers a money/goods discrepancy already
 * refuses to act on it automatically, and says so:
 *
 *   PaymentService        records a confirmed receipt it could not apply as
 *                         `confirmed_unapplied` + `requires_reconciliation` +
 *                         a `reconciliation_reason`, and issues NO refund.
 *   FulfilmentService     refuses to consume stock for a paid order no receipt
 *                         authorizes, writes `orders."fulfillmentLastError"`
 *                         and leaves the order recoverable.
 *   OrdersService         (since the paid-order guard) refuses to advance such
 *                         an order out of `paid` at all.
 *
 * All three then say the same thing: "a human must decide". There was nowhere
 * for that human to go and nowhere for their decision to be recorded.
 * `payment.reconciled_at` — the column that means "dealt with" — had ZERO
 * writers anywhere in `src/`, so the escape hatch it feeds in
 * `FulfilmentService`'s authorization predicate was unreachable from the
 * application, and every operator decision (refund it / back-order it / it was
 * fine) was an untracked conversation.
 *
 * ==========================================================================
 * WHAT THIS MIGRATION ADDS  —  THREE THINGS, ALL ADDITIVE
 * ==========================================================================
 *
 * 1. `payment_actions` — AN APPEND-ONLY AUDIT TABLE, modelled on
 *    `order_actions`: `actorUserId` + an IMMUTABLE `actorDisplaySnapshot` that
 *    survives renaming, deactivating or deleting the operator, a MANDATORY
 *    `reason`, the from/to states of every entity the action moved, the
 *    external provider reference, the amount, and the `Idempotency-Key` the
 *    action was taken under.
 *
 *    APPEND-ONLY IS ENFORCED BY THE DATABASE, not by convention: the trigger
 *    `trg_payment_actions_append_only` raises on any UPDATE or DELETE. A
 *    financial audit trail that application code is merely trusted not to
 *    rewrite is not an audit trail. (`TRUNCATE` does not fire row triggers, so
 *    the integration harness's per-test reset is unaffected — and `TRUNCATE`
 *    requires table ownership, which application credentials should not have.)
 *
 *    THERE IS DELIBERATELY NO FOREIGN KEY ON `actorUserId`. `order_actions`
 *    has one with `ON DELETE SET NULL`, which is an UPDATE — and an UPDATE
 *    against an append-only table is exactly what the trigger must forbid.
 *    Deleting a staff member would therefore either rewrite the audit trail or
 *    fail with a trigger error, and neither is acceptable. The column keeps the
 *    id for joining while the operator exists; `actorDisplaySnapshot` is the
 *    record that must survive, and it is NOT NULL.
 *
 * 2. `orders."reconciliationState"` / `orders."reconciliationResolvedAt"` —
 *    THE CASE LIFECYCLE.
 *
 *      open              triaged, no decision taken yet
 *      refund_required   an operator decided money must go back. NOTHING has
 *                        been refunded; this records the obligation.
 *      refund_confirmed  an operator confirmed a refund THEY completed with the
 *                        provider, quoting its reference.        [resolved]
 *      backordered       an explicit decision to keep the paid order open and
 *                        wait for stock. Stays in the queue.
 *      resolved          closed with no financial action.        [resolved]
 *
 *    `NULL` means the case has never been touched. The two resolved states are
 *    the only ones allowed to stamp `"reconciliationResolvedAt"`, enforced by
 *    `ck_orders_reconciliation_resolved` — so "resolved" cannot be claimed
 *    without naming which resolution it was.
 *
 *    WHY ON `orders` AND NOT ON `payment`. A reconciliation case is a decision
 *    about ONE ORDER — retry its fulfilment, refund its customer, back-order
 *    its goods — and an order can carry several receipts that are all part of
 *    the same case (a duplicate confirmation is the archetype). Per-receipt
 *    closure still exists and is still recorded, on the pre-existing
 *    `payment.reconciled_at`, which this change finally gives a writer.
 *
 * 3. `idempotency_keys.scope` gains `payment_reconciliation`, so every
 *    reconciliation mutation gets its own replay-protection namespace instead
 *    of sharing `payment_verify` (declared since 0002 and still unused) with a
 *    completely different operation.
 *
 *    The enum is REBUILT rather than extended with `ALTER TYPE ... ADD VALUE`:
 *    an added value cannot be removed, so `down()` could not be honest, and a
 *    rebuild is fully transactional in both directions.
 *
 * ==========================================================================
 * WHAT THIS MIGRATION DOES NOT DO
 * ==========================================================================
 * It does not alter, widen, re-type or backfill ANY existing money column.
 * `payment.amount`, `payment.gateway_amount`, `payment.gateway_amount_raw`,
 * `payment.ref_number` and `payment.paid_at` are untouched: they are the
 * gateway receipt, and a receipt is evidence, not state. Every figure this
 * feature needs to record is a NEW column on a NEW table.
 *
 * It adds no enum member to `payment.status` or to
 * `payment.reconciliation_reason`: the lifecycle above is a fact about the
 * OPERATOR'S DECISION, not about what the gateway said, and fusing the two is
 * the mistake `PaymentStatusEnum` was already split up to undo.
 *
 * TABLE COUNT: 25 -> 26 (`payment_actions`).
 * `test/integration/smoke.int-spec.ts` is updated in the same change.
 */
export class PaymentReconciliationQueue1757000000018 implements MigrationInterface {
  name = 'PaymentReconciliationQueue1757000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------- payment_actions
    await queryRunner.query(
      `CREATE TYPE "public"."payment_actions_action_enum" AS ENUM(` +
        `'retry_fulfilment', 'mark_refund_required', 'confirm_external_refund', ` +
        `'mark_backorder', 'resolve_no_action')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_actions" (
         "id" SERIAL NOT NULL,
         "orderId" integer NOT NULL,
         "paymentId" integer,
         "action" "public"."payment_actions_action_enum" NOT NULL,
         "fromPaymentStatus" character varying(32),
         "toPaymentStatus" character varying(32),
         "fromOrderStatus" character varying(32),
         "toOrderStatus" character varying(32),
         "fromReconciliationState" character varying(32),
         "toReconciliationState" character varying(32),
         "actorUserId" integer,
         "actorDisplaySnapshot" character varying NOT NULL,
         "reason" text NOT NULL,
         "externalReference" character varying(128),
         "amount" bigint,
         "idempotencyKey" character varying(255),
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_payment_actions_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_action_order" ON "payment_actions" ("orderId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_action_payment" ON "payment_actions" ("paymentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_action_actor" ON "payment_actions" ("actorUserId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_actions" ADD CONSTRAINT "FK_payment_actions_order" ` +
        `FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_actions" ADD CONSTRAINT "FK_payment_actions_payment" ` +
        `FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // APPEND-ONLY, ENFORCED BY THE DATABASE.
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."payment_actions_append_only"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION
           'payment_actions is append-only: % is not permitted', TG_OP
           USING ERRCODE = '23514';
       END;
       $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_payment_actions_append_only"
         BEFORE UPDATE OR DELETE ON "payment_actions"
         FOR EACH ROW EXECUTE FUNCTION "public"."payment_actions_append_only"()`,
    );

    // --------------------------------------------- orders case lifecycle
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "reconciliationState" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "reconciliationResolvedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_reconciliation_state" CHECK (
         "reconciliationState" IS NULL
         OR "reconciliationState" IN ('open', 'refund_required',
                                      'refund_confirmed', 'backordered',
                                      'resolved'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_reconciliation_resolved" CHECK (
         "reconciliationResolvedAt" IS NULL
         OR "reconciliationState" IN ('refund_confirmed', 'resolved'))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_reconciliation_open" ON "orders" ("reconciliationState")
         WHERE "reconciliationState" IS NOT NULL AND "reconciliationResolvedAt" IS NULL`,
    );

    // ------------------------------------- idempotency scope for these actions
    await queryRunner.query(
      `ALTER TYPE "public"."idempotency_keys_scope_enum" RENAME TO "idempotency_keys_scope_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."idempotency_keys_scope_enum" AS ENUM(` +
        `'pos_sale', 'online_order', 'payment_verify', 'payment_reconciliation')`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "scope" TYPE "public"."idempotency_keys_scope_enum" ` +
        `USING "scope"::text::"public"."idempotency_keys_scope_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."idempotency_keys_scope_enum_old"`,
    );
  }

  /**
   * Exact inverse, in reverse order.
   *
   * The idempotency scope is narrowed back to the three original members, which
   * would fail on a row that actually uses `payment_reconciliation` — correctly
   * so: silently rewriting such a row would destroy the record of which
   * operation a key belonged to. Reconciliation keys are request-replay records
   * with no financial meaning of their own, so a deliberate rollback deletes
   * them first rather than rewriting them.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "idempotency_keys" WHERE "scope" = 'payment_reconciliation'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."idempotency_keys_scope_enum" RENAME TO "idempotency_keys_scope_enum_new"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."idempotency_keys_scope_enum" AS ENUM(` +
        `'pos_sale', 'online_order', 'payment_verify')`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "scope" TYPE "public"."idempotency_keys_scope_enum" ` +
        `USING "scope"::text::"public"."idempotency_keys_scope_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."idempotency_keys_scope_enum_new"`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."idx_orders_reconciliation_open"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "ck_orders_reconciliation_resolved"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "ck_orders_reconciliation_state"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "reconciliationResolvedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "reconciliationState"`,
    );

    await queryRunner.query(
      `DROP TRIGGER "trg_payment_actions_append_only" ON "payment_actions"`,
    );
    await queryRunner.query(
      `DROP FUNCTION "public"."payment_actions_append_only"()`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_actions" DROP CONSTRAINT "FK_payment_actions_payment"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_actions" DROP CONSTRAINT "FK_payment_actions_order"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_payment_action_actor"`);
    await queryRunner.query(`DROP INDEX "public"."idx_payment_action_payment"`);
    await queryRunner.query(`DROP INDEX "public"."idx_payment_action_order"`);
    await queryRunner.query(`DROP TABLE "payment_actions"`);
    await queryRunner.query(`DROP TYPE "public"."payment_actions_action_enum"`);
  }
}
