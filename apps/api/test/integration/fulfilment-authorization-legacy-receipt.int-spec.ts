import { Logger } from '@nestjs/common';

import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import {
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from 'src/modules/payment/enums/payment-status-enum';
import { FulfilmentBlockedReason } from 'src/modules/payment/fulfilment.service';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  createInventoryHarness,
  makeBranch,
  makeCatalog,
  makeOnlineOrder,
  makePosOrder,
  makeUser,
  movementRows,
  orderState,
  physicalStock,
  reservationRows,
} from './support/inventory.harness';

/**
 * ============================================================================
 * FINDING 1 -- A LEGACY UNVERIFIED `success` RECEIPT MUST NOT AUTHORIZE *NEW*
 *              FULFILMENT
 * ============================================================================
 *
 * THE ROW SET UNDER TEST
 * ----------------------
 *     payment.status                = success
 *     payment.amount                = 1000000
 *     payment.gateway_amount        =  500000
 *     payment.reconciliation_reason = amount_mismatch
 *     orders.status                 = paid
 *     orders."fulfillmentState"     = pending
 *
 * It is planted with RAW SQL because that is the only way to create it now: the
 * current settle decision (migration 0016 / finding 2) refuses to write
 * `success` for a receipt whose amount is not present, valid and equal, so no
 * code path in the repository can produce this combination any more. It exists
 * only as HISTORY, written by the pre-fix decision -- and history is never
 * rewritten here, which is exactly why the fulfilment side has to defend
 * itself.
 *
 * The order is PAID BUT NOT YET FULFILLED. Three entry points reach stock
 * consumption, and all three are exercised below:
 *
 *   1. the gateway callback -- `PaymentService.Verify()`'s duplicate-callback
 *      replay, which logged the legacy mismatch and then drove phase 2 anyway;
 *   2. the recovery worker -- `FulfilmentRecoveryService.recover()`;
 *   3. a direct/manual `FulfilmentService.drive()`.
 *
 * WHAT IS ASSERTED
 * ----------------
 * THE DATABASE, not the returned object: `stock_movements`,
 * `product_variants.stock`, the `orders` row and the `payment` rows. A returned
 * object that says the right thing over a database that shipped the goods is
 * the precise failure mode being fixed. The returned object is checked too, as
 * a contract, but never instead.
 *
 * NO TEST HERE TOUCHES A LIVE GATEWAY: everything runs through
 * `StubPaymentGateway` behind the `PaymentGateway` seam. Nothing here issues a
 * refund, credit or reversal, and neither does the code under test -- on any
 * path, behind any flag. No test rewrites or deletes a payment row except where
 * it explicitly simulates a HUMAN reconciliation decision, and it says so where
 * it does.
 * ============================================================================
 */
