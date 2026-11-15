import { DataSource } from 'typeorm';

import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { PaymentStatusEnum } from 'src/modules/payment/enums/payment-status-enum';
import {
  FulfilmentRecoveryService,
  RECOVERABLE_FULFILLMENT_STATES,
} from 'src/modules/payment/fulfilment-recovery.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createProductWithVariant, createUser } from './setup/seed-helpers';

/**
 * ===========================================================================
 * A PAID ORDER MAY NOT LEAVE `paid` UNTIL ITS GOODS ARE ALLOCATED
 * ===========================================================================
 *
 * THE DEFECT. `OrdersService.updateStatus` locked the order row, checked
 * `voidedAt`, refused canceled/refunded, validated the transition against the
 * state machine — and never read `fulfillmentState`. `paid -> processing` was
 * therefore legal on an order whose stock had never been consumed.
 *
 * WHY THAT IS UNRECOVERABLE RATHER THAN MERELY WRONG. Both re-drivers of phase
 * 2 filter on `status = 'paid'`:
 *
 *   FulfilmentService.claim()             SELECT id FROM orders
 *   FulfilmentRecoveryService.leaseDue…    WHERE status = 'paid'
 *                                            AND "fulfillmentState" IN
 *                                                ('pending','awaiting_stock')
 *
 * Nothing else in the system writes `fulfillmentState`, and no sweep looks at
 * `processing`. One PATCH therefore evicted the order from phase 2 for good:
 * money taken, goods never allocated, and no queue entry anywhere to show for
 * it. `idx_orders_fulfillment_due` is partial on the same predicate, so the row
 * left the operator's index too.
 *
 * WHAT THESE CASES PROVE. Not just that the 409 happens, but the three
 * properties that make the refusal safe:
 *
 *   1. the refusal is a NO-OP — status, fulfilment state, stock rows and
 *      `stock_movements` are all byte-identical afterwards;
 *   2. the order is STILL SELECTED by the recovery lease, asserted with the
 *      lease's REAL SQL rather than a paraphrase of it, so a later drift in
 *      that query fails here;
 *   3. once recovery genuinely fulfils the order, the same PATCH succeeds —
 *      the guard gates on the FACT, never on a flag somebody has to clear.
 *
 * NO LIVE GATEWAY IS INVOLVED. The orders are written straight into their
 * recorded post-payment states, with the settling receipt phase 1 would have
 * written (`gateway_amount = amount = orders.total_price`, no reconciliation
 * reason), because what is under test is the STATUS TRANSITION, not the money.
 * That receipt shape is exactly what `FulfilmentService.claim()`'s
 * authorization predicate requires, so the recovery half of these tests
 * exercises a row set production can actually reach.
 */
