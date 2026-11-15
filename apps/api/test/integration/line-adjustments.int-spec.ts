import * as request from 'supertest';
import { EntityManager } from 'typeorm';

import { getTestDataSource, resetDb } from './setup/test-db';
import {
  CookieJar,
  TestApp,
  authenticate,
  createPosTestApp,
  posEmitted,
  resetPosEmitted,
  withCookies,
} from './support/pos.harness';
import {
  Cashier,
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
  seedSale,
} from './support/pos.fixtures';
import {
  createCategory,
  createProductWithVariant,
  createUser,
} from './setup/seed-helpers';
import {
  fixtureIdempotencyKey,
  fixtureProductCode,
  fixtureRoleName,
} from './setup/fixture-ids';
import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { Branch } from 'src/modules/branch/entities/branch.entity';

/**
 * ============================================================================
 * PARTIAL RETURNS AND REFUNDS — `POST /admin/orders/:orderId/line-adjustments`
 * ============================================================================
 *
 * Contract: docs/PURCHASE-COST-ACCOUNTING.md §2.1 (the three "(new)" rows),
 * §5, §5.1 and §13. Every assertion about cost is made against the DATABASE —
 * the pool on `product_variants`, the evidence on `stock_movements` and the
 * ledger in `order_item_adjustments` — not only against the response.
 *
 * THE PROPERTY THAT MATTERS MOST: a returned unit goes back at the cost it
 * LEFT with, never at the variant's current average. Several cases below move
 * the average with a later receipt at a different price first, precisely so
 * that "restored at the average" and "restored at the line's own cost" give
 * different numbers.
 */

const ROUTE = (orderId: number) => `/admin/orders/${orderId}/line-adjustments`;
const TEHRAN = 'Asia/Tehran';

/** Today's local calendar day in Tehran, as the reports interpret `from/to`. */
function tehranToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TEHRAN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Every catalogue code a super_admin can confer (see the report authz suite). */
const EVERY_GRANTABLE_CAPABILITY = [...PERMISSION_CODES].filter(
  (code) => code !== 'storefront.access',
);

interface Pool {
  stock: number;
  unvaluedQuantity: number;
  inventoryCostValue: string;
}

