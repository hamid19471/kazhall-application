import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { FulfillmentStateEnum } from '../orders/enums/fulfillment-state.enum';
import { InventoryService } from '../inventory/inventory.service';
import {
  ConsumedVariantResult,
  InsufficientStockForFulfilmentError,
} from '../inventory/inventory.types';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import { OrderReconciliationState } from '../orders/enums/reconciliation-state.enum';
import {
  AMOUNT_RECONCILIATION_REASONS,
  PaymentStatusEnum,
} from './enums/payment-status-enum';

/**
 * Why phase 2 REFUSED to consume stock for an order it could otherwise have
 * claimed. Distinct from "not claimed" (wrong state, or another instance holds
 * the row): those are ordinary, expected no-ops, whereas this is an order that
 * is PAID and UNFULFILLED and that the system will not fulfil until a human
 * or a valid receipt resolves it.
 */
export enum FulfilmentBlockedReason {
  /**
   * No `payment` row authorizes consuming stock for this order: every
   * `success` receipt it has carries an OPEN AMOUNT QUESTION
   * (`reconciliation_reason IN ('amount_mismatch','amount_missing',
   * 'amount_invalid')`).
   *
   * The order is left exactly where it was (`pending` / `awaiting_stock`), so
   * it stays inside FulfilmentRecoveryService's bounded retry set and
   * self-heals the moment a valid receipt settles it. NOTHING financial
   * happens: no refund, no credit, no reversal, and no payment row is touched.
   */
  RECONCILIATION_REQUIRED = 'reconciliation_required',
}

export interface FulfilmentOutcome {
  orderId: number;
  state: FulfillmentStateEnum;
  /** True when THIS call did the work (as opposed to finding it already done). */
  claimed: boolean;
  consumed: ConsumedVariantResult[];
  /**
   * Non-null ONLY when the order was in a claimable state and phase 2 refused
   * to consume stock for it. `null` covers both "we did the work" and the
   * ordinary no-ops (already fulfilled, not paid, row locked elsewhere).
   *
   * A caller must never report an order with a non-null `blocked` as fulfilled
   * or as paid-and-progressing.
   */
  blocked: FulfilmentBlockedReason | null;
}

/**
 * ONE RECEIPT, JUDGED CLAUSE BY CLAUSE AGAINST THE AUTHORIZATION PREDICATE.
 *
 * Produced by `readAuthorizationClauses`. It exists so the operator-facing
 * reconciliation API and the operator-facing LOG LINE are computed by the same
 * SQL: a diagnosis an operator reads in the admin UI and a diagnosis they read
 * in the log cannot disagree about why a receipt failed.
 *
 * EVERY MONETARY FIELD IS A STRING, and that is not a serialization detail.
 * These columns are `bigint` INTEGER RIAL; reading one into a JS `Number`
 * silently rounds anything past 2^53, which integer Rial reaches for ordinary
 * sums (2^53 Rial ≈ 900 billion Toman). The SQL casts them to `::text` and
 * nothing on this path converts them back — they are quoted to a human and
 * compared in PostgreSQL, never in JavaScript. `id` is the only number here.
 */
export interface FulfilmentAuthorizationClauses {
  id: number;
  status: string;
  /** What we asked for. INTEGER RIAL as text. */
  amount: string | null;
  /** What the gateway said. INTEGER RIAL as text; NULL when unusable. */
  gateway_amount: string | null;
  /** `orders.total_price`. INTEGER RIAL as text. */
  order_total: string | null;
  reconciliation_reason: string | null;
  /** clause 1: the receipt settled its order. */
  is_success: boolean;
  /** clauses 2+3: the gateway reported a usable sum. */
  has_gateway_amount: boolean;
  /** clause 4: that sum is the sum we asked for. */
  gateway_matches_amount: boolean;
  /** clause 5: which is the sum the order is actually for. */
  amount_matches_order: boolean;
  /** clause 6: no amount-verification reason is left unresolved. */
  reason_resolved: boolean;
}

