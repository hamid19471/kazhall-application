/**
 * Payment gateway seam.
 *
 * The service talks to THIS interface, never to axios directly, so the test
 * suite can drive every branch (success, failure, already-verified, network
 * error) against `StubPaymentGateway`. NO TEST EVER CALLS A LIVE GATEWAY --
 * live credentials are out of scope for this work package.
 */

/** Zibal result codes the service actually reasons about. */
export const ZIBAL_RESULT = {
  /** Verified successfully. */
  SUCCESS: 100,
  /** Already verified -- an idempotent replay, not a failure. */
  ALREADY_VERIFIED: 201,
} as const;

export interface GatewayRequestInput {
  /** INTEGER RIAL. No unit conversion happens anywhere in this module. */
  amount: number;
  orderId: number;
  callbackUrl: string;
  description?: string;
  mobile?: string;
}

export interface GatewayRequestResult {
  trackId: string;
  raw: unknown;
}

export interface GatewayVerifyResult {
  /** Gateway result code; 100 = verified, 201 = already verified. */
  result: number;
  /** INTEGER RIAL as reported by the gateway, when it reports one. */
  amount?: number | null;
  refNumber?: string | null;
  raw: unknown;
}

export interface PaymentGateway {
  request(input: GatewayRequestInput): Promise<GatewayRequestResult>;
  verify(input: { trackId: string }): Promise<GatewayVerifyResult>;
  /** Where the customer is sent to complete the payment. */
  paymentUrl(trackId: string): string;
}

/** DI token. Bound to Zibal or to the stub by PaymentModule. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
