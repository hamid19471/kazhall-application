import { Injectable } from '@nestjs/common';

import {
  GatewayRequestInput,
  GatewayRequestResult,
  GatewayVerifyResult,
  PaymentGateway,
  ZIBAL_RESULT,
} from './payment-gateway.interface';

/**
 * Deterministic in-memory gateway for tests and local development.
 *
 * Bound whenever `PAYMENT_GATEWAY_DRIVER=stub`, which is the default under
 * `NODE_ENV=test`. NO LIVE GATEWAY IS EVER CALLED FROM A TEST.
 *
 * Every branch the real service must handle is drivable:
 *   - `programVerify(trackId, result)` forces a specific gateway result code
 *   - `programVerifyAmount(trackId, amount)` forces the amount the gateway
 *     claims to have taken, so an over/underpayment can be reproduced. It also
 *     accepts `null`/`undefined` (the gateway reporting NO amount) and unusable
 *     figures (`NaN`, negative, fractional), because `GatewayVerifyResult.amount`
 *     is `number | null | undefined` and all of those are reachable states that
 *     the settle decision has to refuse. Programming `null` here really does
 *     mean "no amount": it does NOT fall back to the requested amount, which
 *     is what made the missing-amount case untestable before.
 *   - `failNextRequest()` simulates the gateway refusing to open a session
 *   - `holdRequests()` freezes `request()` mid-flight, which is the ONLY way to
 *     reproduce two concurrent `Start()` calls racing one gateway round trip
 *   - `verifyCalls` lets a test assert that a duplicate verification did NOT
 *     hit the gateway a second time
 */
@Injectable()
export class StubPaymentGateway implements PaymentGateway {
  private sequence = 1;
  private readonly programmedVerifies = new Map<string, number>();
  private readonly programmedAmounts = new Map<
    string,
    number | null | undefined
  >();
  private readonly issued = new Map<string, GatewayRequestInput>();
  private requestFailure: Error | null = null;
  private requestGate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  /** Every trackId that `verify()` was called with, in order. */
  readonly verifyCalls: string[] = [];
  readonly requestCalls: GatewayRequestInput[] = [];

  reset(): void {
    this.sequence = 1;
    this.programmedVerifies.clear();
    this.programmedAmounts.clear();
    this.issued.clear();
    this.requestFailure = null;
    this.releaseGate?.();
    this.requestGate = null;
    this.releaseGate = null;
    this.verifyCalls.length = 0;
    this.requestCalls.length = 0;
  }

  programVerify(trackId: string, result: number): void {
    this.programmedVerifies.set(trackId, result);
  }

  /**
   * INTEGER RIAL, like everything else. No conversion anywhere.
   *
   * `null`/`undefined` programs a gateway that reports NO amount, and an
   * unusable number (NaN, negative, fractional) programs a gateway that reports
   * nonsense. Both are states of `GatewayVerifyResult` and both must be refused
   * by the settle decision, so both have to be drivable from a test.
   */
  programVerifyAmount(
    trackId: string,
    amount: number | null | undefined,
  ): void {
    this.programmedAmounts.set(trackId, amount);
  }

  failNextRequest(error = new Error('stub gateway unavailable')): void {
    this.requestFailure = error;
  }

  /**
   * Blocks every `request()` until the returned function is called.
   *
   * A real gateway round trip takes hundreds of milliseconds, and the whole
   * concurrency question in `Start()` -- can a second caller open a SECOND
   * session while the first is in flight? -- only exists during that window. A
   * stub that always returns immediately makes the window unobservable and lets
   * the bug hide.
   */
  holdRequests(): () => void {
    if (this.releaseGate) return this.releaseGate;
    this.requestGate = new Promise<void>((resolve) => {
      this.releaseGate = () => {
        this.requestGate = null;
        this.releaseGate = null;
        resolve();
      };
    });
    return () => this.releaseGate?.();
  }

  issuedFor(trackId: string): GatewayRequestInput | undefined {
    return this.issued.get(trackId);
  }

  async request(input: GatewayRequestInput): Promise<GatewayRequestResult> {
    this.requestCalls.push(input);
    if (this.requestGate) await this.requestGate;
    if (this.requestFailure) {
      const error = this.requestFailure;
      this.requestFailure = null;
      throw error;
    }
    const trackId = `stub-${this.sequence++}`;
    this.issued.set(trackId, input);
    return { trackId, raw: { result: 100, trackId } };
  }

  async verify(input: { trackId: string }): Promise<GatewayVerifyResult> {
    this.verifyCalls.push(input.trackId);
    const result =
      this.programmedVerifies.get(input.trackId) ?? ZIBAL_RESULT.SUCCESS;
    // `has()`, not `??`: a programmed `null` or `undefined` is the POINT (the
    // gateway reporting no amount), and `??` would have silently fallen through
    // to the requested amount and turned that case back into a happy path.
    const amount = this.programmedAmounts.has(input.trackId)
      ? this.programmedAmounts.get(input.trackId)
      : (this.issued.get(input.trackId)?.amount ?? null);
    return Promise.resolve({
      result,
      amount,
      refNumber: `ref-${input.trackId}`,
      raw: { result },
    });
  }

  paymentUrl(trackId: string): string {
    return `https://stub.gateway.local/start/${trackId}`;
  }
}