describe('fulfilment authorization -- a legacy unverified success receipt cannot authorize new fulfilment (finding 1)', () => {
  let h: InventoryHarness;
  let shopper: number;
  let catalog: Catalog;
  let branchId: number;

  const UNIT_PRICE = 1_000_000;

  /** A PENDING online order with a live order allocation, ready to be paid. */
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

  interface PlantedPayment {
    status: PaymentStatusEnum;
    amount: number;
    gatewayAmount: number | null;
    reason: PaymentReconciliationReason | null;
    requiresReconciliation?: boolean;
    trackId: string;
  }

  /**
   * Inserts one `payment` row verbatim.
   *
   * TEST-ONLY BACK DOOR, exactly like `backdateReservations` in the harness. It
   * exists because the row shapes this suite is about are unreachable through
   * the service, and it is the reviewer's own method for planting them.
   */
  async function plantPayment(
    orderId: number,
    row: PlantedPayment,
  ): Promise<number> {
    const rows: Array<{ id: number }> = await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, status, track_id,
                            paid_at, ref_number,
                            requires_reconciliation, reconciliation_reason,
                            created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, now(), now())
       RETURNING id`,
      [
        orderId,
        row.amount,
        row.gatewayAmount,
        row.status,
        row.trackId,
        `ref-${row.trackId}`,
        row.requiresReconciliation ?? row.reason !== null,
        row.reason,
      ],
    );
    return Number(rows[0].id);
  }

  /** Puts an order into the settled-but-unfulfilled state, in raw SQL. */
  async function plantOrderPaid(
    orderId: number,
    state: FulfillmentStateEnum,
  ): Promise<void> {
    await h.dataSource.query(
      `UPDATE orders
          SET status = $2::orders_status_enum,
              paid_at = now(),
              "fulfillmentState" = $3::orders_fulfillmentstate_enum
        WHERE id = $1`,
      [orderId, OrderStatusEnum.PAID, state],
    );
  }

  /**
   * THE REVIEWER'S ROW SET. Returns the order id and the legacy receipt's
   * trackId, which is what the duplicate-callback replay is driven with.
   */
  async function plantLegacyUnverifiedSuccess(
    quantity: number,
    state: FulfillmentStateEnum = FulfillmentStateEnum.PENDING,
    trackId = `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  ): Promise<{ orderId: number; trackId: string; paymentId: number }> {
    const orderId = await checkout(quantity);
    const paymentId = await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: UNIT_PRICE * quantity,
      // Half the money, exactly as the reviewer planted it.
      gatewayAmount: (UNIT_PRICE * quantity) / 2,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      requiresReconciliation: true,
      trackId,
    });
    await plantOrderPaid(orderId, state);
    return { orderId, trackId, paymentId };
  }

  interface PaymentSnapshot {
    id: number;
    status: PaymentStatusEnum;
    amount: number;
    gatewayAmount: number | null;
    reason: PaymentReconciliationReason | null;
    requiresReconciliation: boolean;
    reconciledAt: Date | null;
    paidAt: Date | null;
  }

  async function paymentRows(orderId: number): Promise<PaymentSnapshot[]> {
    const rows: Array<Record<string, unknown>> = await h.dataSource.query(
      `SELECT id, status::text AS status, amount, gateway_amount,
              reconciliation_reason, requires_reconciliation, reconciled_at, paid_at
         FROM payment WHERE "orderId" = $1 ORDER BY id ASC`,
      [orderId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      status: r.status as PaymentStatusEnum,
      amount: Number(r.amount),
      gatewayAmount:
        r.gateway_amount === null ? null : Number(r.gateway_amount),
      reason: r.reconciliation_reason as PaymentReconciliationReason | null,
      requiresReconciliation: r.requires_reconciliation as boolean,
      reconciledAt: r.reconciled_at as Date | null,
      paidAt: r.paid_at as Date | null,
    }));
  }

  async function lastFulfilmentError(orderId: number): Promise<string | null> {
    const rows: Array<{ err: string | null }> = await h.dataSource.query(
      `SELECT "fulfillmentLastError" AS err FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0].err;
  }

  /**
   * Everything that must be true of a BLOCKED order: the money fact is intact,
   * NOTHING was consumed, and the order is visibly on hold in a state the
   * recovery worker still owns.
   */
  async function expectBlockedInDatabase(
    orderId: number,
    expected: { state: FulfillmentStateEnum; stock: number },
  ): Promise<void> {
    // 1. No stock left the building.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(
      expected.stock,
    );
    const fulfilments = (
      await movementRows(h.dataSource, catalog.variantId)
    ).filter((m) => m.reason === 'online_fulfillment' && m.orderId === orderId);
    expect(fulfilments).toHaveLength(0);

    // 2. The allocation was NOT consumed, so it is still there to be consumed
    //    if a valid receipt ever settles the order.
    const allocations = (
      await reservationRows(h.dataSource, catalog.variantId)
    ).filter((r) => r.kind === 'order' && r.orderId === orderId);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].status).toBe('active');
    expect(allocations[0].releaseReason).toBeNull();

    // 3. The order is where it was -- NOT a new terminal state -- so it stays
    //    inside the recovery worker's bounded retry set.
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: expected.state,
    });

    // 4. Visibly blocked on the order row, not only in a log.
    expect(await lastFulfilmentError(orderId)).toMatch(
      /no payment row authorizes consuming stock/i,
    );

    // 5. HISTORY PRESERVED. The receipt is byte-for-byte what was planted: no
    //    status rewrite, no "correction", no reconciled_at stamped by code,
    //    and nothing that looks like a refund.
    const payments = await paymentRows(orderId);
    const legacy = payments.filter(
      (p) => p.status === PaymentStatusEnum.SUCCESS,
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      status: PaymentStatusEnum.SUCCESS,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      requiresReconciliation: true,
      reconciledAt: null,
    });
    expect(legacy[0].paidAt).not.toBeNull();
    expect(payments.some((p) => p.status === PaymentStatusEnum.REFUNDED)).toBe(
      false,
    );
  }

  beforeEach(async () => {
    h = await createInventoryHarness();
    branchId = await makeBranch(h.dataSource, `Store ${Date.now()}`);
    shopper = await makeUser(h.dataSource, `payer-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // Entry point 1 -- the gateway callback (duplicate-callback replay)
  // ==========================================================================
  it('F1-1 - the CALLBACK replay does not fulfil a legacy unverified success receipt', async () => {
    const { orderId, trackId, paymentId } =
      await plantLegacyUnverifiedSuccess(3);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);

    // The customer's browser (or the gateway) hits POST /payment/verify again.
    const result = await h.payment.Verify(trackId);

    await expectBlockedInDatabase(orderId, {
      state: FulfillmentStateEnum.PENDING,
      stock: 10,
    });

    // The replay never re-asked the gateway: the outcome is already recorded.
    expect(h.gateway.verifyCalls).toEqual([]);

    // The returned contract is HONEST about all of it.
    expect(result).toMatchObject({
      success: true,
      alreadyProcessed: true,
      orderId,
      orderStatus: OrderStatusEnum.PAID,
      // The order's REAL state, not a claim that fulfilment is under way.
      fulfillmentState: FulfillmentStateEnum.PENDING,
      fulfilmentBlocked: FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      expectedAmount: 3_000_000,
      gatewayAmount: 1_500_000,
    });
    expect(result.updatedVariants).toEqual([]);
    // The customer is not told the payment failed, and not told the order is
    // on its way either.
    expect(result.message).toMatch(/recorded/i);
    expect(result.message).toMatch(/on hold/i);
    expect(result.message).not.toMatch(/being prepared/i);
    expect(result.message).not.toMatch(/verified successfully/i);
    expect(result.message).not.toMatch(/failed/i);

    // The receipt itself is untouched -- same id, same figures.
    const payments = await paymentRows(orderId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: paymentId,
      amount: 3_000_000,
      gatewayAmount: 1_500_000,
    });
  });

  // ==========================================================================
  // Entry point 2 -- the recovery worker
  // ==========================================================================
  it('F1-2 - the RECOVERY WORKER does not fulfil a legacy unverified success receipt, and reports it blocked', async () => {
    const { orderId } = await plantLegacyUnverifiedSuccess(4);

    const report = await h.recovery.recover();

    await expectBlockedInDatabase(orderId, {
      state: FulfillmentStateEnum.PENDING,
      stock: 10,
    });

    expect(report).toMatchObject({
      scanned: 1,
      fulfilled: 0,
      awaitingStock: 0,
      failed: 0,
      // NOT hidden inside `skipped` ("nothing to do") or `failed` ("it threw").
      blocked: 1,
      blockedOrderIds: [orderId],
      skipped: 0,
      orderIds: [orderId],
    });

    // It is still in the queue, with a next attempt scheduled, so it can
    // self-heal rather than being abandoned.
    expect(report.attempts).toEqual([
      { orderId, attempt: 1, nextAttemptAt: expect.any(Date) },
    ]);

    // A second pass is equally refused and still consumes nothing. (The lease
    // backoff is bypassed the way the starvation suite does it, so the retry is
    // observable without waiting a minute.)
    await h.dataSource.query(
      `UPDATE orders SET "fulfillmentNextAttemptAt" = NULL WHERE id = $1`,
      [orderId],
    );
    const second = await h.recovery.recover();
    expect(second).toMatchObject({ scanned: 1, blocked: 1, fulfilled: 0 });
    await expectBlockedInDatabase(orderId, {
      state: FulfillmentStateEnum.PENDING,
      stock: 10,
    });
  });

  // ==========================================================================
  // Entry point 3 -- direct / manual drive
  // ==========================================================================
  it('F1-3 - a DIRECT FulfilmentService.drive() does not fulfil a legacy unverified success receipt', async () => {
    // Quantity 1, so the planted receipt carries the reviewer's exact figures:
    // amount = 1000000, gateway_amount = 500000.
    const { orderId } = await plantLegacyUnverifiedSuccess(1);
    const planted = await paymentRows(orderId);
    expect(planted[0]).toMatchObject({
      amount: 1_000_000,
      gatewayAmount: 500_000,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      status: PaymentStatusEnum.SUCCESS,
    });

    const outcome = await h.fulfilment.drive(orderId);

    expect(outcome).toEqual({
      orderId,
      state: FulfillmentStateEnum.PENDING,
      claimed: false,
      consumed: [],
      blocked: FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
    });
    await expectBlockedInDatabase(orderId, {
      state: FulfillmentStateEnum.PENDING,
      stock: 10,
    });
  });

  it('F1-4 - the same refusal applies to an order in AWAITING_STOCK', async () => {
    const { orderId, trackId } = await plantLegacyUnverifiedSuccess(
      2,
      FulfillmentStateEnum.AWAITING_STOCK,
    );

    // All three entry points, on the same order, in the same state.
    const direct = await h.fulfilment.drive(orderId);
    expect(direct.blocked).toBe(
      FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
    );

    const replay = await h.payment.Verify(trackId);
    expect(replay.fulfilmentBlocked).toBe(
      FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
    );
    expect(replay.fulfillmentState).toBe(FulfillmentStateEnum.AWAITING_STOCK);

    const report = await h.recovery.recover();
    expect(report).toMatchObject({ blocked: 1, fulfilled: 0, scanned: 1 });

    // AWAITING_STOCK is preserved: the order is not shunted into a new state,
    // so it keeps its place in the retry set.
    await expectBlockedInDatabase(orderId, {
      state: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 10,
    });
  });

  // ==========================================================================
  // History is preserved -- this blocks NEW consumption only
  // ==========================================================================
  it('F1-5 - an already FULFILLED order with a legacy receipt is untouched and keeps its historical stock movement', async () => {
    // A legitimate order, fulfilled by the current code: real movement, real
    // consumed allocation.
    const orderId = await checkout(3);
    const started = await h.payment.Start(orderId, shopper);
    await h.payment.Verify(started.trackId);
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    const before = await movementRows(h.dataSource, catalog.variantId);
    expect(before).toHaveLength(1);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);

    // Now make its receipt look like the legacy population (raw SQL: this is
    // the state a pre-fix settle would have left behind on a FULFILLED order).
    await h.dataSource.query(
      `UPDATE payment
          SET gateway_amount = amount / 2,
              requires_reconciliation = true,
              reconciliation_reason = $2
        WHERE "orderId" = $1 AND status = 'success'`,
      [orderId, PaymentReconciliationReason.AMOUNT_MISMATCH],
    );

    // Every entry point, on an order that has already shipped.
    const direct = await h.fulfilment.drive(orderId);
    const replay = await h.payment.Verify(started.trackId);
    const report = await h.recovery.recover();

    // NOT blocked -- there is nothing to block. The state filter runs first, so
    // a FULFILLED order is an ordinary no-op and stays fulfilled.
    expect(direct).toEqual({
      orderId,
      state: FulfillmentStateEnum.FULFILLED,
      claimed: false,
      consumed: [],
      blocked: null,
    });
    expect(replay.fulfilmentBlocked).toBeNull();
    expect(replay.fulfillmentState).toBe(FulfillmentStateEnum.FULFILLED);
    expect(report).toMatchObject({ scanned: 0, blocked: 0, fulfilled: 0 });

    // THE POINT: the movement that already happened is NOT reversed, and no
    // second one is written.
    expect(await movementRows(h.dataSource, catalog.variantId)).toEqual(before);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await lastFulfilmentError(orderId)).toBeNull();
  });

  // ==========================================================================
  // EXISTS, not "no bad receipt anywhere"
  // ==========================================================================
  it('F1-6 - a discrepant receipt plus a SEPARATE valid settling receipt fulfils exactly once', async () => {
    // Produced entirely by the CURRENT code: attempt 1 under-reports, attempt 2
    // is correct. No planting at all.
    const orderId = await checkout(3);
    const first = await h.payment.Start(orderId, shopper);
    h.gateway.programVerifyAmount(first.trackId, 1_500_000); // half the money

    const discrepant = await h.payment.Verify(first.trackId);
    expect(discrepant).toMatchObject({
      applied: false,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      fulfilmentBlocked: null,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);

    // The customer pays again, properly.
    const second = await h.payment.Start(orderId, shopper);
    const settled = await h.payment.Verify(second.trackId);

    expect(settled).toMatchObject({
      applied: true,
      paymentStatus: PaymentStatusEnum.SUCCESS,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      // NOT blocked: the check is an EXISTS over the order's payments, not
      // "this order has no bad receipt".
      fulfilmentBlocked: null,
    });

    // Stock moved exactly ONCE, for the right quantity.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      delta: -3,
      balanceAfter: 7,
      reason: 'online_fulfillment',
      orderId,
    });

    // Both money facts survive side by side; nothing was refunded.
    const payments = await paymentRows(orderId);
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.status)).toEqual([
      PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      PaymentStatusEnum.SUCCESS,
    ]);
    expect(payments.some((p) => p.status === PaymentStatusEnum.REFUNDED)).toBe(
      false,
    );

    // A re-drive after the fact is still a no-op, not a second consumption.
    await h.fulfilment.drive(orderId);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
  });

  it('F1-6b - a PLANTED discrepant receipt beside a planted valid one still fulfils (the predicate is an EXISTS)', async () => {
    const orderId = await checkout(2);
    // The bad one first, so a "first receipt wins" implementation would fail.
    await plantPayment(orderId, {
      status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      amount: 2_000_000,
      gatewayAmount: 999_999,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      trackId: 'exists-bad',
    });
    await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 2_000_000,
      gatewayAmount: 2_000_000,
      reason: null,
      requiresReconciliation: false,
      trackId: 'exists-good',
    });
    await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

    const outcome = await h.fulfilment.drive(orderId);

    expect(outcome).toMatchObject({
      state: FulfillmentStateEnum.FULFILLED,
      claimed: true,
      blocked: null,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
  });

  it('F1-6c - a success receipt whose reason is the INFORMATIONAL late_confirmation_applied still authorizes', async () => {
    const orderId = await checkout(1);
    await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 1_000_000,
      gatewayAmount: 1_000_000,
      reason: PaymentReconciliationReason.LATE_CONFIRMATION_APPLIED,
      requiresReconciliation: false,
      trackId: 'late-applied',
    });
    await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

    const outcome = await h.fulfilment.drive(orderId);

    /**
     * It authorizes because the MONEY AGREES -- gateway_amount = amount =
     * orders.total_price -- and `late_confirmation_applied` is not an
     * outstanding amount question. The label is the last clause checked, not
     * the first: see F1-6e, where the same label with disagreeing figures is
     * refused.
     */
    expect(outcome).toMatchObject({
      state: FulfillmentStateEnum.FULFILLED,
      claimed: true,
      blocked: null,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(9);
  });

  it('F1-6d - the other two amount reasons on a success row are refused as well', async () => {
    for (const reason of [
      PaymentReconciliationReason.AMOUNT_MISSING,
      PaymentReconciliationReason.AMOUNT_INVALID,
    ]) {
      const orderId = await checkout(1);
      await plantPayment(orderId, {
        status: PaymentStatusEnum.SUCCESS,
        amount: 1_000_000,
        // `amount_missing` / `amount_invalid` both leave gateway_amount NULL,
        // so this also proves the block keys on the REASON and not on a NULL
        // gateway amount (which the legacy no-evidence case shares).
        gatewayAmount: null,
        reason,
        requiresReconciliation: true,
        trackId: `legacy-${reason}`,
      });
      await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

      const outcome = await h.fulfilment.drive(orderId);
      expect(outcome.blocked).toBe(
        FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
      );
      expect(await orderState(h.dataSource, orderId)).toMatchObject({
        fulfillmentState: FulfillmentStateEnum.PENDING,
      });
    }
    // Nothing moved for either of them.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
  });

  it('F1-6e - an INFORMATIONAL label cannot excuse disagreeing amounts (reviewer case 3)', async () => {
    /**
     * THE REVIEWER'S THIRD ROW SET, verbatim:
     *   amount=1000000, gateway_amount=500000, reason=late_confirmation_applied
     *
     * The old LABEL-BASED predicate authorized this, because
     * `late_confirmation_applied` is not one of the three amount reasons -- so
     * the check passed while the two amounts in the very same row differed by
     * half. Goods shipped against a receipt for half the money.
     *
     * Nothing about a label can excuse figures that disagree, so the amount
     * clauses are now evaluated on their own terms.
     */
    const orderId = await checkout(1);
    await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 1_000_000,
      gatewayAmount: 500_000,
      reason: PaymentReconciliationReason.LATE_CONFIRMATION_APPLIED,
      requiresReconciliation: false,
      trackId: 'late-applied-mismatch',
    });
    await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

    const outcome = await h.fulfilment.drive(orderId);

    expect(outcome).toMatchObject({
      state: FulfillmentStateEnum.PENDING,
      claimed: false,
      blocked: FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
      consumed: [],
    });
    // DATABASE-LEVEL: nothing left the building.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect(await orderState(h.dataSource, orderId)).toMatchObject({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    // The receipt itself is untouched -- a confirmation is never rewritten.
    const [receipt] = await h.dataSource.query<
      Array<{ status: string; amount: string; gateway_amount: string }>
    >(
      `SELECT status::text AS status, amount::text AS amount,
              gateway_amount::text AS gateway_amount
         FROM payment WHERE "orderId" = $1`,
      [orderId],
    );
    expect(receipt).toEqual({
      status: PaymentStatusEnum.SUCCESS,
      amount: '1000000',
      gateway_amount: '500000',
    });
  });

  // ==========================================================================
  // Missing amount evidence is NOT proof of payment
  // ==========================================================================
  it('F1-7 - a success receipt with NO amount evidence is REFUSED, not trusted (reviewer case 2)', async () => {
    /**
     * THE REVIEWER'S SECOND ROW SET, verbatim:
     *   amount=1000000, gateway_amount=NULL, reason=NULL
     *
     * The amount was never checked -- the row predates migration 0010, or a
     * gateway reported nothing and the old expression scored silence as
     * equality. Either way there is no evidence, and the absence of a recorded
     * discrepancy is not evidence of its absence.
     *
     * An earlier version of this suite asserted this receipt was TRUSTED and
     * that the trust was logged. That test encoded a financial policy nobody
     * approved, so it is gone and this is its inversion: no evidence means
     * `reconciliation_required`.
     */
    const orderId = await checkout(1);
    await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 1_000_000,
      gatewayAmount: null,
      reason: null,
      requiresReconciliation: false,
      trackId: 'no-amount-evidence',
    });
    await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

    const outcome = await h.fulfilment.drive(orderId);

    expect(outcome).toMatchObject({
      state: FulfillmentStateEnum.PENDING,
      claimed: false,
      blocked: FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
      consumed: [],
    });
    // DATABASE-LEVEL: no stock consumed, no movement, order untouched.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect(await orderState(h.dataSource, orderId)).toMatchObject({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    // The order says WHY, for an operator reading the row rather than the log.
    const [row] = await h.dataSource.query<
      Array<{ fulfillmentLastError: string | null }>
    >(`SELECT "fulfillmentLastError" FROM orders WHERE id = $1`, [orderId]);
    expect(row.fulfillmentLastError).toMatch(/fulfilment refused/i);

    // And the receipt is preserved exactly as it was.
    const [receipt] = await h.dataSource.query<
      Array<{ status: string; amount: string; gateway_amount: string | null }>
    >(
      `SELECT status::text AS status, amount::text AS amount,
              gateway_amount::text AS gateway_amount
         FROM payment WHERE "orderId" = $1`,
      [orderId],
    );
    expect(receipt).toEqual({
      status: PaymentStatusEnum.SUCCESS,
      amount: '1000000',
      gateway_amount: null,
    });
  });

  it('F1-7b - a receipt that agrees with itself but NOT with the order total is refused', async () => {
    /**
     * The clause the reviewer's three cases did not reach, and the one that
     * completes the chain: without `amount = orders.total_price` a receipt
     * could agree with itself while agreeing with nothing the customer
     * ordered. Here the gateway confirmed exactly what we asked for -- and
     * what we asked for was not the price of the order.
     */
    const orderId = await checkout(3); // orders.total_price = 3,000,000
    await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 1_000_000,
      gatewayAmount: 1_000_000,
      reason: null,
      requiresReconciliation: false,
      trackId: 'self-consistent-but-wrong-order',
    });
    await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

    const outcome = await h.fulfilment.drive(orderId);

    expect(outcome.blocked).toBe(
      FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
    );
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
  });

  it('F1-7c - the operator log names the failing clause and carries amounts as text', async () => {
    const orderId = await checkout(1);
    const paymentId = await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 1_000_000,
      gatewayAmount: 500_000,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      requiresReconciliation: true,
      trackId: 'diagnostic-log',
    });
    await plantOrderPaid(orderId, FulfillmentStateEnum.PENDING);

    const error = jest.spyOn(Logger.prototype, 'error');
    await h.fulfilment.drive(orderId);

    const refusal = error.mock.calls
      .map((call) => String(call[0]))
      .find((message) => /FULFILMENT REFUSED/i.test(message));
    expect(refusal).toBeDefined();
    // Per-receipt diagnosis, with the exact figures, so an operator does not
    // have to re-derive why it was refused.
    expect(refusal).toContain(`payment ${paymentId}`);
    expect(refusal).toContain('gateway amount 500000');
    expect(refusal).toContain('requested amount 1000000');
    expect(refusal).toMatch(/unresolved amount reason amount_mismatch/i);
    // Amounts are rendered from PostgreSQL `::text`, never through a JS Number.
    expect(refusal).not.toMatch(/1e\+?6|500000\.0|NaN/);
  });

  it('F1-7d - amounts beyond 2^53 are compared EXACTLY, not through a JS Number', async () => {
    /**
     * 9007199254740993 is 2^53 + 1: the smallest integer a JavaScript `Number`
     * cannot represent. It rounds to 9007199254740992, which is also what
     * 9007199254740993 - 1 rounds to -- so a predicate that pulled these
     * columns into JS would score two DIFFERENT sums as equal.
     *
     * Integer Rial reaches this range for ordinary business figures (2^53 Rial
     * is roughly 900 billion Toman), so this is not a synthetic curiosity. All
     * three comparisons happen in PostgreSQL between `bigint` columns.
     */
    const beyondDouble = '9007199254740993';
    const offByOne = '9007199254740992';

    // (a) exact agreement at that magnitude authorizes.
    const okOrder = await checkout(1);
    await h.dataSource.query(
      `UPDATE orders SET total_price = $2::bigint WHERE id = $1`,
      [okOrder, beyondDouble],
    );
    await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, status, track_id,
                            paid_at, requires_reconciliation, created_at, updated_at)
       VALUES ($1, $2::bigint, $2::bigint, $3, 'bigint-exact', now(), false, now(), now())`,
      [okOrder, beyondDouble, PaymentStatusEnum.SUCCESS],
    );
    await plantOrderPaid(okOrder, FulfillmentStateEnum.PENDING);

    expect(await h.fulfilment.drive(okOrder)).toMatchObject({
      state: FulfillmentStateEnum.FULFILLED,
      claimed: true,
      blocked: null,
    });

    // (b) a ONE-RIAL difference at the same magnitude is refused. Through a JS
    // Number these two values are indistinguishable; in PostgreSQL they are
    // not.
    const badOrder = await checkout(1);
    await h.dataSource.query(
      `UPDATE orders SET total_price = $2::bigint WHERE id = $1`,
      [badOrder, beyondDouble],
    );
    await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, status, track_id,
                            paid_at, requires_reconciliation, created_at, updated_at)
       VALUES ($1, $2::bigint, $3::bigint, $4, 'bigint-off-by-one', now(), false, now(), now())`,
      [badOrder, beyondDouble, offByOne, PaymentStatusEnum.SUCCESS],
    );
    await plantOrderPaid(badOrder, FulfillmentStateEnum.PENDING);

    expect(await h.fulfilment.drive(badOrder)).toMatchObject({
      claimed: false,
      blocked: FulfilmentBlockedReason.RECONCILIATION_REQUIRED,
      consumed: [],
    });

    // Exactly one of the two consumed stock.
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
  });

  // ==========================================================================
  // POS
  // ==========================================================================
  it('F1-8 - POS sales are unaffected: they can never reach the authorization check', async () => {
    // A POS sale as `OrdersService.recordPosSale` writes it: status PAID,
    // fulfillmentState FULFILLED, and the stock moved INSIDE the sale
    // transaction. It has no online `payment` row of any kind.
    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 4 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 4 }],
        orderId: posOrderId,
        actorUserId: shopper,
        actorDisplaySnapshot: 'Cashier',
        branchId,
      }),
    );
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(6);
    const before = await movementRows(h.dataSource, catalog.variantId);
    expect(before).toHaveLength(1);
    expect(before[0].reason).toBe('pos_sale');

    // There is genuinely no payment row to authorize anything.
    const payments = await paymentRows(posOrderId);
    expect(payments).toHaveLength(0);

    // Driving phase 2 for it is an ordinary no-op -- NOT blocked. The state
    // filter (`pending`/`awaiting_stock`) runs before the authorization probe,
    // so an order created FULFILLED never reaches it. If this ever reported
    // `blocked`, in-store sales would be stranded by a check about online
    // payments.
    const outcome = await h.fulfilment.drive(posOrderId);
    expect(outcome).toEqual({
      orderId: posOrderId,
      state: FulfillmentStateEnum.FULFILLED,
      claimed: false,
      consumed: [],
      blocked: null,
    });

    // The recovery worker does not even see it.
    const report = await h.recovery.recover();
    expect(report).toMatchObject({
      scanned: 0,
      blocked: 0,
      blockedOrderIds: [],
      orderIds: [],
    });

    // Nothing changed: same stock, same single movement, same state, no error
    // text written onto an in-store sale.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(6);
    expect(await movementRows(h.dataSource, catalog.variantId)).toEqual(before);
    expect(await orderState(h.dataSource, posOrderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await lastFulfilmentError(posOrderId)).toBeNull();
  });

  // ==========================================================================
  // No regression on the happy path
  // ==========================================================================
  it('F1-9 - the normal current-code happy path still fulfils, through all three entry points', async () => {
    // Callback.
    const a = await checkout(2);
    const startedA = await h.payment.Start(a, shopper);
    const verified = await h.payment.Verify(startedA.trackId);
    expect(verified).toMatchObject({
      applied: true,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      fulfilmentBlocked: null,
    });
    expect(verified.message).toMatch(/verified successfully/i);
    expect(verified.updatedVariants).toEqual([
      { variantId: catalog.variantId, newStock: 8 },
    ]);

    // Recovery worker, on an order whose phase 2 never ran.
    const b = await checkout(3);
    const startedB = await h.payment.Start(b, shopper);
    const kill = jest
      .spyOn(h.fulfilment, 'drive')
      .mockRejectedValueOnce(new Error('SIGKILL between phases'));
    await h.payment.Verify(startedB.trackId);
    kill.mockRestore();
    expect(await orderState(h.dataSource, b)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    const report = await h.recovery.recover();
    expect(report).toMatchObject({
      scanned: 1,
      fulfilled: 1,
      blocked: 0,
      blockedOrderIds: [],
      failed: 0,
      orderIds: [b],
    });

    // Direct drive, idempotently re-run over both.
    expect((await h.fulfilment.drive(a)).blocked).toBeNull();
    expect((await h.fulfilment.drive(b)).blocked).toBeNull();

    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(5);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.delta)).toEqual([-2, -3]);
  });

  // ==========================================================================
  // Self-healing
  // ==========================================================================
  it('F1-10 - a blocked order SELF-HEALS: once a valid receipt settles it, the worker fulfils it', async () => {
    const { orderId, paymentId } = await plantLegacyUnverifiedSuccess(3);

    // Blocked, and still in the queue.
    const first = await h.recovery.recover();
    expect(first).toMatchObject({ blocked: 1, fulfilled: 0 });
    await expectBlockedInDatabase(orderId, {
      state: FulfillmentStateEnum.PENDING,
      stock: 10,
    });

    // ---- A HUMAN RECONCILES IT ------------------------------------------
    // This is the ONLY step in this suite that changes a payment row, and it is
    // deliberately done here in raw SQL as an OPERATOR action -- no code under
    // test does it, and none may. Two things happen, in the order an operator
    // would do them:
    //
    //  1. the discrepant receipt is moved off `success` to `refunded`, the
    //     terminal state PaymentStatusEnum documents as reachable only by a
    //     human reconciliation decision, and `reconciled_at` is stamped. This
    //     is also what frees the partial unique index
    //     `uq_payment_one_success_per_order`, which is why a NEW settling
    //     receipt for this order is impossible until a human acts;
    //  2. the receipt that actually pays for the order is recorded, with the
    //     gateway amount matching what we asked for.
    //
    // No automatic path does any of this, and nothing here is a refund issued
    // BY the application.
    await h.dataSource.query(
      `UPDATE payment SET status = 'refunded', reconciled_at = now() WHERE id = $1`,
      [paymentId],
    );
    await plantPayment(orderId, {
      status: PaymentStatusEnum.SUCCESS,
      amount: 3_000_000,
      gatewayAmount: 3_000_000,
      reason: null,
      requiresReconciliation: false,
      trackId: 'operator-settled',
    });

    // ---- and the worker heals it, with no further human step -------------
    await h.dataSource.query(
      `UPDATE orders SET "fulfillmentNextAttemptAt" = NULL WHERE id = $1`,
      [orderId],
    );
    const healed = await h.recovery.recover();

    expect(healed).toMatchObject({
      scanned: 1,
      fulfilled: 1,
      blocked: 0,
      blockedOrderIds: [],
      failed: 0,
      orderIds: [orderId],
    });
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      delta: -3,
      balanceAfter: 7,
      reason: 'online_fulfillment',
      orderId,
    });
    // The stale "blocked" text is cleared once the order really has moved, so
    // an operator is not sent after a healed order.
    expect(await lastFulfilmentError(orderId)).toBeNull();

    // The historical receipt is STILL THERE. Reconciled, not erased.
    const payments = await paymentRows(orderId);
    expect(payments).toHaveLength(2);
    expect(payments[0]).toMatchObject({
      id: paymentId,
      amount: 3_000_000,
      gatewayAmount: 1_500_000,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
    });
  });
});
