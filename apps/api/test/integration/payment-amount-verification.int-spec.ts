import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import {
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from 'src/modules/payment/enums/payment-status-enum';
import { PaymentReverificationService } from 'src/modules/payment/payment-reverification.service';
import { PaymentConfig } from 'src/modules/payment/payment.config';
import { PaymentService } from 'src/modules/payment/payment.service';
import { ProvisionalPaymentPolicy } from 'src/modules/payment/provisional-policy';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  createInventoryHarness,
  fakeConfig,
  makeCatalog,
  makeOnlineOrder,
  makeUser,
  movementRows,
  orderState,
  physicalStock,
} from './support/inventory.harness';

/**
 * ============================================================================
 * FINDING 2 -- AN AMOUNT-DISCREPANT RECEIPT MUST NOT AUTHORIZE FULFILMENT
 * ============================================================================
 *
 * THE DEFECT THESE TESTS PIN DOWN
 * -------------------------------
 * `PaymentService.runPhase1` computed
 *
 *     const amountMismatch =
 *       gatewayAmount !== null && gatewayAmount !== Number(payment.amount);
 *
 * and then left it OUT of the settle decision
 *
 *     const settles = orderPayable && (!wasWrittenOff || lateConfirmationApplies);
 *
 * so a receipt for the wrong sum still became `payment.status = 'success'`,
 * flipped the order to PAID with `fulfillmentState = 'pending'`, and phase 2
 * consumed stock and shipped the goods. The discrepancy was recorded via
 * `requires_reconciliation`, but by the time an operator looked at the
 * reconciliation queue the stock was gone. Recording a problem is not refusing
 * to act on it.
 *
 * The same expression was wrong twice over: `gatewayAmount === null` -- the
 * gateway reporting NO amount -- yielded `amountMismatch = false`, so an
 * UNKNOWN amount was silently treated as PROVEN EQUALITY.
 *
 * WHAT IS ASSERTED
 * ----------------
 * Every case checks the DATABASE -- the payment row, the order row,
 * `stock_movements`, and the operator reconciliation query -- not just the
 * object `Verify()` returns. A returned object that says the right thing over a
 * database that shipped the goods is exactly the failure mode being fixed.
 *
 * NO TEST HERE TOUCHES A LIVE GATEWAY: everything runs through
 * `StubPaymentGateway` behind the `PaymentGateway` seam. Nothing here issues a
 * refund, credit or reversal, and neither does the code under test -- on any
 * path, behind any flag.
 * ============================================================================
 */
