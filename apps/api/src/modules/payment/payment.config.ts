import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Gateway and fulfilment configuration.
 *
 * Everything here used to be a hardcoded literal in payment.service.ts
 * (`merchant: 'zibal'`, `callbackUrl: 'https://test.ir/'`, the gateway base
 * URL). A placeholder callback URL in source is a production incident waiting
 * to happen, so all of it now comes from configuration with explicit defaults.
 *
 * MONEY: amounts are INTEGER RIAL end to end (docs/ARCHITECTURE.md section 0).
 * Zibal is also Rial, so there is deliberately NO unit conversion anywhere in
 * this module -- the old `amount * 10` assumed Toman storage and overcharged
 * every customer tenfold.
 */
@Injectable()
export class PaymentConfig {
  constructor(private readonly configService: ConfigService) {}

  private str(key: string, fallback: string): string {
    const value = this.configService.get<string>(key);
    return value === undefined || value === '' ? fallback : value;
  }

  private num(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /** `'zibal'` is Zibal's own sandbox merchant id -- fine as a default, not as a secret. */
  get merchant(): string {
    return this.str('ZIBAL_MERCHANT', 'zibal');
  }

  get baseUrl(): string {
    return this.str('ZIBAL_BASE_URL', 'https://gateway.zibal.ir').replace(
      /\/+$/,
      '',
    );
  }

  /**
   * Where the GATEWAY sends the customer's browser after payment: the Web
   * storefront's return page (`/checkout/payment/return`), which then calls
   * `POST /payment/verify` itself. Never the API's `/payment/verify` — that
   * route is POST-only and a gateway redirect is a GET, so pointing the gateway
   * there strands every customer on a 404. The default is the Web dev server.
   */
  get callbackUrl(): string {
    return this.str(
      'PAYMENT_CALLBACK_URL',
      'http://localhost:8001/checkout/payment/return',
    );
  }

  get requestTimeoutMs(): number {
    return this.num('PAYMENT_GATEWAY_TIMEOUT_MS', 15_000);
  }

  /** `'zibal'` (default) or `'stub'`. Tests always run on the stub. */
  get driver(): 'zibal' | 'stub' {
    const configured = this.configService.get<string>('PAYMENT_GATEWAY_DRIVER');
    if (configured === 'stub' || configured === 'zibal') return configured;
    return process.env.NODE_ENV === 'test' ? 'stub' : 'zibal';
  }

  /**
   * How long an unfinished `pending` payment row may be reused by a repeated
   * `Start()` before a fresh gateway request is made. Prevents an unbounded
   * queue of pending payments per order.
   */
  get pendingReuseWindowMs(): number {
    return this.num('PAYMENT_PENDING_REUSE_MS', 15 * 60 * 1000);
  }

  /** Hard cap on live pending attempts per order. */
  get maxPendingPerOrder(): number {
    return this.num('PAYMENT_MAX_PENDING_PER_ORDER', 3);
  }

  // ==========================================================================
  // Concurrent Start() / in-flight gateway session (FINDING E)
  // ==========================================================================

  /**
   * How long a `pending` attempt with NO `track_id` is treated as "a gateway
   * request is in flight right now" rather than as debris.
   *
   * `Start()` commits the payment INSERT, then calls the gateway OUTSIDE the
   * transaction (holding a pooled connection across a network round trip is how
   * connection pools die), then writes the `track_id`. Between the commit and
   * that write, a second concurrent `Start()` used to see a pending row with a
   * NULL `track_id`, decide it was not reusable, and open a SECOND gateway
   * session. Two live sessions for one order is two ways for the customer to
   * pay twice.
   *
   * The window must comfortably exceed `requestTimeoutMs`, otherwise a slow but
   * healthy gateway request would be mistaken for a crashed one.
   */
  get gatewayInFlightWindowMs(): number {
    return this.num(
      'PAYMENT_GATEWAY_INFLIGHT_WINDOW_MS',
      Math.max(30_000, this.requestTimeoutMs * 2),
    );
  }

  /** Bounded wait for an in-flight attempt's `track_id` to land. */
  get startInFlightWaitMs(): number {
    return this.num('PAYMENT_START_INFLIGHT_WAIT_MS', 10_000);
  }

  /** Poll interval while waiting. Cheap indexed single-row lookup. */
  get startInFlightPollMs(): number {
    return this.num('PAYMENT_START_INFLIGHT_POLL_MS', 100);
  }

  // ==========================================================================
  // Fulfilment recovery (FINDING F)
  // ==========================================================================

  /*
   * ===========================================================================
   * A TEST RUN NEVER ARMS A BACKGROUND SWEEP
   * ===========================================================================
   *
   * `NODE_ENV === 'test'` is checked FIRST and is not overridable. It used to
   * be the fallback -- `env ?? (NODE_ENV !== 'test')` -- which reads as "off in
   * tests" and is not: `apps/api/.env` sets both flags to `true`, ConfigModule
   * loads that file during integration runs, and the explicit branch won. So a
   * timer everybody believed was disabled fired every 30 seconds (recovery) and
   * every 60 seconds (re-verification) inside the integration suite, opening
   * transactions that took `RowShareLock` on `orders` and `payment` -- two of
   * the 28 tables the harness TRUNCATEs between tests -- at moments no test
   * controlled. That is a lock collision with a periodic schedule, which is
   * exactly the shape of the intermittent `resetDb` stall in
   * `delegated-role-matrix`.
   *
   * A developer's local `.env` must not be able to arm a background job inside
   * a test process. It is the same rule `ReservationSweeperService` already
   * applies, and both services expose their pass (`sweep()` / `recover()`) for
   * a spec to drive DIRECTLY, which is the supported way to test them.
   */
  get recoveryEnabled(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    const raw = this.configService.get<string>('FULFILMENT_RECOVERY_ENABLED');
    if (raw !== undefined) return raw === 'true' || raw === '1';
    return true;
  }

  get recoveryIntervalMs(): number {
    return this.num('FULFILMENT_RECOVERY_INTERVAL_MS', 120_000);
  }

  get recoveryBatchSize(): number {
    return this.num('FULFILMENT_RECOVERY_BATCH_SIZE', 50);
  }

  /**
   * First retry delay for an order phase 2 could not finish. Doubles per
   * attempt up to `recoveryBackoffMaxMs`.
   *
   * This is what stops permanently unfulfillable orders from occupying every
   * batch forever: after one attempt they are scheduled into the future and the
   * DUE query moves on to orders that have never been tried.
   */
  get recoveryBackoffBaseMs(): number {
    return this.num('FULFILMENT_RECOVERY_BACKOFF_BASE_MS', 60_000);
  }

  get recoveryBackoffMaxMs(): number {
    return this.num('FULFILMENT_RECOVERY_BACKOFF_MAX_MS', 3_600_000);
  }

  /**
   * Attempts after which an order is reported as needing a human.
   *
   * Retrying does NOT stop at this threshold: giving up would mean deciding
   * what happens to a paid, unfulfillable order, which is exactly the owner
   * decision (D-2) that is still open. The order keeps being retried at the
   * capped interval and is counted in `RecoveryReport.overdue`.
   */
  get recoveryAttemptAlertThreshold(): number {
    return this.num('FULFILMENT_RECOVERY_ALERT_ATTEMPTS', 10);
  }

  // ==========================================================================
  // Payment re-verification sweep (FINDING E -- receipts never recorded)
  // ==========================================================================

  /** See {@link recoveryEnabled} for why `test` is checked first and wins. */
  get reverifyEnabled(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    const raw = this.configService.get<string>('PAYMENT_REVERIFY_ENABLED');
    if (raw !== undefined) return raw === 'true' || raw === '1';
    return true;
  }

  get reverifyIntervalMs(): number {
    return this.num('PAYMENT_REVERIFY_INTERVAL_MS', 300_000);
  }

  get reverifyBatchSize(): number {
    return this.num('PAYMENT_REVERIFY_BATCH_SIZE', 25);
  }

  /** Minimum age before an unfinished attempt is re-asked about. */
  get reverifyAfterMs(): number {
    return this.num('PAYMENT_REVERIFY_AFTER_MS', 15 * 60 * 1000);
  }

  /**
   * Attempts older than this are left alone. A gateway will not answer about
   * ancient transactions, and an unbounded sweep would grow with the table.
   */
  get reverifyMaxAgeMs(): number {
    return this.num('PAYMENT_REVERIFY_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000);
  }

  /** Hard cap on how many times one attempt is re-asked about. */
  get reverifyMaxAttempts(): number {
    return this.num('PAYMENT_REVERIFY_MAX_ATTEMPTS', 8);
  }

  get reverifyBackoffBaseMs(): number {
    return this.num('PAYMENT_REVERIFY_BACKOFF_BASE_MS', 5 * 60 * 1000);
  }

  get reverifyBackoffMaxMs(): number {
    return this.num('PAYMENT_REVERIFY_BACKOFF_MAX_MS', 6 * 60 * 60 * 1000);
  }
}