/** What the authorization probe found, when it found something. */
interface FulfilmentAuthorization {
  /**
   * The `payment.id` that carries POSITIVE AMOUNT EVIDENCE for this order.
   *
   * There is deliberately nothing else here. An earlier version also reported
   * whether the receipt carried no amount evidence at all, because such a row
   * was authorized anyway with a warning. It no longer is: a receipt either
   * proves its amount or it does not authorize anything, so there is no
   * second-class "trusted" case left to describe.
   */
  paymentId: number;
}

/**
 * What is written to `orders."fulfillmentLastError"` when fulfilment is
 * refused, so the blocked order is visible to an operator reading the order
 * row and not only to whoever was watching the log.
 */
const RECONCILIATION_REQUIRED_ERROR =
  'fulfilment refused: no payment row authorizes consuming stock for this order ' +
  '(every success receipt has an open amount question: amount_mismatch / ' +
  'amount_missing / amount_invalid). The order is PAID and NOT fulfilled and needs ' +
  'a human. No refund, credit or reversal has been issued.';

/**
 * ============================================================================
 * PAYMENT PHASE 2  --  docs/ARCHITECTURE.md section 2
 * ============================================================================
 *
 * Phase 1 (PaymentService) records `payment=SUCCESS`, `order=PAID`,
 * `fulfillmentState=PENDING` and COMMITS. A confirmed payment is never rolled
 * back.
 *
 * Phase 2 is this service. It is a SEPARATE transaction that consumes the
 * order's allocations and decrements stock. It is:
 *
 *  - ATOMIC IN ITSELF. Consuming the allocations, decrementing stock, writing
 *    the ledger rows and flipping `fulfillmentState` to FULFILLED all commit
 *    together or not at all. This is emphatically NOT "move the stock deduction
 *    outside the transaction and call it solved".
 *
 *  - IDEMPOTENT PER ORDER. `consumeForOnlineFulfilment` locks the order row and
 *    uses the existence of an `online_fulfillment` ledger row as its completion
 *    marker, and the final state change is a guarded conditional UPDATE. Two
 *    payment attempts, a duplicate webhook and the recovery worker can all run
 *    it; stock moves exactly once.
 *
 *  - RE-DRIVABLE. If it cannot get the stock it records AWAITING_STOCK; if the
 *    process dies mid-flight the order stays PENDING. Both are picked up again
 *    by FulfilmentRecoveryService.
 *
 *  - MULTI-INSTANCE SAFE WITHOUT REDIS. The claim is
 *    `SELECT ... FOR UPDATE SKIP LOCKED` on the order row plus a guarded
 *    conditional UPDATE -- both database primitives. Redis is never the sole
 *    protection for inventory correctness.
 *
 * ============================================================================
 * FINDING 1 -- A LEGACY UNVERIFIED `success` RECEIPT MUST NOT AUTHORIZE
 *              *NEW* FULFILMENT
 * ============================================================================
 *
 * THE DEFECT
 * ----------
 * `claim()` only ever looked at `orders.status` and `orders."fulfillmentState"`.
 * It had NO notion of whether any payment actually authorized consuming stock.
 * Migration 0016 fixed the settle decision so a discrepant receipt can no
 * longer become `success` -- but rows written by the PRE-FIX code are still
 * there, and they are never rewritten (a confirmation is a fact). The reviewer
 * planted exactly one of them:
 *
 *     payment.status                = success
 *     payment.amount                = 1000000
 *     payment.gateway_amount        =  500000
 *     payment.reconciliation_reason = amount_mismatch
 *     orders.status                 = paid
 *     orders."fulfillmentState"     = pending
 *
 * That order is PAID BUT NOT YET FULFILLED, and three entry points would all
 * have consumed its stock and shipped the goods against a receipt for half the
 * money:
 *
 *   - the gateway callback (`PaymentService.Verify()`'s duplicate-callback
 *     replay, which logged the legacy mismatch and then drove phase 2 anyway on
 *     the assumption that such an order was "probably already shipped" -- which
 *     `fulfillmentState = pending` disproves);
 *   - `FulfilmentRecoveryService`'s worker and admin endpoint;
 *   - a direct/manual `drive()`.
 *
 * WHERE THE FIX LIVES, AND WHY HERE
 * ---------------------------------
 * All three reach stock through THIS method, so the check is enforced INSIDE
 * `claim()` -- in the same transaction, with the order row already locked. No
 * caller can bypass it, no caller has to remember it, and a future fourth
 * caller inherits it for free. The check is not scattered across the callers.
 *
 * THE AUTHORIZATION PREDICATE, IN FULL
 * ------------------------------------
 *     EXISTS (
 *       SELECT 1 FROM payment
 *        WHERE "orderId" = :orderId
 *          AND status::text = 'success'
 *          AND (reconciliation_reason IS NULL
 *               OR NOT (reconciliation_reason = ANY(
 *                        ARRAY['amount_mismatch','amount_missing','amount_invalid'])))
 *     )
 *
 * It is an EXISTS, deliberately, and NOT "no bad receipt anywhere": an order
 * that has a discrepant receipt AND a separate valid settling receipt is
 * fulfilled normally. One customer's failed first attempt must not strand their
 * successful second one.
 *
 * A `success` row with a NON-amount reason still authorizes:
 * `late_confirmation_applied` is documented as informational
 * (`requires_reconciliation = false`) and sits on a receipt that DID settle its
 * order. Only the three AMOUNT reasons mean "the sum was never established",
 * and only those are refused. The list is `AMOUNT_RECONCILIATION_REASONS`, so
 * this predicate and `isAmountReconciliationReason` cannot drift apart.
 *
 * MISSING AMOUNT EVIDENCE IS NOT PROOF OF PAYMENT
 * -----------------------------------------------
 * A `success` row with `gateway_amount IS NULL` is a row whose amount was
 * NEVER CHECKED: either it predates migration 0010 (the columns did not exist)
 * or it was written between 0010 and 0016 by a gateway that reported no amount,
 * which the old expression `gatewayAmount !== null && gatewayAmount !== ours`
 * scored as "no mismatch". The two are indistinguishable by row shape.
 *
 * SUCH A RECEIPT DOES NOT AUTHORIZE FULFILMENT. It defaults to
 * `reconciliation_required`.
 *
 * An earlier version of this file trusted those rows and logged a warning,
 * arguing that refusing them would strand legitimate historical orders. That
 * traded a bookkeeping gap for shipped goods, and the trade was never the
 * owner's to have made here: trusting absent evidence is a financial policy,
 * and no such approval exists. The absence of a recorded discrepancy is not
 * evidence of its absence.
 *
 * The consequence is stated plainly rather than mitigated: a legitimate
 * historical paid order whose receipt carries no amount evidence WILL sit
 * unfulfilled until a human resolves it. That is a visible, enumerable,
 * recoverable state -- `orders."fulfillmentLastError"` is set, the order is
 * counted in `RecoveryReport.blocked`, and it self-heals the moment a receipt
 * with real evidence settles it. Shipping against no evidence is none of those
 * things. Enumerate the affected orders before deploying:
 *
 *     SELECT o.id, p.id AS payment_id, p.amount::text, p.gateway_amount::text,
 *            p.reconciliation_reason, p.paid_at
 *       FROM orders o
 *       JOIN payment p ON p."orderId" = o.id AND p.status = 'success'
 *      WHERE o.status = 'paid'
 *        AND o."fulfillmentState" IN ('pending','awaiting_stock');
 *
 * Every row it returns needs a human decision, and owner decisions D-2 / D-3
 * are still open. There is deliberately NO config flag to loosen this: a flag
 * that silently changes which receipts may ship goods is exactly the policy
 * nobody approved.
 *
 * WHAT BEING BLOCKED DOES *NOT* DO
 * --------------------------------
 * It never rewrites, deletes or "corrects" a payment row; it never reverses a
 * stock movement that already happened; it never touches an order that is
 * already FULFILLED (the state filter runs FIRST, so this blocks only NEW
 * consumption); and it issues no refund, credit or adjustment on any path
 * behind any flag. It records `orders."fulfillmentLastError"` and reports a
 * distinct outcome. That is all.
 *
 * WHY NO NEW `fulfillmentState` VALUE. Leaving the order `pending` /
 * `awaiting_stock` is what keeps it inside the recovery worker's bounded,
 * backoff-scheduled retry set, so it SELF-HEALS the instant a valid receipt
 * settles it, and keeps it in `RecoveryReport.overdue` for a human. A new enum
 * member would need a migration, would have to be added to
 * `RECOVERABLE_FULFILLMENT_STATES` anyway to keep that property, and would then
 * be indistinguishable from `pending` in behaviour while duplicating a fact
 * that already lives on the `payment` row.
 *
 * POS IS UNAFFECTED, BY CONSTRUCTION. `OrdersService.recordPosSale` creates the
 * order `status = paid` with `fulfillmentState = FULFILLED` and moves the stock
 * inside the sale transaction, and POS orders have no online `payment` row at
 * all. The state filter in `claim()` admits only `pending`/`awaiting_stock`, and
 * it is evaluated BEFORE the authorization probe, so a POS sale can never reach
 * the probe and can never be blocked by it.
 */
