import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { PaymentMessages } from 'src/common/constants/payment.messages';
import {
  isAmountReconciliationReason,
  PaymentStatusEnum,
} from './enums/payment-status-enum';
import { PaymentConfig } from './payment.config';
import { PaymentService } from './payment.service';

export interface ReverificationReport {
  scanned: number;
  /** Receipts that turned out to be real AND settled their order. */
  recovered: number;
  /** Receipts that were real but did not settle the order; flagged for a human. */
  unapplied: number;
  /**
   * The subset of `unapplied` whose AMOUNT could not be verified -- reported
   * separately because "we found money we had not recorded" and "we found money
   * we cannot match to an order" are different operational problems, and
   * because a sweep that reported them as one could hide the second inside the
   * first.
   */
  amountUnverified: number;
  /** The gateway confirmed the attempt was not paid. */
  notPaid: number;
  errored: number;
  paymentIds: number[];
}

/**
 * ============================================================================
 * PAYMENT RE-VERIFICATION  --  "the gateway took the money and we never heard"
 * ============================================================================
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * Everything that records money in this module happens when the verify
 * callback arrives. If the callback never arrives -- the customer closed the
 * tab, the callback HTTP request was lost, or THIS process died between the
 * gateway confirming and phase 1 committing -- then the receipt exists at the
 * gateway and nowhere else. `FulfilmentRecoveryService` cannot help: it scans
 * orders that are already `status='paid'`, and a payment whose phase 1 never
 * committed produced no paid order. That gap was previously not covered by
 * anything, while the module's comments implied crash recovery was solved.
 *
 * This service closes as much of the gap as is closable from here: it re-asks
 * the gateway, through the same `PaymentGateway` seam the callback uses, about
 * attempts that are still unfinished but DO have a `track_id`. A confirmation
 * then flows through the ordinary `PaymentService.Verify()` path, so it lands
 * in exactly the same honest states (`success`, or `confirmed_unapplied` +
 * reconciliation flag) with no second code path to keep in sync.
 *
 * WHAT IT DOES RECOVER
 * --------------------
 *  - the customer paid and the callback never reached us (`pending` attempt);
 *  - the process crashed after the gateway confirmed but before phase 1
 *    committed -- the attempt is still `pending` with its `track_id`;
 *  - a payment confirmed after `Start()` had already written the attempt off as
 *    `failed` (the receipt is recorded; whether it may SETTLE the order is the
 *    provisional policy in provisional-policy.ts).
 *
 * WHAT IT DOES **NOT** RECOVER -- STATED PLAINLY, NOT HEDGED
 * ----------------------------------------------------------
 *  - AN ATTEMPT WITH NO `track_id`. If the process died between the gateway
 *    returning a session id and `Start()` writing it down, the local row has no
 *    handle to ask about, and this service cannot invent one. Nothing in this
 *    codebase can recover that receipt; it requires the gateway's own
 *    settlement report, keyed by the `orderId` we send with the request. That
 *    integration does not exist. NOTE: such a receipt requires the customer to
 *    have reached the payment page, which cannot happen when `Start()` fails --
 *    the payment URL is only returned after the `track_id` is written -- so the
 *    exposure is limited to a crash inside that one-statement window.
 *  - A RECEIPT WHOSE AMOUNT DOES NOT CHECK OUT. If the gateway's amount is
 *    absent, unusable, or different from the amount we asked for, this sweep
 *    RECORDS the receipt (`confirmed_unapplied` + a reconciliation reason) and
 *    settles NOTHING: the order stays PENDING, no stock moves, and the receipt
 *    is counted in `amountUnverified`, not in `recovered`. It is then TERMINAL
 *    -- `leaseDueAttempts` below only ever selects `pending`/`failed` rows, so
 *    a `confirmed_unapplied` receipt can never be picked up by a later pass and
 *    talked into settling. There is no flag that changes this: an unverified
 *    receipt settling an order is not a policy, it is the defect. A human
 *    decides, and this service never moves money.
 *  - A RECEIPT OLDER THAN `PAYMENT_REVERIFY_MAX_AGE_MS` (7 days by default), or
 *    one that has already been re-asked about `PAYMENT_REVERIFY_MAX_ATTEMPTS`
 *    times. The sweep is bounded on purpose; an unbounded one grows with the
 *    table and hammers the gateway. Rows that fall off the end keep their
 *    honest state and remain visible to the reconciliation query on the Payment
 *    entity.
 *  - ANY MONEY MOVEMENT. Nothing here refunds, credits or reverses anything.
 *
 * FINDING 1 -- IT INHERITS THE FULFILMENT AUTHORIZATION CHECK, WITH NO SECOND
 * CODE PATH. This sweep reaches stock only through `PaymentService.Verify()`,
 * which reaches it only through `FulfilmentService.drive()`, where the check
 * lives (see `FulfilmentService.claim()`). So a receipt this sweep recovers can
 * only fulfil an order that a payment actually authorizes.
 *
 * `ReverificationReport` gets no `blocked` counter because a blocked outcome is
 * UNREACHABLE from here, and inventing an always-zero field would imply
 * otherwise: `leaseDueAttempts` selects only `pending`/`failed` rows, and a
 * receipt that settles an order in this pass is `success` with a PRESENT, VALID
 * and EQUAL amount, which authorizes by construction. The blocked population is
 * the legacy `success` rows, and those this sweep never touches. A blocked order
 * is reported by `RecoveryReport.blocked` and `VerifyPaymentResult`
 * `.fulfilmentBlocked`.
 *
 * BOUNDED AND MULTI-INSTANCE SAFE, exactly like the fulfilment recovery worker:
 * a due-time queue with capped exponential backoff persisted on the payment row
 * (migration 0010), leased with `FOR UPDATE SKIP LOCKED` before any gateway
 * call, so two instances never re-verify the same attempt at the same moment.
 * ============================================================================
 */
