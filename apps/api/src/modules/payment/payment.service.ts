import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { PaymentMessages } from 'src/common/constants/payment.messages';
import { FulfillmentStateEnum } from '../orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import UserRoleEnum from '../user/enums/user-role.enum';
import { verifyGatewayAmount } from './amount-verification';
import {
  isAmountReconciliationReason,
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from './enums/payment-status-enum';
import {
  FulfilmentBlockedReason,
  FulfilmentOutcome,
  FulfilmentService,
} from './fulfilment.service';
import {
  GatewayVerifyResult,
  PAYMENT_GATEWAY,
  PaymentGateway,
  ZIBAL_RESULT,
} from './gateways/payment-gateway.interface';
import { PaymentConfig } from './payment.config';
import { ProvisionalPaymentPolicy } from './provisional-policy';

const PG_UNIQUE_VIOLATION = '23505';
const ONE_SUCCESS_PER_ORDER = 'uq_payment_one_success_per_order';

/**
 * The two states a confirmation may legally be applied FROM.
 *
 * `failed` is included on purpose: `Start()` writes abandoned attempts off, and
 * the gateway can confirm one afterwards. That money is real and must be
 * recorded whatever we had assumed about it.
 */
const APPLICABLE_STATUSES: readonly PaymentStatusEnum[] = [
  PaymentStatusEnum.PENDING,
  PaymentStatusEnum.FAILED,
];

export interface StartPaymentResult {
  paymentId: number;
  orderId: number;
  trackId: string;
  amount: number;
  paymentUrl: string;
  /** True when an existing unfinished attempt was handed back instead of a new one. */
  reused: boolean;
}

export interface VerifyPaymentResult {
  /** The gateway confirmed the receipt. Says nothing about the order. */
  success: boolean;
  /** This CALL did not do the settling work (a replay, or another attempt won). */
  alreadyProcessed: boolean;
  /**
   * Whether this receipt is the one that SETTLED its order. False means the
   * money is recorded as `confirmed_unapplied` and is waiting for a human.
   */
  applied: boolean;
  /** The honest, persisted state of this receipt. Never `pending` after a confirmation. */
  paymentStatus: PaymentStatusEnum;
  requiresReconciliation: boolean;
  reconciliationReason: PaymentReconciliationReason | null;
  trackId: string;
  orderId: number;
  /** The order's ACTUAL status -- not an assumption that it must be PAID. */
  orderStatus: OrderStatusEnum;
  fulfillmentState: FulfillmentStateEnum;
  /**
   * INTEGER RIAL we asked the gateway for (`payment.amount`). Never overwritten
   * by the gateway's figure, whatever the gateway says.
   */
  expectedAmount: number;
  /**
   * INTEGER RIAL the GATEWAY reported, or `null` when it reported none or
   * reported something unusable. Reported alongside `expectedAmount` so a
   * caller can see the discrepancy that stopped the order being confirmed,
   * instead of having to infer it from `reconciliationReason`.
   */
  gatewayAmount: number | null;
  /**
   * FINDING 1. Non-null when phase 2 REFUSED to consume stock for this order
   * because no payment row authorizes it. The order is PAID and NOT fulfilled.
   *
   * When this is set, `fulfillmentState` is the order's real, unchanged state
   * (`pending` / `awaiting_stock`) and `message` is the reconciliation message
   * -- never "your order is being prepared" and never "verified". `applied` may
   * still be `true`, because for the legacy population it IS true: that receipt
   * did settle the order, historically. What is false is any suggestion that
   * fulfilment is under way.
   */
  fulfilmentBlocked: FulfilmentBlockedReason | null;
  message: string;
  updatedVariants: Array<{ variantId: number; newStock: number }>;
}

/**
 * WHO is asking to verify a payment attempt.
 *
 * Both fields come from the ACCESS TOKEN by way of `JwtStrategy` (`req.user`),
 * and `roles` is loaded from the database on every request, not read out of the
 * token body. NOTHING here may ever be populated from a request body: a
 * `userId` a caller can type is not an identity.
 */
export interface VerifyCaller {
  /** `req.user.sub`. */
  userId: number;
  /** `req.user.roles`, straight from `JwtStrategy`. */
  roles: UserRoleEnum[];
}

/** What phase 1 decided about one confirmed receipt. */
interface Phase1Result {
  /** This receipt settled the order (now, or in an earlier committed call). */
  applied: boolean;
  /** This call did not do the settling work. */
  alreadyProcessed: boolean;
  status: PaymentStatusEnum;
  requiresReconciliation: boolean;
  reason: PaymentReconciliationReason | null;
  /** `payment.amount` -- what WE asked for. */
  expectedAmount: number;
  /** `payment.gateway_amount` -- what the GATEWAY reported, if usable. */
  gatewayAmount: number | null;
}

/**
 * Raw `orders` projection. `status` is selected as `status::text`, whose values
 * are exactly the OrderStatusEnum members, so it is typed as the enum rather
 * than as `string` -- otherwise every comparison below is an unchecked
 * string-vs-enum test that a renamed member would silently break.
 */
interface OrderRow {
  id: number;
  userId: number | null;
  status: OrderStatusEnum;
  total_price: string | number;
}

interface PaymentRow {
  id: number;
  status: PaymentStatusEnum;
  amount: string | number;
  /** `bigint`, so node-postgres hands it back as a string. */
  gateway_amount: string | number | null;
  requires_reconciliation: boolean;
  reconciliation_reason: PaymentReconciliationReason | null;
}

/** `bigint`/`null` out of the database to `number`/`null` in memory. */
function rial(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * ============================================================================
 * PAYMENT  --  two committed phases (docs/ARCHITECTURE.md section 2)
 * ============================================================================
 *
 * PHASE 1 (transaction A, here):  the MONEY FACTS.  COMMIT.
 * PHASE 2 (transaction B, FulfilmentService): consume allocations, decrement
 *                                 stock, fulfillmentState=FULFILLED -- or
 *                                 AWAITING_STOCK when the stock is not there.
 *
 * A CONFIRMED PAYMENT IS NEVER ROLLED BACK. The original implementation
 * deducted stock in the same transaction that recorded the payment, so a stock
 * shortfall rolled back a payment the gateway had already taken money for.
 *
 * THREE CONCERNS, KEPT SEPARATE (FINDING E)
 * -----------------------------------------
 * The previous version of THIS file fused them, and the fusion was the defect:
 * when the gateway confirmed a second payment for an order another attempt had
 * already paid (or when `uq_payment_one_success_per_order` raised 23505), it
 * returned `{alreadyProcessed:true}` and LEFT THE ROW `pending`. Money the
 * gateway had confirmed was recorded as "not paid yet" -- the books denied
 * receiving money the business had actually received -- and `Start()` would
 * later sweep that same row to `failed`, destroying the record entirely.
 *
 *  1. GATEWAY CONFIRMATION -- an objective external fact. EVERY verified
 *     receipt is persisted with an explicit state and a `paid_at` from the
 *     DATABASE clock: `success` if it settled its order, `confirmed_unapplied`
 *     if it did not. Never `pending`.
 *
 *  2. RECONCILIATION -- a separate, queryable state
 *     (`requires_reconciliation`, `reconciliation_reason`, `ref_number`,
 *     `gateway_amount`) with the exact operator query documented on the Payment
 *     entity. NO AUTOMATIC FINANCIAL ACTION: no refunds, ever, from this code.
 *
 *  3. EXACTLY-ONCE FULFILMENT -- enforced at the ORDER/FULFILMENT layer by
 *     FulfilmentService (`FOR UPDATE SKIP LOCKED` claim + guarded conditional
 *     UPDATE), not by hiding a receipt.
 *
 * ============================================================================
 * FINDING 2 -- AN AMOUNT-DISCREPANT RECEIPT MUST NOT AUTHORIZE FULFILMENT
 * ============================================================================
 * `runPhase1` used to compute
 *
 *     const amountMismatch =
 *       gatewayAmount !== null && gatewayAmount !== Number(payment.amount);
 *
 * and then LEAVE IT OUT of the settle decision:
 *
 *     const settles = orderPayable && (!wasWrittenOff || lateConfirmationApplies);
 *
 * so a receipt for the wrong sum still became `success`, flipped the order to
 * PAID / `fulfillmentState = pending`, and phase 2 shipped the goods. The
 * discrepancy was recorded, but recording a problem is not refusing to act on
 * it: by the time an operator ran the reconciliation query the stock was gone.
 * That same expression also made a MISSING gateway amount evaluate to "no
 * mismatch" -- silence from the gateway was treated as proven equality.
 *
 * THE SETTLE DECISION IS NOW, IN FULL:
 *
 *     settles = orderPayable
 *            && (!wasWrittenOff || lateConfirmationApplies)
 *            && amount.verified            //  <-- added
 *
 * where `amount.verified` (amount-verification.ts) is true ONLY when the
 * gateway's figure is PRESENT, VALID (finite, non-negative, whole Rial) and
 * EQUAL to `payment.amount`. Every other outcome is recorded as
 * `confirmed_unapplied` with `paid_at` from the database clock,
 * `requires_reconciliation = true` and one of `amount_mismatch` /
 * `amount_missing` / `amount_invalid`, and settles NOTHING. The order stays
 * PENDING, its `fulfillmentState` is untouched and no stock moves.
 *
 * NOTHING IS ROLLED BACK OR ERASED to achieve that: the money fact is persisted
 * on every single path, and no refund, credit, reversal or adjustment is issued
 * anywhere -- not now, not behind a flag. `payment.amount` (ours) and
 * `payment.gateway_amount` / `gateway_amount_raw` (theirs) are both kept, so the
 * discrepancy is evidence rather than a guess.
 *
 * The rule is applied at EVERY confirmation path, because a rule enforced in
 * three places out of four is not enforced:
 *   - `runPhase1`'s settle branch;
 *   - `runPhase1`'s `uq_payment_one_success_per_order` (23505) loser branch;
 *   - `Verify()`'s terminal-state replay early-return (which never re-settles,
 *     and reports the PERSISTED facts);
 *   - `PaymentReverificationService`'s sweep, which reaches this code through
 *     `Verify()` and therefore inherits the rule with no second code path.
 *
 * BECAUSE THE ORDER IS LEFT PENDING, a SEPARATE, VALID receipt for the same
 * order can still settle it: the discrepant row is `confirmed_unapplied`, not
 * `success`, so the partial unique index `uq_payment_one_success_per_order`
 * does not stand in its way, and `Start()`'s abandoned-attempt sweep only ever
 * touches `pending` rows, so it can never write the discrepant receipt off as
 * `failed`.
 *
 * ============================================================================
 * FINDING 1 -- A LEGACY UNVERIFIED `success` RECEIPT MUST NOT AUTHORIZE *NEW*
 *              FULFILMENT
 * ============================================================================
 * Finding 2 above stopped a discrepant receipt BECOMING `success`. It did not,
 * and could not, do anything about the rows the pre-fix code had already
 * written -- `status = 'success'` WITH `reconciliation_reason = 'amount_mismatch'`
 * -- because a confirmation is never rewritten. Those orders are PAID, and some
 * of them are still `fulfillmentState = 'pending'`: paid, and NOT yet shipped.
 *
 * `Verify()`'s duplicate-callback replay below used to log that legacy mismatch
 * and then drive phase 2 anyway, reasoning that such an order was "probably
 * already shipped". `fulfillmentState = 'pending'` disproves that, and the
 * consequence was stock consumed and goods shipped against a receipt for half
 * the money.
 *
 * THE FIX IS NOT IN THIS FILE, ON PURPOSE. All three entry points -- this
 * callback, `FulfilmentRecoveryService`'s worker/endpoint, and the
 * re-verification sweep (which reaches stock through this same `Verify()`) --
 * consume stock through `FulfilmentService.drive()`. The authorization check
 * therefore lives inside `FulfilmentService.claim()`, in the same transaction
 * with the order row locked, so no caller can bypass it and a future caller
 * inherits it. The predicate, the legacy missing-amount-evidence decision and
 * the POS argument are all documented there.
 *
 * WHAT THIS FILE OWES THAT FIX: an honest answer. A blocked outcome sets
 * `VerifyPaymentResult.fulfilmentBlocked`, reports the order's REAL
 * `fulfillmentState`, and returns
 * `PaymentMessages.FULFILMENT_RECONCILIATION_REQUIRED` -- never
 * "being prepared", never "verified", and never "your payment failed". No
 * refund, credit or reversal is issued on this path either.
 *
 * OTHER DEFECTS FIXED HERE (verified against the installed TypeORM 1.1.0):
 *
 *  a. BROKEN VARIANT LOADING. `Verify()` loaded `relations: { order: { items:
 *     true } }`, which does NOT populate `items.variant`, then called
 *     `findOne({ where: { id: item.variant?.id } })` with `undefined`, which
 *     TypeORM throws on -- AFTER the gateway had confirmed the payment. Stock
 *     is now resolved by the inventory layer from `order_items."variantId"`.
 *  b. MONEY UNIT. `amount * 10` assumed Toman storage. Money is INTEGER RIAL
 *     and Zibal is Rial, so the multiplier is DELETED.
 *  c. HARDCODED CONFIG -> PaymentConfig.
 *  d. LIVE GATEWAY IN TESTS -> the `PaymentGateway` seam; tests bind the stub.
 *  e. UNBOUNDED PENDING PAYMENTS -> `Start()` deduplicates and caps attempts.
 *  f. DUPLICATE GATEWAY SESSIONS FROM CONCURRENT `Start()` -> in-flight
 *     reservation with a bounded wait (see `Start()`).
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly config: PaymentConfig,
    private readonly fulfilmentService: FulfilmentService,
    private readonly realtimeGateway: RealtimeGateway,
    /**
     * OPTIONAL ON PURPOSE, and absent means OFF.
     *
     * PaymentModule always provides it, so production always has it. Making it
     * optional means a caller that constructs this service by hand (the
     * integration harness other workstreams share) cannot accidentally acquire
     * an owner-unapproved policy just by existing -- and the fallback is the
     * conservative branch: a late confirmation is recorded as
     * `confirmed_unapplied` and flagged, never applied to an order.
     */
    @Optional()
    private readonly provisionalPolicy?: ProvisionalPaymentPolicy,
  ) {}

  // ==========================================================================
  // Start
  // ==========================================================================

  /**
   * Opens (or re-uses, or waits for) a gateway session for an order.
   *
   * The original implementation inserted a brand-new `payment` row on every
   * call, so a customer tapping "pay" five times left five pending payments
   * behind. An unfinished attempt for the same order and amount inside the
   * reuse window is handed back instead, stale attempts are failed off, and a
   * hard cap stops the table growing without bound.
   *
   * CONCURRENT STARTS (FINDING E). The gateway call happens OUTSIDE the
   * transaction -- holding a pooled connection across a network round trip is
   * how connection pools die -- so there is a window in which a committed
   * `pending` row has no `track_id` yet. The old reuse branch required
   * `track_id IS NOT NULL`, so a second concurrent caller skipped it and opened
   * a SECOND gateway session: two live sessions for one order, i.e. two ways to
   * charge the customer twice. Now that row is a RESERVATION: the second caller
   * (which is serialised behind the same `FOR UPDATE` on the order row) waits a
   * BOUNDED time for the `track_id` to land and re-uses it. If the in-flight
   * attempt fails outright, the waiter retries once; if it never lands, the
   * caller gets a clear error instead of a duplicate session.
   */
  async Start(orderId: number, userId: number): Promise<StartPaymentResult> {
    return this.startAttempt(orderId, userId, 0);
  }

  private async startAttempt(
    orderId: number,
    userId: number,
    retry: number,
  ): Promise<StartPaymentResult> {
    const prepared = await this.dataSource.transaction(async (manager) => {
      // FOR UPDATE serialises concurrent Start() calls for the same order. It
      // is also what makes the in-flight reservation below race-free: a second
      // caller cannot even look until the first has committed its INSERT.
      const orders: OrderRow[] = await manager.query(
        `SELECT id, "userId", status::text AS status, total_price
           FROM orders
          WHERE id = $1
            FOR UPDATE`,
        [orderId],
      );
      const order = orders[0];
      if (!order) throw new NotFoundException(PaymentMessages.ORDER_NOT_FOUND);
      if (Number(order.userId) !== Number(userId)) {
        throw new BadRequestException(PaymentMessages.ONLY_ORDER_OWNER_CAN_PAY);
      }
      if (order.status !== OrderStatusEnum.PENDING) {
        throw new BadRequestException(PaymentMessages.ORDER_NOT_PAYABLE);
      }

      // INTEGER RIAL. No conversion -- Zibal is Rial too.
      const amount = Number(order.total_price);

      // Expire attempts the customer clearly abandoned.
      //
      // The cutoff is computed IN SQL, not from `Date.now()`. `payment.created_at`
      // is `timestamp` WITHOUT time zone, and node-postgres serialises a JS Date
      // using the CLIENT's local offset; Postgres then drops that offset when
      // coercing to `timestamp`. On an Asia/Tehran box that shifts the comparison
      // by 3.5 hours and every fresh attempt looks abandoned. Using the database
      // clock on both sides of the comparison removes the whole class of bug.
      //
      // Only `pending` rows are swept. `confirmed_unapplied` is a confirmed
      // receipt and must never be touched by a sweeper again.
      //
      // That scoping matters more since finding 2: an AMOUNT-DISCREPANT receipt
      // leaves its order PENDING, so the customer can and does retry, and THIS
      // statement then runs on an order that already holds a real receipt. The
      // `status = $2` (`pending`) predicate is what stops it writing that
      // receipt off as `failed` -- which is exactly why a confirmed receipt is
      // never left `pending` in the first place.
      await manager.query(
        `UPDATE payment
            SET status = $3, updated_at = now()
          WHERE "orderId" = $1
            AND status = $2
            AND created_at < now() - ($4 * interval '1 millisecond')`,
        [
          orderId,
          PaymentStatusEnum.PENDING,
          PaymentStatusEnum.FAILED,
          this.config.pendingReuseWindowMs,
        ],
      );

      const reusable: Array<{ id: number; track_id: string }> =
        await manager.query(
          `SELECT id, track_id
             FROM payment
            WHERE "orderId" = $1
              AND status = $2
              AND amount = $3
              AND track_id IS NOT NULL
            ORDER BY id DESC
            LIMIT 1`,
          [orderId, PaymentStatusEnum.PENDING, amount],
        );
      if (reusable.length > 0) {
        return {
          kind: 'reuse' as const,
          paymentId: Number(reusable[0].id),
          trackId: reusable[0].track_id,
          amount,
        };
      }

      // A reservation from a concurrent Start() whose gateway request has not
      // come back yet. Younger than the in-flight window => somebody is really
      // waiting on the gateway right now; older => that process died and the
      // row is debris the sweep above will eventually fail off.
      const inFlight: Array<{ id: number }> = await manager.query(
        `SELECT id
           FROM payment
          WHERE "orderId" = $1
            AND status = $2
            AND amount = $3
            AND track_id IS NULL
            AND created_at > now() - ($4 * interval '1 millisecond')
          ORDER BY id DESC
          LIMIT 1`,
        [
          orderId,
          PaymentStatusEnum.PENDING,
          amount,
          this.config.gatewayInFlightWindowMs,
        ],
      );
      if (inFlight.length > 0) {
        return {
          kind: 'wait' as const,
          paymentId: Number(inFlight[0].id),
          amount,
        };
      }

      const pending: Array<{ count: string }> = await manager.query(
        `SELECT COUNT(*) AS count
           FROM payment
          WHERE "orderId" = $1 AND status = $2`,
        [orderId, PaymentStatusEnum.PENDING],
      );
      if (Number(pending[0]?.count ?? 0) >= this.config.maxPendingPerOrder) {
        throw new BadRequestException(
          PaymentMessages.TOO_MANY_PENDING_PAYMENTS,
        );
      }

      const inserted: Array<{ id: number }> = await manager.query(
        `INSERT INTO payment ("orderId", amount, status, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         RETURNING id`,
        [orderId, amount, PaymentStatusEnum.PENDING],
      );
      return {
        kind: 'create' as const,
        paymentId: Number(inserted[0].id),
        amount,
      };
    });

    if (prepared.kind === 'reuse') {
      return {
        paymentId: prepared.paymentId,
        orderId,
        trackId: prepared.trackId,
        amount: prepared.amount,
        paymentUrl: this.gateway.paymentUrl(prepared.trackId),
        reused: true,
      };
    }

    if (prepared.kind === 'wait') {
      const landed = await this.awaitInFlightTrackId(prepared.paymentId);
      if (landed.trackId !== null) {
        return {
          paymentId: prepared.paymentId,
          orderId,
          trackId: landed.trackId,
          amount: prepared.amount,
          paymentUrl: this.gateway.paymentUrl(landed.trackId),
          reused: true,
        };
      }
      // The in-flight attempt failed outright (the gateway refused it). One
      // retry, and only one: a caller must never be able to spin here.
      if (landed.abandoned && retry < 1) {
        return this.startAttempt(orderId, userId, retry + 1);
      }
      this.logger.warn(
        `order ${orderId}: gave up waiting for in-flight payment ${prepared.paymentId}; ` +
          `refusing to open a second gateway session`,
      );
      throw new BadRequestException(PaymentMessages.PAYMENT_START_IN_FLIGHT);
    }

    // The gateway call is deliberately OUTSIDE the transaction: holding a
    // database connection open across a network round trip is how connection
    // pools die. The committed `pending` row above is the reservation that
    // stops a concurrent caller from opening a second session meanwhile.
    let trackId: string;
    try {
      const requested = await this.gateway.request({
        amount: prepared.amount,
        orderId,
        callbackUrl: this.config.callbackUrl,
      });
      trackId = requested.trackId;
    } catch (error) {
      // The customer never received a payment URL, so they cannot have paid
      // this attempt: failing it off is honest, and there is no receipt to
      // reconcile.
      await this.dataSource.query(
        `UPDATE payment SET status = $2, updated_at = now()
          WHERE id = $1 AND status = $3`,
        [
          prepared.paymentId,
          PaymentStatusEnum.FAILED,
          PaymentStatusEnum.PENDING,
        ],
      );
      this.logger.error(
        `gateway request failed for order ${orderId}: ${(error as Error).message}`,
      );
      throw new BadRequestException(PaymentMessages.GATEWAY_UNAVAILABLE);
    }

    await this.dataSource.query(
      `UPDATE payment SET track_id = $2, updated_at = now()
        WHERE id = $1 AND status = $3`,
      [prepared.paymentId, trackId, PaymentStatusEnum.PENDING],
    );

    return {
      paymentId: prepared.paymentId,
      orderId,
      trackId,
      amount: prepared.amount,
      paymentUrl: this.gateway.paymentUrl(trackId),
      reused: false,
    };
  }

  /**
   * Bounded wait for a concurrent Start()'s gateway session to land.
   *
   * Polling a single indexed row is deliberate: `LISTEN/NOTIFY` would need a
   * dedicated connection per waiter, and holding a row lock across the other
   * caller's network round trip is exactly what this module refuses to do.
   */
  private async awaitInFlightTrackId(
    paymentId: number,
  ): Promise<{ trackId: string | null; abandoned: boolean }> {
    const deadline = Date.now() + this.config.startInFlightWaitMs;
    for (;;) {
      const rows: Array<{
        track_id: string | null;
        status: PaymentStatusEnum;
      }> = await this.dataSource.query(
        `SELECT track_id, status::text AS status FROM payment WHERE id = $1`,
        [paymentId],
      );
      const row = rows[0];
      if (!row) return { trackId: null, abandoned: true };
      if (row.track_id !== null)
        return { trackId: row.track_id, abandoned: false };
      if (row.status !== PaymentStatusEnum.PENDING) {
        return { trackId: null, abandoned: true };
      }
      if (Date.now() >= deadline) return { trackId: null, abandoned: false };
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.startInFlightPollMs),
      );
    }
  }

  // ==========================================================================
  // Verify
  // ==========================================================================

  /**
   * ==========================================================================
   * THE HTTP BOUNDARY for `POST /payment/verify`. Nothing else may call this.
   * ==========================================================================
   *
   * THE DEFECT
   * ----------
   * The controller was
   *
   *     const result = await this.paymentService.Verify(verifyPaymentDto.trackId);
   *
   * with no `@Roles` and no ownership check of any kind. `trackId` is a value
   * the caller supplies, so ANY authenticated customer could drive verification
   * of ANY other customer's payment attempt -- and get back that attempt's
   * order id, order status, fulfilment state, `expectedAmount` and
   * `gatewayAmount`. `Start()` has always refused to open a session for
   * somebody else's order; `Verify()` accepted one from anybody.
   *
   * THE POLICY
   * ----------
   *  - A customer may verify an attempt ONLY if the order behind it is theirs,
   *    i.e. `orders."userId" = req.user.sub`.
   *  - `super_admin` MAY verify any attempt, whoever owns it. That is explicit
   *    rather than incidental: support staff have to be able to re-drive a
   *    stuck callback for a customer who is on the phone, the sweep endpoints
   *    next to this one (`POST /payment/admin/reverify`) are already
   *    `super_admin`, and `Verify()` moves no money -- it re-asks the gateway
   *    and applies what the gateway already decided. `sale` gets NO such
   *    exemption: a till never handles an ecommerce callback.
   *  - An order with no customer at all (`orders."userId" IS NULL`, i.e. a POS
   *    sale) is owned by nobody, so no customer passes this check for it.
   *
   * WHY THE CHECK IS *HERE* AND NOT INSIDE `Verify()`
   * -------------------------------------------------
   * Two internal workers re-drive verification with no user in sight:
   * `PaymentReverificationService.sweep()` (the only path that can discover a
   * receipt the gateway confirmed but that was never recorded) and, indirectly,
   * `FulfilmentRecoveryService`. Pushing an ownership test into `Verify()`
   * would force those workers to impersonate a customer -- to invent an
   * identity in order to do work that has no identity. So `Verify()` stays
   * exactly as it was, this method wraps it, and the workers keep calling
   * `Verify()` directly.
   *
   * NON-ENUMERATING 404
   * -------------------
   * A refusal must not tell the caller whether the `trackId` they guessed
   * exists. An unknown trackId and a real trackId belonging to somebody else
   * therefore produce the IDENTICAL response: 404, the same message and the
   * same `error` code, from the one throw site below. This CHANGES THE PUBLIC
   * CONTRACT -- an unknown trackId used to be a 400 from `Verify()` -- and the
   * change is the point: a 400-for-unknown / 200-for-foreign pair is a
   * membership oracle over other people's payment attempts.
   *
   * The lookup is a single indexed read (`uq_payment_track_id`) that decides
   * nothing about money, and settlement is left entirely to `Verify()`.
   */
  async verifyForCaller(
    trackId: string,
    caller: VerifyCaller,
  ): Promise<VerifyPaymentResult> {
    const rows: Array<{ ownerUserId: number | string | null }> =
      await this.dataSource.query(
        `SELECT o."userId" AS "ownerUserId"
           FROM payment p
           JOIN orders o ON o.id = p."orderId"
          WHERE p.track_id = $1`,
        [trackId],
      );

    // `track_id` is uniquely indexed (`uq_payment_track_id`, partial on NOT
    // NULL), so this is at most one row -- the same row `Verify()` will act on.
    const found = rows[0];
    const ownerUserId =
      found === undefined || found.ownerUserId == null
        ? null
        : Number(found.ownerUserId);

    const callerOwnsIt =
      ownerUserId !== null && ownerUserId === Number(caller.userId);
    const callerIsSuperAdmin = caller.roles.includes(UserRoleEnum.superAdmin);

    // ONE throw site, so the "does not exist" and "is not yours" answers cannot
    // drift apart. `found === undefined` covers a trackId nobody ever issued
    // AND an attempt whose order has since been deleted.
    if (found === undefined || !(callerOwnsIt || callerIsSuperAdmin)) {
      throw new NotFoundException({
        message: PaymentMessages.PAYMENT_NOT_FOUND,
        error: 'PAYMENT_ATTEMPT_NOT_FOUND',
      });
    }

    return this.Verify(trackId);
  }

  async Verify(trackId: string): Promise<VerifyPaymentResult> {
    // `amount` and `gateway_amount` are selected so the terminal-state replays
    // below can report the PERSISTED money facts rather than re-deriving (or
    // worse, re-deciding) them. A replay must never re-open the amount
    // question: the answer is already committed on the row.
    const known: Array<{
      id: number;
      orderId: number;
      status: PaymentStatusEnum;
      amount: string | number;
      gateway_amount: string | number | null;
      requires_reconciliation: boolean;
      reconciliation_reason: PaymentReconciliationReason | null;
    }> = await this.dataSource.query(
      `SELECT id, "orderId", status::text AS status, amount, gateway_amount,
              requires_reconciliation, reconciliation_reason
           FROM payment
          WHERE track_id = $1`,
      [trackId],
    );
    if (known.length === 0) {
      throw new BadRequestException(PaymentMessages.PAYMENT_NOT_FOUND);
    }
    const attempt = known[0];
    const orderId = Number(attempt.orderId);
    const persistedAmounts = {
      expectedAmount: Number(attempt.amount),
      gatewayAmount: rial(attempt.gateway_amount),
    };

    // --- Idempotent replay -------------------------------------------------
    // A duplicate callback for an attempt whose outcome is already recorded
    // must not re-verify at the gateway and must not fulfil a second time.
    // Phase 2 is still re-driven for a settled payment because it is idempotent
    // and this is a free recovery point for an order stuck in
    // PENDING/AWAITING_STOCK.
    if (attempt.status === PaymentStatusEnum.SUCCESS) {
      // A `success` row written by the CURRENT code has a verified amount, so
      // re-driving phase 2 for it is safe by construction. A row written by the
      // OLD code may be `success` WITH an amount-verification reason, because
      // the old settle decision ignored the amount entirely.
      //
      // FINDING 1 -- THE CORRECTED REASONING. This branch used to argue that
      // such an order was "already PAID and (probably) already shipped", so
      // refusing phase 2 "would only strand it PENDING forever". The reviewer's
      // planted row set disproves the premise: `fulfillmentState = pending` on a
      // PAID order means the goods have NOT gone, and driving phase 2 here was
      // therefore not a harmless re-drive of finished work -- it CONSUMED THE
      // STOCK and shipped goods against a receipt for half the money.
      //
      // Phase 2 is still driven, because it is idempotent and this is a free
      // recovery point for a legitimately settled order stuck in
      // PENDING/AWAITING_STOCK. What changed is that `FulfilmentService.claim()`
      // now decides, in its own transaction with the order row locked, whether
      // any payment authorizes consuming stock. For this legacy population it
      // does not, so the outcome comes back BLOCKED, nothing moves, and the
      // order stays exactly where it is -- inside the recovery worker's retry
      // set, where a valid receipt can still settle it.
      //
      // The receipt is still left exactly as it is (a confirmation is never
      // rewritten) and still shouted about: it is precisely the population an
      // operator has to review.
      if (isAmountReconciliationReason(attempt.reconciliation_reason)) {
        this.logger.error(
          `payment ${attempt.id} (track ${trackId}) is status=success WITH ` +
            `reconciliation_reason=${String(attempt.reconciliation_reason)}. That ` +
            `combination can only have been written by the PRE-FIX settle decision, ` +
            `which ignored the gateway amount: order ${orderId} was settled by a ` +
            `receipt whose amount was never verified. It does NOT authorize consuming ` +
            `stock, so this duplicate callback will not fulfil the order. Left exactly ` +
            `as it is (a confirmation is never rewritten) and needs a human. No ` +
            `automatic financial action taken.`,
        );
      }
      const outcome = await this.drivePhase2(orderId);
      await this.publish(outcome, orderId, false);
      return this.result(trackId, orderId, outcome, {
        applied: true,
        alreadyProcessed: true,
        status: PaymentStatusEnum.SUCCESS,
        requiresReconciliation: attempt.requires_reconciliation,
        reason: attempt.reconciliation_reason,
        ...persistedAmounts,
      });
    }
    // A receipt already recorded as confirmed-but-not-applied (or already
    // refunded by a human) is TERMINAL for this service. Re-verifying it at the
    // gateway would achieve nothing, and it must never be resurrected into
    // `success` -- another attempt settled the order, the order was not
    // payable, or ITS AMOUNT DID NOT CHECK OUT. In the amount cases the order
    // is typically still PENDING, which is the whole point of the fix: a
    // duplicate callback must not be the thing that talks the system into
    // settling a receipt it already refused. Nothing below writes a row.
    if (
      attempt.status === PaymentStatusEnum.CONFIRMED_UNAPPLIED ||
      attempt.status === PaymentStatusEnum.REFUNDED
    ) {
      const state = await this.fulfilmentService.currentState(orderId);
      return this.result(
        trackId,
        orderId,
        { orderId, state, claimed: false, consumed: [], blocked: null },
        {
          applied: false,
          alreadyProcessed: true,
          status: attempt.status,
          requiresReconciliation: attempt.requires_reconciliation,
          reason: attempt.reconciliation_reason,
          ...persistedAmounts,
        },
      );
    }

    const verified = await this.gateway.verify({ trackId });
    const gatewayConfirmed =
      verified.result === ZIBAL_RESULT.SUCCESS ||
      verified.result === ZIBAL_RESULT.ALREADY_VERIFIED;
    if (!gatewayConfirmed) {
      // Not money: the gateway says this attempt was NOT paid. `failed` is the
      // honest state, and re-asserting it on an already-failed row is a no-op.
      //
      // `next_reverify_at` is deliberately NOT cleared here. "Not paid yet" is
      // not a permanent answer -- the customer may still complete the same
      // gateway session -- so the attempt stays on the bounded re-verification
      // schedule (capped attempts, capped age) rather than being written off
      // for good on the first negative answer.
      await this.dataSource.query(
        `UPDATE payment
            SET status = $2, updated_at = now()
          WHERE id = $1 AND status = ANY($3::text[]::payment_status_enum[])`,
        [
          Number(attempt.id),
          PaymentStatusEnum.FAILED,
          [...APPLICABLE_STATUSES],
        ],
      );
      throw new BadRequestException(PaymentMessages.PAYMENT_FAILED);
    }

    // --- PHASE 1 (transaction A) ------------------------------------------
    const phase1 = await this.runPhase1(trackId, orderId, verified);

    // --- PHASE 2 (transaction B) ------------------------------------------
    // Separate transaction. Whatever happens here, phase 1 stands. It is safe
    // to drive even for an unapplied receipt: the claim requires the order to
    // be PAID and recoverable, so an unpayable order simply is not claimed,
    // while an order paid by ANOTHER attempt gets a free recovery point.
    const outcome = await this.drivePhase2(orderId);

    await this.publish(
      outcome,
      orderId,
      phase1.applied && !phase1.alreadyProcessed,
    );
    return this.result(trackId, orderId, outcome, phase1);
  }

  /**
   * Runs phase 2 and REFUSES TO TURN ITS FAILURE INTO A FAILED PAYMENT.
   *
   * The customer's money has already moved and phase 1 is committed. Throwing
   * here would answer a successful payment with an error, which is both wrong
   * and useless -- the caller cannot un-take the money. Instead the order is
   * left in its recorded PENDING state, which `FulfilmentRecoveryService`
   * re-drives, and the customer is told their order is being prepared.
   */
  private async drivePhase2(orderId: number): Promise<FulfilmentOutcome> {
    try {
      return await this.fulfilmentService.drive(orderId);
    } catch (error) {
      this.logger.error(
        `phase 2 failed for order ${orderId}; left recoverable: ${
          (error as Error).message
        }`,
      );
      return {
        orderId,
        state: FulfillmentStateEnum.PENDING,
        claimed: false,
        consumed: [],
        // `blocked` is a DECISION phase 2 reached, and phase 2 did not reach
        // one here -- it threw. Claiming "reconciliation required" for a crash
        // would send an operator after a financial question that does not
        // exist. The order stays recoverable and the worker will get a real
        // answer on the next pass.
        blocked: null,
      };
    }
  }

  /**
   * PHASE 1. Records the MONEY FACTS and COMMITS. Nothing in here touches
   * stock, so nothing in here can fail because of stock.
   *
   * Every path through this method ends with the receipt persisted in an
   * explicit state. There is no path that leaves confirmed money `pending`.
   */
  private async runPhase1(
    trackId: string,
    orderId: number,
    verified: GatewayVerifyResult,
  ): Promise<Phase1Result> {
    const lateConfirmationApplies =
      this.provisionalPolicy?.lateConfirmationSettlesOrder === true;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const payments: PaymentRow[] = await manager.query(
          `SELECT id, status::text AS status, amount, gateway_amount,
                  requires_reconciliation, reconciliation_reason
             FROM payment
            WHERE track_id = $1
              FOR UPDATE`,
          [trackId],
        );
        const payment = payments[0];
        if (!payment) {
          throw new BadRequestException(PaymentMessages.PAYMENT_NOT_FOUND);
        }
        const expectedAmount = Number(payment.amount);
        // Another caller committed the outcome while we were verifying.
        if (payment.status === PaymentStatusEnum.SUCCESS) {
          return {
            applied: true,
            alreadyProcessed: true,
            status: payment.status,
            requiresReconciliation: payment.requires_reconciliation,
            reason: payment.reconciliation_reason,
            expectedAmount,
            gatewayAmount: rial(payment.gateway_amount),
          };
        }
        if (
          payment.status === PaymentStatusEnum.CONFIRMED_UNAPPLIED ||
          payment.status === PaymentStatusEnum.REFUNDED
        ) {
          return {
            applied: false,
            alreadyProcessed: true,
            status: payment.status,
            requiresReconciliation: payment.requires_reconciliation,
            reason: payment.reconciliation_reason,
            expectedAmount,
            gatewayAmount: rial(payment.gateway_amount),
          };
        }

        const orders: Array<{ id: number; status: OrderStatusEnum }> =
          await manager.query(
            `SELECT id, status::text AS status FROM orders WHERE id = $1 FOR UPDATE`,
            [orderId],
          );
        if (orders.length === 0) {
          throw new NotFoundException(PaymentMessages.ORDER_NOT_FOUND);
        }
        const orderStatus = orders[0].status;

        // THE AMOUNT CHECK IS PART OF THE SETTLE DECISION (FINDING 2).
        //
        // The gateway's own figure is kept beside ours rather than overwriting
        // it -- a discrepancy is evidence and overwriting would destroy it --
        // and, crucially, it now GATES settlement. The previous version
        // computed a mismatch flag, wrote it to `requires_reconciliation`, and
        // settled the order anyway; phase 2 then consumed stock and shipped
        // goods against a receipt for the wrong sum. It also treated a MISSING
        // gateway amount as equality. See amount-verification.ts.
        const amount = verifyGatewayAmount(payment.amount, verified.amount);

        // `failed` here means WE had already written the attempt off (Start()
        // expires abandoned attempts) and the gateway confirmed it afterwards.
        const wasWrittenOff = payment.status === PaymentStatusEnum.FAILED;
        const orderPayable = orderStatus === OrderStatusEnum.PENDING;
        // Applying a LATE confirmation to an order we had given up on is a
        // BUSINESS POLICY the owner has not approved. It lives behind
        // ProvisionalPaymentPolicy and is off by default and in production.
        //
        // `amount.verified` is a hard conjunct and is NOT behind any flag: an
        // unverified receipt settling an order is not a policy choice, it is a
        // defect.
        const settles =
          orderPayable &&
          (!wasWrittenOff || lateConfirmationApplies) &&
          amount.verified;

        if (!settles) {
          const siblingSuccess: Array<{ id: number }> = await manager.query(
            `SELECT id FROM payment
              WHERE "orderId" = $1 AND status = $2 AND id <> $3
              LIMIT 1`,
            [orderId, PaymentStatusEnum.SUCCESS, Number(payment.id)],
          );
          // Precedence (documented on PaymentReconciliationReason): the
          // AMOUNT-VERIFICATION facts win, then a duplicate, then an unpayable
          // order, then a late confirmation. Until the amount question is
          // answered an operator cannot decide what the receipt is worth, so
          // that is what they have to act on first -- a duplicate of a known
          // sum and a duplicate of an unknown sum are different problems.
          const reason =
            amount.reason ??
            (siblingSuccess.length > 0
              ? PaymentReconciliationReason.DUPLICATE_CONFIRMED
              : !orderPayable
                ? PaymentReconciliationReason.ORDER_NOT_PAYABLE
                : PaymentReconciliationReason.LATE_CONFIRMATION_UNAPPLIED);

          this.logger.warn(
            `payment ${payment.id} (track ${trackId}) was CONFIRMED by the gateway for ` +
              `order ${orderId} (order status ${orderStatus}) but did not settle it; ` +
              `recorded as ${PaymentStatusEnum.CONFIRMED_UNAPPLIED} / ${reason} ` +
              `(we asked for ${expectedAmount} Rial, the gateway reported ` +
              `${amount.gatewayAmount === null ? (amount.gatewayAmountRaw ?? 'nothing') : String(amount.gatewayAmount)}). ` +
              `The order is NOT settled and NOTHING is fulfilled. ` +
              `NO automatic financial action taken (owner decisions D-2 / D-3).`,
          );
          await this.recordUnapplied(manager, {
            paymentId: Number(payment.id),
            reason,
            gatewayAmount: amount.gatewayAmount,
            gatewayAmountRaw: amount.gatewayAmountRaw,
            refNumber: verified.refNumber ?? null,
          });
          return {
            applied: false,
            alreadyProcessed: true,
            status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
            requiresReconciliation: true,
            reason,
            expectedAmount,
            gatewayAmount: amount.gatewayAmount,
          };
        }

        // ---- this receipt settles the order --------------------------------
        // `paid_at` is `timestamp` WITHOUT time zone on both tables, so the
        // instant comes from the DATABASE clock (`now()`), never from a JS Date
        // -- a Date is serialised with the client's UTC offset, which Postgres
        // then discards, storing a value hours away from every other timestamp
        // in the row. Both statements below run in the same transaction, so
        // `now()` is the same instant for the payment and the order.
        //
        // `settles` implies `amount.verified`, so `amount.reason` is null here
        // and this branch can no longer produce AMOUNT_MISMATCH. That is the
        // point of the fix: `success` now means the gateway's amount was
        // present, valid and equal, and there is no such thing as a settled
        // receipt with an open amount question.
        const reason = wasWrittenOff
          ? PaymentReconciliationReason.LATE_CONFIRMATION_APPLIED
          : null;
        if (wasWrittenOff) {
          this.logger.warn(
            `payment ${payment.id} (track ${trackId}) was confirmed AFTER being written ` +
              `off as failed and settled order ${orderId} under the PROVISIONAL, ` +
              `OWNER-UNAPPROVED late-payment policy`,
          );
        }
        this.assertOne(
          await manager.query(
            `UPDATE payment
                SET status = $2,
                    paid_at = now(),
                    updated_at = now(),
                    ref_number = $4,
                    gateway_amount = $5,
                    gateway_amount_raw = NULL,
                    requires_reconciliation = false,
                    reconciliation_reason = $6,
                    next_reverify_at = NULL
              WHERE id = $1
                AND status = ANY($3::text[]::payment_status_enum[])`,
            [
              Number(payment.id),
              PaymentStatusEnum.SUCCESS,
              [...APPLICABLE_STATUSES],
              verified.refNumber ?? null,
              // Verified equal to `payment.amount`, and stored anyway: an
              // operator reading one row must be able to see WHICH figure the
              // gateway confirmed, not infer it from the absence of a flag.
              amount.gatewayAmount,
              reason,
            ],
          ),
          'payment',
        );

        this.assertOne(
          await manager.query(
            `UPDATE orders
                SET status = $2,
                    paid_at = now(),
                    "fulfillmentState" = $3,
                    "fulfillmentAttempts" = 0,
                    "fulfillmentNextAttemptAt" = NULL,
                    "fulfillmentLastError" = NULL
              WHERE id = $1
                AND status::text = $4`,
            [
              orderId,
              OrderStatusEnum.PAID,
              FulfillmentStateEnum.PENDING,
              OrderStatusEnum.PENDING,
            ],
          ),
          'order',
        );

        return {
          applied: true,
          alreadyProcessed: false,
          status: PaymentStatusEnum.SUCCESS,
          // Unconditionally false: a receipt only reaches this branch with a
          // fully verified amount, so there is nothing outstanding on it. This
          // used to be `amountMismatch`, i.e. the service settled the order and
          // raised a flag about the very receipt it had just acted on.
          requiresReconciliation: false,
          reason,
          expectedAmount,
          gatewayAmount: amount.gatewayAmount,
        };
      });
    } catch (error) {
      // `uq_payment_one_success_per_order ON payment(orderId) WHERE
      // status='success'`. Two attempts raced to phase 1 and this one lost.
      // The winner's phase 1 is committed, so the order is already PAID.
      //
      // THE OLD CODE STOPPED HERE and left the loser `pending` -- i.e. it
      // recorded real money as "not paid". The receipt is now written in a NEW
      // transaction (the one above is aborted) as `confirmed_unapplied` and
      // flagged for reconciliation. Still NO automatic financial action.
      if (this.isOneSuccessPerOrderViolation(error)) {
        this.logger.warn(
          `duplicate CONFIRMED payment for order ${orderId} rejected by ` +
            `${ONE_SUCCESS_PER_ORDER}; recording it as ` +
            `${PaymentStatusEnum.CONFIRMED_UNAPPLIED} for reconciliation`,
        );
        // THE SAME AMOUNT RULE APPLIES ON THIS PATH. It is a second, separate
        // confirmation path -- the aborted transaction above never wrote
        // anything -- so the amount classification has to be redone here
        // against the row's own `amount`. A rule enforced on the happy path
        // only is not enforced.
        const recorded = await this.dataSource.transaction(async (manager) => {
          const rows: Array<{ id: number; amount: string | number }> =
            await manager.query(
              `SELECT id, amount FROM payment WHERE track_id = $1 FOR UPDATE`,
              [trackId],
            );
          if (rows.length === 0) return null;
          const amount = verifyGatewayAmount(rows[0].amount, verified.amount);
          // Amount facts beat DUPLICATE_CONFIRMED (precedence is documented on
          // PaymentReconciliationReason): an operator cannot decide what a
          // duplicate is worth before knowing its sum.
          const reason =
            amount.reason ?? PaymentReconciliationReason.DUPLICATE_CONFIRMED;
          await this.recordUnapplied(manager, {
            paymentId: Number(rows[0].id),
            reason,
            gatewayAmount: amount.gatewayAmount,
            gatewayAmountRaw: amount.gatewayAmountRaw,
            refNumber: verified.refNumber ?? null,
          });
          return {
            reason,
            expectedAmount: Number(rows[0].amount),
            gatewayAmount: amount.gatewayAmount,
          };
        });
        return {
          applied: false,
          alreadyProcessed: true,
          status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
          requiresReconciliation: true,
          // The REASON ACTUALLY PERSISTED, not a guess. This used to return
          // DUPLICATE_CONFIRMED unconditionally while the row was being written
          // with `amount_mismatch`, so the caller was told something the
          // database did not say.
          reason:
            recorded?.reason ?? PaymentReconciliationReason.DUPLICATE_CONFIRMED,
          expectedAmount: recorded?.expectedAmount ?? 0,
          gatewayAmount: recorded?.gatewayAmount ?? null,
        };
      }
      throw error;
    }
  }

  /**
   * Persists a confirmed receipt that did NOT settle its order.
   *
   * `paid_at` comes from the database clock exactly as it does for a settling
   * payment: the money moved, and the books say so. `next_reverify_at` is
   * cleared because the outcome is now known -- there is nothing left to ask
   * the gateway about.
   *
   * `amount` (ours) IS DELIBERATELY NOT IN THIS STATEMENT. It is never
   * overwritten -- not by the gateway's figure, not to make a discrepancy
   * disappear. `gateway_amount` (theirs, when storable) and
   * `gateway_amount_raw` (theirs verbatim, when not) are written beside it, so
   * the two figures and their difference remain evidence an operator can act
   * on. This method also NEVER moves money: no refund, no credit, no reversal.
   */
  private async recordUnapplied(
    manager: EntityManager,
    input: {
      paymentId: number;
      reason: PaymentReconciliationReason;
      gatewayAmount: number | null;
      gatewayAmountRaw: string | null;
      refNumber: string | null;
    },
  ): Promise<void> {
    this.assertOne(
      await manager.query(
        `UPDATE payment
            SET status = $2,
                paid_at = now(),
                updated_at = now(),
                ref_number = $4,
                gateway_amount = $5,
                gateway_amount_raw = $6,
                requires_reconciliation = true,
                reconciliation_reason = $7,
                next_reverify_at = NULL
          WHERE id = $1
            AND status = ANY($3::text[]::payment_status_enum[])`,
        [
          input.paymentId,
          PaymentStatusEnum.CONFIRMED_UNAPPLIED,
          [...APPLICABLE_STATUSES],
          input.refNumber,
          input.gatewayAmount,
          input.gatewayAmountRaw,
          input.reason,
        ],
      ),
      'unapplied payment',
    );
  }

  private assertOne(raw: unknown, what: string): void {
    const affected =
      Array.isArray(raw) && raw.length === 2 ? Number(raw[1]) : 0;
    if (affected !== 1) {
      throw new Error(`phase 1 ${what} update affected ${affected} rows`);
    }
  }

  private isOneSuccessPerOrderViolation(error: unknown): boolean {
    const driver = error as QueryFailedError & {
      code?: string;
      constraint?: string;
      driverError?: { code?: string; constraint?: string };
    };
    const code = driver?.code ?? driver?.driverError?.code;
    if (code !== PG_UNIQUE_VIOLATION) return false;
    const constraint = driver?.constraint ?? driver?.driverError?.constraint;
    return constraint === undefined || constraint === ONE_SUCCESS_PER_ORDER;
  }

  // ==========================================================================
  // Post-commit notifications (R7 -- advisory only)
  // ==========================================================================

  /**
   * The audience for one order's post-commit notifications.
   *
   * `ownerUserId` is `null` for an order with no customer (a POS sale), which
   * simply means there is no customer channel to publish to.
   */
  private async orderAudience(orderId: number): Promise<{
    ownerUserId: number | null;
    branchId: number | null;
  }> {
    const rows: Array<{
      userId: number | string | null;
      branchId: number | string | null;
    }> = await this.dataSource.query(
      `SELECT "userId", "branchId" FROM orders WHERE id = $1`,
      [orderId],
    );
    const row = rows[0];
    return {
      ownerUserId: row?.userId == null ? null : Number(row.userId),
      branchId: row?.branchId == null ? null : Number(row.branchId),
    };
  }

  /**
   * R7: emitted AFTER commit and advisory only. Every stock number here is the
   * COMMITTED `balanceAfter` returned by the R2 conditional UPDATE -- never a
   * value recomputed in memory from a pre-lock snapshot. A dropped frame is not
   * a correctness problem: the next `GET /cart` re-derives the truth.
   *
   * ==========================================================================
   * NO EVENT PUBLISHED HERE IS A GLOBAL BROADCAST
   * ==========================================================================
   * This method used to call `server.emit(...)` directly, twice:
   *
   *   server.emit('stock:updated',        { variantId, newStock });
   *   server.emit('order.status.updated', { orderId, status });
   *
   * `Server.emit` reaches EVERY connected socket. So every signed-in retail
   * customer with a page open learned the exact physical stock of every variant
   * (a figure every HTTP route serving it gates behind `sale`/`super_admin`)
   * and the id and status of every other customer's order. Neither leak needed
   * a bug to trigger; they were the normal, successful path.
   *
   * Publishing now goes through the gateway's SCOPED API only, and the audience
   * is stated explicitly for each event:
   *
   *   stock:updated        -> emitStockEvent      -> admins (+ order's branch)
   *   availability:invalidated -> publishAvailabilityInvalidation
   *                        -> the public storefront room; no quantity, no boolean
   *   order.created        -> emitOrderEvent      -> admins (+ order's branch)
   *   order.status.updated -> emitOrderEvent      -> admins (+ order's branch)
   *                        -> emitToUser          -> the owning customer ONLY
   *   order.awaiting_stock -> emitOrderEvent      -> admins (+ order's branch)
   *
   * The owning customer id is read from `orders."userId"` -- the same column
   * `Start()` checks ownership against -- and never from anything a caller
   * supplied. The read happens POST-COMMIT and its failure is swallowed: a
   * notification that cannot find its audience must not turn a settled payment
   * into an error response.
   */
  private async publish(
    outcome: FulfilmentOutcome,
    orderId: number,
    settledNow: boolean,
  ): Promise<void> {
    const gateway = this.realtimeGateway;
    if (!gateway) return;

    let audience: { ownerUserId: number | null; branchId: number | null };
    try {
      audience = await this.orderAudience(orderId);
    } catch (error) {
      this.logger.warn(
        `could not resolve the notification audience for order ${orderId}; ` +
          `no realtime frame published (advisory only, nothing else is ` +
          `affected): ${(error as Error).message}`,
      );
      return;
    }

    for (const consumed of outcome.consumed) {
      // Exact quantity -> staff rooms only.
      gateway.emitStockEvent({
        variantId: consumed.variantId,
        newStock: consumed.balanceAfter,
        branchId: audience.branchId,
      });
      // Coarse, customer-safe counterpart, so the storefront can still notice
      // that a variant just sold out. `balanceAfter` is the COMMITTED figure,
      // so `inStock: false` is a fact rather than a guess; see
    }

    /*
     * The customer-safe counterpart -- one frame per variant, published once
     * for the whole fulfilment.
     *
     * Called unconditionally. An optional call (`?.`) would have been the
     * defensive choice, but the test stubs in test/integration/support exist
     * precisely to MIRROR this API -- pos.harness.ts says so in its own
     * comment -- and `?.` would let a stub that omits an emitter silently
     * skip it instead of failing, which is the exact class of hole those
     * stubs were written to close.
     */
    void gateway.publishAvailabilityInvalidation(
      outcome.consumed.map((row) => row.variantId),
      'stock',
    );

    // Only the receipt that actually settled the order announces the order as
    // paid. A `confirmed_unapplied` duplicate must not tell the shop floor that
    // a second order was paid.
    if (settledNow) {
      gateway.emitOrderEvent('order.created', {
        orderId,
        branchId: audience.branchId,
      });
      gateway.emitOrderEvent('order.status.updated', {
        orderId,
        status: OrderStatusEnum.PAID,
        branchId: audience.branchId,
      });
      // The customer's own channel. Deliberately a NARROWER payload than the
      // staff one above: no branch attribution, and nothing about anybody
      // else's order can reach `user:<ownerUserId>`.
      if (audience.ownerUserId !== null) {
        gateway.emitToUser(audience.ownerUserId, 'order.status.updated', {
          orderId,
          status: OrderStatusEnum.PAID,
        });
      }
    }

    if (outcome.state === FulfillmentStateEnum.AWAITING_STOCK) {
      // Operators need to know; the customer is told through the order state
      // and through the `order.status.updated` they received on their own room.
      gateway.emitOrderEvent('order.awaiting_stock', {
        orderId,
        branchId: audience.branchId,
      });
    }

    // FINDING 1. A BLOCKED outcome emits NOTHING here, and that is deliberate
    // rather than an omission: `outcome.consumed` is empty so no stock frame
    // goes out, and `settledNow` is false on every path that can be blocked (a
    // receipt that settles in THIS call is `success` with a verified amount, so
    // it authorizes by construction; the blocked population is the legacy
    // `success` rows reached through the replay branch, which passes
    // `settledNow = false`). Announcing such an order as paid-and-progressing
    // on the shop floor is exactly the false signal this finding is about.
    // The blocked order is surfaced through `RecoveryReport.blocked`,
    // `orders."fulfillmentLastError"`, `VerifyPaymentResult.fulfilmentBlocked`
    // and two operator logs instead.
  }

  private async result(
    trackId: string,
    orderId: number,
    outcome: FulfilmentOutcome,
    phase1: Phase1Result,
  ): Promise<VerifyPaymentResult> {
    // The order's REAL status. The old implementation hardcoded PAID here,
    // which was a lie for every receipt that arrived after a cancellation.
    const rows: Array<{ status: OrderStatusEnum }> =
      await this.dataSource.query(
        `SELECT status::text AS status FROM orders WHERE id = $1`,
        [orderId],
      );
    const orderStatus = rows[0]?.status ?? OrderStatusEnum.PENDING;

    return {
      success: true,
      alreadyProcessed: phase1.alreadyProcessed,
      applied: phase1.applied,
      paymentStatus: phase1.status,
      requiresReconciliation: phase1.requiresReconciliation,
      reconciliationReason: phase1.reason,
      trackId,
      orderId,
      orderStatus,
      fulfillmentState: outcome.state,
      expectedAmount: phase1.expectedAmount,
      gatewayAmount: phase1.gatewayAmount,
      fulfilmentBlocked: outcome.blocked,
      // A BLOCKED ORDER OUTRANKS EVERY OTHER MESSAGE, including the `applied`
      // branch. Its receipt did settle the order, so without this the customer
      // would be told "your order is being prepared" about an order the system
      // has just refused to prepare. The message it gets instead says the money
      // is on our books, the order is not confirmed yet and a human is looking
      // -- it never claims the payment failed, because it did not.
      message:
        outcome.blocked !== null
          ? PaymentMessages.FULFILMENT_RECONCILIATION_REQUIRED
          : !phase1.applied
            ? this.unappliedMessage(phase1.reason)
            : outcome.state === FulfillmentStateEnum.AWAITING_STOCK
              ? PaymentMessages.FULFILMENT_AWAITING_STOCK
              : outcome.state === FulfillmentStateEnum.FULFILLED
                ? PaymentMessages.PAYMENT_VERIFIED
                : PaymentMessages.FULFILMENT_PENDING,
      updatedVariants: outcome.consumed.map((c) => ({
        variantId: c.variantId,
        newStock: c.balanceAfter,
      })),
    };
  }

  /**
   * What the CUSTOMER is told about a receipt that was recorded but settled
   * nothing.
   *
   * All three messages say the money was received -- because it was, and
   * telling the customer their payment failed would be a lie -- and that the
   * order is not confirmed and a human is reviewing it. They differ because the
   * causes differ, and the generic
   * `PAYMENT_RECORDED_NOT_APPLIED` asserts the order "was already settled or is
   * no longer payable", which for an amount discrepancy is simply false: that
   * order is still PENDING and waiting.
   */
  private unappliedMessage(reason: PaymentReconciliationReason | null): string {
    switch (reason) {
      case PaymentReconciliationReason.AMOUNT_MISMATCH:
        return PaymentMessages.PAYMENT_RECORDED_AMOUNT_MISMATCH;
      case PaymentReconciliationReason.AMOUNT_MISSING:
      case PaymentReconciliationReason.AMOUNT_INVALID:
        return PaymentMessages.PAYMENT_RECORDED_AMOUNT_UNVERIFIED;
      default:
        return PaymentMessages.PAYMENT_RECORDED_NOT_APPLIED;
    }
  }
}
