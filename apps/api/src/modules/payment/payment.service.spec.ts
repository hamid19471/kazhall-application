import { ConfigService } from '@nestjs/config';

import {
  GATEWAY_AMOUNT_RAW_MAX_LENGTH,
  verifyGatewayAmount,
} from './amount-verification';
import { PaymentReconciliationReason } from './enums/payment-status-enum';
import { StubPaymentGateway } from './gateways/stub.gateway';
import { ZIBAL_RESULT } from './gateways/payment-gateway.interface';
import { PaymentConfig } from './payment.config';
import {
  PROVISIONAL_POLICY_ACK_VALUE,
  ProvisionalPaymentPolicy,
} from './provisional-policy';

/**
 * ============================================================================
 * REWRITTEN for the two-phase PaymentService (workstream D).
 *
 * The previous version of this file mocked `DataSource.transaction` and
 * asserted that verification deducted stock inside the payment transaction --
 * i.e. it asserted the defect. Payment is now two committed phases
 * (docs/ARCHITECTURE.md section 2) and a confirmed payment is never rolled
 * back, so those assertions had to go rather than be patched up.
 *
 * WHAT IS AND IS NOT TESTED HERE
 * ------------------------------
 * Only the two pieces that are honestly unit-testable: the CONFIG (which used
 * to be hardcoded literals, including the `* 10` money bug) and the GATEWAY
 * STUB that keeps live gateways out of the test suite.
 *
 * The behaviour that matters -- phase 1 committing independently of phase 2,
 * idempotent replay, two attempts not decrementing twice, AWAITING_STOCK,
 * crash recovery -- is about committed database transactions and is covered
 * against a disposable PostgreSQL in:
 *
 *   test/integration/payment-fulfilment.int-spec.ts         (23-26)
 *   test/integration/payment-reconciliation.int-spec.ts     (finding E)
 *   test/integration/recovery-starvation.int-spec.ts        (finding F)
 *
 * The one thing added here is the PRODUCTION GUARD on the provisional,
 * owner-unapproved late-payment policy: it is pure decision logic over
 * environment variables, so a unit test is the honest place for it, and it must
 * be impossible to ship that policy on by accident.
 *
 * FINDING 2 adds a second such thing: `verifyGatewayAmount`, the pure predicate
 * the settle decision now depends on. It is exhaustively testable without a
 * database or a gateway, and it is the single most consequential branch in the
 * module, so every state of `GatewayVerifyResult.amount` is enumerated here.
 * The DATABASE consequences -- nothing settled, no stock moved, both figures
 * kept -- are asserted against real PostgreSQL in
 *   test/integration/payment-amount-verification.int-spec.ts
 * ============================================================================
 */