@Injectable()
export class PaymentReverificationService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentReverificationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The pass currently in flight, so shutdown can await it. */
  private inFlight: Promise<unknown> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly paymentService: PaymentService,
    private readonly config: PaymentConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.reverifyEnabled) return;
    this.timer = setInterval(() => {
      this.inFlight = this.sweep().catch((error) =>
        this.logger.error(
          `payment re-verification run failed: ${(error as Error).message}`,
        ),
      );
    }, this.config.reverifyIntervalMs);
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

  /** One bounded pass. Safe to call manually; the admin endpoint does. */
  async sweep(limit?: number): Promise<ReverificationReport> {
    const report: ReverificationReport = {
      scanned: 0,
      recovered: 0,
      unapplied: 0,
      amountUnverified: 0,
      notPaid: 0,
      errored: 0,
      paymentIds: [],
    };
    if (this.running) return report;
    this.running = true;

    try {
      const batch = limit ?? this.config.reverifyBatchSize;
      const leased = await this.leaseDueAttempts(batch);

      for (const attempt of leased) {
        report.scanned += 1;
        report.paymentIds.push(attempt.paymentId);
        try {
          const result = await this.paymentService.Verify(attempt.trackId);
          if (result.applied) {
            report.recovered += 1;
            this.logger.warn(
              `payment ${attempt.paymentId} (track ${attempt.trackId}) was confirmed by ` +
                `the gateway but had never been recorded locally; it has now settled ` +
                `order ${result.orderId}`,
            );
          } else {
            report.unapplied += 1;
            if (isAmountReconciliationReason(result.reconciliationReason)) {
              report.amountUnverified += 1;
            }
            this.logger.warn(
              `payment ${attempt.paymentId} (track ${attempt.trackId}) was confirmed by ` +
                `the gateway but did not settle order ${result.orderId}; recorded as ` +
                `${result.paymentStatus} / ${String(result.reconciliationReason)} for ` +
                `reconciliation (we asked for ${result.expectedAmount} Rial, the gateway ` +
                `reported ${result.gatewayAmount === null ? 'nothing usable' : String(result.gatewayAmount)})`,
            );
          }
        } catch (error) {
          const message = (error as Error).message;
          // The gateway answering "not paid" is the expected, healthy outcome
          // for most of this batch: an abandoned checkout. It is not an error.
          if (message === PaymentMessages.PAYMENT_FAILED) {
            report.notPaid += 1;
          } else {
            report.errored += 1;
            this.logger.error(
              `re-verifying payment ${attempt.paymentId} failed: ${message}`,
            );
          }
        }
      }
    } finally {
      this.running = false;
    }

    return report;
  }

  /**
   * Selects the DUE head of the queue and schedules each row's next attempt in
   * one short transaction, BEFORE any gateway call. Stamping first is what
   * keeps a crashed pass from re-pinning the same attempts at the head, and
   * what stops two instances asking the gateway about the same trackId at once.
   *
   * All time arithmetic is done in SQL against the database clock: `created_at`
   * is a naive `timestamp` and comparing it to a JS Date silently shifts by the
   * client's UTC offset (see PaymentService.Start).
   */
  private async leaseDueAttempts(
    batch: number,
  ): Promise<Array<{ paymentId: number; trackId: string }>> {
    return this.dataSource.transaction(async (manager) => {
      const due: Array<{ id: number; track_id: string }> = await manager.query(
        `SELECT id, track_id
           FROM payment
          WHERE track_id IS NOT NULL
            AND status = ANY($1::text[]::payment_status_enum[])
            AND created_at < now() - ($2 * interval '1 millisecond')
            AND created_at > now() - ($3 * interval '1 millisecond')
            AND reverify_attempts < $4
            AND (next_reverify_at IS NULL OR next_reverify_at <= now())
          ORDER BY next_reverify_at ASC NULLS FIRST, id ASC
          LIMIT $5
          FOR UPDATE SKIP LOCKED`,
        [
          [PaymentStatusEnum.PENDING, PaymentStatusEnum.FAILED],
          this.config.reverifyAfterMs,
          this.config.reverifyMaxAgeMs,
          this.config.reverifyMaxAttempts,
          batch,
        ],
      );
      if (due.length === 0) return [];

      const ids = due.map((row) => Number(row.id));
      await manager.query(
        `UPDATE payment
            SET reverify_attempts = reverify_attempts + 1,
                last_reverified_at = now(),
                next_reverify_at = now() + (
                  LEAST(
                    $2::double precision
                      * power(2, LEAST(reverify_attempts, 20)::double precision),
                    $3::double precision
                  ) * interval '1 millisecond'
                )
          WHERE id = ANY($1::int[])`,
        [
          ids,
          this.config.reverifyBackoffBaseMs,
          this.config.reverifyBackoffMaxMs,
        ],
      );

      return due.map((row) => ({
        paymentId: Number(row.id),
        trackId: row.track_id,
      }));
    });
  }
}
