/**
 * GROSS-PROFIT REPORTING — `/reports/profit/*` and the dashboard `profit`
 * block (docs/PURCHASE-COST-ACCOUNTING.md §1, §9, §13).
 *
 * ONE deterministic scenario, built once through the real write paths, and
 * asserted to the Rial:
 *
 *   P1  simple, POST /products, 10 opening units @ 60 000, sells at 100 000,
 *       categories {cat1, cat2}
 *   P2  simple, POST /products,  5 opening units @ 45 000, sells at  50 000,
 *       category  {cat1}
 *   P3  seeded variant with stock and NO cost (the pool guard records it
 *       unvalued), sells at 1 000 000, category {cat2}
 *
 *   S1  cashier A @ branch A, P1 x2           2026-09-01T20:29:59Z (Tehran 23:59:59, 1 Sep)
 *       cogs 2 x 60 000 = 120 000
 *   --  receipt: P1 5 units @ 90 000 → pool 13 units, 930 000
 *   S2  cashier B @ branch B, P1 x3 + P2 x1   2026-09-01T20:30:00Z (Tehran 00:00:00, 2 Sep)
 *       P1 cogs floor(930 000 x 3 / 13) = 214 615, P2 cogs 45 000
 *   S3  cashier A @ branch A, P3 x1           2026-09-02T06:00:00Z   unknown cost
 *   W1  ONLINE, paid, not fulfilled (pending), 70 000   2026-09-02T07:00:00Z
 *
 *   R1  POST /orders/S1/return            today    known   -200 000 revenue, -120 000 COGS, 2 restocked
 *   R4  POST /orders/S3/void              today    unknown -1 000 000 revenue, 1 restocked (unknown)
 *   R2  refund_only S2/P1 x1              2026-09-03T08:00Z  -100 000 revenue, COGS NOT reversed
 *   R3  return_refund S2/P1 x1            2026-09-03T09:00Z  -100 000 revenue, -71 538 COGS (floor(214 615/3))
 *   L1  stock adjust P2 -1 (valued)       today    inventory loss 45 000
 *   L2  stock adjust P3 -1 (unvalued)     today    inventory loss, 1 unknown-cost unit
 */
import { DataSource, EntityManager } from 'typeorm';
import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  as,
  Cashier,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
} from './support/pos.fixtures';
import { seedReportingSale } from './support/reporting.fixtures';
import { createCategory, createProductWithVariant } from './setup/seed-helpers';
import { fixtureProductCode } from './setup/fixture-ids';
import { CookieJar } from './setup/test-app';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { reverseRevenue } from 'src/modules/inventory/valuation/valuation';
import { PROFIT_INCOMPLETE_WARNING } from 'src/modules/reports/profit-report.service';

const WARNING = PROFIT_INCOMPLETE_WARNING;

interface Row {
  key: string | number | null;
  label: string | null;
  grossSalesRevenue: string;
  revenueReversed: string;
  netSalesRevenue: string;
  unitsSold: number;
  unitsReturned: number;
  knownNetRevenue: string;
  unknownNetRevenue: string;
  netCogs: string;
  grossProfit: string | null;
  grossMarginPercent: string | null;
  coveragePercent: string | null;
  costCoverage: 'complete' | 'partial' | 'none';
  warning: string | null;
}

const sum = (rows: Row[], field: keyof Row): string =>
  rows
    .reduce((acc, r) => acc + BigInt((r[field] as string | null) ?? '0'), 0n)
    .toString();