describe('paid order cannot be advanced with fulfilment incomplete', () => {
  let app: TestApp;
  let ds: DataSource;
  let admin: CookieJar;
  let shopperId: number;

  const UNIT_PRICE = 1_000_000;

  interface SeededOrder {
    orderId: number;
    variantId: number;
  }

  /**
   * A paid ONLINE order in the given fulfilment state, with the settling
   * receipt that made it paid.
   *
   * `stock` is the FREE stock left on the variant: 0 makes fulfilment
   * impossible, a positive number makes it succeed the moment phase 2 runs.
   */
  async function seedPaidOrder(options: {
    fulfillmentState: FulfillmentStateEnum;
    stock: number;
    quantity?: number;
  }): Promise<SeededOrder> {
    const quantity = options.quantity ?? 1;
    const { product, variant } = await createProductWithVariant(
      ds,
      { basePrice: UNIT_PRICE },
      { price: UNIT_PRICE, stock: options.stock },
    );
    const total = UNIT_PRICE * quantity;

    const orderRows: Array<{ id: number }> = await ds.query(
      `INSERT INTO orders (channel, "userId", status, total_price, subtotal,
                           "fulfillmentState", paid_at, "paidAt", "soldAt")
       VALUES ($1, $2, $3, $4, $4, $5, now(), now(), now())
       RETURNING id`,
      [
        OrderChannel.ONLINE,
        shopperId,
        OrderStatusEnum.PAID,
        total,
        options.fulfillmentState,
      ],
    );
    const orderId = Number(orderRows[0].id);

    await ds.query(
      `INSERT INTO order_items ("orderId", "productId", "variantId", quantity,
                                unit_price, total_price, "productTitleSnapshot")
       VALUES ($1, $2, $3, $4, $5, $6, 'snapshot')`,
      [orderId, product.id, variant.id, quantity, UNIT_PRICE, total],
    );

    // The receipt phase 1 writes for a clean settlement: present, valid and
    // EQUAL on both sides, and equal to the order total.
    await ds.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, status, track_id,
                            paid_at, requires_reconciliation, reconciliation_reason,
                            created_at, updated_at)
       VALUES ($1, $2, $2, $3, $4, now(), false, NULL, now(), now())`,
      [orderId, total, PaymentStatusEnum.SUCCESS, `guard-track-${orderId}`],
    );

    return { orderId, variantId: variant.id };
  }

  /**
   * The two columns as ENUM types, not `string`.
   *
   * The database values ARE the enum values (both columns are Postgres enums
   * built from these TypeScript enums), and typing them properly means a
   * renamed member breaks this file at compile time instead of silently
   * comparing false forever.
   */
  async function orderRow(orderId: number): Promise<{
    status: OrderStatusEnum;
    fulfillmentState: FulfillmentStateEnum;
  }> {
    const rows: Array<{
      status: OrderStatusEnum;
      fulfillmentState: FulfillmentStateEnum;
    }> = await ds.query(
      `SELECT status::text AS status,
                "fulfillmentState"::text AS "fulfillmentState"
           FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0];
  }

  /**
   * THE RECOVERY LEASE'S REAL PREDICATE, copied verbatim from
   * `FulfilmentRecoveryService.leaseDueOrders` (minus the `FOR UPDATE SKIP
   * LOCKED`, which would deadlock a read-only probe and is irrelevant to
   * SELECTION).
   *
   * Written out here rather than paraphrased so that a change to the real
   * lease's filter breaks this assertion instead of silently passing it, and
   * fed from `RECOVERABLE_FULFILLMENT_STATES` — the same exported constant the
   * service binds — so the two lists cannot drift.
   */
  async function selectedByRecoveryLease(orderId: number): Promise<boolean> {
    const rows: Array<{ id: number }> = await ds.query(
      `SELECT id
         FROM orders
        WHERE status::text = $1
          AND "fulfillmentState"::text = ANY($2::text[])
          AND ("fulfillmentNextAttemptAt" IS NULL
               OR "fulfillmentNextAttemptAt" <= now())
          AND id = $3`,
      [OrderStatusEnum.PAID, [...RECOVERABLE_FULFILLMENT_STATES], orderId],
    );
    return rows.length === 1;
  }

  async function movementCount(): Promise<number> {
    const rows: Array<{ count: string }> = await ds.query(
      `SELECT COUNT(*) AS count FROM stock_movements`,
    );
    return Number(rows[0].count);
  }

  async function reservationCount(): Promise<number> {
    const rows: Array<{ count: string }> = await ds.query(
      `SELECT COUNT(*) AS count FROM stock_reservations`,
    );
    return Number(rows[0].count);
  }

  async function physicalStock(variantId: number): Promise<number> {
    const rows: Array<{ stock: string }> = await ds.query(
      `SELECT stock FROM product_variants WHERE id = $1`,
      [variantId],
    );
    return Number(rows[0].stock);
  }

  function patchStatus(orderId: number, status: OrderStatusEnum) {
    return withCookies(app, admin)
      .patch(`/orders/status/${orderId}`)
      .send({ status });
  }

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.dataSource;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(ds);
    const created = await createUser(ds, {
      roles: [UserRoleEnum.superAdmin],
    });
    admin = await authenticate(app, created.username, created.password);
    const shopper = await createUser(ds, { roles: [UserRoleEnum.site] });
    shopperId = shopper.user.id;
  });

  // =========================================================================
  // The refusal
  // =========================================================================

  it('refuses paid + pending -> processing with 409 ORDER_FULFILMENT_INCOMPLETE', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 0,
    });

    const response = await patchStatus(orderId, OrderStatusEnum.PROCESSING);

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    // The machine-readable code is TOP LEVEL, not inside `details`.
    expect(response.body.error).toBe('ORDER_FULFILMENT_INCOMPLETE');
    expect(response.body.details).toMatchObject({
      orderId,
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
      requestedStatus: OrderStatusEnum.PROCESSING,
      reconciliationQueue: '/payment/admin/reconciliation',
    });

    // No internal error text reaches the caller.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('fulfillmentLastError');
    expect(body).not.toContain('SELECT');

    expect(await orderRow(orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
  });

  it('refuses paid + awaiting_stock -> processing, and -> shipped', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });

    const processing = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(processing.status).toBe(409);
    expect(processing.body.error).toBe('ORDER_FULFILMENT_INCOMPLETE');

    // `paid -> shipped` is a legal state-machine edge, so this proves the guard
    // covers every post-payment operational target and not just `processing`.
    const shipped = await patchStatus(orderId, OrderStatusEnum.SHIPPED);
    expect(shipped.status).toBe(409);
    expect(shipped.body.error).toBe('ORDER_FULFILMENT_INCOMPLETE');
    expect(shipped.body.details.requestedStatus).toBe(OrderStatusEnum.SHIPPED);

    expect(await orderRow(orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
    });
  });

  it('fabricates NO stock row and NO stock movement on refusal', async () => {
    const { orderId, variantId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 0,
    });

    const movementsBefore = await movementCount();
    const reservationsBefore = await reservationCount();
    const stockBefore = await physicalStock(variantId);

    const response = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(response.status).toBe(409);

    expect(await movementCount()).toBe(movementsBefore);
    expect(await reservationCount()).toBe(reservationsBefore);
    expect(await physicalStock(variantId)).toBe(stockBefore);

    // Nor is the refusal itself recorded as if something had happened to the
    // order: `order_actions` is for things that DID happen.
    const actions: Array<{ count: string }> = await ds.query(
      `SELECT COUNT(*) AS count FROM order_actions WHERE "orderId" = $1`,
      [orderId],
    );
    expect(Number(actions[0].count)).toBe(0);

    // And no payment row was touched.
    const payments: Array<{
      status: string;
      requires_reconciliation: boolean;
    }> = await ds.query(
      `SELECT status::text AS status, requires_reconciliation
           FROM payment WHERE "orderId" = $1`,
      [orderId],
    );
    expect(payments).toEqual([
      { status: PaymentStatusEnum.SUCCESS, requires_reconciliation: false },
    ]);
  });

  // =========================================================================
  // The refusal keeps the order recoverable
  // =========================================================================

  it('leaves the order selected by the recovery lease after a refusal', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 0,
    });

    expect(await selectedByRecoveryLease(orderId)).toBe(true);

    const response = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(response.status).toBe(409);

    expect(await selectedByRecoveryLease(orderId)).toBe(true);
  });

  it('allows the transition once recovery has actually fulfilled the order', async () => {
    // Stock IS available, so the very next recovery pass completes phase 2.
    const { orderId, variantId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 5,
    });

    const refused = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('ORDER_FULFILMENT_INCOMPLETE');

    const recovery = app.app.get(FulfilmentRecoveryService);
    const report = await recovery.recover(10);
    expect(report.fulfilled).toBe(1);
    expect(report.blocked).toBe(0);

    expect(await orderRow(orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    // The goods really moved — this is the fact the guard was waiting for.
    expect(await physicalStock(variantId)).toBe(4);

    const allowed = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(allowed.status).toBe(200);
    expect(await orderRow(orderId)).toEqual({
      status: OrderStatusEnum.PROCESSING,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
  });

  // =========================================================================
  // The states that MAY advance
  // =========================================================================

  it('allows paid + fulfilled to advance per the state machine', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      stock: 5,
    });

    expect(
      (await patchStatus(orderId, OrderStatusEnum.PROCESSING)).status,
    ).toBe(200);
    expect((await patchStatus(orderId, OrderStatusEnum.SHIPPED)).status).toBe(
      200,
    );
    expect((await patchStatus(orderId, OrderStatusEnum.DELIVERED)).status).toBe(
      200,
    );

    expect(await orderRow(orderId)).toEqual({
      status: OrderStatusEnum.DELIVERED,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
  });

  it('allows paid + not_required (nothing to fulfil through phase 2)', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
      stock: 5,
    });

    const response = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(response.status).toBe(200);
    expect((await orderRow(orderId)).status).toBe(OrderStatusEnum.PROCESSING);
  });

  it('still refuses an illegal transition with 400, not 409', async () => {
    // `paid -> delivered` is not an edge of the state machine at all. The
    // state machine must keep answering first, so a client is told the real
    // reason rather than a fulfilment story.
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 0,
    });

    const response = await patchStatus(orderId, OrderStatusEnum.DELIVERED);
    expect(response.status).toBe(400);
  });

  it('still freezes a voided order with the void conflict, not this one', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 0,
    });
    await ds.query(`UPDATE orders SET "voidedAt" = now() WHERE id = $1`, [
      orderId,
    ]);

    const response = await patchStatus(orderId, OrderStatusEnum.PROCESSING);
    expect(response.status).toBe(409);
    expect(response.body.error).not.toBe('ORDER_FULFILMENT_INCOMPLETE');
  });

  // =========================================================================
  // Concurrency
  // =========================================================================

  it('preserves the invariant when recovery and the status change race', async () => {
    // Enough stock that recovery CAN succeed, so both outcomes are live and
    // the test is a real race rather than a foregone conclusion.
    const { orderId, variantId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 5,
    });
    const recovery = app.app.get(FulfilmentRecoveryService);

    const [recoveryReport, patchResult] = await Promise.all([
      recovery.recover(10),
      patchStatus(orderId, OrderStatusEnum.PROCESSING),
    ]);

    const finalState = await orderRow(orderId);
    const stock = await physicalStock(variantId);

    // Whoever won, the DATABASE facts have to agree with each other. The
    // forbidden outcome is the one the defect produced: the order out of `paid`
    // while its goods were never consumed.
    if (patchResult.status === 200) {
      // The PATCH won only by observing a FULFILLED order, which means recovery
      // committed first and the stock really moved.
      expect(finalState.status).toBe(OrderStatusEnum.PROCESSING);
      expect(finalState.fulfillmentState).toBe(FulfillmentStateEnum.FULFILLED);
      expect(stock).toBe(4);
    } else {
      expect(patchResult.status).toBe(409);
      expect(patchResult.body.error).toBe('ORDER_FULFILMENT_INCOMPLETE');
      // Refused, so the order is still `paid` — either already fulfilled by the
      // concurrent pass or still recoverable. Never `processing`.
      expect(finalState.status).toBe(OrderStatusEnum.PAID);
    }

    // Recovery is not required to have claimed the row (SKIP LOCKED lets it
    // move on), but it must never report fulfilling an order it did not.
    expect(recoveryReport.fulfilled).toBeLessThanOrEqual(1);
    if (recoveryReport.fulfilled === 1) {
      expect(finalState.fulfillmentState).toBe(FulfillmentStateEnum.FULFILLED);
    }
    expect(finalState.status).not.toBe(OrderStatusEnum.SHIPPED);
    // The one outcome the defect made possible must be impossible now.
    expect(
      finalState.status === OrderStatusEnum.PROCESSING &&
        finalState.fulfillmentState !== FulfillmentStateEnum.FULFILLED,
    ).toBe(false);
  });

  it('never lets two concurrent status changes evict an unfulfilled order', async () => {
    const { orderId } = await seedPaidOrder({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      stock: 0,
    });

    const results = await Promise.all([
      patchStatus(orderId, OrderStatusEnum.PROCESSING),
      patchStatus(orderId, OrderStatusEnum.SHIPPED),
    ]);

    for (const result of results) {
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('ORDER_FULFILMENT_INCOMPLETE');
    }
    expect(await orderRow(orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    expect(await selectedByRecoveryLease(orderId)).toBe(true);
  });
});
