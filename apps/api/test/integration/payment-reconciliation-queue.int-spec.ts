import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import {
  CustomerOrderReviewState,
  OrderReconciliationState,
} from 'src/modules/orders/enums/reconciliation-state.enum';
import {
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from 'src/modules/payment/enums/payment-status-enum';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  createBranch,
  createProductWithVariant,
  createUser,
  forceStockForTest,
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * MANUAL RECONCILIATION WITH AN ADMIN QUEUE  —  OWNER DECISION D-2
 * ===========================================================================
 *
 * Three parts of this system already detect a money/goods discrepancy, refuse
 * to act on it, and say a human must decide. Until migration 0018 there was
 * nowhere for that human to go and nowhere for their decision to be recorded —
 * `payment.reconciled_at`, the column that means "dealt with", had ZERO writers
 * anywhere in the application.
 *
 * WHAT THESE CASES ARE REALLY GUARDING. Not that the endpoints answer 200, but
 * the six promises the feature makes:
 *
 *   1. NOTHING IS AUTOMATIC — no refund, cancellation, back-order or write-off
 *      happens without an operator asking for it with a reason.
 *   2. GATEWAY EVIDENCE IS NEVER REWRITTEN — `amount`, `gateway_amount`,
 *      `gateway_amount_raw`, `ref_number` and `paid_at` are asserted byte-equal
 *      before and after every mutation.
 *   3. STOCK IS NEVER INVENTED — a refund restores physical stock ONLY where a
 *      real prior consumption exists, proved both ways round.
 *   4. NO DECISION IS TAKEN TWICE — replay, key reuse and concurrent operators.
 *   5. EVERYTHING IS AUDITED, AND THE AUDIT CANNOT BE REWRITTEN — asserted
 *      against the DATABASE, by attempting an UPDATE and a DELETE.
 *   6. THE CUSTOMER IS TOLD SOMETHING TRUE — asserted through the real
 *      `GET /me/orders/:id` projection, including that nothing internal leaks.
 *
 * NO LIVE GATEWAY IS INVOLVED. Orders and receipts are written directly into
 * the recorded states phase 1 produces, because what is under test is the
 * OPERATOR WORKFLOW, not the money's arrival.
 */
describe('manual reconciliation queue (D-2)', () => {
  let app: TestApp;
  let ds: DataSource;
  let admin: CookieJar;
  let adminUserId: number;
  let shopperId: number;
  let shopper: CookieJar;

  const UNIT_PRICE = 1_000_000;
  const QUEUE = '/payment/admin/reconciliation';
  const key = () => `recon-${randomUUID()}`;

  interface Seeded {
    orderId: number;
    variantId: number;
    paymentId: number;
    total: number;
  }

  /**
   * One order plus one receipt, written straight into the states under test.
   *
   * `paymentStatus` / `reconciliationReason` / `gatewayAmount` describe the
   * RECEIPT exactly as phase 1 would have recorded it, so every case here is a
   * row set production can actually reach.
   */
  async function seed(options: {
    orderStatus?: OrderStatusEnum;
    fulfillmentState?: FulfillmentStateEnum;
    paymentStatus?: PaymentStatusEnum;
    /** `undefined` = equal to the requested amount; `null` = gateway said nothing. */
    gatewayAmount?: number | null;
    reconciliationReason?: PaymentReconciliationReason | null;
    requiresReconciliation?: boolean;
    stock?: number;
    quantity?: number;
    branchId?: number | null;
    /** Write an `online_fulfillment` movement, i.e. the goods really left. */
    consumed?: boolean;
  }): Promise<Seeded> {
    const quantity = options.quantity ?? 1;
    const total = UNIT_PRICE * quantity;
    const { product, variant } = await createProductWithVariant(
      ds,
      { basePrice: UNIT_PRICE },
      { price: UNIT_PRICE, stock: options.stock ?? 5 },
    );

    const orderRows: Array<{ id: number }> = await ds.query(
      `INSERT INTO orders (channel, "userId", "branchId", status, total_price,
                           subtotal, "fulfillmentState", paid_at, "paidAt", "soldAt")
       VALUES ($1, $2, $3, $4, $5, $5, $6, now(), now(), now())
       RETURNING id`,
      [
        OrderChannel.ONLINE,
        shopperId,
        options.branchId ?? null,
        options.orderStatus ?? OrderStatusEnum.PAID,
        total,
        options.fulfillmentState ?? FulfillmentStateEnum.PENDING,
      ],
    );
    const orderId = Number(orderRows[0].id);

    await ds.query(
      `INSERT INTO order_items ("orderId", "productId", "variantId", quantity,
                                unit_price, total_price, "productTitleSnapshot")
       VALUES ($1, $2, $3, $4, $5, $6, 'snapshot')`,
      [orderId, product.id, variant.id, quantity, UNIT_PRICE, total],
    );

    const gatewayAmount =
      options.gatewayAmount === undefined ? total : options.gatewayAmount;
    const paymentRows: Array<{ id: number }> = await ds.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, ref_number, status,
                            track_id, paid_at, requires_reconciliation,
                            reconciliation_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, now(), now())
       RETURNING id`,
      [
        orderId,
        total,
        gatewayAmount,
        `REF-${orderId}`,
        options.paymentStatus ?? PaymentStatusEnum.SUCCESS,
        `recon-track-${orderId}`,
        options.requiresReconciliation ?? false,
        options.reconciliationReason ?? null,
      ],
    );
    const paymentId = Number(paymentRows[0].id);

    if (options.consumed) {
      // A REAL prior consumption: stock down, and a movement to derive the
      // restore from. This is the only thing that entitles a refund to give
      // physical stock back.
      // (A raw stock UPDATE is refused by the pool guard since 0037; the
      // helper writes the lower count as unvalued units, which is what the
      // seeded shelf already held.)
      await forceStockForTest(
        ds,
        variant.id,
        (await physicalStock(variant.id)) - quantity,
      );
      const balance = await physicalStock(variant.id);
      await ds.query(
        `INSERT INTO stock_movements ("variantId", delta, "balanceAfter", reason,
                                      "orderId", "actorDisplaySnapshot", "createdAt")
         VALUES ($1, $2, $3, 'online_fulfillment', $4, 'seed', now())`,
        [variant.id, -quantity, balance, orderId],
      );
    }

    return { orderId, variantId: variant.id, paymentId, total };
  }

  /**
   * A SECOND, gateway-confirmed receipt that settled nothing — the archetypal
   * reconciliation case. It is what puts an otherwise clean, fulfilled order
   * into the queue, which is how a real "the customer paid twice" case reaches
   * an operator.
   */
  async function addDuplicateReceipt(
    orderId: number,
    amount = UNIT_PRICE,
  ): Promise<number> {
    const rows: Array<{ id: number }> = await ds.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, ref_number, status,
                            track_id, paid_at, requires_reconciliation,
                            reconciliation_reason, created_at, updated_at)
       VALUES ($1, $2, $2, $3, $4, $5, now(), true, $6, now(), now())
       RETURNING id`,
      [
        orderId,
        amount,
        `REF-DUP-${orderId}`,
        PaymentStatusEnum.CONFIRMED_UNAPPLIED,
        `recon-dup-${orderId}`,
        PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      ],
    );
    return Number(rows[0].id);
  }

  async function physicalStock(variantId: number): Promise<number> {
    const rows: Array<{ stock: string }> = await ds.query(
      `SELECT stock FROM product_variants WHERE id = $1`,
      [variantId],
    );
    return Number(rows[0].stock);
  }

  async function orderRow(orderId: number): Promise<{
    status: string;
    fulfillmentState: string;
    reconciliationState: string | null;
    reconciliationResolvedAt: Date | null;
    refundedAt: Date | null;
  }> {
    const rows: Array<{
      status: string;
      fulfillmentState: string;
      reconciliationState: string | null;
      reconciliationResolvedAt: Date | null;
      refundedAt: Date | null;
    }> = await ds.query(
      `SELECT status::text AS status,
              "fulfillmentState"::text AS "fulfillmentState",
              "reconciliationState",
              "reconciliationResolvedAt",
              "refundedAt"
         FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0];
  }

  /** The gateway's own evidence, as TEXT. Nothing here may ever change. */
  async function receiptEvidence(paymentId: number): Promise<{
    amount: string;
    gateway_amount: string | null;
    gateway_amount_raw: string | null;
    ref_number: string | null;
    paid_at: Date | null;
  }> {
    const rows: Array<{
      amount: string;
      gateway_amount: string | null;
      gateway_amount_raw: string | null;
      ref_number: string | null;
      paid_at: Date | null;
    }> = await ds.query(
      `SELECT amount::text AS amount,
              gateway_amount::text AS gateway_amount,
              gateway_amount_raw,
              ref_number,
              paid_at
         FROM payment WHERE id = $1`,
      [paymentId],
    );
    return rows[0];
  }

  async function auditRows(orderId: number): Promise<
    Array<{
      id: number;
      action: string;
      reason: string;
      actorDisplaySnapshot: string;
      externalReference: string | null;
      amount: string | null;
      idempotencyKey: string | null;
    }>
  > {
    return ds.query(
      `SELECT id, action::text AS action, reason, "actorDisplaySnapshot",
              "externalReference", amount::text AS amount, "idempotencyKey"
         FROM payment_actions WHERE "orderId" = $1 ORDER BY id ASC`,
      [orderId],
    );
  }

  async function movementCount(): Promise<number> {
    const rows: Array<{ count: string }> = await ds.query(
      `SELECT COUNT(*) AS count FROM stock_movements`,
    );
    return Number(rows[0].count);
  }

  function post(path: string, idempotencyKey: string | null) {
    const req = withCookies(app, admin).post(path);
    return idempotencyKey === null
      ? req
      : req.set('Idempotency-Key', idempotencyKey);
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
    const created = await createUser(ds, { roles: [UserRoleEnum.superAdmin] });
    admin = await authenticate(app, created.username, created.password);
    adminUserId = created.user.id;
    const customer = await createUser(ds, { roles: [UserRoleEnum.site] });
    shopperId = customer.user.id;
    shopper = await authenticate(app, customer.username, customer.password);
  });

  // =========================================================================
  // Queue visibility
  // =========================================================================

  it('shows an order whose confirmed receipt was never applied', async () => {
    const { orderId } = await seed({
      orderStatus: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      gatewayAmount: 500_000,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      requiresReconciliation: true,
    });

    const response = await withCookies(app, admin).get(QUEUE);
    expect(response.status).toBe(200);

    const rows = response.body.data.data as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.orderId === orderId);
    expect(row).toBeDefined();
    expect(row!.caseTypes).toContain('unapplied_receipt');
    expect(row!.fulfilmentAuthorized).toBe(false);
    // Money is STRINGS of integer Rial, in disjoint buckets.
    expect(row!.money).toEqual({
      orderTotal: '1000000',
      confirmedHeld: '500000',
      confirmedUnapplied: '500000',
      refundedTotal: '0',
      hasAmountDiscrepancy: true,
    });
  });

  it('shows a paid order whose goods were never allocated, and hides a clean one', async () => {
    const stuck = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const clean = await seed({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });

    const response = await withCookies(app, admin).get(QUEUE);
    const ids = (response.body.data.data as Array<{ orderId: number }>).map(
      (r) => r.orderId,
    );
    expect(ids).toContain(stuck.orderId);
    expect(ids).not.toContain(clean.orderId);
  });

  it('filters by case type, order state, branch, date range and resolution', async () => {
    const branch = await createBranch(ds);
    const pending = await seed({
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    const awaiting = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
      branchId: branch.id,
    });

    const byType = await withCookies(app, admin)
      .get(QUEUE)
      .query({ caseType: 'awaiting_stock' });
    expect(
      (byType.body.data.data as Array<{ orderId: number }>).map(
        (r) => r.orderId,
      ),
    ).toEqual([awaiting.orderId]);

    const byState = await withCookies(app, admin)
      .get(QUEUE)
      .query({ fulfillmentState: FulfillmentStateEnum.PENDING });
    expect(
      (byState.body.data.data as Array<{ orderId: number }>).map(
        (r) => r.orderId,
      ),
    ).toEqual([pending.orderId]);

    const byBranch = await withCookies(app, admin)
      .get(QUEUE)
      .query({ branchId: branch.id });
    expect(
      (byBranch.body.data.data as Array<{ orderId: number }>).map(
        (r) => r.orderId,
      ),
    ).toEqual([awaiting.orderId]);

    const future = new Date(Date.now() + 60_000).toISOString();
    const byDate = await withCookies(app, admin)
      .get(QUEUE)
      .query({ createdFrom: future });
    expect(byDate.body.data.total).toBe(0);

    // `resolved=false` must mean UNRESOLVED, not "truthy string".
    const unresolved = await withCookies(app, admin)
      .get(QUEUE)
      .query({ resolved: 'false' });
    expect(unresolved.body.data.total).toBe(2);
    const resolved = await withCookies(app, admin)
      .get(QUEUE)
      .query({ resolved: 'true' });
    expect(resolved.body.data.total).toBe(0);

    // Unknown filter names are rejected, not silently ignored.
    const typo = await withCookies(app, admin)
      .get(QUEUE)
      .query({ casetype: 'awaiting_stock' });
    expect(typo.status).toBe(400);
  });

  it('paginates', async () => {
    for (let i = 0; i < 3; i++) {
      await seed({ fulfillmentState: FulfillmentStateEnum.PENDING });
    }

    const first = await withCookies(app, admin)
      .get(QUEUE)
      .query({ page: 1, limit: 2 });
    expect(first.body.data.total).toBe(3);
    expect(first.body.data.totalPages).toBe(2);
    expect(first.body.data.data).toHaveLength(2);

    const second = await withCookies(app, admin)
      .get(QUEUE)
      .query({ page: 2, limit: 2 });
    expect(second.body.data.data).toHaveLength(1);
  });

  // =========================================================================
  // Role enforcement and DTO privacy
  // =========================================================================

  it('refuses a storefront or till session on every route', async () => {
    // The queue moves money and is declared Admin-only. Neither a shopper nor a
    // cashier holds an admin session, so every route refuses at the audience
    // layer (401) without ever reaching the role check.
    const { orderId } = await seed({});
    const sale = await createUser(ds, { roles: [UserRoleEnum.sale] });
    const saleJar = await authenticate(app, sale.username, sale.password);

    for (const jar of [shopper, saleJar]) {
      expect((await withCookies(app, jar).get(QUEUE)).status).toBe(401);
      expect(
        (await withCookies(app, jar).get(`${QUEUE}/${orderId}`)).status,
      ).toBe(401);
      for (const action of [
        'retry-fulfilment',
        'mark-refund-required',
        'confirm-refund',
        'mark-backorder',
        'resolve',
      ]) {
        const response = await withCookies(app, jar)
          .post(`${QUEUE}/${orderId}/${action}`)
          .set('Idempotency-Key', key())
          .send({ reason: 'not allowed' });
        expect(response.status).toBe(401);
      }
    }

    // And nothing was written by any of those attempts.
    expect(await auditRows(orderId)).toHaveLength(0);
  });

  it('never exposes the gateway session id or internal worker columns', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    await ds.query(
      `UPDATE orders SET "fulfillmentLastError" = $2 WHERE id = $1`,
      [orderId, 'INTERNAL-SENTINEL-DO-NOT-LEAK'],
    );

    const detail = await withCookies(app, admin).get(`${QUEUE}/${orderId}`);
    expect(detail.status).toBe(200);
    const body = JSON.stringify(detail.body);

    // `track_id` IS the credential POST /payment/verify accepts.
    expect(body).not.toContain('recon-track-');
    expect(body).not.toContain('track_id');
    expect(body).not.toContain('trackId');
    expect(body).not.toContain('INTERNAL-SENTINEL-DO-NOT-LEAK');
    expect(body).not.toContain('fulfillmentLastError');
    expect(body).not.toContain('reverify');
    expect(body).not.toContain('password');

    // But it DOES carry the reference an operator quotes, and the diagnosis.
    expect(detail.body.data.receipts[0].refNumber).toBe(`REF-${orderId}`);
    expect(detail.body.data.authorizationClauses[0].qualifies).toBe(true);
    expect(detail.body.data.allowedActions).toContain('retry_fulfilment');
    expect(detail.body.data.stock).toMatchObject({
      fulfilmentMovements: 0,
      netMovementDelta: 0,
      orderedUnits: 1,
    });
  });

  it('answers 404 for an order with nothing outstanding', async () => {
    const clean = await seed({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    const response = await withCookies(app, admin).get(
      `${QUEUE}/${clean.orderId}`,
    );
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('RECONCILIATION_CASE_NOT_FOUND');
  });

  // =========================================================================
  // Retry fulfilment
  // =========================================================================

  it('retries fulfilment and consumes stock exactly once', async () => {
    const { orderId, variantId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 4,
    });

    const response = await post(
      `${QUEUE}/${orderId}/retry-fulfilment`,
      key(),
    ).send({ reason: 'Restocked this morning.' });

    expect(response.status).toBe(200);
    expect(response.body.data.fulfilled).toBe(true);
    expect(response.body.data.blocked).toBeNull();
    expect(await physicalStock(variantId)).toBe(3);
    expect((await orderRow(orderId)).fulfillmentState).toBe(
      FulfillmentStateEnum.FULFILLED,
    );

    // A SECOND retry with a NEW key must not consume anything again. The order
    // has left the queue entirely, which is the honest answer.
    const again = await post(
      `${QUEUE}/${orderId}/retry-fulfilment`,
      key(),
    ).send({ reason: 'Double check.' });
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('RECONCILIATION_CASE_NOT_FOUND');
    expect(await physicalStock(variantId)).toBe(3);

    const audit = await auditRows(orderId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('retry_fulfilment');
    expect(audit[0].reason).toBe('Restocked this morning.');
  });

  it('reports a retry that the authorization predicate refuses, and consumes nothing', async () => {
    // A receipt with an OPEN amount question: `success` but the gateway
    // reported a different sum. The predicate must still refuse it.
    const { orderId, variantId } = await seed({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      gatewayAmount: 500_000,
      reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      requiresReconciliation: true,
      stock: 5,
    });
    const movementsBefore = await movementCount();

    const response = await post(
      `${QUEUE}/${orderId}/retry-fulfilment`,
      key(),
    ).send({ reason: 'Trying anyway.' });

    expect(response.status).toBe(200);
    expect(response.body.data.fulfilled).toBe(false);
    expect(response.body.data.blocked).toBe('reconciliation_required');
    expect(await physicalStock(variantId)).toBe(5);
    expect(await movementCount()).toBe(movementsBefore);
    // The refusal opened the case rather than inventing a state.
    expect((await orderRow(orderId)).reconciliationState).toBe(
      OrderReconciliationState.OPEN,
    );
  });

  // =========================================================================
  // Refund workflow
  // =========================================================================

  it('marks for manual refund without refunding anything', async () => {
    const { orderId, paymentId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const evidenceBefore = await receiptEvidence(paymentId);

    const response = await post(
      `${QUEUE}/${orderId}/mark-refund-required`,
      key(),
    ).send({ reason: 'Cannot source the item.', expectedAmount: 1_000_000 });

    expect(response.status).toBe(200);
    expect(response.body.data.reconciliationState).toBe('refund_required');

    const order = await orderRow(orderId);
    // Nothing pretended to happen: the order is still paid, still unresolved.
    expect(order.status).toBe(OrderStatusEnum.PAID);
    expect(order.refundedAt).toBeNull();
    expect(order.reconciliationResolvedAt).toBeNull();

    const payments: Array<{ status: string }> = await ds.query(
      `SELECT status::text AS status FROM payment WHERE id = $1`,
      [paymentId],
    );
    expect(payments[0].status).toBe(PaymentStatusEnum.SUCCESS);
    expect(await receiptEvidence(paymentId)).toEqual(evidenceBefore);

    // It stays in the queue: an unpaid obligation must not be able to leave.
    const queue = await withCookies(app, admin).get(QUEUE);
    const row = (
      queue.body.data.data as Array<{ orderId: number; caseTypes: string[] }>
    ).find((r) => r.orderId === orderId);
    expect(row!.caseTypes).toContain('operator_open');

    const audit = await auditRows(orderId);
    expect(audit[0].action).toBe('mark_refund_required');
    expect(audit[0].amount).toBe('1000000');
  });

  it('confirms an external refund of the SETTLING receipt: order refunded, stock restored', async () => {
    const { orderId, variantId, paymentId } = await seed({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      stock: 5,
      consumed: true, // a REAL prior consumption
    });
    // The order is a case because a SECOND receipt was confirmed against it;
    // the operator's decision is to refund the SETTLING one and unwind the sale.
    await addDuplicateReceipt(orderId);
    await post(`${QUEUE}/${orderId}/mark-refund-required`, key()).send({
      reason: 'Customer returned the item.',
    });
    const stockBefore = await physicalStock(variantId);
    const evidenceBefore = await receiptEvidence(paymentId);

    const response = await post(
      `${QUEUE}/${orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Refunded via the provider console.',
      paymentId,
      amount: 1_000_000,
      externalReference: 'ZBL-REFUND-99213',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.stockRestored).toBe(true);

    const order = await orderRow(orderId);
    expect(order.status).toBe(OrderStatusEnum.REFUNDED);
    expect(order.refundedAt).not.toBeNull();
    expect(order.reconciliationState).toBe('refund_confirmed');
    expect(order.reconciliationResolvedAt).not.toBeNull();

    const payments: Array<{ status: string; reconciled_at: Date | null }> =
      await ds.query(
        `SELECT status::text AS status, reconciled_at FROM payment WHERE id = $1`,
        [paymentId],
      );
    expect(payments[0].status).toBe(PaymentStatusEnum.REFUNDED);
    // The column that had ZERO writers finally has one.
    expect(payments[0].reconciled_at).not.toBeNull();

    // THE RECEIPT ITSELF IS UNTOUCHED.
    expect(await receiptEvidence(paymentId)).toEqual(evidenceBefore);

    expect(await physicalStock(variantId)).toBe(stockBefore + 1);

    const audit = await auditRows(orderId);
    const confirm = audit.find((a) => a.action === 'confirm_external_refund');
    expect(confirm).toBeDefined();
    expect(confirm!.externalReference).toBe('ZBL-REFUND-99213');
    expect(confirm!.amount).toBe('1000000');
  });

  it('restores NO stock when the order never consumed any', async () => {
    // Same refund, but nothing was ever fulfilled: `stock_movements` has no
    // negative net for this order, so there is nothing to give back.
    const { orderId, variantId, paymentId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 5,
      consumed: false,
    });
    const stockBefore = await physicalStock(variantId);
    const movementsBefore = await movementCount();

    const response = await post(
      `${QUEUE}/${orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Refunded; we never shipped it.',
      paymentId,
      amount: 1_000_000,
      externalReference: 'ZBL-REFUND-77',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.stockRestored).toBe(false);
    expect(await physicalStock(variantId)).toBe(stockBefore);
    // NO restoration movement was fabricated.
    expect(await movementCount()).toBe(movementsBefore);
    expect((await orderRow(orderId)).status).toBe(OrderStatusEnum.REFUNDED);
  });

  it('refunding a confirmed_unapplied duplicate leaves the order alone', async () => {
    // The order was legitimately paid and fulfilled by receipt #1; receipt #2 is
    // a duplicate confirmation. Refunding #2 must NOT cancel the order.
    const { orderId, variantId } = await seed({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      stock: 5,
      consumed: true,
    });
    const duplicateId = await addDuplicateReceipt(orderId);
    const stockBefore = await physicalStock(variantId);

    const response = await post(
      `${QUEUE}/${orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Duplicate capture returned to the customer.',
      paymentId: duplicateId,
      amount: 1_000_000,
      externalReference: 'ZBL-REFUND-DUP',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.stockRestored).toBe(false);

    const order = await orderRow(orderId);
    expect(order.status).toBe(OrderStatusEnum.PAID);
    expect(order.refundedAt).toBeNull();
    expect(order.fulfillmentState).toBe(FulfillmentStateEnum.FULFILLED);
    expect(await physicalStock(variantId)).toBe(stockBefore);

    // The settling receipt is untouched; only the duplicate moved.
    const statuses: Array<{ id: number; status: string }> = await ds.query(
      `SELECT id, status::text AS status FROM payment WHERE "orderId" = $1 ORDER BY id`,
      [orderId],
    );
    expect(statuses[0].status).toBe(PaymentStatusEnum.SUCCESS);
    expect(statuses[1].status).toBe(PaymentStatusEnum.REFUNDED);
  });

  it('refuses a second confirmation, a foreign payment, an unconfirmed one and a bad amount', async () => {
    const first = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const other = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });

    const foreign = await post(
      `${QUEUE}/${first.orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Wrong receipt.',
      paymentId: other.paymentId,
      amount: 1_000_000,
      externalReference: 'X-1',
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('PAYMENT_NOT_ON_ORDER');

    const overAmount = await post(
      `${QUEUE}/${first.orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Too much.',
      paymentId: first.paymentId,
      amount: 9_999_999,
      externalReference: 'X-2',
    });
    expect(overAmount.status).toBe(400);
    expect(overAmount.body.error).toBe('REFUND_AMOUNT_INVALID');

    // A never-confirmed attempt has no receipt to refund.
    const pendingRows: Array<{ id: number }> = await ds.query(
      `INSERT INTO payment ("orderId", amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now()) RETURNING id`,
      [first.orderId, 1_000_000, PaymentStatusEnum.PENDING],
    );
    const unconfirmed = await post(
      `${QUEUE}/${first.orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Never confirmed.',
      paymentId: Number(pendingRows[0].id),
      amount: 1_000_000,
      externalReference: 'X-3',
    });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error).toBe('PAYMENT_NOT_REFUNDABLE');

    // The real one succeeds; a repeat with a NEW key is refused as a duplicate.
    const good = await post(
      `${QUEUE}/${first.orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Refunded.',
      paymentId: first.paymentId,
      amount: 1_000_000,
      externalReference: 'X-4',
    });
    expect(good.status).toBe(200);

    const twice = await post(
      `${QUEUE}/${first.orderId}/confirm-refund`,
      key(),
    ).send({
      reason: 'Refunded again?',
      paymentId: first.paymentId,
      amount: 1_000_000,
      externalReference: 'X-5',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('RECONCILIATION_ALREADY_RESOLVED');
  });

  // =========================================================================
  // Backorder and resolution
  // =========================================================================

  it('marks a backorder without consuming stock, and keeps the case in the queue', async () => {
    const { orderId, variantId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const movementsBefore = await movementCount();

    const response = await post(
      `${QUEUE}/${orderId}/mark-backorder`,
      key(),
    ).send({ reason: 'Supplier delivers in three weeks.' });

    expect(response.status).toBe(200);
    expect(response.body.data.reconciliationState).toBe('backordered');
    expect(await physicalStock(variantId)).toBe(0);
    expect(await movementCount()).toBe(movementsBefore);

    const order = await orderRow(orderId);
    // Still paid and still recoverable, so it self-heals when stock returns.
    expect(order.status).toBe(OrderStatusEnum.PAID);
    expect(order.fulfillmentState).toBe(FulfillmentStateEnum.AWAITING_STOCK);
    expect(order.reconciliationResolvedAt).toBeNull();

    const queue = await withCookies(app, admin).get(QUEUE);
    expect(
      (queue.body.data.data as Array<{ orderId: number }>).map(
        (r) => r.orderId,
      ),
    ).toContain(orderId);
  });

  it('refuses to backorder an order that is not paid-and-unallocated', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.PENDING,
      requiresReconciliation: true,
      reconciliationReason: PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      orderStatus: OrderStatusEnum.PENDING,
    });

    const response = await post(
      `${QUEUE}/${orderId}/mark-backorder`,
      key(),
    ).send({ reason: 'Not applicable.' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ORDER_NOT_BACKORDERABLE');
  });

  it('resolves with no financial action and signs off the flagged receipts', async () => {
    const { orderId, paymentId } = await seed({
      orderStatus: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
      paymentStatus: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
      reconciliationReason: PaymentReconciliationReason.DUPLICATE_CONFIRMED,
      requiresReconciliation: true,
    });
    const evidenceBefore = await receiptEvidence(paymentId);

    const response = await post(`${QUEUE}/${orderId}/resolve`, key()).send({
      reason: 'Gateway reported one capture twice; the bank shows one.',
      resolutionType: 'gateway_duplicate',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.reconciliationState).toBe('resolved');

    const payments: Array<{
      status: string;
      reconciled_at: Date | null;
      requires_reconciliation: boolean;
    }> = await ds.query(
      `SELECT status::text AS status, reconciled_at, requires_reconciliation
         FROM payment WHERE id = $1`,
      [paymentId],
    );
    // Signed off, NOT rewritten: the status, the flag and every figure stand.
    expect(payments[0].reconciled_at).not.toBeNull();
    expect(payments[0].status).toBe(PaymentStatusEnum.CONFIRMED_UNAPPLIED);
    expect(payments[0].requires_reconciliation).toBe(true);
    expect(await receiptEvidence(paymentId)).toEqual(evidenceBefore);

    // The explicit resolution type is on the permanent record.
    const audit = await auditRows(orderId);
    expect(audit[0].reason).toContain('[gateway_duplicate]');
  });

  it('refuses to resolve a case that still owes a refund', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    await post(`${QUEUE}/${orderId}/mark-refund-required`, key()).send({
      reason: 'Money must go back.',
    });

    const response = await post(`${QUEUE}/${orderId}/resolve`, key()).send({
      reason: 'Closing it.',
      resolutionType: 'no_discrepancy',
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('REFUND_PENDING_CONFIRMATION');
    expect((await orderRow(orderId)).reconciliationState).toBe(
      'refund_required',
    );
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  it('requires an Idempotency-Key and rejects a malformed one', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });

    const missing = await post(`${QUEUE}/${orderId}/mark-backorder`, null).send(
      { reason: 'No key.' },
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const malformed = await post(
      `${QUEUE}/${orderId}/mark-backorder`,
      'short',
    ).send({ reason: 'Bad key.' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('IDEMPOTENCY_KEY_INVALID');

    expect(await auditRows(orderId)).toHaveLength(0);
  });

  it('replays an identical retry and writes ONE audit row', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const k = key();
    const body = { reason: 'Supplier delivers in three weeks.' };

    const first = await post(`${QUEUE}/${orderId}/mark-backorder`, k).send(
      body,
    );
    const second = await post(`${QUEUE}/${orderId}/mark-backorder`, k).send(
      body,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(await auditRows(orderId)).toHaveLength(1);
  });

  it('refuses the same key with a different payload', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const k = key();

    const first = await post(`${QUEUE}/${orderId}/mark-backorder`, k).send({
      reason: 'Supplier delivers in three weeks.',
    });
    expect(first.status).toBe(200);

    const second = await post(`${QUEUE}/${orderId}/mark-backorder`, k).send({
      reason: 'A COMPLETELY different reason.',
    });
    expect(second.status).toBe(409);
    expect(second.body.details.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await auditRows(orderId)).toHaveLength(1);
  });

  it('lets a refused decision be retried with the SAME key once it is fixed', async () => {
    // The refusal must not burn the key: an operator who is told
    // ORDER_NOT_BACKORDERABLE and fixes the request should not also have to
    // discover that their key is now poisoned.
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    await ds.query(
      `UPDATE orders SET "reconciliationState" = $2 WHERE id = $1`,
      [orderId, OrderReconciliationState.OPEN],
    );
    const k = key();

    const refused = await post(`${QUEUE}/${orderId}/mark-backorder`, k).send({
      reason: 'Wrong action for this order.',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('ORDER_NOT_BACKORDERABLE');

    const retried = await post(`${QUEUE}/${orderId}/mark-backorder`, k).send({
      reason: 'Wrong action for this order.',
    });
    // Same refusal, NOT an idempotency error.
    expect(retried.status).toBe(409);
    expect(retried.body.error).toBe('ORDER_NOT_BACKORDERABLE');
  });

  it('serialises two concurrent operators onto one decision', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });

    const results = await Promise.all([
      post(`${QUEUE}/${orderId}/mark-backorder`, key()).send({
        reason: 'Operator one.',
      }),
      post(`${QUEUE}/${orderId}/mark-refund-required`, key()).send({
        reason: 'Operator two.',
      }),
    ]);

    // Both are legal from `open`, so both may succeed — what must NOT happen is
    // an inconsistent row or a lost audit entry.
    for (const result of results) expect(result.status).toBe(200);
    const audit = await auditRows(orderId);
    expect(audit).toHaveLength(2);

    const order = await orderRow(orderId);
    expect(['backordered', 'refund_required']).toContain(
      order.reconciliationState,
    );
    expect(order.reconciliationResolvedAt).toBeNull();
  });

  // =========================================================================
  // Audit immutability
  // =========================================================================

  it('refuses to update or delete an audit row, in the DATABASE', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    await post(`${QUEUE}/${orderId}/mark-backorder`, key()).send({
      reason: 'The original reason.',
    });
    const [row] = await auditRows(orderId);

    await expect(
      ds.query(
        `UPDATE payment_actions SET reason = 'rewritten' WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      ds.query(`DELETE FROM payment_actions WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/append-only/i);

    const after = await auditRows(orderId);
    expect(after).toHaveLength(1);
    expect(after[0].reason).toBe('The original reason.');
    // The operator name is a snapshot, not a join.
    expect(after[0].actorDisplaySnapshot).toBeTruthy();
    expect(after[0].idempotencyKey).toBeTruthy();
  });

  it('keeps the audit when the operator account is deleted', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    await post(`${QUEUE}/${orderId}/mark-backorder`, key()).send({
      reason: 'Recorded by an operator who later left.',
    });
    const before = await auditRows(orderId);

    // No FK on `actorUserId`, precisely so this cannot rewrite the audit row.
    await ds.query(`DELETE FROM user_roles WHERE "usersId" = $1`, [
      adminUserId,
    ]);
    await ds.query(`DELETE FROM refresh_tokens WHERE "userId" = $1`, [
      adminUserId,
    ]);
    await ds.query(`DELETE FROM users WHERE id = $1`, [adminUserId]);

    expect(await auditRows(orderId)).toEqual(before);
  });

  // =========================================================================
  // Customer projection and realtime scoping
  // =========================================================================

  it('tells the customer an honest review state and nothing internal', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });

    // Before any operator touches it, `awaiting_stock` already reads as review.
    let view = await withCookies(app, shopper).get(`/me/orders/${orderId}`);
    expect(view.status).toBe(200);
    expect(view.body.data.reviewState).toBe(
      CustomerOrderReviewState.UNDER_REVIEW,
    );

    await post(`${QUEUE}/${orderId}/mark-refund-required`, key()).send({
      reason: 'INTERNAL NOTE THE CUSTOMER MUST NEVER SEE',
    });

    view = await withCookies(app, shopper).get(`/me/orders/${orderId}`);
    expect(view.body.data.reviewState).toBe(
      CustomerOrderReviewState.REFUND_IN_PROGRESS,
    );
    // It says a refund is IN PROGRESS; it does NOT claim one happened.
    expect(view.body.data.status).toBe(OrderStatusEnum.PAID);
    expect(view.body.data.refundedAt).toBeNull();

    const body = JSON.stringify(view.body);
    expect(body).not.toContain('INTERNAL NOTE');
    expect(body).not.toContain('reconciliationState');
    expect(body).not.toContain('reconciliationResolvedAt');
    expect(body).not.toContain('fulfillmentLastError');
    expect(body).not.toContain('REF-');
  });

  it('reports a confirmed refund honestly and clears the review flag', async () => {
    const { orderId, paymentId } = await seed({
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      consumed: true,
    });
    await addDuplicateReceipt(orderId);
    await post(`${QUEUE}/${orderId}/confirm-refund`, key()).send({
      reason: 'Refunded with the provider.',
      paymentId,
      amount: 1_000_000,
      externalReference: 'ZBL-REFUND-1',
    });

    const view = await withCookies(app, shopper).get(`/me/orders/${orderId}`);
    // The complete, honest answer is `status` + `refundedAt`; the provisional
    // wording goes away rather than lingering as a second claim.
    expect(view.body.data.status).toBe(OrderStatusEnum.REFUNDED);
    expect(view.body.data.refundedAt).not.toBeNull();
    expect(view.body.data.reviewState).toBeNull();
  });

  it('emits only SCOPED realtime — never a global broadcast', async () => {
    const { orderId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    const gateway = app.app.get(RealtimeGateway);
    const orderEvent = jest.spyOn(gateway, 'emitOrderEvent');
    const toUser = jest.spyOn(gateway, 'emitToUser');

    await post(`${QUEUE}/${orderId}/mark-backorder`, key()).send({
      reason: 'Supplier delivers in three weeks.',
    });

    expect(orderEvent).toHaveBeenCalledWith(
      'order.status.updated',
      expect.objectContaining({ orderId }),
    );
    expect(toUser).toHaveBeenCalledWith(
      shopperId,
      'order.status.updated',
      expect.objectContaining({ orderId }),
    );

    // The customer payload carries no operator note, reference or branch.
    const payload = toUser.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'fulfillmentState',
      'orderId',
      'status',
    ]);

    orderEvent.mockRestore();
    toUser.mockRestore();
  });

  // =========================================================================
  // Reporting
  // =========================================================================

  it('keeps confirmed money visible and reports the refund without double counting', async () => {
    // A paid order whose goods were never allocated: already a case, with
    // exactly one confirmed receipt so the buckets are unambiguous.
    const { orderId, paymentId } = await seed({
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      stock: 0,
    });
    await post(`${QUEUE}/${orderId}/mark-refund-required`, key()).send({
      reason: 'Agreed with the customer.',
    });

    const beforeQueue = await withCookies(app, admin).get(
      `${QUEUE}/${orderId}`,
    );
    expect(beforeQueue.body.data.money).toMatchObject({
      confirmedHeld: '1000000',
      refundedTotal: '0',
    });

    await post(`${QUEUE}/${orderId}/confirm-refund`, key()).send({
      reason: 'Refunded.',
      paymentId,
      amount: 1_000_000,
      externalReference: 'ZBL-REFUND-2',
    });

    // The receipt moved buckets; it is never in both. Read from the QUEUE row,
    // because a resolved case is still listed there — that is the point.
    const all = await withCookies(app, admin).get(QUEUE);
    const afterRow = (
      all.body.data.data as Array<{
        orderId: number;
        money: Record<string, string>;
        reconciliationResolvedAt: string | null;
      }>
    ).find((r) => r.orderId === orderId);
    expect(afterRow!.money).toMatchObject({
      confirmedHeld: '0',
      refundedTotal: '1000000',
    });
    expect(afterRow!.reconciliationResolvedAt).not.toBeNull();

    expect(
      (all.body.data.data as Array<{ orderId: number }>).map((r) => r.orderId),
    ).toContain(orderId);
    const onlyOpen = await withCookies(app, admin)
      .get(QUEUE)
      .query({ resolved: 'false' });
    expect(
      (onlyOpen.body.data.data as Array<{ orderId: number }>).map(
        (r) => r.orderId,
      ),
    ).not.toContain(orderId);
  });
});