function configWith(values: Record<string, string> = {}): PaymentConfig {
  return new PaymentConfig({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('PaymentConfig', () => {
  const previousEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('has no placeholder callback URL baked into the source', () => {
    // The old service hardcoded `callbackUrl: 'https://test.ir/'`.
    expect(configWith().callbackUrl).not.toBe('https://test.ir/');
  });

  it('sends the gateway back to the Web return page, never to the POST-only verify route', () => {
    const fallback = new URL(configWith().callbackUrl);
    expect(fallback.pathname).toBe('/checkout/payment/return');
    expect(fallback.pathname).not.toMatch(/\/payment\/(verify|callback)$/);
  });

  it('takes merchant, base URL and callback URL from configuration', () => {
    const config = configWith({
      ZIBAL_MERCHANT: 'kazhal-live',
      ZIBAL_BASE_URL: 'https://gateway.example.test/',
      PAYMENT_CALLBACK_URL: 'https://shop.example.test/pay/callback',
    });
    expect(config.merchant).toBe('kazhal-live');
    // Trailing slash trimmed so path concatenation cannot produce `//v1`.
    expect(config.baseUrl).toBe('https://gateway.example.test');
    expect(config.callbackUrl).toBe('https://shop.example.test/pay/callback');
  });

  it('defaults to the stub gateway under NODE_ENV=test so no test can call a live gateway', () => {
    process.env.NODE_ENV = 'test';
    expect(configWith().driver).toBe('stub');

    process.env.NODE_ENV = 'production';
    expect(configWith().driver).toBe('zibal');
    expect(configWith({ PAYMENT_GATEWAY_DRIVER: 'stub' }).driver).toBe('stub');
  });

  it('gives the in-flight window room for a slow but healthy gateway request', () => {
    // A window shorter than the request timeout would make a slow gateway look
    // like a crashed process, and a concurrent Start() would open a second
    // session -- exactly the bug the window exists to prevent.
    const config = configWith({ PAYMENT_GATEWAY_TIMEOUT_MS: '40000' });
    expect(config.gatewayInFlightWindowMs).toBeGreaterThan(
      config.requestTimeoutMs,
    );
    expect(configWith().gatewayInFlightWindowMs).toBeGreaterThanOrEqual(30_000);
  });

  it('bounds every retry sweep: batch, backoff and attempt caps all have defaults', () => {
    const config = configWith();
    expect(config.recoveryBackoffBaseMs).toBeGreaterThan(0);
    expect(config.recoveryBackoffMaxMs).toBeGreaterThan(
      config.recoveryBackoffBaseMs,
    );
    expect(config.reverifyMaxAttempts).toBeGreaterThan(0);
    expect(config.reverifyMaxAgeMs).toBeGreaterThan(config.reverifyAfterMs);
  });

  it('falls back to sane defaults when a numeric setting is missing or junk', () => {
    expect(configWith().maxPendingPerOrder).toBe(3);
    expect(
      configWith({ PAYMENT_MAX_PENDING_PER_ORDER: 'abc' }).maxPendingPerOrder,
    ).toBe(3);
    expect(
      configWith({ PAYMENT_MAX_PENDING_PER_ORDER: '7' }).maxPendingPerOrder,
    ).toBe(7);
  });
});

describe('ProvisionalPaymentPolicy (owner-UNAPPROVED late-payment policy)', () => {
  const previousEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  function policyWith(
    values: Record<string, string> = {},
  ): ProvisionalPaymentPolicy {
    return new ProvisionalPaymentPolicy({
      get: (key: string) => values[key],
    } as unknown as ConfigService);
  }

  it('is OFF by default, in every environment', () => {
    for (const env of ['test', 'development', 'staging', 'production']) {
      process.env.NODE_ENV = env;
      expect(policyWith().lateConfirmationSettlesOrder).toBe(false);
    }
  });

  it('REFUSES to activate in production without the explicit acknowledgement', () => {
    process.env.NODE_ENV = 'production';
    const policy = policyWith({ PAYMENT_LATE_CONFIRMATION_APPLIES: 'true' });
    expect(policy.lateConfirmationSettlesOrder).toBe(false);

    expect(
      policyWith({
        PAYMENT_LATE_CONFIRMATION_APPLIES: 'true',
        PROVISIONAL_PAYMENT_POLICY_ACK: 'yes please',
      }).lateConfirmationSettlesOrder,
    ).toBe(false);

    // Only the exact acknowledgement token turns it on in production.
    expect(
      policyWith({
        PAYMENT_LATE_CONFIRMATION_APPLIES: 'true',
        PROVISIONAL_PAYMENT_POLICY_ACK: PROVISIONAL_POLICY_ACK_VALUE,
      }).lateConfirmationSettlesOrder,
    ).toBe(true);
  });

  it('can be enabled outside production for development and testing', () => {
    process.env.NODE_ENV = 'development';
    expect(
      policyWith({ PAYMENT_LATE_CONFIRMATION_APPLIES: 'true' })
        .lateConfirmationSettlesOrder,
    ).toBe(true);
  });
});

describe('verifyGatewayAmount (finding 2 -- the settle decision predicate)', () => {
  const OURS = 2_000_000;

  it('VERIFIES only a present, valid, EQUAL amount', () => {
    expect(verifyGatewayAmount(OURS, OURS)).toEqual({
      verified: true,
      reason: null,
      gatewayAmount: OURS,
      gatewayAmountRaw: null,
    });
    // `amount` is read from a `bigint` column, so node-postgres hands it over
    // as a string. That must still compare equal, not be treated as a
    // discrepancy.
    expect(verifyGatewayAmount('2000000', OURS).verified).toBe(true);
    // Zero is a legitimate integer Rial figure; a zero-total order that the
    // gateway confirms for zero is not a discrepancy.
    expect(verifyGatewayAmount(0, 0).verified).toBe(true);
  });

  it('treats a MISSING amount as unverified, NOT as proven equality', () => {
    // The defect: `gatewayAmount !== null && gatewayAmount !== ours` returned
    // FALSE ("no mismatch") when the gateway reported nothing, so silence was
    // read as proof and the receipt settled the order.
    for (const missing of [null, undefined]) {
      expect(verifyGatewayAmount(OURS, missing)).toEqual({
        verified: false,
        reason: PaymentReconciliationReason.AMOUNT_MISSING,
        gatewayAmount: null,
        gatewayAmountRaw: null,
      });
    }
  });

  it('rejects an amount that cannot be an amount, and keeps it verbatim', () => {
    // Money is INTEGER RIAL end to end, so a fraction means the gateway is
    // talking about a different unit than we are.
    for (const [reported, raw] of [
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
      [-1, '-1'],
      [-OURS, '-2000000'],
      [2_000_000.5, '2000000.5'],
    ] as Array<[number, string]>) {
      expect(verifyGatewayAmount(OURS, reported)).toEqual({
        verified: false,
        reason: PaymentReconciliationReason.AMOUNT_INVALID,
        // Unusable, so nothing can go in the `bigint` column...
        gatewayAmount: null,
        // ...but the only evidence of what the gateway said is preserved.
        gatewayAmountRaw: raw,
      });
    }
  });

  it('reports an over- or underpayment as a mismatch, keeping BOTH figures', () => {
    expect(verifyGatewayAmount(OURS, OURS + 50_000)).toEqual({
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      gatewayAmount: OURS + 50_000,
      gatewayAmountRaw: null,
    });
    expect(verifyGatewayAmount(OURS, OURS - 1)).toMatchObject({
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      gatewayAmount: OURS - 1,
    });
    // A zero receipt against a real order is a shortfall, not "no amount".
    expect(verifyGatewayAmount(OURS, 0)).toMatchObject({
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      gatewayAmount: 0,
    });
    // NOTHING is rescaled: Rial vs Toman is a mismatch, never a conversion.
    expect(verifyGatewayAmount(OURS, OURS / 10)).toMatchObject({
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
    });
  });

  it('treats an unusable EXPECTED amount as unverifiable too, never as equality', () => {
    // `payment.amount` is `bigint NOT NULL`, so this is defence in depth. It
    // must still not fall through to "verified": if we cannot state what we
    // asked for, we cannot claim the gateway paid it.
    const verdict = verifyGatewayAmount('not-a-number', OURS);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe(PaymentReconciliationReason.AMOUNT_INVALID);
  });

  it('bounds the verbatim figure so a hostile gateway payload cannot bloat a row', () => {
    const verdict = verifyGatewayAmount(OURS, Number('1'.repeat(400) + '.5'));
    // (that parses to Infinity, but the bound is what is under test here)
    expect(verdict.gatewayAmountRaw?.length ?? 0).toBeLessThanOrEqual(
      GATEWAY_AMOUNT_RAW_MAX_LENGTH,
    );
  });

  it('never returns a verdict that settles AND carries a reason', () => {
    // The invariant the fix rests on: `success` now means the amount was
    // present, valid and equal, so a settling receipt cannot have an open
    // amount question. The old settle branch could write
    // `status='success'` together with `reconciliation_reason='amount_mismatch'`.
    const inputs: Array<number | null | undefined> = [
      OURS,
      OURS + 1,
      0,
      -1,
      1.5,
      Number.NaN,
      null,
      undefined,
    ];
    for (const reported of inputs) {
      const verdict = verifyGatewayAmount(OURS, reported);
      expect(verdict.verified).toBe(verdict.reason === null);
    }
  });
});

describe('StubPaymentGateway', () => {
  let gateway: StubPaymentGateway;

  beforeEach(() => {
    gateway = new StubPaymentGateway();
  });

  it('passes the amount through untouched -- money is integer Rial, with no x10', async () => {
    const { trackId } = await gateway.request({
      amount: 2_500_000,
      orderId: 1,
      callbackUrl: 'https://shop.example.test/cb',
    });
    expect(gateway.issuedFor(trackId)?.amount).toBe(2_500_000);
    const verified = await gateway.verify({ trackId });
    expect(verified.amount).toBe(2_500_000);
  });

  it('verifies successfully by default and can be programmed to fail', async () => {
    const { trackId } = await gateway.request({
      amount: 1000,
      orderId: 1,
      callbackUrl: 'https://shop.example.test/cb',
    });
    await expect(gateway.verify({ trackId })).resolves.toMatchObject({
      result: ZIBAL_RESULT.SUCCESS,
    });

    gateway.programVerify(trackId, 202);
    await expect(gateway.verify({ trackId })).resolves.toMatchObject({
      result: 202,
    });
  });

  it('can report NO amount, and does not fall back to the requested one', async () => {
    // `??` in the old implementation meant a programmed `null` silently became
    // the requested amount, which made the missing-amount case -- the one the
    // service used to read as proven equality -- impossible to reproduce.
    const { trackId } = await gateway.request({
      amount: 2_000_000,
      orderId: 1,
      callbackUrl: 'https://shop.example.test/cb',
    });
    gateway.programVerifyAmount(trackId, null);
    expect((await gateway.verify({ trackId })).amount).toBeNull();

    gateway.programVerifyAmount(trackId, undefined);
    expect((await gateway.verify({ trackId })).amount).toBeUndefined();

    // ...and an unusable figure passes through untouched, so the service's
    // refusal of it is what the test observes.
    gateway.programVerifyAmount(trackId, -1);
    expect((await gateway.verify({ trackId })).amount).toBe(-1);
  });

  it('records every call so a test can assert a replay did NOT re-hit the gateway', async () => {
    const { trackId } = await gateway.request({
      amount: 1000,
      orderId: 1,
      callbackUrl: 'https://shop.example.test/cb',
    });
    await gateway.verify({ trackId });
    expect(gateway.requestCalls).toHaveLength(1);
    expect(gateway.verifyCalls).toEqual([trackId]);
  });

  it('can simulate the gateway refusing to open a session', async () => {
    gateway.failNextRequest(new Error('gateway down'));
    await expect(
      gateway.request({
        amount: 1000,
        orderId: 1,
        callbackUrl: 'https://shop.example.test/cb',
      }),
    ).rejects.toThrow('gateway down');
    // One-shot: the next attempt succeeds again.
    await expect(
      gateway.request({
        amount: 1000,
        orderId: 1,
        callbackUrl: 'https://shop.example.test/cb',
      }),
    ).resolves.toMatchObject({ trackId: expect.any(String) });
  });
});