@Injectable()
export class FulfilmentService {
  private readonly logger = new Logger(FulfilmentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventoryService: InventoryService,
  ) {}

  /**
   * Runs (or re-runs) phase 2 for one order. Never throws for a stock
   * shortfall -- that is a recorded state, not an error.
   */
  async drive(
    orderId: number,
    actorUserId: number | null = null,
  ): Promise<FulfilmentOutcome> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const claim = await this.claim(manager, orderId);
        if (!claim.claimed) {
          return {
            orderId,
            state: await this.readState(manager, orderId),
            claimed: false,
            consumed: [],
            blocked: claim.blocked,
          };
        }

        const result = await this.inventoryService.consumeForOnlineFulfilment(
          manager,
          { orderId, actorUserId },
        );

        await this.transitionTo(
          manager,
          orderId,
          FulfillmentStateEnum.FULFILLED,
        );

        return {
          orderId,
          state: FulfillmentStateEnum.FULFILLED,
          claimed: true,
          consumed: result.consumed,
          blocked: null,
        };
      });
    } catch (error) {
      if (error instanceof InsufficientStockForFulfilmentError) {
        // Transaction B rolled back (nothing was consumed). Record the
        // recoverable state in its own committed transaction. The payment
        // stands; no automatic financial action is taken (owner decision D-2).
        this.logger.warn(
          `order ${orderId} cannot be fulfilled from stock: ${error.detail}`,
        );
        await this.dataSource.transaction((manager) =>
          this.transitionTo(
            manager,
            orderId,
            FulfillmentStateEnum.AWAITING_STOCK,
            false,
          ),
        );
        return {
          orderId,
          state: FulfillmentStateEnum.AWAITING_STOCK,
          claimed: true,
          consumed: [],
          blocked: null,
        };
      }
      // Anything else leaves the order in PENDING, which recovery re-drives.
      throw error;
    }
  }

  /**
   * Claim.
   *
   * TWO GATES, IN THIS ORDER, IN ONE TRANSACTION.
   *
   * 1. STATE + LOCK
   *
   *   SELECT id FROM orders
   *    WHERE id = $1
   *      AND status::text = 'paid'
   *      AND "fulfillmentState"::text IN ('pending','awaiting_stock')
   *      FOR UPDATE SKIP LOCKED
   *
   * SKIP LOCKED means a second app instance running recovery at the same
   * moment simply gets no row and moves on, instead of blocking behind us or
   * duplicating the work. `::text` keeps this working whether the column is
   * declared as a Postgres enum or as varchar.
   *
   * Because this gate runs FIRST, an order that is already FULFILLED (which
   * includes every POS sale) never reaches gate 2 -- so gate 2 can only ever
   * block NEW consumption, and can never strand an in-store sale.
   *
   * 2. PAYMENT AUTHORIZATION (finding 1; the predicate is documented in full on
   *    the class). Evaluated with the order row already locked, so a receipt
   *    cannot settle between the two gates and be missed, and phase 1 cannot be
   *    half-applied underneath us.
   *
   * Returning a decision object rather than a boolean is what keeps "nothing to
   * do" and "refused" apart: the first is an ordinary no-op, the second is an
   * order that is PAID and UNFULFILLED and must be visible.
   */
  private async claim(
    manager: EntityManager,
    orderId: number,
  ): Promise<{ claimed: boolean; blocked: FulfilmentBlockedReason | null }> {
    const rows: Array<{ id: number }> = await manager.query(
      `SELECT id
         FROM orders
        WHERE id = $1
          AND status::text = $2
          AND "fulfillmentState"::text = ANY($3::text[])
          FOR UPDATE SKIP LOCKED`,
      [
        orderId,
        OrderStatusEnum.PAID,
        [FulfillmentStateEnum.PENDING, FulfillmentStateEnum.AWAITING_STOCK],
      ],
    );
    if (rows.length === 0) return { claimed: false, blocked: null };

    const authorization = await this.readAuthorization(manager, orderId);
    if (authorization === null) {
      // NOTHING financial happens here and no payment row is touched. The order
      // is left exactly as it is, which is what keeps it in the recovery
      // worker's retry set so it self-heals when a valid receipt settles it.
      const diagnostics = await this.readAuthorizationDiagnostics(
        manager,
        orderId,
      );
      this.logger.error(
        `order ${orderId} is PAID and NOT fulfilled, and NO payment row carries ` +
          `POSITIVE AMOUNT EVIDENCE for it. A receipt authorizes consuming stock only ` +
          `when it is 'success', the gateway reported a usable amount, that amount ` +
          `equals the amount we requested, that amount equals orders.total_price, and ` +
          `no amount-verification reason is left unresolved. Per receipt: ` +
          `${diagnostics.join(' | ')}. FULFILMENT REFUSED -- no stock consumed, no ` +
          `movement written, the order left in its recorded state so a valid receipt ` +
          `can still settle it. Every payment row is untouched (a confirmation is never ` +
          `rewritten) and NO refund, credit or reversal has been issued (owner decisions ` +
          `D-2 / D-3 are open). Reconcile it: ` +
          `SELECT id, status, amount::text, gateway_amount::text, gateway_amount_raw, ` +
          `reconciliation_reason, reconciled_at FROM payment WHERE "orderId" = ${orderId};`,
      );
      await this.recordBlocked(manager, orderId);
      return {
        claimed: false,
        blocked: FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
      };
    }

    return { claimed: true, blocked: null };
  }

  /**
   * "Does at least one payment authorize consuming stock for this order?"
   *
   *   SELECT id, ...
   *     FROM payment
   *    WHERE "orderId" = $1
   *      AND status::text = 'success'
   *      AND (reconciliation_reason IS NULL
   *           OR NOT (reconciliation_reason = ANY($2::text[])))
   *    ORDER BY (gateway_amount IS NOT NULL) DESC, id ASC
   *    LIMIT 1
   *
   * `LIMIT 1` over the whole order's payments is the EXISTS semantics the fix
   * requires: a discrepant receipt does not disqualify an order that also has a
   * valid settling one. `uq_payment_one_success_per_order` (a partial unique
   * index on `("orderId") WHERE status = 'success'`) makes this an index lookup
   * and normally caps it at one row anyway; the ORDER BY prefers a receipt that
   * HAS amount evidence so the no-evidence warning only fires when there is
   * genuinely nothing better, which also keeps the answer deterministic on a
   * legacy database whose index was built after the data.
   *
   * `$2` is `AMOUNT_RECONCILIATION_REASONS`, the same list
   * `isAmountReconciliationReason` uses, so the SQL and the TypeScript cannot
   * drift. `::text` on `status` keeps this working whether the column is a
   * Postgres enum or varchar, exactly like the claim above.
   *
   * READ-ONLY. It never writes to `payment`.
   */
  /**
   * ==========================================================================
   * POSITIVE AMOUNT EVIDENCE -- the authorization predicate
   * ==========================================================================
   *
   * WHAT THIS REPLACED, AND WHY IT WAS WRONG.
   *
   * The first version of this check was LABEL-BASED: it authorized any
   * `success` receipt whose `reconciliation_reason` was not one of the three
   * amount reasons.
   *
   *     AND (reconciliation_reason IS NULL
   *          OR NOT (reconciliation_reason = ANY(amount_reasons)))
   *
   * That asked "has anyone written a complaint about this receipt?", not "is
   * this receipt for the right money?" -- and the absence of a complaint is not
   * proof of payment. An independent reviewer walked straight through it twice:
   *
   *   amount=1000000, gateway_amount=NULL,   reason=NULL
   *       -> authorized. No amount was ever recorded, so nothing contradicted
   *          the label. Stock was decremented against no evidence at all. The
   *          old code called this "trusting legacy rows" and logged a warning;
   *          it was never an approved policy and it is gone.
   *
   *   amount=1000000, gateway_amount=500000, reason=late_confirmation_applied
   *       -> authorized. `late_confirmation_applied` is documented as
   *          informational and is not in the amount list, so the label passed
   *          -- while the two amounts sitting in the same row differed by half.
   *          The check never looked at them.
   *
   * The predicate now requires EVIDENCE, and every clause is a fact about
   * money rather than about a label:
   *
   *   1. `status = 'success'`                      -- the receipt settled.
   *   2. `gateway_amount IS NOT NULL`              -- the gateway told us a sum.
   *   3. `gateway_amount >= 0`                     -- and it is a usable one.
   *   4. `gateway_amount = amount`                 -- it is the sum we asked for.
   *   5. `amount = orders.total_price`             -- which is the sum the order
   *                                                   is actually for.
   *   6. no UNRESOLVED amount reason on that row   -- nothing outstanding.
   *
   * Clause 5 is new and is the one that makes the chain complete: without it a
   * receipt could agree with itself while agreeing with nothing the customer
   * ordered.
   *
   * MONEY IS COMPARED IN POSTGRESQL, NEVER IN JAVASCRIPT. `amount`,
   * `gateway_amount` and `orders.total_price` are all `bigint`; `=` between
   * them is an exact integer comparison. Reading them into JS `Number` would
   * silently round anything past 2^53 -- and integer Rial reaches that range
   * for perfectly ordinary sums (2^53 Rial is about 900 billion Toman). Nothing
   * in this file converts a monetary column to `Number`: the only value that
   * crosses into JS is `payment.id`, and the diagnostics below carry every
   * amount as TEXT.
   *
   * Integrality needs no check -- `bigint` cannot hold a fraction. `>= 0` is
   * defence in depth: `verifyGatewayAmount` already stores an unusable figure
   * as NULL with the verbatim text in `gateway_amount_raw`.
   *
   * "UNRESOLVED" means the row still carries an amount reason and no operator
   * has closed it (`reconciled_at IS NULL`). A closed one is allowed through
   * because clauses 2-5 have to hold anyway, so the money is proven
   * independently of the label -- a resolved label cannot rescue a receipt
   * whose figures disagree, and it should not condemn one whose figures agree.
   *
   * It stays an EXISTS (`LIMIT 1` over the order's receipts), so a genuinely
   * valid receipt authorizes fulfilment even when a discrepant receipt sits
   * beside it.
   */
  private async readAuthorization(
    manager: EntityManager,
    orderId: number,
  ): Promise<FulfilmentAuthorization | null> {
    const rows: Array<{ id: number }> = await manager.query(
      `SELECT p.id
         FROM payment p
         JOIN orders o ON o.id = p."orderId"
        WHERE p."orderId" = $1
          AND p.status::text = $2
          AND p.gateway_amount IS NOT NULL
          AND p.gateway_amount >= 0
          AND p.gateway_amount = p.amount
          AND p.amount = o.total_price
          AND (p.reconciliation_reason IS NULL
               OR NOT (p.reconciliation_reason = ANY($3::text[]))
               OR p.reconciled_at IS NOT NULL)
        ORDER BY p.id ASC
        LIMIT 1`,
      [orderId, PaymentStatusEnum.SUCCESS, [...AMOUNT_RECONCILIATION_REASONS]],
    );
    const row = rows[0];
    return row ? { paymentId: Number(row.id) } : null;
  }

  /**
   * Why every receipt on a blocked order failed, for the operator log.
   *
   * Each clause is evaluated in SQL and returned as a boolean, and every
   * monetary column is cast to TEXT. That is deliberate: this runs only on the
   * blocked path, where the numbers are by definition suspect, and it must not
   * be the place a `bigint` gets rounded through a JS `Number` on its way into
   * a log line an operator will act on.
   */
  async readAuthorizationClauses(
    manager: EntityManager,
    orderId: number,
  ): Promise<FulfilmentAuthorizationClauses[]> {
    const rows: FulfilmentAuthorizationClauses[] = await manager.query(
      `SELECT p.id,
              p.status::text                        AS status,
              p.amount::text                        AS amount,
              p.gateway_amount::text                AS gateway_amount,
              o.total_price::text                   AS order_total,
              p.reconciliation_reason               AS reconciliation_reason,
              (p.status::text = $2)                 AS is_success,
              (p.gateway_amount IS NOT NULL
                 AND p.gateway_amount >= 0)         AS has_gateway_amount,
              (p.gateway_amount IS NOT NULL
                 AND p.gateway_amount = p.amount)   AS gateway_matches_amount,
              (p.amount = o.total_price)            AS amount_matches_order,
              (p.reconciliation_reason IS NULL
                 OR NOT (p.reconciliation_reason = ANY($3::text[]))
                 OR p.reconciled_at IS NOT NULL)    AS reason_resolved
         FROM payment p
         JOIN orders o ON o.id = p."orderId"
        WHERE p."orderId" = $1
        ORDER BY p.id ASC`,
      [orderId, PaymentStatusEnum.SUCCESS, [...AMOUNT_RECONCILIATION_REASONS]],
    );

    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
    }));
  }

  /**
   * The same diagnosis, rendered as one line per receipt for the operator log.
   * Formatting only — every fact comes from `readAuthorizationClauses` above,
   * so the log and the admin API cannot disagree about why a receipt failed.
   */
  private async readAuthorizationDiagnostics(
    manager: EntityManager,
    orderId: number,
  ): Promise<string[]> {
    const rows = await this.readAuthorizationClauses(manager, orderId);

    if (rows.length === 0) return ['no payment row exists for this order'];

    return rows.map((row) => {
      const failed: string[] = [];
      if (!row.is_success) failed.push(`status=${row.status} (not success)`);
      if (!row.has_gateway_amount) {
        failed.push(
          `no usable gateway amount (gateway_amount=${row.gateway_amount ?? 'NULL'})`,
        );
      } else if (!row.gateway_matches_amount) {
        failed.push(
          `gateway amount ${row.gateway_amount} <> requested amount ${row.amount}`,
        );
      }
      if (!row.amount_matches_order) {
        failed.push(
          `receipt amount ${row.amount} <> order total ${row.order_total}`,
        );
      }
      if (!row.reason_resolved) {
        failed.push(
          `unresolved amount reason ${String(row.reconciliation_reason)}`,
        );
      }
      return `payment ${row.id}: ${failed.length === 0 ? 'qualifies' : failed.join('; ')}`;
    });
  }

  /**
   * Records the refusal on the order, for the operator reading the order row.
   *
   * It ALSO opens the reconciliation case (migration 0018) — this refusal IS
   * the system acknowledging that a human must decide, which is exactly what
   * `OrderReconciliationState.OPEN` means, and it is what makes the customer's
   * derived `reviewState` say "payment received, this order requires review"
   * instead of nothing.
   *
   * `WHERE "reconciliationState" IS NULL` is what keeps this from being a
   * decision. Once an operator has moved the case to `refund_required`,
   * `backordered` or a terminal state, a later blocked pass must not drag it
   * back to `open` and quietly erase their decision. A repeat refusal on an
   * untouched case is a no-op beyond refreshing the error text.
   *
   * Nothing financial happens here and no `payment` row is touched.
   */
  private async recordBlocked(
    manager: EntityManager,
    orderId: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE orders
          SET "fulfillmentLastError" = $2,
              "reconciliationState" = COALESCE("reconciliationState", $3)
        WHERE id = $1`,
      [orderId, RECONCILIATION_REQUIRED_ERROR, OrderReconciliationState.OPEN],
    );
  }

  /**
   * Guarded conditional state change. The WHERE clause repeats the claim
   * predicate so a concurrent writer cannot have moved the order underneath us.
   *
   * `"fulfillmentLastError"` is cleared on the way to FULFILLED, and only then:
   * once the goods have moved, the recorded reason they had not moved is stale,
   * and leaving it behind would show an operator a "reconciliation required"
   * order that has in fact self-healed. It is left untouched on the way to
   * AWAITING_STOCK, where the recorded reason is still the current one.
   */
  private async transitionTo(
    manager: EntityManager,
    orderId: number,
    next: FulfillmentStateEnum,
    assertApplied = true,
  ): Promise<void> {
    const clearLastError = next === FulfillmentStateEnum.FULFILLED;
    const raw: unknown = await manager.query(
      `UPDATE orders
          SET "fulfillmentState" = $2${
            clearLastError ? ', "fulfillmentLastError" = NULL' : ''
          }
        WHERE id = $1
          AND status::text = $3
          AND "fulfillmentState"::text = ANY($4::text[])`,
      [
        orderId,
        next,
        OrderStatusEnum.PAID,
        [FulfillmentStateEnum.PENDING, FulfillmentStateEnum.AWAITING_STOCK],
      ],
    );
    const affected =
      Array.isArray(raw) && raw.length === 2 ? Number(raw[1]) : 0;
    if (assertApplied && affected !== 1) {
      throw new Error(
        `fulfilment state transition to ${next} for order ${orderId} affected ${affected} rows`,
      );
    }
  }

  async readState(
    manager: EntityManager,
    orderId: number,
  ): Promise<FulfillmentStateEnum> {
    const rows: Array<{ fulfillmentState: string | null }> =
      await manager.query(
        `SELECT "fulfillmentState" FROM orders WHERE id = $1`,
        [orderId],
      );
    return (rows[0]?.fulfillmentState ??
      FulfillmentStateEnum.NOT_REQUIRED) as FulfillmentStateEnum;
  }

  /** Convenience wrapper for callers that are not already in a transaction. */
  async currentState(orderId: number): Promise<FulfillmentStateEnum> {
    return this.readState(this.dataSource.manager, orderId);
  }
}