describe('order line adjustments (int)', () => {
  let ctx: TestApp;
  let branch: Branch;
  let cashier: Cashier;
  let admin: { userId: number; jar: CookieJar; username: string };

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    branch = await seedBranch(ctx, 'Adjustments');
    cashier = await loginCashier(ctx, branch);
    admin = await loginSuperAdmin(ctx);
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  /** A simple product with VALUED opening stock, through the real endpoint. */
  async function valuedVariant(opts: {
    price: number;
    stock: number;
    cost: number;
  }): Promise<number> {
    const category = await createCategory(ctx.dataSource);
    const response = await withCookies(ctx, admin.jar)
      .post('/products')
      .send({
        title: `کالای برگشتی ${Date.now()}`,
        description: 'برای آزمون برگشت اقلام',
        basePrice: opts.price,
        categoryIds: [category.id],
        productCode: fixtureProductCode(),
        initialStock: opts.stock,
        purchasePrice: opts.cost,
        visibleOnSite: true,
        branchVisibility: 'all',
      });
    expect([200, 201]).toContain(response.status);
    const productId = Number(response.body.data.id);
    const [variant] = await ctx.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM product_variants WHERE "productId" = $1`,
      [productId],
    );
    return Number(variant.id);
  }

  /** A receipt at a new price — moves the moving average. */
  async function receive(variantId: number, quantity: number, cost: number) {
    const inventory = ctx.app.get(InventoryService);
    await ctx.dataSource.transaction((manager: EntityManager) =>
      inventory.receiveValued(manager, {
        variantId,
        quantity,
        unitCost: BigInt(cost),
        reason: StockMovementReason.STOCK_RECEIPT,
        reasonText: null,
        supplierReference: null,
        actorUserId: admin.userId,
        actorDisplaySnapshot: admin.username,
        now: new Date(),
      }),
    );
  }

  /** A real till sale. Returns the order id and its (single) line id. */
  async function posSale(
    variantId: number,
    quantity: number,
  ): Promise<{ orderId: number; lineId: number }> {
    const response = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variantId, quantity }],
      });
    expect(response.status).toBe(201);
    const orderId = Number(response.body.data.id);
    const [line] = await ctx.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM order_items WHERE "orderId" = $1`,
      [orderId],
    );
    return { orderId, lineId: Number(line.id) };
  }

  function adjust(
    orderId: number,
    body: Record<string, unknown>,
    key = fixtureIdempotencyKey('lineadj'),
    jar: CookieJar = admin.jar,
  ) {
    return withCookies(ctx, jar)
      .post(ROUTE(orderId))
      .set('Idempotency-Key', key)
      .send(body);
  }

  async function poolOf(variantId: number): Promise<Pool> {
    const [row] = await ctx.dataSource.query<Array<Pool>>(
      `SELECT stock, "unvaluedQuantity", "inventoryCostValue"::text AS "inventoryCostValue"
         FROM product_variants WHERE id = $1`,
      [variantId],
    );
    return row;
  }

  async function lineOf(lineId: number) {
    const [row] = await ctx.dataSource.query<
      Array<{
        costStatus: string;
        cogsTotal: string | null;
        costKnownQuantity: number | null;
        costUnknownQuantity: number | null;
      }>
    >(
      `SELECT "costStatus", "cogsTotal"::text AS "cogsTotal",
              "costKnownQuantity", "costUnknownQuantity"
         FROM order_items WHERE id = $1`,
      [lineId],
    );
    return row;
  }

  async function adjustmentsOf(orderId: number) {
    return ctx.dataSource.query<
      Array<{
        id: number;
        orderItemId: number;
        kind: string;
        scope: string;
        revenueQuantity: number;
        revenueReversed: string;
        restockedKnownQuantity: number | null;
        restockedUnknownQuantity: number | null;
        cogsReversed: string | null;
        stockMovementId: number | null;
        idempotencyKey: string | null;
        actorUserId: number | null;
        reason: string | null;
        eventAt: Date | null;
      }>
    >(
      `SELECT id, "orderItemId", kind, scope, "revenueQuantity",
              "revenueReversed"::text AS "revenueReversed",
              "restockedKnownQuantity", "restockedUnknownQuantity",
              "cogsReversed"::text AS "cogsReversed",
              "stockMovementId", "idempotencyKey", "actorUserId", reason, "eventAt"
         FROM order_item_adjustments WHERE "orderId" = $1 ORDER BY id`,
      [orderId],
    );
  }

  async function movementsOf(orderId: number) {
    return ctx.dataSource.query<
      Array<{
        id: number;
        reason: string;
        delta: number;
        costDelta: string | null;
        reasonText: string | null;
      }>
    >(
      `SELECT id, reason::text AS reason, delta, "costDelta"::text AS "costDelta", "reasonText"
         FROM stock_movements WHERE "orderId" = $1 ORDER BY id`,
      [orderId],
    );
  }

  async function orderRow(orderId: number) {
    const [row] = await ctx.dataSource.query<
      Array<{
        status: string;
        voidedAt: Date | null;
        refundedAt: Date | null;
        paymentStatus: string;
      }>
    >(
      `SELECT o.status::text AS status, o."voidedAt", o."refundedAt",
              (SELECT p.status::text FROM payment p WHERE p."orderId" = o.id
                ORDER BY p.id DESC LIMIT 1) AS "paymentStatus"
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
    return row;
  }

  // =========================================================================
  // 1. The line's own cost, never the average
  // =========================================================================

  it('a partial return restores stock AND the exact original COGS after a receipt moved the average', async () => {
    // 3 @ 10 000 → sell 2 → COGS 20 000; pool 1 unit, 10 000.
    const variantId = await valuedVariant({
      price: 100_000,
      stock: 3,
      cost: 10_000,
    });
    const { orderId, lineId } = await posSale(variantId, 2);
    expect(await lineOf(lineId)).toEqual({
      costStatus: 'known',
      cogsTotal: '20000',
      costKnownQuantity: 2,
      costUnknownQuantity: 0,
    });

    // Receipt at a DIFFERENT price: pool 3 units, 36 002 → average 12 000.
    await receive(variantId, 2, 13_001);
    expect(await poolOf(variantId)).toEqual({
      stock: 3,
      unvaluedQuantity: 0,
      inventoryCostValue: '36002',
    });

    resetPosEmitted();
    const response = await adjust(orderId, {
      kind: 'return_refund',
      reason: '  مشتری یکی را برگرداند  ',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({
      orderId,
      kind: 'return_refund',
      adjustments: [
        {
          id: expect.any(Number),
          orderItemId: lineId,
          revenueQuantity: 1,
          revenueReversed: '100000',
          restockedKnownQuantity: 1,
          restockedUnknownQuantity: 0,
          // The line's own cost (20 000 / 2), NOT the 12 000 average.
          cogsReversed: '10000',
        },
      ],
      totals: {
        revenueReversed: '100000',
        cogsReversed: '10000',
        unitsRestocked: 1,
      },
    });

    // After commit: the stock count and an availability invalidation — the
    // same frames a whole-order return sends, and never a cost figure.
    expect(posEmitted()).toEqual([
      {
        event: 'stock:updated',
        payload: { variantId, newStock: 4, branchId: branch.id },
      },
      {
        event: 'availability:invalidated',
        payload: { variantId, reason: 'stock' },
      },
    ]);

    // The pool grew by exactly the line's cost.
    expect(await poolOf(variantId)).toEqual({
      stock: 4,
      unvaluedQuantity: 0,
      inventoryCostValue: '46002',
    });

    // One restore movement carrying that cost and the operator's (trimmed) reason.
    const movements = await movementsOf(orderId);
    expect(movements.map((m) => [m.reason, m.delta, m.costDelta])).toEqual([
      ['pos_sale', -2, '-20000'],
      ['return_restore', 1, '10000'],
    ]);
    expect(movements[1].reasonText).toBe('مشتری یکی را برگرداند');

    const [row] = await adjustmentsOf(orderId);
    expect(row).toMatchObject({
      kind: 'return_refund',
      scope: 'line',
      stockMovementId: movements[1].id,
      actorUserId: admin.userId,
      reason: 'مشتری یکی را برگرداند',
    });
    expect(row.idempotencyKey).toEqual(expect.any(String));
    expect(row.eventAt).not.toBeNull();

    // The order is untouched: still a sale, payment row still success.
    expect(await orderRow(orderId)).toEqual({
      status: 'paid',
      voidedAt: null,
      refundedAt: null,
      paymentStatus: 'success',
    });

    // Audit: ids, kind and quantities — never a Rial amount.
    const [audit] = await ctx.dataSource.query<
      Array<{ action: string; summary: Record<string, unknown> }>
    >(
      `SELECT action, summary FROM admin_audit_log
        WHERE action = 'order.lines.adjusted' AND "targetId" = $1`,
      [String(orderId)],
    );
    expect(audit.summary).toMatchObject({
      orderId,
      kind: 'return_refund',
      lines: [
        { orderItemId: lineId, revenueQuantity: 1, restockedQuantity: 1 },
      ],
      unitsRestocked: 1,
    });
    expect(JSON.stringify(audit.summary)).not.toMatch(
      /100000|10000|cogs|revenueReversed/i,
    );
  });

  it('a full return in two partial steps gives back COGS summing exactly to cogsTotal', async () => {
    // 7 @ 10 001 = 70 007; sell 3 → floor(70 007 × 3 / 7) = 30 003.
    const variantId = await valuedVariant({
      price: 33_334,
      stock: 7,
      cost: 10_001,
    });
    const { orderId, lineId } = await posSale(variantId, 3);
    expect((await lineOf(lineId)).cogsTotal).toBe('30003');
    await receive(variantId, 5, 7_777); // move the average away

    const first = await adjust(orderId, {
      kind: 'return_refund',
      reason: 'برگشت اول',
      lines: [{ orderItemId: lineId, quantity: 2 }],
    });
    expect(first.status).toBe(201);
    const second = await adjust(orderId, {
      kind: 'return_refund',
      reason: 'برگشت دوم',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(second.status).toBe(201);

    const rows = await adjustmentsOf(orderId);
    expect(rows.map((r) => r.cogsReversed)).toEqual(['20002', '10001']);
    const cogsBack = rows.reduce((t, r) => t + BigInt(r.cogsReversed!), 0n);
    expect(cogsBack.toString()).toBe('30003');
    // Revenue too: 100 002 total, reversed 66 668 + 33 334 — no Rial lost.
    const revenueBack = rows.reduce(
      (t, r) => t + BigInt(r.revenueReversed),
      0n,
    );
    expect(revenueBack.toString()).toBe('100002');

    // Nothing left to return.
    const third = await adjust(orderId, {
      kind: 'return_only',
      reason: 'برگشت سوم',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('ADJUSTMENT_EXCEEDS_LINE');
  });

  // =========================================================================
  // 2. The kinds
  // =========================================================================

  it('refund_only reverses revenue and leaves stock and the pool untouched', async () => {
    const variantId = await valuedVariant({
      price: 50_000,
      stock: 4,
      cost: 20_000,
    });
    const { orderId, lineId } = await posSale(variantId, 2);
    const before = await poolOf(variantId);
    const movementsBefore = await movementsOf(orderId);

    const response = await adjust(orderId, {
      kind: 'refund_only',
      reason: 'تخفیف بابت خراشیدگی',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.data.adjustments[0]).toMatchObject({
      revenueQuantity: 1,
      revenueReversed: '50000',
      restockedKnownQuantity: 0,
      restockedUnknownQuantity: 0,
      cogsReversed: '0',
    });
    expect(response.body.data.totals.unitsRestocked).toBe(0);
    expect(await poolOf(variantId)).toEqual(before);
    expect(await movementsOf(orderId)).toEqual(movementsBefore);
    expect((await adjustmentsOf(orderId))[0].stockMovementId).toBeNull();

    // The goods are still restockable afterwards; only the money is gone.
    const back = await adjust(orderId, {
      kind: 'return_only',
      reason: 'کالا هم برگشت',
      lines: [{ orderItemId: lineId, quantity: 2 }],
    });
    expect(back.status).toBe(201);
    expect(back.body.data.totals).toEqual({
      revenueReversed: '0',
      cogsReversed: '40000',
      unitsRestocked: 2,
    });
    // But the revenue of the refunded unit cannot be refunded twice.
    const again = await adjust(orderId, {
      kind: 'refund_only',
      reason: 'دوباره بازپرداخت',
      lines: [{ orderItemId: lineId, quantity: 2 }],
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('ADJUSTMENT_EXCEEDS_LINE');
    expect(again.body.details.remaining).toEqual({
      revenueUnits: 1,
      restockUnits: 0,
    });
  });

  it('return_only restores stock and cost with revenueReversed 0', async () => {
    const variantId = await valuedVariant({
      price: 90_000,
      stock: 2,
      cost: 30_000,
    });
    const { orderId, lineId } = await posSale(variantId, 2);
    await receive(variantId, 1, 45_000);

    const response = await adjust(orderId, {
      kind: 'return_only',
      reason: 'تعویض با کالای دیگر',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.data.adjustments[0]).toMatchObject({
      revenueQuantity: 0,
      revenueReversed: '0',
      restockedKnownQuantity: 1,
      cogsReversed: '30000',
    });
    expect(await poolOf(variantId)).toEqual({
      stock: 2,
      unvaluedQuantity: 0,
      inventoryCostValue: '75000',
    });
  });

  // =========================================================================
  // 3. Refusals write nothing
  // =========================================================================

  it('exceeding what remains is 409 ADJUSTMENT_EXCEEDS_LINE and writes nothing', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const { orderId, lineId } = await posSale(variantId, 3);
    const before = await poolOf(variantId);
    const key = fixtureIdempotencyKey('exceeds');

    const refused = await adjust(
      orderId,
      {
        kind: 'return_refund',
        reason: 'بیش از فروش',
        lines: [{ orderItemId: lineId, quantity: 4 }],
      },
      key,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('ADJUSTMENT_EXCEEDS_LINE');
    expect(refused.body.details).toMatchObject({
      orderItemId: lineId,
      requested: 4,
      remaining: { revenueUnits: 3, restockUnits: 3 },
    });

    expect(await adjustmentsOf(orderId)).toEqual([]);
    expect(await poolOf(variantId)).toEqual(before);
    expect((await movementsOf(orderId)).map((m) => m.reason)).toEqual([
      'pos_sale',
    ]);
    const keys = await ctx.dataSource.query(
      `SELECT 1 FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    // The claim rolled back with the refusal, so the key is free again.
    expect(keys).toHaveLength(0);
    const retried = await adjust(
      orderId,
      {
        kind: 'return_refund',
        reason: 'بیش از فروش',
        lines: [{ orderItemId: lineId, quantity: 3 }],
      },
      key,
    );
    expect(retried.status).toBe(201);
  });

  it('a line of another order is a 400 naming the field', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const mine = await posSale(variantId, 1);
    const other = await posSale(variantId, 1);
    const response = await adjust(mine.orderId, {
      kind: 'refund_only',
      reason: 'قلم اشتباه',
      lines: [{ orderItemId: other.lineId, quantity: 1 }],
    });
    expect(response.status).toBe(400);
    expect(response.body.details.field).toBe('lines[0].orderItemId');
    expect(await adjustmentsOf(mine.orderId)).toEqual([]);
  });

  it('validates the body: reason length after trim, unique lines, positive quantity', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const { orderId, lineId } = await posSale(variantId, 2);
    const bodies = [
      {
        kind: 'return_refund',
        reason: '   ab   ',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      },
      {
        kind: 'void',
        reason: 'ابطال کامل',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      },
      { kind: 'refund_only', reason: 'بدون قلم', lines: [] },
      {
        kind: 'refund_only',
        reason: 'قلم تکراری',
        lines: [
          { orderItemId: lineId, quantity: 1 },
          { orderItemId: lineId, quantity: 1 },
        ],
      },
      {
        kind: 'refund_only',
        reason: 'تعداد صفر',
        lines: [{ orderItemId: lineId, quantity: 0 }],
      },
    ];
    for (const body of bodies) {
      const response = await adjust(orderId, body);
      expect([JSON.stringify(body), response.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
    const noKey = await withCookies(ctx, admin.jar)
      .post(ROUTE(orderId))
      .send({
        kind: 'refund_only',
        reason: 'بدون کلید',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await adjustmentsOf(orderId)).toEqual([]);
  });

  // =========================================================================
  // 4. Online orders and the whole-order paths
  // =========================================================================

  /** A paid web order still awaiting stock: its line is `pending`. */
  async function paidWebOrderAwaitingStock(variantId: number) {
    const order = await seedSale(ctx.dataSource, {
      soldAt: new Date(),
      branchId: branch.id,
      branchName: branch.name,
      cashierUserId: cashier.userId,
      cashierDisplay: cashier.username,
      total: 80_000,
      quantity: 2,
      variantId,
      channel: OrderChannel.ONLINE,
    });
    await ctx.dataSource.query(
      `UPDATE orders SET "fulfillmentState" = 'awaiting_stock' WHERE id = $1`,
      [order.id],
    );
    const [line] = await ctx.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM order_items WHERE "orderId" = $1`,
      [order.id],
    );
    return { orderId: order.id, lineId: Number(line.id) };
  }

  it('an online paid-but-unfulfilled line is 409 ORDER_LINE_NOT_FULFILLED', async () => {
    const variantId = await valuedVariant({
      price: 40_000,
      stock: 1,
      cost: 5_000,
    });
    const { orderId, lineId } = await paidWebOrderAwaitingStock(variantId);
    expect((await lineOf(lineId)).costStatus).toBe('pending');

    for (const kind of ['refund_only', 'return_refund', 'return_only']) {
      const response = await adjust(orderId, {
        kind,
        reason: 'هنوز ارسال نشده',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      });
      expect([kind, response.status, response.body.error]).toEqual([
        kind,
        409,
        'ORDER_LINE_NOT_FULFILLED',
      ]);
    }
    expect(await adjustmentsOf(orderId)).toEqual([]);
  });

  it('a void BEFORE fulfilment writes no COGS and no stock movement', async () => {
    const variantId = await valuedVariant({
      price: 40_000,
      stock: 1,
      cost: 5_000,
    });
    const { orderId } = await paidWebOrderAwaitingStock(variantId);
    const pool = await poolOf(variantId);

    const voided = await withCookies(ctx, admin.jar)
      .post(`/orders/${orderId}/void`)
      .send({ reason: 'لغو پیش از ارسال' });
    expect(voided.status).toBe(200);

    expect(await movementsOf(orderId)).toEqual([]);
    expect(await poolOf(variantId)).toEqual(pool);
    const rows = await adjustmentsOf(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'void',
      scope: 'order',
      // It was paid, so the revenue is reversed — but nothing left the shelf.
      revenueQuantity: 2,
      revenueReversed: '80000',
      restockedKnownQuantity: 0,
      restockedUnknownQuantity: 0,
      cogsReversed: '0',
      stockMovementId: null,
    });
  });

  it('a void AFTER consumption writes scope=order rows and restores the exact COGS', async () => {
    const variantId = await valuedVariant({
      price: 100_000,
      stock: 3,
      cost: 10_000,
    });
    const { orderId, lineId } = await posSale(variantId, 2);
    await receive(variantId, 2, 13_001); // pool 3 units, 36 002

    const voided = await withCookies(ctx, admin.jar)
      .post(`/orders/${orderId}/void`)
      .send({ reason: 'ابطال فروش' });
    expect(voided.status).toBe(200);

    expect(await poolOf(variantId)).toEqual({
      stock: 5,
      unvaluedQuantity: 0,
      inventoryCostValue: '56002',
    });
    const rows = await adjustmentsOf(orderId);
    expect(rows).toEqual([
      expect.objectContaining({
        orderItemId: lineId,
        kind: 'void',
        scope: 'order',
        revenueQuantity: 2,
        revenueReversed: '200000',
        restockedKnownQuantity: 2,
        restockedUnknownQuantity: 0,
        cogsReversed: '20000',
      }),
    ]);

    // And a voided order is no longer adjustable line by line.
    const response = await adjust(orderId, {
      kind: 'refund_only',
      reason: 'پس از ابطال',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ORDER_NOT_ADJUSTABLE');
  });

  it('whole-order void and return are refused once a line adjustment exists', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const { orderId, lineId } = await posSale(variantId, 3);
    const response = await adjust(orderId, {
      kind: 'return_refund',
      reason: 'برگشت جزئی',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(response.status).toBe(201);

    for (const action of ['void', 'return']) {
      const refused = await withCookies(ctx, admin.jar)
        .post(`/orders/${orderId}/${action}`)
        .send({ reason: 'کل سفارش' });
      expect([action, refused.status, refused.body.error]).toEqual([
        action,
        409,
        'ORDER_HAS_LINE_ADJUSTMENTS',
      ]);
    }
    expect((await orderRow(orderId)).status).toBe('paid');
    expect(await adjustmentsOf(orderId)).toHaveLength(1);
  });

  it('refuses orders that are not completed sales with ORDER_NOT_ADJUSTABLE', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const returned = await posSale(variantId, 1);
    const ok = await withCookies(ctx, admin.jar)
      .post(`/orders/${returned.orderId}/return`)
      .send({ reason: 'برگشت کامل' });
    expect(ok.status).toBe(200);

    const pending = await seedSale(ctx.dataSource, {
      soldAt: new Date(),
      branchId: branch.id,
      branchName: branch.name,
      cashierUserId: cashier.userId,
      cashierDisplay: cashier.username,
      total: 10_000,
      variantId,
      channel: OrderChannel.ONLINE,
      status: OrderStatusEnum.PENDING,
    });
    const [pendingLine] = await ctx.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM order_items WHERE "orderId" = $1`,
      [pending.id],
    );

    for (const [orderId, lineId] of [
      [returned.orderId, returned.lineId],
      [pending.id, Number(pendingLine.id)],
    ]) {
      const response = await adjust(orderId, {
        kind: 'refund_only',
        reason: 'قابل تنظیم نیست',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      });
      expect([orderId, response.status, response.body.error]).toEqual([
        orderId,
        409,
        'ORDER_NOT_ADJUSTABLE',
      ]);
    }

    const missing = await adjust(999_999, {
      kind: 'refund_only',
      reason: 'سفارش ناموجود',
      lines: [{ orderItemId: 1, quantity: 1 }],
    });
    expect(missing.status).toBe(404);
  });

  // =========================================================================
  // 5. Legacy / unknown cost
  // =========================================================================

  it('a line sold from UNVALUED stock returns its units as unvalued, never at a cost', async () => {
    // A raw fixture INSERT carrying stock: the pool guard records it unvalued.
    const { variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { price: 25_000, stock: 5 },
    );
    expect(await poolOf(variant.id)).toEqual({
      stock: 5,
      unvaluedQuantity: 5,
      inventoryCostValue: '0',
    });
    const { orderId, lineId } = await posSale(variant.id, 2);
    expect(await lineOf(lineId)).toEqual({
      costStatus: 'unknown',
      cogsTotal: '0',
      costKnownQuantity: 0,
      costUnknownQuantity: 2,
    });

    const response = await adjust(orderId, {
      kind: 'return_refund',
      reason: 'برگشت کالای قدیمی',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.data.adjustments[0]).toMatchObject({
      revenueReversed: '25000',
      restockedKnownQuantity: 0,
      restockedUnknownQuantity: 1,
      cogsReversed: '0',
    });
    expect(await poolOf(variant.id)).toEqual({
      stock: 4,
      unvaluedQuantity: 4,
      inventoryCostValue: '0',
    });
  });

  // =========================================================================
  // 6. Idempotency and concurrency
  // =========================================================================

  it('replays the same key + body as one set of rows, and refuses the key with another body', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const { orderId, lineId } = await posSale(variantId, 3);
    const key = fixtureIdempotencyKey('replay');
    const body = {
      kind: 'return_refund',
      reason: 'برگشت تکراری',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    };

    const first = await adjust(orderId, body, key);
    const second = await adjust(orderId, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);

    expect(await adjustmentsOf(orderId)).toHaveLength(1);
    expect(
      (await movementsOf(orderId)).filter((m) => m.reason === 'return_restore'),
    ).toHaveLength(1);
    expect((await poolOf(variantId)).stock).toBe(3);

    const conflict = await adjust(
      orderId,
      { ...body, lines: [{ orderItemId: lineId, quantity: 2 }] },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await adjustmentsOf(orderId)).toHaveLength(1);
  });

  it('two concurrent adjustments of one line cannot together exceed it', async () => {
    const variantId = await valuedVariant({
      price: 10_000,
      stock: 5,
      cost: 1_000,
    });
    const { orderId, lineId } = await posSale(variantId, 3);
    const body = {
      kind: 'return_refund',
      reason: 'برگشت همزمان',
      lines: [{ orderItemId: lineId, quantity: 2 }],
    };

    const results = await Promise.all([
      adjust(orderId, body, fixtureIdempotencyKey('race-a')),
      adjust(orderId, body, fixtureIdempotencyKey('race-b')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe(
      'ADJUSTMENT_EXCEEDS_LINE',
    );

    const rows = await adjustmentsOf(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].restockedKnownQuantity).toBe(2);
    expect((await poolOf(variantId)).stock).toBe(4);
  });

  // =========================================================================
  // 7. The existing sales reports see partial refunds
  // =========================================================================

  it('netSales = gross − refunded − voided − lineRefundedTotal on the summary, by-cashier and dashboard', async () => {
    const variantId = await valuedVariant({
      price: 100_000,
      stock: 10,
      cost: 10_000,
    });
    const partly = await posSale(variantId, 2); // 200 000
    const voided = await posSale(variantId, 1); // 100 000
    const returned = await posSale(variantId, 1); // 100 000

    expect(
      (
        await adjust(partly.orderId, {
          kind: 'return_refund',
          reason: 'برگشت یکی',
          lines: [{ orderItemId: partly.lineId, quantity: 1 }],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await withCookies(ctx, admin.jar)
          .post(`/orders/${voided.orderId}/void`)
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (
        await withCookies(ctx, admin.jar)
          .post(`/orders/${returned.orderId}/return`)
          .send({})
      ).status,
    ).toBe(200);

    const today = tehranToday();
    const summary = await withCookies(ctx, admin.jar)
      .get('/reports/sales/summary')
      .query({ from: today, to: today });
    expect(summary.status).toBe(200);
    expect(summary.body.totals).toMatchObject({
      grossSales: '400000',
      refundedTotal: '100000',
      voidedTotal: '100000',
      lineRefundedTotal: '100000',
      netSales: '100000',
      unitsReturnedByLine: 1,
      lineAdjustedCount: 1,
    });
    expect(summary.body.semantics.netSales).toContain('lineRefundedTotal');

    // Outside the range it contributes nothing.
    const yesterday = await withCookies(ctx, admin.jar)
      .get('/reports/sales/summary')
      .query({ from: '2020-01-01', to: '2020-01-01' });
    expect(yesterday.body.totals.lineRefundedTotal).toBe('0');

    const byCashier = await withCookies(ctx, admin.jar)
      .get('/reports/sales/by-cashier')
      .query({ from: today, to: today });
    expect(byCashier.body.data).toEqual([
      expect.objectContaining({
        cashierUserId: cashier.userId,
        grossSales: '400000',
        lineRefundedTotal: '100000',
        unitsReturnedByLine: 1,
        netSales: '100000',
      }),
    ]);

    const list = await withCookies(ctx, admin.jar)
      .get('/reports/sales')
      .query({ from: today, to: today });
    const partlyRow = (
      list.body.data as Array<{ id: number; lineRefundedTotal: string }>
    ).find((r) => Number(r.id) === partly.orderId);
    expect(partlyRow).toMatchObject({
      lineRefundedTotal: '100000',
      lineAdjustedInRange: true,
    });

    const financial = await withCookies(ctx, admin.jar).get(
      '/admin/dashboard/financial',
    );
    expect(financial.status).toBe(200);
    expect(financial.body.data.money).toEqual({
      grossSales: '400000',
      refundedTotal: '100000',
      voidedTotal: '100000',
      lineRefundedTotal: '100000',
      netSales: '100000',
    });
    const pos = (
      financial.body.data.byChannel as Array<{
        channel: string;
        netSales: string;
      }>
    ).find((c) => c.channel === 'pos');
    expect(pos?.netSales).toBe('100000');
  });

  // =========================================================================
  // 8. Authorization — super_admin by ROLE, nobody else
  // =========================================================================

  describe('authorization', () => {
    async function fixture() {
      const variantId = await valuedVariant({
        price: 10_000,
        stock: 5,
        cost: 1_000,
      });
      return posSale(variantId, 2);
    }
    const bodyFor = (lineId: number) => ({
      kind: 'return_refund',
      reason: 'دسترسی',
      lines: [{ orderItemId: lineId, quantity: 1 }],
    });

    it('refuses a delegated administrator holding every grantable capability (403)', async () => {
      const { orderId, lineId } = await fixture();
      const role = await withCookies(ctx, admin.jar)
        .post('/admin/access/roles')
        .send({
          name: fixtureRoleName('delegated'),
          titleFa: 'نقش واگذارشده',
          permissions: EVERY_GRANTABLE_CAPABILITY,
        });
      expect(role.status).toBe(201);
      const created = await createUser(ctx.dataSource, { roles: [] });
      const assign = await withCookies(ctx, admin.jar)
        .put(`/admin/access/users/${created.user.id}/roles`)
        .send({ roleIds: [Number(role.body.data.id)] });
      expect(assign.status).toBe(200);
      const delegated = await authenticate(
        ctx,
        created.username,
        created.password,
        'admin',
      );

      const response = await adjust(
        orderId,
        bodyFor(lineId),
        fixtureIdempotencyKey('authz'),
        delegated,
      );
      expect(response.status).toBe(403);
      expect(await adjustmentsOf(orderId)).toEqual([]);
    });

    it('refuses a cashier (POS session — refused at the audience layer)', async () => {
      const { orderId, lineId } = await fixture();
      const response = await adjust(
        orderId,
        bodyFor(lineId),
        fixtureIdempotencyKey('authz'),
        cashier.jar,
      );
      expect(response.status).toBe(401);
      expect(await adjustmentsOf(orderId)).toEqual([]);
    });

    it('refuses an anonymous caller (401)', async () => {
      const { orderId, lineId } = await fixture();
      const response = await request(ctx.server)
        .post(ROUTE(orderId))
        .set('Idempotency-Key', fixtureIdempotencyKey('anon'))
        .send(bodyFor(lineId));
      expect(response.status).toBe(401);
      expect(await adjustmentsOf(orderId)).toEqual([]);
    });
  });
});
