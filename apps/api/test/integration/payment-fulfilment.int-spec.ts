import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { PaymentStatusEnum } from 'src/modules/payment/enums/payment-status-enum';
import { ZIBAL_RESULT } from 'src/modules/payment/gateways/payment-gateway.interface';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  backdateReservations,
  createInventoryHarness,
  makeBranch,
  makeCatalog,
  makeOnlineOrder,
  makePosOrder,
  makeUser,
  movementRows,
  orderState,
  physicalStock,
  receiveStock,
  reservationRows,
} from './support/inventory.harness';

/**
 * Acceptance tests 23-26 -- the two-phase payment boundary
 * (docs/ARCHITECTURE.md section 2).
 *
 * NO TEST HERE TOUCHES A LIVE GATEWAY. Everything goes through
 * `StubPaymentGateway` behind the `PaymentGateway` seam.
 */
describe('payment fulfilment (23-26)', () => {
  let h: InventoryHarness;
  let shopper: number;
  let catalog: Catalog;
  let branchId: number;

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

  beforeEach(async () => {
    h = await createInventoryHarness();
    branchId = await makeBranch(h.dataSource, `Store ${Date.now()}`);
    shopper = await makeUser(h.dataSource, `payer-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // Money unit + config (docs/ARCHITECTURE.md section 0)
  // ==========================================================================
  it('money - the gateway is asked for the order total in Rial, with no x10 multiplier', async () => {
    const orderId = await checkout(2);
    // makeOnlineOrder prices each unit at 1_000_000 Rial.
    const started = await h.payment.Start(orderId, shopper);

    expect(started.amount).toBe(2_000_000);
    expect(h.gateway.requestCalls).toHaveLength(1);
    expect(h.gateway.requestCalls[0].amount).toBe(2_000_000);
    // The old code sent 20_000_000 here.
    expect(h.gateway.requestCalls[0].amount).not.toBe(20_000_000);
    // callbackUrl comes from config, not from a `https://test.ir/` literal.
    expect(h.gateway.requestCalls[0].callbackUrl).not.toBe('https://test.ir/');
  });

  it('start - repeated Start() calls reuse the pending attempt instead of piling up payment rows', async () => {
    const orderId = await checkout(1);

    const first = await h.payment.Start(orderId, shopper);
    const second = await h.payment.Start(orderId, shopper);
    const third = await h.payment.Start(orderId, shopper);

    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ reused: true, trackId: first.trackId });
    expect(third).toMatchObject({ reused: true, trackId: first.trackId });
    expect(h.gateway.requestCalls).toHaveLength(1);

    const rows: Array<{ count: string }> = await h.dataSource.query(
      `SELECT COUNT(*) AS count FROM payment WHERE "orderId" = $1`,
      [orderId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  // ==========================================================================
  // 23
  // ==========================================================================
  it('23 - duplicate payment verification does not duplicate fulfilment', async () => {
    const orderId = await checkout(3);
    const started = await h.payment.Start(orderId, shopper);

    const first = await h.payment.Verify(started.trackId);
    expect(first).toMatchObject({
      success: true,
      alreadyProcessed: false,
      orderId,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(first.updatedVariants).toEqual([
      { variantId: catalog.variantId, newStock: 7 },
    ]);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);

    // Replay the same callback three more times.
    for (let i = 0; i < 3; i++) {
      const replay = await h.payment.Verify(started.trackId);
      expect(replay).toMatchObject({
        success: true,
        alreadyProcessed: true,
        orderId,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
      });
    }

    // Stock moved once. The ledger has one row. The allocation was consumed once.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      delta: -3,
      balanceAfter: 7,
      reason: 'online_fulfillment',
      orderId,
    });

    const allocations = (
      await reservationRows(h.dataSource, catalog.variantId)
    ).filter((r) => r.kind === 'order');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      status: 'consumed',
      releaseReason: 'fulfilled',
    });

    // An idempotent replay never re-verifies at the gateway.
    expect(h.gateway.verifyCalls).toEqual([started.trackId]);
  });

  it('23b - a gateway rejection marks the attempt failed and never touches stock', async () => {
    const orderId = await checkout(3);
    const started = await h.payment.Start(orderId, shopper);
    h.gateway.programVerify(started.trackId, 202); // "not paid"

    await expect(h.payment.Verify(started.trackId)).rejects.toThrow(
      /Payment failed/,
    );

    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    expect(await orderState(h.dataSource, orderId)).toMatchObject({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
  });

  // ==========================================================================
  // 24
  // ==========================================================================
  it('24 - two payment attempts for one order cannot decrement stock twice', async () => {
    const orderId = await checkout(3);

    // Two independent attempts. The reuse window is bypassed by clearing the
    // first attempt's track_id lookup path: a second row is forced directly,
    // exactly as a retried checkout on a second device would produce.
    const first = await h.payment.Start(orderId, shopper);
    const secondTrack = 'stub-second-attempt';
    await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, status, track_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [orderId, 3_000_000, PaymentStatusEnum.PENDING, secondTrack],
    );
    h.gateway.programVerify(secondTrack, ZIBAL_RESULT.SUCCESS);

    const [a, b] = await Promise.all([
      h.payment.Verify(first.trackId).catch((e: Error) => e),
      h.payment.Verify(secondTrack).catch((e: Error) => e),
    ]);

    // Both callbacks report success to the gateway (the money is real in both
    // cases); exactly one of them did the fulfilment work.
    for (const outcome of [a, b]) {
      expect(outcome).not.toBeInstanceOf(Error);
    }
    const processedFresh = [a, b].filter(
      (r) => (r as { alreadyProcessed: boolean }).alreadyProcessed === false,
    );
    expect(processedFresh).toHaveLength(1);

    // THE POINT: 10 - 3, never 10 - 6.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0].delta).toBe(-3);

    // `uq_payment_one_success_per_order` allowed exactly one SUCCESS row.
    const successes: Array<{ count: string }> = await h.dataSource.query(
      `SELECT COUNT(*) AS count FROM payment WHERE "orderId" = $1 AND status = 'success'`,
      [orderId],
    );
    expect(Number(successes[0].count)).toBe(1);
  });

  // ==========================================================================
  // 25
  // ==========================================================================
  it('25 - a payment that lands after its allocation expired ends in the documented AWAITING_STOCK state', async () => {
    const orderId = await checkout(4);
    const started = await h.payment.Start(orderId, shopper);

    // The allocation times out and somebody else takes the stock while the
    // customer is still on the gateway's page.
    await backdateReservations(h.dataSource, { orderId });
    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 10 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 10 }],
        orderId: posOrderId,
        actorUserId: shopper,
        actorDisplaySnapshot: 'Cashier',
        branchId,
      }),
    );
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(0);

    // Now the payment comes back successful.
    const result = await h.payment.Verify(started.trackId);

    // A CONFIRMED PAYMENT IS NEVER ROLLED BACK.
    expect(result).toMatchObject({
      success: true,
      orderId,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
    });
    expect(result.message).toMatch(/temporarily out of stock/i);

    const payments: Array<{ status: string }> = await h.dataSource.query(
      `SELECT status::text AS status FROM payment WHERE track_id = $1`,
      [started.trackId],
    );
    expect(payments[0].status).toBe(PaymentStatusEnum.SUCCESS);
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
    });

    // Phase 2 rolled back cleanly: nothing was half-consumed.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(0);
    const fulfilments = (
      await movementRows(h.dataSource, catalog.variantId)
    ).filter((m) => m.reason === 'online_fulfillment');
    expect(fulfilments).toHaveLength(0);

    // ...and it is genuinely recoverable: restock, re-drive, fulfilled.
    await receiveStock(h.dataSource, h.inventory, catalog.variantId, 4);
    const report = await h.recovery.recover();
    expect(report).toMatchObject({ scanned: 1, fulfilled: 1, failed: 0 });
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(0);
  });

  // ==========================================================================
  // 26
  // ==========================================================================
  it('26 - a process interruption between phase 1 and phase 2 does not permanently lose processing', async () => {
    const orderId = await checkout(3);
    const started = await h.payment.Start(orderId, shopper);

    // Kill the process the instant phase 1 commits: phase 2 never runs.
    const kill = jest
      .spyOn(h.fulfilment, 'drive')
      .mockRejectedValueOnce(new Error('SIGKILL between phases'));

    // A confirmed payment is NEVER reported as a failure to the customer: the
    // money is gone, so Verify resolves with the recorded recoverable state
    // rather than throwing an error nobody can act on.
    const verified = await h.payment.Verify(started.trackId);
    expect(verified).toMatchObject({
      success: true,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    expect(verified.message).toMatch(/being prepared/i);
    kill.mockRestore();

    // Phase 1 stands on its own -- the money is recorded and committed.
    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    const payments: Array<{ status: string }> = await h.dataSource.query(
      `SELECT status::text AS status FROM payment WHERE track_id = $1`,
      [started.trackId],
    );
    expect(payments[0].status).toBe(PaymentStatusEnum.SUCCESS);
    // ...and phase 2 demonstrably did not run.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);

    // The app restarts. Recovery finds the order and re-drives phase 2.
    const report = await h.recovery.recover();
    expect(report).toMatchObject({
      scanned: 1,
      fulfilled: 1,
      awaitingStock: 0,
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
    expect(movements[0]).toMatchObject({ delta: -3, balanceAfter: 7 });

    // Recovery is idempotent: a second pass finds nothing to do.
    const second = await h.recovery.recover();
    expect(second).toMatchObject({ scanned: 0, fulfilled: 0 });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);
  });

  it('26b - concurrent recovery passes on two app instances fulfil the order exactly once', async () => {
    const orderId = await checkout(2);
    const started = await h.payment.Start(orderId, shopper);
    const kill = jest
      .spyOn(h.fulfilment, 'drive')
      .mockRejectedValueOnce(new Error('SIGKILL between phases'));
    await expect(h.payment.Verify(started.trackId)).resolves.toMatchObject({
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    kill.mockRestore();

    // Two instances, same moment. The claim is `FOR UPDATE SKIP LOCKED` plus a
    // guarded conditional UPDATE -- no Redis anywhere.
    const [a, b] = await Promise.all([
      h.recovery.recover(),
      // A second, independent recovery service over the same DataSource, so the
      // in-process `running` guard cannot be what makes this pass.
      Object.create(
        Object.getPrototypeOf(h.recovery),
        Object.getOwnPropertyDescriptors(h.recovery),
      ).recover(),
    ]);

    const fulfilled = a.fulfilled + (b as { fulfilled: number }).fulfilled;
    expect(fulfilled).toBeLessThanOrEqual(1);

    expect(await orderState(h.dataSource, orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(8);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(1);
  });

  it('26c - an order line whose variant is gone is recorded, not crashed on', async () => {
    // The exact shape of the old bug: `items.variant` was never loaded, so
    // `findOne({ where: { id: undefined } })` threw inside the payment
    // transaction and rolled back a confirmed payment. Here a NULL variant is
    // rejected explicitly and the payment survives.
    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 1,
      },
    ]);
    await h.dataSource.query(
      `UPDATE order_items SET "variantId" = NULL WHERE "orderId" = $1`,
      [orderId],
    );
    const started = await h.payment.Start(orderId, shopper);

    const result = await h.payment.Verify(started.trackId);
    expect(result).toMatchObject({
      success: true,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
    });
    const payments: Array<{ status: string }> = await h.dataSource.query(
      `SELECT status::text AS status FROM payment WHERE track_id = $1`,
      [started.trackId],
    );
    expect(payments[0].status).toBe(PaymentStatusEnum.SUCCESS);
  });
});
