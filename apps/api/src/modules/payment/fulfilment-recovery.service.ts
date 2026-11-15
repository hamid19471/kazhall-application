import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FulfillmentStateEnum } from '../orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import { FulfilmentService } from './fulfilment.service';
import { PaymentConfig } from './payment.config';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * The states a PAID order can be re-driven from.
 *
 * PENDING        -- phase 2 never ran, or the process died before it committed.
 * AWAITING_STOCK -- phase 2 ran and could not get the stock; stock may since
 *                   have been restocked or returned.
 *
 * FULFILLED and FAILED are terminal; NOT_REQUIRED means there was never
 * anything to fulfil (a POS sale moves stock inside the sale transaction).
 */
export const RECOVERABLE_FULFILLMENT_STATES: readonly FulfillmentStateEnum[] = [
  FulfillmentStateEnum.PENDING,
  FulfillmentStateEnum.AWAITING_STOCK,
];

/** One leased attempt, as recorded on the order row. */
export interface RecoveryAttempt {
  orderId: number;
  /** Attempt number AFTER this lease (1 on the first ever attempt). */
  attempt: number;
  /** When this order becomes eligible again, from the DATABASE clock. */
  nextAttemptAt: Date | null;
}

export interface RecoveryReport {
  scanned: number;
  fulfilled: number;
  awaitingStock: number;
  /** Claimed by another instance, or already finished. */
  skipped: number;
  failed: number;
  /**
   * FINDING 1. Orders phase 2 REFUSED to fulfil because no payment row
   * authorizes consuming their stock -- every `success` receipt they have
   * carries an open amount question. Counted SEPARATELY from `skipped` and
   * `failed` on purpose: `skipped` means "nothing to do" and `failed` means
   * "it threw", and a blocked order is neither. It is PAID, UNFULFILLED, and
   * waiting on a human or on a valid receipt.
   *
   * These orders are deliberately still retried on the capped interval and
   * still counted in `overdue`, so a blocked order self-heals the moment a
   * valid receipt settles it. Nothing financial is ever done to them.
   */
  blocked: number;
  /** The `blocked` orders by id, so an operator can go straight to them. */
  blockedOrderIds: number[];
  orderIds: number[];
  /** Every lease this pass took, with its attempt number and next due time. */
  attempts: RecoveryAttempt[];
  /**
   * Orders that have now been retried more than
   * `FULFILMENT_RECOVERY_ALERT_ATTEMPTS` times. They are STILL retried -- see
   * the note on giving up below -- but an operator should look at them.
   */
  overdue: number[];
}