describe('Gross-profit reporting (int)', () => {
  let ctx: TestApp;
  let admin: { userId: number; jar: CookieJar };
  let cashierA: Cashier;
  let cashierB: Cashier;
  let branchA: Branch;
  let branchB: Branch;
  let cat1: number;
  let cat2: number;
  let p1: { productId: number; variantId: number };
  let p2: { productId: number; variantId: number };
  let p3: { productId: number; variantId: number };
  let s1: number;
  let s2: number;
  let s3: number;
  let w1: number;
  let today: string;
  let s1CogsBeforeReceipt: string;

  const D1_LAST_SECOND = new Date('2026-09-01T20:29:59Z');
  const D2_FIRST_SECOND = new Date('2026-09-01T20:30:00Z');

  const get = (url: string, query: Record<string, unknown> = {}) =>
    as(ctx, admin).get(url).query(query).expect(200);

  async function createSimple(
    code: string,
    price: number,
    stock: number,
    cost: number,
    categoryIds: number[],
  ) {
    const res = await as(ctx, admin)
      .post('/products')
      .send({
        title: `کالای ${code}`,
        description: 'profit fixture',
        basePrice: price,
        categoryIds,
        productCode: code,
        initialStock: stock,
        purchasePrice: cost,
        visibleOnSite: true,
        branchVisibility: 'all',
      });
    expect(res.status).toBe(201);
    const productId = Number(res.body.data.id);
    const [variant] = await ctx.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM product_variants WHERE "productId" = $1 AND "isDefault"`,
      [productId],
    );
    return { productId, variantId: Number(variant.id) };
  }

  async function posSale(
    cashier: Cashier,
    items: Array<{ variantId: number; quantity: number }>,
    at: Date,
  ): Promise<number> {
    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: items.map((i) => ({
          productVariantId: i.variantId,
          quantity: i.quantity,
        })),
      });
    expect(res.status).toBe(201);
    const id = Number(res.body.data.id);
    await ctx.dataSource.query(
      `UPDATE orders SET "paidAt" = $2, "soldAt" = $2 WHERE id = $1`,
      [id, at],
    );
    return id;
  }

  async function lineOf(orderId: number, variantId: number) {
    const [row] = await ctx.dataSource.query<
      Array<{ id: number; cogsTotal: string | null; costStatus: string }>
    >(
      `SELECT id, "cogsTotal"::text AS "cogsTotal", "costStatus"
         FROM order_items WHERE "orderId" = $1 AND "variantId" = $2`,
      [orderId, variantId],
    );
    return row;
  }

  /** A line-scope adjustment written through the inventory primitives. */
  async function lineAdjustment(
    orderId: number,
    orderItemId: number,
    kind: 'refund_only' | 'return_refund',
    units: number,
    eventAt: Date,
    key: string,
  ) {
    const inventory = ctx.app.get(InventoryService);
    await ctx.dataSource.transaction(async (m: EntityManager) => {
      await m.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [
        orderId,
      ]);
      const lines = await inventory.loadLineCostStates(m, orderId);
      const line = lines.find((l) => l.id === orderItemId)!;
      const revenue = reverseRevenue(line.state, units);
      let split = { knownQuantity: 0, unknownQuantity: 0, cogsReversed: 0n };
      let movementId: number | null = null;
      if (kind === 'return_refund') {
        const restocked = await inventory.restockOrderLines(m, {
          orderId,
          reason: StockMovementReason.RETURN_RESTORE,
          actorUserId: admin.userId,
          actorDisplaySnapshot: 'admin',
          reasonText: 'line return',
          lines: [
            {
              orderItemId,
              variantId: line.variantId!,
              state: line.state,
              units,
            },
          ],
          now: eventAt,
        });
        const got = restocked.perLine.get(orderItemId)!;
        split = got;
        movementId = got.movementId;
      }
      await inventory.insertAdjustment(m, {
        orderId,
        orderItemId,
        kind,
        scope: 'line',
        revenueQuantity: units,
        revenueReversed: revenue,
        restockedKnownQuantity: split.knownQuantity,
        restockedUnknownQuantity: split.unknownQuantity,
        cogsReversed: split.cogsReversed,
        eventAt,
        actorUserId: admin.userId,
        actorDisplaySnapshot: 'admin',
        reason: 'fixture',
        idempotencyKey: key,
        stockMovementId: movementId,
      });
    });
  }

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
    await resetDb(ctx.dataSource);
    const ds: DataSource = ctx.dataSource;

    admin = await loginSuperAdmin(ctx, { username: 'owner_profit' });
    branchA = await seedBranch(ctx, 'Tehran');
    branchB = await seedBranch(ctx, 'Shiraz');
    cashierA = await loginCashier(ctx, branchA, {
      username: 'cashier_a',
    });
    cashierB = await loginCashier(ctx, branchB, {
      username: 'cashier_b',
    });
    const c1 = await createCategory(ds, 'cat-one');
    const c2 = await createCategory(ds, 'cat-two');
    cat1 = c1.id;
    cat2 = c2.id;

    p1 = await createSimple(fixtureProductCode('PRA'), 100_000, 10, 60_000, [
      cat1,
      cat2,
    ]);
    p2 = await createSimple(fixtureProductCode('PRB'), 50_000, 5, 45_000, [
      cat1,
    ]);
    const seeded = await createProductWithVariant(
      ds,
      { title: 'Unknown-cost tent', categories: [c2] },
      { price: 1_000_000, stock: 5 },
    );
    p3 = { productId: seeded.product.id, variantId: seeded.variant.id };

    s1 = await posSale(
      cashierA,
      [{ variantId: p1.variantId, quantity: 2 }],
      D1_LAST_SECOND,
    );
    s1CogsBeforeReceipt = (await lineOf(s1, p1.variantId)).cogsTotal!;

    // A second receipt at a DIFFERENT price, through the valuation writer.
    await ds.transaction((m) =>
      ctx.app.get(InventoryService).receiveValued(m, {
        variantId: p1.variantId,
        quantity: 5,
        unitCost: 90_000n,
        reason: StockMovementReason.STOCK_RECEIPT,
        reasonText: null,
        supplierReference: 'INV-2',
        actorUserId: admin.userId,
        actorDisplaySnapshot: 'owner_profit',
        now: new Date(),
      }),
    );

    s2 = await posSale(
      cashierB,
      [
        { variantId: p1.variantId, quantity: 3 },
        { variantId: p2.variantId, quantity: 1 },
      ],
      D2_FIRST_SECOND,
    );
    s3 = await posSale(
      cashierA,
      [{ variantId: p3.variantId, quantity: 1 }],
      new Date('2026-09-02T06:00:00Z'),
    );
    const web = await seedReportingSale(ds, {
      soldAt: new Date('2026-09-02T07:00:00Z'),
      branchId: branchA.id,
      branchName: 'Tehran',
      cashierUserId: admin.userId,
      cashierDisplay: 'سفارش آنلاین',
      total: 70_000,
      channel: OrderChannel.ONLINE,
    });
    w1 = web.id;

    // Whole-order reversals, through the real routes (dated now).
    await as(ctx, admin)
      .post(`/orders/${s1}/return`)
      .send({ reason: 'customer returned both' })
      .expect(200);
    await as(ctx, admin)
      .post(`/orders/${s3}/void`)
      .send({ reason: 'rung up by mistake' })
      .expect(200);

    // Line-level refund-only and partial return (the line endpoint is another
    // workstream's; the primitives it will call are used directly).
    const s2p1 = (await lineOf(s2, p1.variantId)).id;
    await lineAdjustment(
      s2,
      Number(s2p1),
      'refund_only',
      1,
      new Date('2026-09-03T08:00:00Z'),
      'profit-fixture-refund-only',
    );
    await lineAdjustment(
      s2,
      Number(s2p1),
      'return_refund',
      1,
      new Date('2026-09-03T09:00:00Z'),
      'profit-fixture-return',
    );

    // Inventory losses: one valued, one unvalued unit.
    for (const variantId of [p2.variantId, p3.variantId]) {
      await as(ctx, admin)
        .post(`/products/variants/${variantId}/stock/adjust`)
        .send({ mode: 'delta', value: -1, reason: 'damaged in store' })
        .expect((r) => {
          if (r.status >= 300) throw new Error(JSON.stringify(r.body));
        });
    }

    const [{ day }] = await ds.query<Array<{ day: string }>>(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Tehran')::date, 'YYYY-MM-DD') AS day`,
    );
    today = day;
  });

  afterAll(async () => {
    await ctx.close();
  });

  // =======================================================================
  // Cost snapshots the report is built on
  // =======================================================================

  it('recognised the exact COGS on each line, and a later receipt did not move an earlier sale', async () => {
    expect(s1CogsBeforeReceipt).toBe('120000');
    expect(await lineOf(s1, p1.variantId)).toEqual(
      expect.objectContaining({ costStatus: 'known', cogsTotal: '120000' }),
    );
    expect(await lineOf(s2, p1.variantId)).toEqual(
      expect.objectContaining({ costStatus: 'known', cogsTotal: '214615' }),
    );
    expect(await lineOf(s2, p2.variantId)).toEqual(
      expect.objectContaining({ costStatus: 'known', cogsTotal: '45000' }),
    );
    expect((await lineOf(s3, p3.variantId)).costStatus).toBe('unknown');

    // And the report of S1's own day still shows the original 80 000 profit.
    const d1 = await get('/reports/profit/summary', {
      from: '2026-09-01',
      to: '2026-09-01',
    });
    expect(d1.body.totals.knownCost.cogs).toBe('120000');
    expect(d1.body.totals.knownCost.grossProfit).toBe('80000');
  });

  // =======================================================================
  // Summary
  // =======================================================================

  it('sale-period summary: exact totals, known vs unknown cost, margin and coverage', async () => {
    const res = await get('/reports/profit/summary', {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    expect(res.body.timezone).toBe('Asia/Tehran');
    expect(res.body.range).toEqual({
      from: '2026-09-01',
      to: '2026-09-02',
      startUtc: '2026-08-31T20:30:00.000Z',
      endUtc: '2026-09-02T20:30:00.000Z',
    });
    expect(res.body.totals).toEqual({
      grossSalesRevenue: '1620000',
      revenueReversed: '0',
      voidedRevenue: '0',
      refundedRevenue: '0',
      netSalesRevenue: '1620000',
      unitsSold: 8,
      unitsReturned: 0,
      unitsRefundedWithoutReturn: 0,
      knownCost: {
        grossRevenue: '550000',
        revenueReversed: '0',
        netRevenue: '550000',
        cogs: '379615',
        cogsReversed: '0',
        netCogs: '379615',
        grossProfit: '170385',
        grossMarginPercent: '30.98',
        lineCount: 3,
      },
      unknownCost: {
        grossRevenue: '1070000',
        revenueReversed: '0',
        netRevenue: '1070000',
        pendingFulfilmentRevenue: '70000',
        unvaluedRevenue: '1000000',
        lineCount: 2,
      },
      coveragePercent: '33.95',
      // Today's losses are outside 1–2 September.
      inventoryLosses: { units: 0, knownCostRemoved: '0', unknownCostUnits: 0 },
    });
    // The 1 000 000 of unknown-cost revenue is NOT in gross profit: counted
    // as zero cost it would have been 1 170 385.
    expect(res.body.totals.knownCost.grossProfit).not.toBe('1170385');
    expect(res.body.semantics.metric).toMatch(/NOT net profit/);
    expect(JSON.stringify(res.body)).not.toMatch(/netProfit/);
  });

  it('all-time summary: reversals by kind, COGS given back only for restocked known units, losses separate', async () => {
    const res = await get('/reports/profit/summary');
    expect(res.body.range.from).toBeNull();
    const t = res.body.totals;
    expect(t).toEqual(
      expect.objectContaining({
        grossSalesRevenue: '1620000',
        revenueReversed: '1400000',
        voidedRevenue: '1000000',
        refundedRevenue: '400000',
        netSalesRevenue: '220000',
        unitsSold: 8,
        unitsReturned: 4,
        unitsRefundedWithoutReturn: 1,
        coveragePercent: '33.95',
      }),
    );
    expect(t.knownCost).toEqual({
      grossRevenue: '550000',
      revenueReversed: '400000',
      netRevenue: '150000',
      cogs: '379615',
      cogsReversed: '191538',
      netCogs: '188077',
      grossProfit: '-38077',
      grossMarginPercent: '-25.38',
      lineCount: 3,
    });
    expect(t.unknownCost).toEqual({
      grossRevenue: '1070000',
      revenueReversed: '1000000',
      netRevenue: '70000',
      pendingFulfilmentRevenue: '70000',
      unvaluedRevenue: '1000000',
      lineCount: 2,
    });
    // Inventory losses: reported beside, never inside, COGS.
    expect(t.inventoryLosses).toEqual({
      units: 2,
      knownCostRemoved: '45000',
      unknownCostUnits: 1,
    });
    expect(res.body.dataQuality.reversalsWithUnknownEventDate.count).toBe(0);
  });

  it('a reversal-only day: negative profit, and a null margin and coverage rather than an invented 0', async () => {
    const res = await get('/reports/profit/summary', {
      from: '2026-09-03',
      to: '2026-09-03',
    });
    const t = res.body.totals;
    expect(t.grossSalesRevenue).toBe('0');
    expect(t.revenueReversed).toBe('200000');
    expect(t.refundedRevenue).toBe('200000');
    expect(t.unitsReturned).toBe(1);
    expect(t.unitsRefundedWithoutReturn).toBe(1);
    expect(t.knownCost.netRevenue).toBe('-200000');
    expect(t.knownCost.cogsReversed).toBe('71538');
    expect(t.knownCost.grossProfit).toBe('-128462');
    expect(t.knownCost.grossMarginPercent).toBeNull();
    expect(t.coveragePercent).toBeNull();
  });

  it('today: whole-order reversals via the real routes, and the losses', async () => {
    const res = await get('/reports/profit/summary', {
      from: today,
      to: today,
    });
    const t = res.body.totals;
    expect(t.revenueReversed).toBe('1200000');
    expect(t.voidedRevenue).toBe('1000000');
    expect(t.refundedRevenue).toBe('200000');
    expect(t.knownCost.cogsReversed).toBe('120000');
    expect(t.knownCost.grossProfit).toBe('-80000');
    expect(t.unknownCost.revenueReversed).toBe('1000000');
    expect(t.inventoryLosses).toEqual({
      units: 2,
      knownCostRemoved: '45000',
      unknownCostUnits: 1,
    });
  });

  // =======================================================================
  // Asia/Tehran boundary
  // =======================================================================

  it('places 20:29:59Z on 1 September and 20:30:00Z on 2 September (Asia/Tehran)', async () => {
    const d1 = await get('/reports/profit/summary', {
      from: '2026-09-01',
      to: '2026-09-01',
    });
    expect(d1.body.totals.grossSalesRevenue).toBe('200000');
    expect(d1.body.totals.unitsSold).toBe(2);

    const d2 = await get('/reports/profit/summary', {
      from: '2026-09-02',
      to: '2026-09-02',
    });
    // S2 (350 000) + S3 (1 000 000) + W1 (70 000).
    expect(d2.body.totals.grossSalesRevenue).toBe('1420000');
    expect(d2.body.totals.knownCost.grossProfit).toBe('90385');
  });

  // =======================================================================
  // Filters
  // =======================================================================

  it('filters on the order (branch, channel, cashier) and on the line (product, variant, category)', async () => {
    const range = { from: '2026-09-01', to: '2026-09-02' };

    const branchB = await get('/reports/profit/summary', {
      ...range,
      branchId: cashierB.branchId,
    });
    expect(branchB.body.totals.grossSalesRevenue).toBe('350000');
    expect(branchB.body.totals.knownCost.grossProfit).toBe('90385');
    expect(branchB.body.totals.coveragePercent).toBe('100.00');

    const online = await get('/reports/profit/summary', {
      ...range,
      channel: 'online',
    });
    expect(online.body.totals.grossSalesRevenue).toBe('70000');
    expect(online.body.totals.unknownCost.pendingFulfilmentRevenue).toBe(
      '70000',
    );
    expect(online.body.totals.knownCost.grossMarginPercent).toBeNull();
    expect(online.body.totals.coveragePercent).toBe('0.00');

    const cashier = await get('/reports/profit/summary', {
      ...range,
      cashierUserId: cashierA.userId,
    });
    expect(cashier.body.totals.grossSalesRevenue).toBe('1200000');

    const product = await get('/reports/profit/summary', {
      ...range,
      productId: p1.productId,
    });
    expect(product.body.totals.grossSalesRevenue).toBe('500000');
    expect(product.body.totals.knownCost.grossProfit).toBe('165385');

    const variant = await get('/reports/profit/summary', {
      ...range,
      variantId: p2.variantId,
    });
    expect(variant.body.totals.knownCost.grossProfit).toBe('5000');

    const category = await get('/reports/profit/summary', {
      ...range,
      categoryId: cat2,
    });
    // P1 (500 000, known) + P3 (1 000 000, unknown).
    expect(category.body.totals.grossSalesRevenue).toBe('1500000');
    expect(category.body.totals.knownCost.grossRevenue).toBe('500000');

    // Line filters reach inventory losses; order filters do not.
    const lossP2 = await get('/reports/profit/summary', {
      productId: p2.productId,
    });
    expect(lossP2.body.totals.inventoryLosses).toEqual({
      units: 1,
      knownCostRemoved: '45000',
      unknownCostUnits: 0,
    });
    const lossBranch = await get('/reports/profit/summary', {
      branchId: cashierB.branchId,
    });
    expect(lossBranch.body.totals.inventoryLosses.units).toBe(2);
    expect(lossBranch.body.semantics.inventoryLosses).toMatch(
      /branchId, channel and cashierUserId do NOT/,
    );
  });

  // =======================================================================
  // Breakdown
  // =======================================================================

  async function breakdown(
    groupBy: string,
    query: Record<string, unknown> = {},
  ) {
    const res = await get('/reports/profit/breakdown', {
      groupBy,
      limit: 200,
      ...query,
    });
    return res.body.data as Row[];
  }

  it('ranks by product: complete before partial before none, by numeric gross profit, and never ranks unknown cost as profitable', async () => {
    const rows = await breakdown('product', {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    expect(rows.map((r) => r.key)).toEqual([
      p1.productId,
      p2.productId,
      p3.productId,
      null,
    ]);
    // 165 385 before 5 000: a string sort would have put "5000" first.
    expect(rows[0]).toEqual({
      key: p1.productId,
      label: expect.any(String),
      grossSalesRevenue: '500000',
      revenueReversed: '0',
      netSalesRevenue: '500000',
      unitsSold: 5,
      unitsReturned: 0,
      knownNetRevenue: '500000',
      unknownNetRevenue: '0',
      netCogs: '334615',
      grossProfit: '165385',
      grossMarginPercent: '33.08',
      coveragePercent: '100.00',
      costCoverage: 'complete',
      warning: null,
    });
    expect(rows[1].grossProfit).toBe('5000');
    // The highest-revenue product has unknown cost: last class, no profit.
    expect(rows[2]).toEqual(
      expect.objectContaining({
        label: 'Unknown-cost tent',
        grossSalesRevenue: '1000000',
        grossProfit: null,
        grossMarginPercent: null,
        coveragePercent: '0.00',
        costCoverage: 'none',
        warning: WARNING,
      }),
    );
    expect(rows[3].costCoverage).toBe('none');
  });

  it.each(['day', 'branch', 'channel', 'cashier', 'product', 'variant'])(
    'groupBy=%s partitions the totals exactly (ranged and all-time)',
    async (groupBy) => {
      for (const query of [{ from: '2026-09-01', to: '2026-09-02' }, {}]) {
        const [rows, summary] = await Promise.all([
          breakdown(groupBy, query),
          get('/reports/profit/summary', query),
        ]);
        const t = summary.body.totals;
        expect(sum(rows, 'grossSalesRevenue')).toBe(t.grossSalesRevenue);
        expect(sum(rows, 'revenueReversed')).toBe(t.revenueReversed);
        expect(sum(rows, 'netSalesRevenue')).toBe(t.netSalesRevenue);
        expect(sum(rows, 'knownNetRevenue')).toBe(t.knownCost.netRevenue);
        expect(sum(rows, 'unknownNetRevenue')).toBe(t.unknownCost.netRevenue);
        expect(sum(rows, 'netCogs')).toBe(t.knownCost.netCogs);
        // Rows with no known cost have no profit to add; the rest add up.
        expect(sum(rows, 'grossProfit')).toBe(t.knownCost.grossProfit);
        expect(rows.reduce((n, r) => n + r.unitsSold, 0)).toBe(t.unitsSold);
        expect(rows.reduce((n, r) => n + r.unitsReturned, 0)).toBe(
          t.unitsReturned,
        );
      }
    },
  );

  it('groupBy=day uses the Tehran calendar day of each event', async () => {
    const rows = await breakdown('day');
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('2026-09-01')).toEqual(
      expect.objectContaining({
        grossSalesRevenue: '200000',
        grossProfit: '80000',
        costCoverage: 'complete',
      }),
    );
    expect(byKey.get('2026-09-02')).toEqual(
      expect.objectContaining({
        grossSalesRevenue: '1420000',
        knownNetRevenue: '350000',
        unknownNetRevenue: '1070000',
        netCogs: '259615',
        grossProfit: '90385',
        costCoverage: 'partial',
        warning: WARNING,
      }),
    );
    expect(byKey.get('2026-09-03')).toEqual(
      expect.objectContaining({
        grossSalesRevenue: '0',
        revenueReversed: '200000',
        grossProfit: '-128462',
        grossMarginPercent: null,
        costCoverage: 'complete',
      }),
    );
    expect(byKey.get(today)).toEqual(
      expect.objectContaining({
        revenueReversed: '1200000',
        costCoverage: 'partial',
      }),
    );
  });

  it('groupBy=branch / channel / cashier rows and their order', async () => {
    const range = { from: '2026-09-01', to: '2026-09-02' };
    const branches = await breakdown('branch', range);
    expect(
      branches.map((r) => [r.key, r.label, r.costCoverage, r.grossProfit]),
    ).toEqual([
      [cashierB.branchId, 'Shiraz', 'complete', '90385'],
      [cashierA.branchId, 'Tehran', 'partial', '80000'],
    ]);

    const channels = await breakdown('channel', range);
    expect(channels.map((r) => [r.key, r.costCoverage, r.grossProfit])).toEqual(
      [
        ['pos', 'partial', '170385'],
        ['online', 'none', null],
      ],
    );

    const cashiers = await breakdown('cashier', range);
    expect(cashiers.map((r) => [r.key, r.label, r.costCoverage])).toEqual([
      [cashierB.userId, 'cashier_b', 'complete'],
      [cashierA.userId, 'cashier_a', 'partial'],
      [admin.userId, 'سفارش آنلاین', 'none'],
    ]);
  });

  it('groupBy=category counts a line in every category of its product (rows overlap)', async () => {
    const range = { from: '2026-09-01', to: '2026-09-02' };
    const rows = await breakdown('category', range);
    expect(
      rows.map((r) => [r.key, r.label, r.costCoverage, r.grossProfit]),
    ).toEqual([
      [cat1, 'cat-one', 'complete', '170385'],
      [cat2, 'cat-two', 'partial', '165385'],
      [null, null, 'none', null],
    ]);
    const summary = await get('/reports/profit/summary', range);
    // 550 000 + 1 500 000 + 70 000 > 1 620 000: P1 is in both categories.
    expect(sum(rows, 'grossSalesRevenue')).toBe('2120000');
    expect(summary.body.totals.grossSalesRevenue).toBe('1620000');
    const res = await get('/reports/profit/breakdown', {
      groupBy: 'category',
    });
    expect(res.body.semantics.groupByCategory).toMatch(/MUST NOT be summed/);
  });

  it('paginates the breakdown and validates groupBy', async () => {
    const page = await get('/reports/profit/breakdown', {
      groupBy: 'product',
      from: '2026-09-01',
      to: '2026-09-02',
      page: 2,
      limit: 3,
    });
    expect(page.body.total).toBe(4);
    expect(page.body.totalPages).toBe(2);
    expect(page.body.data.map((r: Row) => r.key)).toEqual([null]);

    await as(ctx, admin)
      .get('/reports/profit/breakdown')
      .query({ groupBy: 'weekday' })
      .expect(400);
    await as(ctx, admin).get('/reports/profit/breakdown').expect(400);
    await as(ctx, admin)
      .get('/reports/profit/summary')
      .query({ limit: 201 })
      .expect(400);
  });

  // =======================================================================
  // Orders
  // =======================================================================

  it('lists orders with per-order profit, newest revenue first', async () => {
    const res = await get('/reports/profit/orders', {
      from: '2026-09-01',
      to: '2026-09-02',
    });
    expect(res.body.total).toBe(4);
    const rows = res.body.data as Array<Row & { orderId: number }>;
    expect(rows.map((r) => r.orderId)).toEqual([w1, s3, s2, s1]);
    const byId = new Map(rows.map((r) => [r.orderId, r]));
    expect(byId.get(s2)).toEqual(
      expect.objectContaining({
        channel: 'pos',
        branchNameSnapshot: 'Shiraz',
        cashierDisplaySnapshot: 'cashier_b',
        grossSalesRevenue: '350000',
        netCogs: '259615',
        grossProfit: '90385',
        grossMarginPercent: '25.82',
        costCoverage: 'complete',
        warning: null,
      }),
    );
    expect(byId.get(s3)).toEqual(
      expect.objectContaining({
        grossProfit: null,
        costCoverage: 'none',
        warning: WARNING,
      }),
    );
    expect(byId.get(w1)?.unknownNetRevenue).toBe('70000');
  });

  it('lists an order whose only in-range event is a reversal', async () => {
    const res = await get('/reports/profit/orders', {
      from: '2026-09-03',
      to: '2026-09-03',
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        orderId: s2,
        grossSalesRevenue: '0',
        revenueReversed: '200000',
        grossProfit: '-128462',
      }),
    );
  });

  it('shows one order with each line cost snapshot, what remains, its adjustments and totals', async () => {
    const res = await get(`/reports/profit/orders/${s2}`);
    const data = res.body.data;
    expect(data.order).toEqual(
      expect.objectContaining({
        id: s2,
        channel: 'pos',
        countsAsSale: true,
        cashierUserId: cashierB.userId,
        totalPrice: '350000',
      }),
    );
    expect(data.lines).toHaveLength(2);
    const [l1, l2] = data.lines;
    expect(l1).toEqual(
      expect.objectContaining({
        variantId: p1.variantId,
        quantity: 3,
        unitPrice: '100000',
        totalPrice: '300000',
        costStatus: 'known',
        cogsTotal: '214615',
        unitCostDisplay: '71538',
        costKnownQuantity: 3,
        costUnknownQuantity: 0,
        remaining: { revenueUnits: 1, restockUnits: 2 },
      }),
    );
    expect(
      l1.adjustments.map(
        (a: {
          kind: string;
          revenueReversed: string;
          cogsReversed: string;
        }) => [a.kind, a.revenueReversed, a.cogsReversed],
      ),
    ).toEqual([
      ['refund_only', '100000', '0'],
      ['return_refund', '100000', '71538'],
    ]);
    expect(l2).toEqual(
      expect.objectContaining({
        variantId: p2.variantId,
        cogsTotal: '45000',
        unitCostDisplay: '45000',
        remaining: { revenueUnits: 1, restockUnits: 1 },
        adjustments: [],
      }),
    );
    expect(data.totals).toEqual(
      expect.objectContaining({
        grossSalesRevenue: '350000',
        revenueReversed: '200000',
        netSalesRevenue: '150000',
        knownNetRevenue: '150000',
        netCogs: '188077',
        grossProfit: '-38077',
        grossMarginPercent: '-25.38',
        costCoverage: 'complete',
      }),
    );

    const unknown = await get(`/reports/profit/orders/${s3}`);
    expect(unknown.body.data.lines[0]).toEqual(
      expect.objectContaining({
        costStatus: 'unknown',
        costUnknownQuantity: 1,
        unitCostDisplay: null,
        remaining: { revenueUnits: 0, restockUnits: 0 },
      }),
    );
    expect(unknown.body.data.totals.grossProfit).toBeNull();

    const pending = await get(`/reports/profit/orders/${w1}`);
    expect(pending.body.data.lines[0]).toEqual(
      expect.objectContaining({
        costStatus: 'pending',
        cogsTotal: null,
        remaining: { revenueUnits: 1, restockUnits: 0 },
      }),
    );
  });

  it('404s an unknown order', async () => {
    await as(ctx, admin).get('/reports/profit/orders/999999').expect(404);
  });

  // =======================================================================
  // Dashboard
  // =======================================================================

  it("adds today's gross-profit headline to the financial dashboard, equal to the profit summary", async () => {
    const [dash, summary] = await Promise.all([
      get('/admin/dashboard/financial'),
      get('/reports/profit/summary', { from: today, to: today }),
    ]);
    const t = summary.body.totals;
    expect(dash.body.data.period.date).toBe(today);
    expect(dash.body.data.profit).toEqual({
      grossProfit: t.knownCost.grossProfit,
      grossMarginPercent: t.knownCost.grossMarginPercent,
      coveragePercent: t.coveragePercent,
      knownNetRevenue: t.knownCost.netRevenue,
      unknownNetRevenue: t.unknownCost.netRevenue,
    });
    expect(dash.body.data.profit).toEqual({
      grossProfit: '-80000',
      grossMarginPercent: null,
      coveragePercent: null,
      knownNetRevenue: '-200000',
      unknownNetRevenue: '-1000000',
    });
  });

  // =======================================================================
  // Legacy reversal with an unknown date (runs LAST: it adds rows)
  // =======================================================================

  describe('a legacy refund whose date migration 0009 could not recover', () => {
    let branchC: Branch;
    let legacyOrder: number;

    beforeAll(async () => {
      branchC = await seedBranch(ctx, 'Tabriz');
      const order = await seedReportingSale(ctx.dataSource, {
        soldAt: new Date('2026-10-05T08:00:00Z'),
        branchId: branchC.id,
        branchName: 'Tabriz',
        cashierUserId: admin.userId,
        cashierDisplay: 'legacy',
        total: 90_000,
        status: OrderStatusEnum.REFUNDED,
        refundedAt: null,
      });
      legacyOrder = order.id;
      // What migration 0037 writes for such a sale: an `unknown` line with no
      // split, and one `legacy` adjustment with eventAt NULL.
      await ctx.dataSource.query(
        `UPDATE order_items SET "costStatus" = 'unknown' WHERE "orderId" = $1`,
        [legacyOrder],
      );
      await ctx.dataSource.query(
        `INSERT INTO order_item_adjustments
           ("orderId", "orderItemId", kind, scope, "revenueQuantity", "revenueReversed", "eventAt")
         SELECT "orderId", id, 'return_refund', 'legacy', quantity, total_price, NULL
           FROM order_items WHERE "orderId" = $1`,
        [legacyOrder],
      );
    });

    it('is excluded from a ranged query and reported as data quality; included all-time', async () => {
      const ranged = await get('/reports/profit/summary', {
        from: '2026-10-05',
        to: '2026-10-05',
        branchId: branchC.id,
      });
      expect(ranged.body.totals.grossSalesRevenue).toBe('90000');
      expect(ranged.body.totals.unknownCost.unvaluedRevenue).toBe('90000');
      expect(ranged.body.totals.revenueReversed).toBe('0');
      expect(ranged.body.dataQuality.reversalsWithUnknownEventDate).toEqual(
        expect.objectContaining({ count: 1, revenueReversed: '90000' }),
      );

      const allTime = await get('/reports/profit/summary', {
        branchId: branchC.id,
      });
      expect(allTime.body.totals.revenueReversed).toBe('90000');
      expect(allTime.body.totals.refundedRevenue).toBe('90000');
      expect(allTime.body.totals.unknownCost.netRevenue).toBe('0');
      // Legacy rows carry no restock evidence: nothing is invented.
      expect(allTime.body.totals.unitsReturned).toBe(0);
      expect(allTime.body.totals.knownCost.grossProfit).toBe('0');
      expect(allTime.body.dataQuality.reversalsWithUnknownEventDate.count).toBe(
        0,
      );

      const detail = await get(`/reports/profit/orders/${legacyOrder}`);
      expect(detail.body.data.lines[0].adjustments[0]).toEqual(
        expect.objectContaining({
          scope: 'legacy',
          eventAt: null,
          cogsReversed: null,
          restockedKnownQuantity: null,
        }),
      );
      expect(detail.body.data.lines[0].remaining).toEqual({
        revenueUnits: 0,
        restockUnits: 1,
      });
    });
  });
});
