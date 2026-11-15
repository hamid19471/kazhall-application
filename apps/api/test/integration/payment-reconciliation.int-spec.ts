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
 * FINDING E -- PAYMENT FACTS vs FULFILMENT IDEMPOTENCY
 * ============================================================================
 *
 * The defect: when the gateway had CONFIRMED a second payment for an order that
 * was already PAID (or `uq_payment_one_success_per_order` raised 23505),
 * `runPhase1` returned `{alreadyProcessed:true}` and LEFT THAT ROW `pending`.
 * The books denied receiving money the business had received, and `Start()`
 * would later sweep the row to `failed`, destroying the record entirely.
 *
 * These tests pin the three concerns apart:
 *   1. every gateway confirmation is persisted with an honest state;
 *   2. duplicates/overpayments are a separate, queryable reconciliation state
 *      with NO automatic financial action;
 *   3. exactly-once fulfilment is enforced at the order/fulfilment layer.
 *
 * NO TEST HERE TOUCHES A LIVE GATEWAY. Everything goes through
 * `StubPaymentGateway` behind the `PaymentGateway` seam. Nothing here issues a
 * refund or any other financial action, and neither does the code under test.
 */
describe('payment reconciliation and receipt honesty (finding E)', () => {
  let h: InventoryHarness;
  let shopper: number;
  let catalog: Catalog;

  /**
   * Builds the payment stack the way PaymentModule does, so a test can choose
   * its configuration (and whether the PROVISIONAL late-payment policy exists
   * at all) without touching the shared harness.
   */
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
    refNumber: string | null;
    paidAt: Date | null;
    requiresReconciliation: boolean;
    reason: PaymentReconciliationReason | null;
  }

  async function paymentRows(orderId?: number): Promise<PaymentRow[]> {
    const rows: Array<Record<string, unknown>> = await h.dataSource.query(
      `SELECT id, "orderId", track_id, status::text AS status, amount,
              gateway_amount, ref_number, paid_at,
              requires_reconciliation, reconciliation_reason
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
      refNumber: r.ref_number as string | null,
      paidAt: r.paid_at as Date | null,
      requiresReconciliation: r.requires_reconciliation as boolean,
      reason: r.reconciliation_reason as PaymentReconciliationReason | null,
    }));
  }

  /**
   * The reconciliation query documented on the Payment entity, verbatim in
   * substance. If this stops returning the right rows, the comment on the
   * entity is a lie and this test says so.
   */
  async function needsReconciliation(): Promise<
    Array<{ id: number; orderId: number; reason: string; orderStatus: string }>
  > {
    const rows: Array<Record<string, unknown>> = await h.dataSource.query(
      `SELECT p.id,
              p."orderId",
              p.track_id,
              p.ref_number,
              p.amount            AS recorded_rial,
              p.gateway_amount    AS gateway_rial,
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
    }));
  }

  /**
   * Inserts a second, independent attempt exactly as a retry on another device
   * would.
   *
   * The gateway is PROGRAMMED to confirm this trackId for `amount`. The row is
   * inserted straight into the table rather than opened through `Start()`, so
   * the stub never issued the trackId and `verify()` would otherwise report NO
   * amount for it. Every case below means "a real duplicate receipt for the
   * right sum", and since finding 2 an unstated gateway amount is no longer
   * read as agreement -- it is an `amount_missing` receipt that settles
   * nothing. Making the fixture state the amount keeps these tests about
   * DUPLICATION, which is what they are for; the amount rule itself is covered
   * in test/integration/payment-amount-verification.int-spec.ts.
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

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(async () => {
    h = await createInventoryHarness();
    shopper = await makeUser(h.dataSource, `recon-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // E1 -- two DIFFERENT confirmed payments for one order
  // ==========================================================================
  it('E1 - both confirmed receipts are persisted honestly, the order is paid once, and the duplicate is queryable', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(3);

    const first = await payment.Start(orderId, shopper);
    const duplicateTrack = 'stub-duplicate-device';
    await secondAttempt(orderId, duplicateTrack, 3_000_000);

    const settled = await payment.Verify(first.trackId);
    expect(settled).toMatchObject({
      success: true,
      applied: true,
      alreadyProcessed: false,
      paymentStatus: PaymentStatusEnum.SUCCESS,
      requiresReconciliation: false,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });

    // The customer's second card is charged too. THE MONEY IS REAL.
    const duplicate = await payment.Verify(duplicateTrack);
    expect(duplicate).toMatchObject({
      success: true,
      // ...but it did NOT settle the order.
      applied: false,
      alreadyProcessed: true,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      orderStatus: OrderStatusEnum.PAID,
    });
    expect(duplicate.message).toMatch(/not applied to this order/i);

    const rows = await paymentRows(orderId);
    expect(rows).toHaveLength(2);
    // 1. The settling receipt.
    expect(rows[0]).toMatchObject({
      status: PaymentStatusEnum.SUCCESS,
      requiresReconciliation: false,
      reason: null,
    });
    expect(rows[0].paidAt).not.toBeNull();
    // 2. The duplicate. NOT `pending` -- that was the defect: it claimed the
    //    customer had not paid, and Start() would later sweep it to `failed`.
    expect(rows[1]).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reason: PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      amount: 3_000_000,
      refNumber: `ref-${duplicateTrack}`,
    });
    expect(rows[1].paidAt).not.toBeNull();

    // Exactly one fulfilment, exactly one settling payment.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
    const successes = rows.filter(
      (r) => r.status === PaymentStatusEnum.SUCCESS,
    );
    expect(successes).toHaveLength(1);

    // The documented reconciliation query finds the duplicate, and only it.
    const outstanding = await needsReconciliation();
    expect(outstanding).toEqual([
      {
        id: rows[1].id,
        orderId,
        reason: PaymentReconciliationReason.DUPLICATE_CONFIRMED,
        orderStatus: OrderStatusEnum.PAID,
      },
    ]);

    // NO AUTOMATIC FINANCIAL ACTION: nothing was refunded, no state invented.
    const refunded = rows.filter(
      (r) => r.status === PaymentStatusEnum.REFUNDED,
    );
    expect(refunded).toHaveLength(0);
  });

  // ==========================================================================
  // E2 -- late confirmation, after the attempt was already marked `failed`
  // ==========================================================================
  it('E2 - a confirmation arriving after the attempt was written off is recorded, not swallowed (provisional policy OFF)', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);

    const abandoned = await payment.Start(orderId, shopper);
    // The customer walks away; the reuse window passes and the next Start()
    // writes the attempt off, exactly as the production sweep does.
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '1 hour' WHERE id = $1`,
      [abandoned.paymentId],
    );
    const retry = await payment.Start(orderId, shopper);
    expect(retry.trackId).not.toBe(abandoned.trackId);
    expect((await paymentRows(orderId))[0].status).toBe(
      PaymentStatusEnum.FAILED,
    );

    // ...and only THEN does the gateway confirm the abandoned attempt.
    const late = await payment.Verify(abandoned.trackId);
    expect(late).toMatchObject({
      success: true,
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reconciliationReason:
        PaymentReconciliationReason.LATE_CONFIRMATION_UNAPPLIED,
      orderStatus: OrderStatusEnum.PENDING,
    });

    // The money is on the books with a `paid_at` from the database clock...
    const rows = await paymentRows(orderId);
    expect(rows[0]).toMatchObject({
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      refNumber: `ref-${abandoned.trackId}`,
    });
    expect(rows[0].paidAt).not.toBeNull();
    // ...it was NOT resurrected into `success`, the order was NOT settled by an
    // unapproved policy, and no stock moved.
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect((await needsReconciliation()).map((r) => r.id)).toEqual([
      rows[0].id,
    ]);

    // A second callback for the same receipt is terminal: no gateway round trip
    // and no change of state.
    h.gateway.verifyCalls.length = 0;
    const replay = await payment.Verify(abandoned.trackId);
    expect(replay).toMatchObject({
      applied: false,
      alreadyProcessed: true,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
    });
    expect(h.gateway.verifyCalls).toEqual([]);
  });

  it('E2b - the PROVISIONAL late-payment policy, when explicitly enabled, settles a still-payable order and says so on the record', async () => {
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

    const late = await payment.Verify(abandoned.trackId);
    expect(late).toMatchObject({
      applied: true,
      paymentStatus: PaymentStatusEnum.SUCCESS,
      // The books balance (one order, one settling receipt), so this is
      // informational rather than an outstanding reconciliation item.
      requiresReconciliation: false,
      reconciliationReason:
        PaymentReconciliationReason.LATE_CONFIRMATION_APPLIED,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await needsReconciliation()).toEqual([]);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);
  });

  // ==========================================================================
  // E3 -- confirmation after the order left a payable state
  // ==========================================================================
  it('E3 - a confirmation arriving after the order was CANCELED is recorded and flagged, and fulfils nothing', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    await h.dataSource.query(`UPDATE orders SET status = $2 WHERE id = $1`, [
      orderId,
      OrderStatusEnum.CANCELED,
    ]);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      success: true,
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.ORDER_NOT_PAYABLE,
      // The old implementation hardcoded PAID here, which was simply a lie.
      orderStatus: OrderStatusEnum.CANCELED,
    });

    const rows = await paymentRows(orderId);
    expect(rows[0].status).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
    expect(rows[0].paidAt).not.toBeNull();
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.CANCELED,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect((await needsReconciliation())[0]).toMatchObject({
      orderId,
      reason: PaymentReconciliationReason.ORDER_NOT_PAYABLE,
      orderStatus: OrderStatusEnum.CANCELED,
    });
  });

  it('E4 - a confirmation arriving after the order has moved on (SHIPPED) is recorded as a duplicate, and ships nothing twice', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(1);

    const settled = await payment.Start(orderId, shopper);
    await payment.Verify(settled.trackId);
    await h.dataSource.query(`UPDATE orders SET status = $2 WHERE id = $1`, [
      orderId,
      OrderStatusEnum.SHIPPED,
    ]);

    const lateTrack = 'stub-late-after-shipping';
    await secondAttempt(orderId, lateTrack, 1_000_000);
    const late = await payment.Verify(lateTrack);

    expect(late).toMatchObject({
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      // A settling payment already exists, so this is a duplicate receipt --
      // the more specific and more actionable of the two possible reasons.
      reconciliationReason: PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      orderStatus: OrderStatusEnum.SHIPPED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(9);
  });

  // ==========================================================================
  // E5 -- concurrent Start() while the first gateway request is in flight
  // ==========================================================================
  it('E5 - a concurrent Start() waits for the in-flight session instead of opening a second one', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);

    // Freeze the gateway mid-request: this is the window in which the old code
    // saw a pending row with a NULL track_id, decided it was not reusable, and
    // opened a SECOND gateway session for the same order.
    const release = h.gateway.holdRequests();
    const firstCall = payment.Start(orderId, shopper);
    await waitFor(() => h.gateway.requestCalls.length === 1);

    const secondCall = payment.Start(orderId, shopper);
    // Give the second caller time to decide. It must NOT call the gateway.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.gateway.requestCalls).toHaveLength(1);

    release();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(second.trackId).toBe(first.trackId);
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.reused).toBe(true);
    // ONE gateway session, ONE payment row: one way for the customer to pay.
    expect(h.gateway.requestCalls).toHaveLength(1);
    expect(await paymentRows(orderId)).toHaveLength(1);
  });

  it('E5b - if the in-flight attempt never lands, the caller is told plainly and still gets no second session', async () => {
    // 200ms bounded wait so the test does not sit on the 10s default.
    const { payment } = paymentStack({
      PAYMENT_START_INFLIGHT_WAIT_MS: '200',
      PAYMENT_START_INFLIGHT_POLL_MS: '20',
    });
    const orderId = await checkout(2);

    // Another process reserved an attempt and then stopped existing.
    await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())`,
      [orderId, 2_000_000, PaymentStatusEnum.PENDING],
    );

    await expect(payment.Start(orderId, shopper)).rejects.toThrow(
      /already being opened/i,
    );
    expect(h.gateway.requestCalls).toHaveLength(0);
    expect(await paymentRows(orderId)).toHaveLength(1);
  });

  // ==========================================================================
  // E6 -- crash after external confirmation, before local recording
  // ==========================================================================
  it('E6 - a receipt confirmed by the gateway but never recorded locally is recovered by the re-verification sweep', async () => {
    const { payment, reverification } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    // The gateway confirms, and the process dies before phase 1 commits.
    const crash = jest
      .spyOn(h.dataSource, 'transaction')
      .mockRejectedValueOnce(
        new Error('SIGKILL after gateway confirmation, before phase 1 commit'),
      );
    await expect(payment.Verify(started.trackId)).rejects.toThrow(/SIGKILL/);
    crash.mockRestore();

    // The gateway HAD confirmed -- the money is real...
    expect(h.gateway.verifyCalls).toEqual([started.trackId]);
    // ...and locally there is no trace of it beyond the unfinished attempt.
    expect((await paymentRows(orderId))[0]).toMatchObject({
      status: PaymentStatusEnum.PENDING,
      paidAt: null,
    });
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    // FulfilmentRecoveryService cannot help here: it only scans orders that are
    // ALREADY `status='paid'`, and this one never got there.
    expect(await h.recovery.recover()).toMatchObject({ scanned: 0 });

    // The attempt ages past the re-verification threshold and the sweep asks
    // the gateway again, through the same seam the callback uses.
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '1 hour' WHERE "orderId" = $1`,
      [orderId],
    );
    const report = await reverification.sweep();
    expect(report).toMatchObject({
      scanned: 1,
      recovered: 1,
      unapplied: 0,
      notPaid: 0,
      errored: 0,
    });

    expect((await paymentRows(orderId))[0]).toMatchObject({
      status: PaymentStatusEnum.SUCCESS,
    });
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);

    // Bounded: the attempt is no longer eligible, so a second pass is a no-op.
    expect(await reverification.sweep()).toMatchObject({ scanned: 0 });
  });

  it('E6b - what the sweep does NOT recover: an attempt with no track_id, and an abandoned checkout', async () => {
    const { payment, reverification } = paymentStack();

    // (1) A crash between the gateway issuing a session and Start() writing the
    // trackId down. There is NO local handle to ask the gateway about, and this
    // codebase has no settlement-report integration, so NOTHING here can
    // recover such a receipt. The sweep does not pretend otherwise: the row is
    // not even a candidate.
    const orphanOrder = await checkout(1);
    const orphan: Array<{ id: number }> = await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, now() - interval '1 hour', now())
       RETURNING id`,
      [orphanOrder, 1_000_000, PaymentStatusEnum.PENDING],
    );

    // (2) An ordinary abandoned checkout: the gateway says "not paid". That is
    // the healthy majority of the queue and is not an error.
    const abandonedOrder = await checkout(1);
    const started = await payment.Start(abandonedOrder, shopper);
    h.gateway.programVerify(started.trackId, 202);
    await h.dataSource.query(
      `UPDATE payment SET created_at = created_at - interval '1 hour' WHERE id = $1`,
      [started.paymentId],
    );

    const report = await reverification.sweep();
    expect(report.paymentIds).toEqual([started.paymentId]);
    expect(report.paymentIds).not.toContain(Number(orphan[0].id));
    expect(report).toMatchObject({
      scanned: 1,
      recovered: 0,
      notPaid: 1,
      errored: 0,
    });

    // The un-askable attempt is untouched and still visible to an operator.
    const orphanRow = (await paymentRows(orphanOrder))[0];
    expect(orphanRow).toMatchObject({
      status: PaymentStatusEnum.PENDING,
      trackId: null,
    });
    // The abandoned one is honestly `failed`; no money was invented.
    expect((await paymentRows(abandonedOrder))[0]).toMatchObject({
      status: PaymentStatusEnum.FAILED,
      paidAt: null,
    });
  });

  // ==========================================================================
  // E7 -- exactly-once fulfilment under concurrent verify callbacks
  // ==========================================================================
  it('E7 - concurrent callbacks (two attempts plus a replay) fulfil exactly once and record both receipts', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(3);

    const first = await payment.Start(orderId, shopper);
    const duplicateTrack = 'stub-concurrent-duplicate';
    await secondAttempt(orderId, duplicateTrack, 3_000_000);

    const results = await Promise.all([
      payment.Verify(first.trackId).catch((e: Error) => e),
      payment.Verify(duplicateTrack).catch((e: Error) => e),
      payment.Verify(first.trackId).catch((e: Error) => e),
    ]);
    for (const result of results) expect(result).not.toBeInstanceOf(Error);

    // Stock moved once. 10 - 3, never 10 - 6.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0].delta).toBe(-3);

    // Exactly one settling receipt; the other is recorded, not hidden.
    const rows = await paymentRows(orderId);
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.SUCCESS),
    ).toHaveLength(1);
    const unapplied = rows.filter(
      (r) => r.status === PaymentStatusEnum.CONFIRMED_UNAPPLIED,
    );
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].requiresReconciliation).toBe(true);
    expect(unapplied[0].paidAt).not.toBeNull();
    // NOTHING is left `pending`: that state cannot describe confirmed money.
    expect(
      rows.filter((r) => r.status === PaymentStatusEnum.PENDING),
    ).toHaveLength(0);
    expect(await needsReconciliation()).toHaveLength(1);
  });

  // ==========================================================================
  // E8 -- overpayment / underpayment (REWRITTEN, FINDING 2)
  // ==========================================================================
  /**
   * WHAT THIS TEST USED TO ASSERT, AND WHY THAT WAS WRONG
   * -----------------------------------------------------
   * It asserted `applied: true`, `paymentStatus: SUCCESS`, `orderStatus: PAID`
   * and `fulfillmentState: FULFILLED` for an OVERPAYMENT -- i.e. it pinned the
   * defect in place as if it were the specification. `runPhase1` computed an
   * `amountMismatch` flag and then left it out of the settle decision, so a
   * receipt for the wrong sum settled the order and phase 2 consumed stock and
   * shipped the goods; the flag was only discoverable afterwards, when the
   * stock was already gone.
   *
   * The rewrite asserts STRICTLY MORE than the original did. It keeps every
   * assertion that was still correct (both figures kept, the receipt flagged,
   * the operator query finding it) and adds the ones that were missing:
   *   - the receipt is `confirmed_unapplied`, not `success`;
   *   - `applied` is false and `requiresReconciliation` is true;
   *   - THE ORDER ROW IS UNCHANGED: still PENDING, `fulfillmentState`
   *     untouched, `paid_at` still NULL;
   *   - `stock_movements` IS EMPTY and the physical count is unchanged --
   *     the assertion the old behaviour could not have passed;
   *   - the customer-facing message is honest (money received, order not
   *     confirmed, human reviewing) and does not say the payment failed;
   *   - a duplicate callback does not resurrect the receipt into `success`.
   *
   * Under/over payment, missing and invalid gateway amounts, races with a valid
   * receipt, and both recovery services are covered exhaustively in
   * test/integration/payment-amount-verification.int-spec.ts.
   */
  it('E8 - a gateway amount that differs from the recorded one SETTLES NOTHING: recorded and flagged, order untouched, no stock moved', async () => {
    const { payment } = paymentStack();
    const orderId = await checkout(2);
    const started = await payment.Start(orderId, shopper);

    // The gateway reports MORE than we asked for. Money is INTEGER RIAL on both
    // sides -- there is no rescaling anywhere, so this really is a discrepancy.
    h.gateway.programVerifyAmount(started.trackId, 2_050_000);

    const result = await payment.Verify(started.trackId);
    expect(result).toMatchObject({
      // The gateway confirmed: the money is real and is recorded as such.
      success: true,
      // ...but it did NOT settle the order, and nothing was fulfilled.
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    // The customer is told the truth on all three counts, and is NOT told the
    // payment failed -- it did not.
    expect(result.message).toMatch(/received and recorded/i);
    expect(result.message).toMatch(/not confirmed the order yet/i);
    expect(result.message).not.toMatch(/failed/i);

    const row = (await paymentRows(orderId))[0];
    // OUR figure is not overwritten; the gateway's is kept beside it. That is
    // the whole evidence of the discrepancy, and neither is ever adjusted to
    // make the other fit.
    expect(row.amount).toBe(2_000_000);
    expect(row.gatewayAmount).toBe(2_050_000);
    // The money fact is persisted with a `paid_at` from the database clock; the
    // confirmation is never rolled back or erased.
    expect(row.status).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
    expect(row.paidAt).not.toBeNull();
    expect(row.refNumber).toBe(`ref-${started.trackId}`);

    // THE ORDER WAS NOT SETTLED AND NOTHING SHIPPED. These are the assertions
    // the old behaviour would fail, and the reason the rewrite is stronger.
    const order: Array<{ status: string; paid_at: Date | null }> =
      await h.dataSource.query(
        `SELECT status::text AS status, paid_at FROM orders WHERE id = $1`,
        [orderId],
      );
    expect(order[0].status).toBe(OrderStatusEnum.PENDING);
    expect(order[0].paid_at).toBeNull();
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);

    // Exactly one reconciliation item, with both figures on it.
    expect(await needsReconciliation()).toHaveLength(1);
    expect((await needsReconciliation())[0]).toMatchObject({
      id: row.id,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PENDING,
    });

    // NO AUTOMATIC FINANCIAL ACTION anywhere on this path.
    expect(
      (await paymentRows(orderId)).filter(
        (r) => r.status === PaymentStatusEnum.REFUNDED,
      ),
    ).toHaveLength(0);

    // A duplicate callback is terminal: no gateway round trip, and no
    // resurrection into `success`.
    h.gateway.verifyCalls.length = 0;
    const replay = await payment.Verify(started.trackId);
    expect(replay).toMatchObject({
      applied: false,
      alreadyProcessed: true,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      orderStatus: OrderStatusEnum.PENDING,
    });
    expect(h.gateway.verifyCalls).toEqual([]);
    expect(await paymentRows(orderId)).toHaveLength(1);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
  });
});