/**
 * Crash recovery for payment phase 2.
 *
 * If the process dies between phase 1 (payment confirmed, order PAID,
 * fulfillmentState=PENDING) and phase 2 (stock consumed), the order is left in
 * a recorded recoverable state. This service finds those orders and re-drives
 * phase 2.
 *
 * ==========================================================================
 * FINDING F -- STARVATION, AND THE FIX
 * ==========================================================================
 * The previous selection was:
 *
 *     SELECT id FROM orders
 *      WHERE status='paid' AND "fulfillmentState" IN ('pending','awaiting_stock')
 *      ORDER BY id ASC LIMIT $batch
 *
 * It had no notion of "tried recently". Orders that can NEVER be fulfilled --
 * an item discontinued, stock that is not coming back -- hold the lowest ids
 * forever and therefore fill EVERY batch, forever. A fulfillable order created
 * afterwards is not merely delayed, it is never reached: the query is
 * deterministic and returns the same doomed head on every single pass. The
 * worker meanwhile reports busy, healthy activity.
 *
 * The fix is a due-time queue with capped exponential backoff, persisted on the
 * order (migration 0011):
 *
 *  - only orders whose `"fulfillmentNextAttemptAt"` is NULL (never tried, or
 *    freshly paid) or in the past are selected;
 *  - the batch is LEASED in one short transaction that stamps
 *    attempts/lastAttemptAt/nextAttemptAt BEFORE any work is done, so the head
 *    of the queue moves on immediately and a second instance running at the
 *    same moment sees different rows;
 *  - ordering is by due time, so the queue ROTATES;
 *  - `FOR UPDATE SKIP LOCKED` is kept, both on the lease and inside
 *    FulfilmentService's own claim.
 *
 * WHY IT NEVER GIVES UP. Retrying stops being useful long before it stops
 * being correct, but "abandon a paid order" is a financial decision (refund?
 * back-order? partial?) that the owner has NOT made -- open decision D-2. So an
 * order past the alert threshold keeps being retried at the CAPPED interval
 * (once an hour by default: negligible load) and is reported in
 * `RecoveryReport.overdue` for a human. No state is invented and no money moves.
 *
 * BOUNDED       -- at most `recoveryBatchSize` orders per run, and each order
 *                  is touched at most once per backoff interval.
 * RETRY-SAFE    -- phase 2 is idempotent per order, so re-driving an order that
 *                  actually completed is a no-op.
 * MULTI-INSTANCE SAFE -- lease and claim are both
 *                  `SELECT ... FOR UPDATE SKIP LOCKED` plus a guarded
 *                  conditional UPDATE. Both are database primitives; Redis is
 *                  never the sole protection for inventory correctness.
 *
 * WHAT THIS SERVICE DOES **NOT** RECOVER. It scans orders that are already
 * `status='paid'`. A payment whose PHASE 1 never committed leaves no paid
 * order, so nothing here can find it -- see PaymentReverificationService, which
 * covers that case from the payment side, and its comment for the precise
 * limits of what is and is not recoverable.
 *
 * ==========================================================================
 * FINDING 1 -- AN ORDER WHOSE PAYMENT DOES NOT AUTHORIZE FULFILMENT
 * ==========================================================================
 * This worker used to be one of three ways to ship goods against a legacy
 * `success` receipt whose amount was never verified: it re-drove any PAID order
 * in a recoverable state, and `FulfilmentService.claim()` only looked at the
 * order's own two columns. The authorization check now lives INSIDE that claim,
 * in the same transaction with the order row locked, so this worker inherits it
 * without a second code path -- exactly like the callback and the
 * re-verification sweep do.
 *
 * What changes HERE is only the reporting: a refused order comes back with
 * `FulfilmentOutcome.blocked` set and is counted in `RecoveryReport.blocked` /
 * `blockedOrderIds` rather than disappearing into `skipped`. It is NOT dropped
 * from the queue: it keeps its lease, its backoff and its place in `overdue`,
 * which is what makes it self-heal the moment a valid receipt settles it. No
 * money moves and no payment row is touched, here or anywhere below.
 */