describe('payment amount verification gates settlement (finding 2)', () => {
  let h: InventoryHarness;
  let shopper: number;
  let catalog: Catalog;

  /** Builds the payment stack the way PaymentModule does. */
  function paymentStack(values: Record<string, string> = {}) {
    const configService = fakeConfig({
      PAYMENT_GATEWAY_DRIVER: 'stub',
      FULFILMENT_RECOVERY_ENABLED: 'false',
      PAYMENT_REVERIFY_ENABLED: 'false',
      ...values,
    });
    const config = new PaymentConfig(configService);
    const policy = new ProvisionalPaymentPolicy(configService);
    const payment = new PaymentService(
      h.dataSource,
      h.gateway,
      config,
      h.fulfilment,
      h.realtime,
      policy,
    );
    const reverification = new PaymentReverificationService(
      h.dataSource,
      payment,
      config,
    );
    return { config, policy, payment, reverification };
  }

  async function checkout(quantity: number): Promise<number> {
    await h.cart.create(
      { productId: catalog.productId, variantId: catalog.variantId, quantity },
      shopper,
    );
    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      { productId: catalog.productId, variantId: catalog.variantId, quantity },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.convertBasketToOrderAllocation(m, {
        userId: shopper,
        orderId,
        items: [{ variantId: catalog.variantId, quantity }],
      }),
    );
    return orderId;
  }

  interface PaymentRow {
    id: number;
    orderId: number;
    trackId: string | null;
    status: PaymentStatusEnum;
    amount: number;
    gatewayAmount: number | null;
    gatewayAmountRaw: string | null;
    refNumber: string | null;
    paidAt: Date | null;
    requiresReconciliation: boolean;
    reason: PaymentReconciliationReason | null;
    reconciledAt: Date | null;
  }

  async function paymentRows(orderId?: number): Promise<PaymentRow[]> {
    const rows: Array<Record<string, unknown>> = await h.dataSource.query(
      `SELECT id, "orderId", track_id, status::text AS status, amount,
              gateway_amount, gateway_amount_raw, ref_number, paid_at,
              requires_reconciliation, reconciliation_reason, reconciled_at
         FROM payment
        ${orderId === undefined ? '' : 'WHERE "orderId" = $1'}
        ORDER BY id ASC`,
      orderId === undefined ? [] : [orderId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      orderId: Number(r.orderId),
      trackId: r.track_id as string | null,
      status: r.status as PaymentStatusEnum,
      amount: Number(r.amount),
      gatewayAmount:
        r.gateway_amount === null ? null : Number(r.gateway_amount),
      gatewayAmountRaw: r.gateway_amount_raw as string | null,
      refNumber: r.ref_number as string | null,
      paidAt: r.paid_at as Date | null,
      requiresReconciliation: r.requires_reconciliation as boolean,
      reason: r.reconciliation_reason as PaymentReconciliationReason | null,
      reconciledAt: r.reconciled_at as Date | null,
    }));
  }

  /**
   * The reconciliation query documented on the Payment entity. An
   * amount-discrepant receipt is only actionable if this returns it.
   */
  async function needsReconciliation(): Promise<
    Array<{
      id: number;
      orderId: number;
      reason: string;
      orderStatus: string;
      recordedRial: number;
      gatewayRial: number | null;
      gatewayRaw: string | null;
    }>
  > {
    const rows: Array<Record<string, unknown>> = await h.dataSource.query(
      `SELECT p.id,
              p."orderId",
              p.track_id,
              p.ref_number,
              p.amount            AS recorded_rial,
              p.gateway_amount    AS gateway_rial,
              p.gateway_amount_raw,
              p.paid_at,
              p.reconciliation_reason,
              o.status::text      AS order_status
         FROM payment p
         JOIN orders o ON o.id = p."orderId"
        WHERE p.requires_reconciliation
          AND p.reconciled_at IS NULL
        ORDER BY p.paid_at DESC`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      orderId: Number(r.orderId),
      reason: r.reconciliation_reason as string,
      orderStatus: r.order_status as string,
      recordedRial: Number(r.recorded_rial),
      gatewayRial: r.gateway_rial === null ? null : Number(r.gateway_rial),
      gatewayRaw: r.gateway_amount_raw as string | null,
    }));
  }

  /**
   * A second, independent attempt, exactly as a retry on another device is.
   *
   * The gateway is PROGRAMMED to confirm this trackId for `amount`, because the
   * row is inserted straight into the table rather than through `Start()` and
   * the stub therefore never issued it. Without that, `verify()` would report NO
   * amount and the attempt would be an `amount_missing` receipt instead of the
   * valid one the caller means -- which is exactly the distinction this suite
   * exists to enforce, so the fixture has to be explicit about it. A test that
   * wants a discrepant amount overrides it afterwards.
   */
  async function secondAttempt(
    orderId: number,
    trackId: string,
    amount: number,
  ): Promise<number> {
    const rows: Array<{ id: number }> = await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, status, track_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING id`,
      [orderId, amount, PaymentStatusEnum.PENDING, trackId],
    );
    h.gateway.programVerifyAmount(trackId, amount);
    return Number(rows[0].id);
  }

  /**
   * Everything that must be true of an order whose only receipt was discrepant:
   * the money is on the books, and NOTHING ELSE happened.
   */
  async function expectNothingSettled(
    orderId: number,
    expected: {
      reason: PaymentReconciliationReason;
      amount: number;
      gatewayAmount: number | null;
      gatewayAmountRaw?: string | null;
      trackId: string;
    },
  ): Promise<PaymentRow> {
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // 1. THE MONEY FACT IS PERSISTED. Never `pending` (a sweeper would erase
    //    it), never `failed` (the customer did pay), never rolled back.
    expect(row.status).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
    expect(row.paidAt).not.toBeNull();
    expect(row.refNumber).toBe(`ref-${expected.trackId}`);

    // 2. BOTH FIGURES ARE KEPT. Ours is never overwritten by the gateway's,
    //    and a discrepancy is never "fixed" by adjusting a stored amount.
    expect(row.amount).toBe(expected.amount);
    expect(row.gatewayAmount).toBe(expected.gatewayAmount);
    expect(row.gatewayAmountRaw).toBe(expected.gatewayAmountRaw ?? null);

    // 3. IT IS FLAGGED, WITH THE SPECIFIC REASON.
    expect(row.requiresReconciliation).toBe(true);
    expect(row.reason).toBe(expected.reason);
    expect(row.reconciledAt).toBeNull();

    // 4. THE ORDER WAS NOT SETTLED AND ITS FULFILMENT STATE IS UNTOUCHED.
    //    This is the assertion the defect failed: it read
    //    {status: paid, fulfillmentState: fulfilled}.
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });

    // 5. NO STOCK MOVED. Not one movement row, and the physical count is
    //    exactly what it was before the callback.
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);

    // 6. NO AUTOMATIC FINANCIAL ACTION: nothing refunded anywhere, ever.
    expect(
      (await paymentRows()).filter(
        (r) => r.status === PaymentStatusEnum.REFUNDED,
      ),
    ).toHaveLength(0);

    // 7. AN OPERATOR CAN FIND IT.
    expect(await needsReconciliation()).toEqual([
      {
        id: row.id,
        orderId,
        reason: expected.reason,
        orderStatus: OrderStatusEnum.PENDING,
        recordedRial: expected.amount,
        gatewayRial: expected.gatewayAmount,
        gatewayRaw: expected.gatewayAmountRaw ?? null,
      },
    ]);

    return row;
  }

  beforeEach(async () => {
    h = await createInventoryHarness();
    shopper = await makeUser(h.dataSource, `amount-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // A1 / A2 -- under- and overpayment
  // ==========================================================================
  it('A1 - an UNDERPAYMENT settles nothing: recorded, flagged, order still PENDING, zero stock movements', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    // The gateway reports LESS than we asked for. Money is INTEGER RIAL on both
    // sides and there is no rescaling anywhere, so this really is a shortfall.
    h.gateway.programVerifyAmount(started.trackId, 1_999_000);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      // The gateway DID confirm: the customer's money moved.
      success: true,
      // ...but this receipt settled nothing.
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      // The order's ACTUAL state. A caller must never be told PAID here.
      orderStatus: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
      expectedAmount: 2_000_000,
      gatewayAmount: 1_999_000,
    });
    // Honest to the customer: money received, order not confirmed, human
    // reviewing. NOT "payment failed" -- it did not fail.
    expect(result.message).toMatch(/received and recorded/i);
    expect(result.message).toMatch(/not confirmed the order yet/i);
    expect(result.message).toMatch(/reviewing/i);
    expect(result.message).not.toMatch(/failed/i);

    await expectNothingSettled(orderId, {
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      amount: 2_000_000,
      gatewayAmount: 1_999_000,
      trackId: started.trackId,
    });
  });

  it('A2 - an OVERPAYMENT settles nothing either: more money is not consent to ship', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    h.gateway.programVerifyAmount(started.trackId, 2_050_000);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PENDING,
      expectedAmount: 2_000_000,
      gatewayAmount: 2_050_000,
    });

    await expectNothingSettled(orderId, {
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      amount: 2_000_000,
      gatewayAmount: 2_050_000,
      trackId: started.trackId,
    });
  });

  // ==========================================================================
  // A3 -- the happy path is untouched
  // ==========================================================================
  it('A3 - a MATCHING payment settles and fulfils exactly as before, with no reconciliation flag', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      success: true,
      applied: true,
      alreadyProcessed: false,
      paymentStatus: PaymentStatusEnum.SUCCESS,
      requiresReconciliation: false,
      reconciliationReason: null,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      expectedAmount: 2_000_000,
      gatewayAmount: 2_000_000,
    });

    const row = (await paymentRows(orderId))[0];
    expect(row).toMatchObject({
      status: PaymentStatusEnum.SUCCESS,
      amount: 2_000_000,
      // The verified figure is stored even though it equals ours, so an
      // operator reading one row can see WHICH sum the gateway confirmed
      // rather than inferring it from the absence of a flag.
      gatewayAmount: 2_000_000,
      gatewayAmountRaw: null,
      requiresReconciliation: false,
      reason: null,
    });
    expect(row.paidAt).not.toBeNull();

    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
    expect(await needsReconciliation()).toEqual([]);
  });

  // ==========================================================================
  // A4 -- the gateway reports NO amount
  // ==========================================================================
  it('A4 - a MISSING gateway amount is not equality: its own reason, nothing settled, zero stock movements', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    // `GatewayVerifyResult.amount` is `number | null | undefined`. The old
    // expression `gatewayAmount !== null && gatewayAmount !== ours` made THIS
    // case evaluate to "no mismatch", i.e. silence was read as proof.
    h.gateway.programVerifyAmount(started.trackId, null);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      success: true,
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      // A SEPARATE, QUERYABLE FACT -- not lumped in with `amount_mismatch`,
      // because "the gateway told us a different number" and "the gateway told
      // us nothing" need different operator responses.
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISSING,
      orderStatus: OrderStatusEnum.PENDING,
      expectedAmount: 2_000_000,
      gatewayAmount: null,
    });
    expect(result.message).toMatch(/did not give us a usable amount/i);
    expect(result.message).not.toMatch(/failed/i);

    await expectNothingSettled(orderId, {
      reason: PaymentReconciliationReason.AMOUNT_MISSING,
      amount: 2_000_000,
      gatewayAmount: null,
      trackId: started.trackId,
    });
  });

  it('A4b - `undefined` is treated exactly like `null`: the gateway still told us nothing', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    h.gateway.programVerifyAmount(started.trackId, undefined);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      applied: false,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISSING,
      orderStatus: OrderStatusEnum.PENDING,
      gatewayAmount: null,
    });
    await expectNothingSettled(orderId, {
      reason: PaymentReconciliationReason.AMOUNT_MISSING,
      amount: 2_000_000,
      gatewayAmount: null,
      trackId: started.trackId,
    });
  });

  // ==========================================================================
  // A5 -- the gateway reports something that cannot be an amount
  // ==========================================================================
  it.each([
    ['negative', -2_000_000, '-2000000'],
    ['fractional', 2_000_000.5, '2000000.5'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
  ])(
    'A5 - an INVALID gateway amount (%s) settles nothing and keeps the verbatim figure as evidence',
    async (_label, reported, raw) => {
      const { payment } = paymentStack();
      const orderId = await checkout(2);
      const started = await payment.Start(orderId, shopper);

      h.gateway.programVerifyAmount(started.trackId, reported);

      const result = await payment.Verify(started.trackId);
      expect(result).toMatchObject({
        success: true,
        applied: false,
        paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
        requiresReconciliation: true,
        reconciliationReason: PaymentReconciliationReason.AMOUNT_INVALID,
        orderStatus: OrderStatusEnum.PENDING,
        expectedAmount: 2_000_000,
        // Unusable, so it cannot go in the `bigint` column...
        gatewayAmount: null,
      });

      const row = await expectNothingSettled(orderId, {
        reason: PaymentReconciliationReason.AMOUNT_INVALID,
        amount: 2_000_000,
        gatewayAmount: null,
        // ...but the verbatim figure IS preserved, because it is the only
        // evidence of what the gateway actually said.
        gatewayAmountRaw: raw,
        trackId: started.trackId,
      });
      expect(row.gatewayAmountRaw).toBe(raw);
    },
  );

  // ==========================================================================
  // A6 -- duplicate callbacks for a discrepant receipt
  // ==========================================================================
  it('A6 - duplicate callbacks for a discrepant receipt are idempotent: no second row, no resurrection into success, no stock movement', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);
    h.gateway.programVerifyAmount(started.trackId, 2_050_000);

    const first = await payment.Verify(started.trackId);
    expect(first.paymentStatus).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
    const recordedAt = (await paymentRows(orderId))[0].paidAt;

    // A retried webhook, a customer refreshing the callback URL, a gateway
    // redelivery. The receipt is TERMINAL: no gateway round trip, no write.
    h.gateway.verifyCalls.length = 0;
    const replays = await Promise.all([
      payment.Verify(started.trackId),
      payment.Verify(started.trackId),
      payment.Verify(started.trackId),
    ]);
    for (const replay of replays) {
      expect(replay).toMatchObject({
        success: true,
        applied: false,
        alreadyProcessed: true,
        paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
        requiresReconciliation: true,
        reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
        orderStatus: OrderStatusEnum.PENDING,
        expectedAmount: 2_000_000,
        gatewayAmount: 2_050_000,
      });
    }
    // Not re-asked: a replay must not spend a gateway round trip, and must not
    // get a second chance to be talked into settling.
    expect(h.gateway.verifyCalls).toEqual([]);

    // ONE row, unchanged, still not `success`, and `paid_at` was not rewritten.
    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
    expect(rows[0].paidAt).toEqual(recordedAt);

    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    // EXACTLY ONE reconciliation entry -- four callbacks must not become four
    // items in an operator's queue.
    expect(await needsReconciliation()).toHaveLength(1);
  });

  // ==========================================================================
  // A7 -- neither recovery service can settle a discrepant receipt later
  // ==========================================================================
  it('A7 - a discrepant receipt is never swept into settling later, and fulfilment recovery finds nothing to fulfil', async () => {
    const { payment, reverification } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);
    h.gateway.programVerifyAmount(started.trackId, 2_050_000);
    await payment.Verify(started.trackId);

    // FulfilmentRecoveryService scans orders that are ALREADY `status='paid'`.
    // The discrepant receipt left this order PENDING, so there is nothing for
    // it to find -- it cannot fulfil an order no valid receipt ever settled.
    expect(await h.recovery.recover()).toMatchObject({
      scanned: 0,
      fulfilled: 0,
      awaitingStock: 0,
      failed: 0,
      orderIds: [],
    });

    // PaymentReverificationService leases only `pending`/`failed` attempts, so
    // a `confirmed_unapplied` receipt is not even a candidate -- ageing it does
    // not change that.
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '1 hour' WHERE "orderId" = $1`,
      [orderId],
    );
    h.gateway.verifyCalls.length = 0;
    expect(await reverification.sweep()).toMatchObject({
      scanned: 0,
      recovered: 0,
      unapplied: 0,
      amountUnverified: 0,
      notPaid: 0,
      errored: 0,
      paymentIds: [],
    });
    expect(h.gateway.verifyCalls).toEqual([]);

    // Still exactly as it was recorded. No resurrection, no fulfilment.
    expect((await paymentRows(orderId))[0]).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
    });
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
  });

  it('A7b - when the re-verification sweep is the thing that discovers a discrepant receipt, it records it and reports it as UNVERIFIED, not RECOVERED', async () => {
    const { payment, reverification } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    // The callback never arrived, and the sum is wrong. The sweep re-asks the
    // gateway through the same seam the callback uses, so it inherits the
    // amount rule with no second code path to keep in sync.
    h.gateway.programVerifyAmount(started.trackId, 1_000_000);
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '1 hour' WHERE id = $1`,
      [started.paymentId],
    );

    expect(await reverification.sweep()).toMatchObject({
      scanned: 1,
      // NOT `recovered`: nothing was settled.
      recovered: 0,
      unapplied: 1,
      amountUnverified: 1,
      notPaid: 0,
      errored: 0,
      paymentIds: [started.paymentId],
    });

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      amount: 2_000_000,
      gatewayAmount: 1_000_000,
    });
    expect(rows[0].paidAt).not.toBeNull();
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);

    // Bounded and terminal: a second pass has nothing to do.
    expect(await reverification.sweep()).toMatchObject({ scanned: 0 });
  });

  // ==========================================================================
  // A8 -- a discrepant receipt alongside a VALID one for the same order
  // ==========================================================================
  it('A8 - discrepant FIRST, then valid: the valid receipt still settles and fulfils exactly once, and the discrepant one stays recorded', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);

    // 1. The discrepant receipt. It settles nothing, WHICH IS THE POINT: the
    //    order is left PENDING and therefore still payable.
    const bad = await payment.Start(orderId, shopper);
    h.gateway.programVerifyAmount(bad.trackId, 2_050_000);
    const badResult = await payment.Verify(bad.trackId);
    expect(badResult).toMatchObject({
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PENDING,
    });

    // 2. The customer pays again, correctly. `uq_payment_one_success_per_order`
    //    is a partial unique index on `status = 'success'`, and the discrepant
    //    row is `confirmed_unapplied`, so it does NOT stand in the way.
    const good = await secondAttempt(orderId, 'stub-valid-retry', 2_000_000);
    const goodResult = await payment.Verify('stub-valid-retry');
    expect(goodResult).toMatchObject({
      applied: true,
      alreadyProcessed: false,
      paymentStatus: PaymentStatusEnum.SUCCESS,
      requiresReconciliation: false,
      reconciliationReason: null,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      expectedAmount: 2_000_000,
      gatewayAmount: 2_000_000,
    });

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(2);
    // The discrepant receipt is INDEPENDENTLY recorded and still flagged; the
    // valid one settling the order does not absolve it.
    expect(rows.find((r) => r.id === bad.paymentId)).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      amount: 2_000_000,
      gatewayAmount: 2_050_000,
    });
    expect(rows.find((r) => r.id === good)).toMatchObject({
      status: PaymentStatusEnum.SUCCESS,
      requiresReconciliation: false,
      reason: null,
    });
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.SUCCESS),
    ).toHaveLength(1);

    // STOCK MOVED EXACTLY ONCE.
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0].delta).toBe(-2);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);

    expect((await needsReconciliation()).map((r) => r.id)).toEqual([
      bad.paymentId,
    ]);
  });

  it('A8b - valid FIRST, then discrepant: the discrepant receipt is recorded and ships nothing extra', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);

    const good = await payment.Start(orderId, shopper);
    await payment.Verify(good.trackId);

    // A second card charged for the wrong sum after the order was settled.
    await secondAttempt(orderId, 'stub-late-discrepant', 2_000_000);
    h.gateway.programVerifyAmount('stub-late-discrepant', 2_050_000);
    const badResult = await payment.Verify('stub-late-discrepant');

    expect(badResult).toMatchObject({
      success: true,
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      // PRECEDENCE: the AMOUNT fact wins over DUPLICATE_CONFIRMED. Until the
      // sum is established an operator cannot decide what the duplicate is
      // worth -- a duplicate of a known sum and of an unknown sum are
      // different problems. (Documented on PaymentReconciliationReason.)
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PAID,
      expectedAmount: 2_000_000,
      gatewayAmount: 2_050_000,
    });

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.SUCCESS),
    ).toHaveLength(1);
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.PENDING),
    ).toHaveLength(0);
    const unapplied = rows.filter(
      (r) => r.status === PaymentStatusEnum.CONFIRMED_UNAPPLIED,
    );
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].paidAt).not.toBeNull();

    // Stock moved once, for the receipt that actually settled the order.
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);
    expect(await needsReconciliation()).toHaveLength(1);
  });

  it('A8c - a discrepant and a valid callback racing CONCURRENTLY: exactly one settles, exactly one fulfilment, both receipts recorded', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(3);

    const good = await payment.Start(orderId, shopper);
    await secondAttempt(orderId, 'stub-race-discrepant', 3_000_000);
    h.gateway.programVerifyAmount('stub-race-discrepant', 3_500_000);

    const results = await Promise.all([
      payment.Verify(good.trackId).catch((e: Error) => e),
      payment.Verify('stub-race-discrepant').catch((e: Error) => e),
    ]);
    for (const result of results) expect(result).not.toBeInstanceOf(Error);

    // ONE fulfilment. 10 - 3, never 10 - 6.
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0].delta).toBe(-3);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.SUCCESS),
    ).toHaveLength(1);
    // Whichever way the race went, the discrepant receipt is recorded, flagged
    // and NOT `success` -- and nothing is left `pending`, which cannot describe
    // confirmed money.
    const discrepant = rows.find((r) => r.trackId === 'stub-race-discrepant');
    expect(discrepant).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      amount: 3_000_000,
      gatewayAmount: 3_500_000,
    });
    expect(discrepant?.paidAt).not.toBeNull();
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.PENDING),
    ).toHaveLength(0);
    expect(await needsReconciliation()).toHaveLength(1);
  });

  // ==========================================================================
  // A9 -- Start()'s abandoned-attempt sweep must not erase a confirmed receipt
  // ==========================================================================
  it('A9 - Start() never writes a confirmed_unapplied receipt off as failed, however old it is', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);

    const bad = await payment.Start(orderId, shopper);
    h.gateway.programVerifyAmount(bad.trackId, 2_050_000);
    await payment.Verify(bad.trackId);

    // Age the receipt well past `PAYMENT_PENDING_REUSE_MS`. `Start()`'s sweep
    // is `UPDATE payment SET status='failed' WHERE "orderId"=$1 AND
    // status='pending' AND created_at < now() - ...`: it is scoped to `pending`
    // ONLY, which is precisely why a confirmed receipt is not left `pending`.
    // Recording real money as "not paid yet" is what let the old code erase it.
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '3 hours' WHERE id = $1`,
      [bad.paymentId],
    );

    // The order is still PENDING, so the customer can genuinely retry.
    const retry = await payment.Start(orderId, shopper);
    expect(retry.trackId).not.toBe(bad.trackId);
    // A `confirmed_unapplied` row is not reusable as a live attempt either.
    expect(retry.reused).toBe(false);

    const rows = await paymentRows(orderId);
    const receipt = rows.find((r) => r.id === bad.paymentId);
    expect(receipt).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      gatewayAmount: 2_050_000,
    });
    expect(receipt?.paidAt).not.toBeNull();
    // And the retry can still settle the order, which is the whole reason the
    // discrepant receipt was allowed to leave it PENDING.
    const settled = await payment.Verify(retry.trackId);
    expect(settled).toMatchObject({
      applied: true,
      paymentStatus: PaymentStatusEnum.SUCCESS,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
    // The receipt survived the whole sequence untouched.
    expect(
      (await paymentRows(orderId)).find((r) => r.id === bad.paymentId)?.status,
    ).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
  });

  // ==========================================================================
  // A10 -- the amount rule is not behind a policy flag
  // ==========================================================================
  it('A10 - even with the PROVISIONAL late-payment policy ON, a discrepant late confirmation settles nothing', async () => {
    // The provisional policy governs ONE question: may a LATE confirmation
    // settle a still-payable order? It has never governed, and must never
    // govern, whether an UNVERIFIED amount may settle one -- that is not a
    // business policy, it is a defect.
    const { payment } = paymentStack({
      PAYMENT_LATE_CONFIRMATION_APPLIES: 'true',
    });
    const orderId = await checkout(2);

    const abandoned = await payment.Start(orderId, shopper);
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '1 hour' WHERE id = $1`,
      [abandoned.paymentId],
    );
    await payment.Start(orderId, shopper);
    expect((await paymentRows(orderId))[0].status).toBe(
      PaymentStatusEnum.FAILED,
    );

    h.gateway.programVerifyAmount(abandoned.trackId, 2_050_000);
    const late = await payment.Verify(abandoned.trackId);

    expect(late).toMatchObject({
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      // The amount fact, NOT `late_confirmation_applied` and NOT
      // `late_confirmation_unapplied`.
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PENDING,
      expectedAmount: 2_000_000,
      gatewayAmount: 2_050_000,
    });
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
  });

  // ==========================================================================
  // A11 -- the schema itself refuses an unknown reason
  // ==========================================================================
  it('A11 - ck_payment_reconciliation_reason admits the three amount reasons and still rejects anything else', async () => {
    const orderId = await checkout(1);
    const paymentId = await secondAttempt(orderId, 'stub-check', 1_000_000);

    for (const reason of [
      PaymentReconciliationReason.AMOUNT_MISMATCH,
      PaymentReconciliationReason.AMOUNT_MISSING,
      PaymentReconciliationReason.AMOUNT_INVALID,
      PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      PaymentReconciliationReason.ORDER_NOT_PAYABLE,
      PaymentReconciliationReason.LATE_CONFIRMATION_UNAPPLIED,
      PaymentReconciliationReason.LATE_CONFIRMATION_APPLIED,
    ]) {
      await expect(
        h.dataSource.query(
          `UPDATE payment SET reconciliation_reason = $2 WHERE id = $1`,
          [paymentId, reason],
        ),
      ).resolves.toBeDefined();
    }

    // The CHECK is still a guard, not a rubber stamp: migration 0016 rebuilt it
    // rather than dropping it.
    await expect(
      h.dataSource.query(
        `UPDATE payment SET reconciliation_reason = 'amount_probably_fine' WHERE id = $1`,
        [paymentId],
      ),
    ).rejects.toThrow(/ck_payment_reconciliation_reason/);
  });
});