@Injectable()
export class FulfilmentRecoveryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(FulfilmentRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The pass currently in flight, so shutdown can await it. */
  private inFlight: Promise<unknown> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fulfilmentService: FulfilmentService,
    private readonly config: PaymentConfig,
    /**
     * Announcing stock this worker consumed. See `publishConsumption` -- the
     * emit is post-commit, because `FulfilmentService.drive` commits before it
     * returns an outcome.
     */
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    if (!this.config.recoveryEnabled) return;
    this.timer = setInterval(() => {
      this.inFlight = this.recover().catch((error) =>
        this.logger.error(
          `fulfilment recovery run failed: ${(error as Error).message}`,
        ),
      );
    }, this.config.recoveryIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer AND WAITS FOR THE PASS THAT IS ALREADY RUNNING.
   *
   * Clearing the interval alone was not enough. A pass that started a
   * millisecond before shutdown keeps querying a DataSource that is being
   * destroyed, and can still be holding a transaction — and therefore locks —
   * after `app.close()` has resolved. In the integration suite that is a lock
   * surviving into the NEXT spec file, where nothing owns it and nothing can
   * explain it.
   *
   * Awaiting the in-flight promise is what makes "the application is closed"
   * mean "nothing of it is still touching the database". The pass is already
   * bounded (one batch loop, no network call inside a transaction), so this
   * cannot hang shutdown indefinitely.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pass = this.inFlight;
    this.inFlight = null;
    if (pass) await pass;
  }

  /**
   * One bounded recovery pass. Safe to call manually at any time -- the admin
   * endpoint and the test suite both use it so recovery can be exercised
   * deterministically instead of waiting on a timer.
   */
  async recover(limit?: number): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      scanned: 0,
      fulfilled: 0,
      awaitingStock: 0,
      skipped: 0,
      failed: 0,
      blocked: 0,
      blockedOrderIds: [],
      orderIds: [],
      attempts: [],
      overdue: [],
    };
    if (this.running) return report;
    this.running = true;

    try {
      const batch = limit ?? this.config.recoveryBatchSize;
      const leased = await this.leaseDueOrders(batch);

      for (const lease of leased) {
        const orderId = lease.orderId;
        report.scanned += 1;
        report.orderIds.push(orderId);
        report.attempts.push(lease);
        if (lease.attempt > this.config.recoveryAttemptAlertThreshold) {
          report.overdue.push(orderId);
          this.logger.error(
            `order ${orderId} has failed fulfilment ${lease.attempt} times and is still ` +
              `being retried on the capped interval. It is PAID and UNFULFILLED and needs ` +
              `a human decision (owner decision D-2 is open: no refund or cancellation is ` +
              `ever issued automatically).`,
          );
        }

        try {
          const outcome = await this.fulfilmentService.drive(orderId);
          // FINDING 1. Checked BEFORE `claimed`, because a blocked order is
          // reported `claimed: false` (nothing was done) and lumping it into
          // `skipped` would hide a paid, unfulfilled order inside the "nothing
          // to do" bucket -- which is how it would go unnoticed.
          if (outcome.blocked !== null) {
            report.blocked += 1;
            report.blockedOrderIds.push(orderId);
            this.logger.error(
              `order ${orderId} was NOT fulfilled: ${outcome.blocked}. It is PAID and ` +
                `UNFULFILLED because no payment row authorizes consuming its stock ` +
                `(FulfilmentService logged the detail and recorded it on ` +
                `orders."fulfillmentLastError"). It stays on the capped retry schedule so ` +
                `a valid receipt can still settle it. NO refund, credit or reversal has ` +
                `been issued and no payment row was changed.`,
            );
          } else if (!outcome.claimed) report.skipped += 1;
          else if (outcome.state === FulfillmentStateEnum.FULFILLED) {
            report.fulfilled += 1;
            await this.publishConsumption(outcome.consumed);
          } else if (outcome.state === FulfillmentStateEnum.AWAITING_STOCK)
            report.awaitingStock += 1;
          else report.skipped += 1;
        } catch (error) {
          // One bad order must never stop the batch; it stays recoverable and
          // its next attempt is already scheduled by the lease.
          report.failed += 1;
          const message = (error as Error).message;
          await this.recordLastError(orderId, message);
          this.logger.error(
            `re-driving fulfilment for order ${orderId} failed: ${message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }

    return report;
  }

  /**
   * Selects the DUE head of the queue and immediately schedules each row's next
   * attempt, in ONE short transaction.
   *
   * Stamping before the work (rather than after) is what makes the queue
   * rotate even if this process dies mid-batch: a crashed pass costs one
   * backoff interval, it does not re-pin the same orders at the head forever.
   *
   * The backoff is computed IN SQL from the database clock and the row's own
   * attempt count -- `base * 2^attempts`, capped -- so it cannot drift with a
   * client's timezone or clock, exactly like every other time comparison in
   * this module. `power()` is clamped at 2^20 first so a very old row cannot
   * overflow to infinity before LEAST() sees it.
   */
  private async leaseDueOrders(batch: number): Promise<RecoveryAttempt[]> {
    return this.dataSource.transaction(async (manager) => {
      const due: Array<{ id: number }> = await manager.query(
        `SELECT id
           FROM orders
          WHERE status::text = $1
            AND "fulfillmentState"::text = ANY($2::text[])
            AND ("fulfillmentNextAttemptAt" IS NULL
                 OR "fulfillmentNextAttemptAt" <= now())
          ORDER BY "fulfillmentNextAttemptAt" ASC NULLS FIRST, id ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED`,
        [OrderStatusEnum.PAID, [...RECOVERABLE_FULFILLMENT_STATES], batch],
      );
      if (due.length === 0) return [];

      const ids = due.map((row) => Number(row.id));
      type LeasedRow = { id: number; attempts: number; next: Date | null };
      // TypeORM's postgres driver returns `[rows, affectedCount]` for an
      // UPDATE ... RETURNING, not a bare row array (the same shape `assertOne`
      // in PaymentService unwraps). Reading it as an array of rows silently
      // yields nothing, which is how the attempt counters first came back as 0.
      const raw: unknown = await manager.query(
        `UPDATE orders
            SET "fulfillmentAttempts" = "fulfillmentAttempts" + 1,
                "fulfillmentLastAttemptAt" = now(),
                "fulfillmentNextAttemptAt" = now() + (
                  LEAST(
                    $2::double precision
                      * power(2, LEAST("fulfillmentAttempts", 20)::double precision),
                    $3::double precision
                  ) * interval '1 millisecond'
                )
          WHERE id = ANY($1::int[])
        RETURNING id,
                  "fulfillmentAttempts" AS attempts,
                  "fulfillmentNextAttemptAt" AS next`,
        [
          ids,
          this.config.recoveryBackoffBaseMs,
          this.config.recoveryBackoffMaxMs,
        ],
      );
      const leased: LeasedRow[] = Array.isArray(raw)
        ? ((Array.isArray(raw[0]) ? raw[0] : raw) as LeasedRow[])
        : [];

      // Preserve the due order of the SELECT; RETURNING order is unspecified.
      const byId = new Map(leased.map((row) => [Number(row.id), row]));
      return ids.map((id) => ({
        orderId: id,
        attempt: Number(byId.get(id)?.attempts ?? 0),
        nextAttemptAt: byId.get(id)?.next ?? null,
      }));
    });
  }

  /** Observability only -- never a state change. */
  private async recordLastError(
    orderId: number,
    message: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE orders SET "fulfillmentLastError" = $2 WHERE id = $1`,
        [orderId, message.slice(0, 500)],
      );
    } catch (error) {
      this.logger.warn(
        `could not record fulfilment error for order ${orderId}: ${
          (error as Error).message
        }`,
      );
    }
  }
  /**
   * Announce the stock this recovery pass consumed.
   *
   * ## The gap this closes
   *
   * An order that could not be fulfilled at payment time sits in
   * `AWAITING_STOCK`. When stock later appears, THIS worker is what fulfils it
   * -- and until now it did so completely silently. Physical stock fell, a
   * `stock_movements` row was written, and no storefront, till or admin console
   * learned anything until its next poll. `PaymentService.publish` announces the
   * identical transition when it happens inline at payment; the only difference
   * was who drove it.
   *
   * ## Post-commit by construction
   *
   * `FulfilmentService.drive` wraps its whole body in
   * `dataSource.transaction(...)` and returns the outcome only after that
   * resolves, so every `balanceAfter` here is a committed value and this call
   * site cannot be inside the transaction that produced it. A rolled-back
   * attempt throws instead of returning, and is caught by the batch's own
   * `catch` -- which emits nothing.
   *
   * ## Scope
   *
   * Stock and availability only. The staff `order.created` /
   * `order.status.updated` frames and the owning customer's notification are
   * still NOT sent from this path -- they need the order's branch and owner,
   * which this worker does not read, and inventory synchronisation is what this
   * workstream is answerable for. The consequence is unchanged from before:
   * a recovered order's STATUS still reaches screens on their next read.
   */
  private async publishConsumption(
    consumed: ReadonlyArray<{ variantId: number; balanceAfter: number }>,
  ): Promise<void> {
    for (const row of consumed) {
      // Staff channel. `branchId: null` -- a background recovery pass belongs
      // to no till, and per `emitStockEvent` a null branch narrows the audience
      // to `admins` rather than widening it to everyone.
      this.realtimeGateway.emitStockEvent({
        variantId: row.variantId,
        newStock: row.balanceAfter,
        branchId: null,
      });
    }
    // The customer-safe counterpart, carrying no quantity. This is the frame a
    // storefront basket and a till both actually receive; one per variant.
    await this.realtimeGateway.publishAvailabilityInvalidation(
      consumed.map((row) => row.variantId),
      'stock',
    );
  }
}
