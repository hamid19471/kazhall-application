/**
 * ===========================================================================
 * THE REPORTING MONEY CONTRACT: INTEGER RIAL AS AN EXACT DECIMAL STRING
 * ===========================================================================
 *
 * WHAT THIS FILE EXISTS TO PROVE, AND WHY IT IS NOT COVERED ELSEWHERE.
 *
 * The admin dashboard has always returned money as `bigint` strings and has a
 * case pinning that at 2^53 + 1 — on `/admin/dashboard/financial` now that the
 * figures have moved there off `/summary`. `/reports/sales*` did not: it read the
 * same `bigint` columns, put them through `Number()`, and computed `netSales`
 * as a floating-point subtraction. Every existing reporting case used figures
 * in the millions, where `Number` is exact, so nothing in the suite could tell
 * the difference between "this pipeline is precise" and "these fixtures are
 * small". That is the gap this file closes, with values ABOVE
 * `Number.MAX_SAFE_INTEGER` on every reporting route.
 *
 * THE NUMBER THAT MATTERS. 2^53 + 1 = 9 007 199 254 740 993 is the first
 * integer a JavaScript `number` cannot represent:
 *
 *   Number('9007199254740993')          === 9007199254740992   // off by one
 *   9007199254740993 - 1                === 9007199254740992   // also off
 *
 * So a single `Number()` anywhere on the path — in the service, in a
 * transformer, in a test helper — changes the last digit and nothing throws.
 * Every assertion below therefore compares against the literal STRING, and
 * several of them additionally assert `not.toBe(String(Number(...)))`: that is
 * the assertion a float-rounding regression fails, and an equality check alone
 * would not.
 *
 * SUBTRACTION IS CHECKED SEPARATELY FROM THE OPERANDS, deliberately. Two
 * values can each be exactly representable while their difference is not, so
 * `netSales` is the first figure to go wrong and the last one a
 * small-fixture test would catch.
 *
 * WHY THE FIXTURES ARE RAW SQL. `orders.total_price`, `orders.subtotal` and
 * both `order_items` money columns carry `bigIntTransformer`, whose `from()`
 * THROWS above `Number.MAX_SAFE_INTEGER`. Inserting through the repositories
 * would fail in the fixture rather than in the assertion, and reading the sale
 * detail through `getRepository(Order).findOne` would 500 — which is precisely
 * why `ReportsService.detail` no longer does.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
} from './support/pos.fixtures';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';

/** 2^53 + 1 — the first integer `Number` cannot hold. */
const BEYOND_FLOAT = '9007199254740993';
/** 2^53 + 3, so that two large operands are distinguishable from each other. */
const BEYOND_FLOAT_PLUS_2 = '9007199254740995';
/** What a float-rounding pipeline would produce for BEYOND_FLOAT. */
const ROUNDED = String(Number(BEYOND_FLOAT)); // '9007199254740992'

/** A fixed Tehran day, safely inside one local calendar day at 12:30 local. */
const SALE_DAY = '2026-10-11';
const SALE_AT = new Date('2026-10-11T09:00:00.000Z');
const REVERSAL_AT = new Date('2026-10-11T10:00:00.000Z');

interface SeedInput {
  total: string;
  branchId: number;
  branchName: string;
  cashierUserId: number;
  cashierDisplay: string;
  status?: OrderStatusEnum;
  voidedAt?: Date | null;
  refundedAt?: Date | null;
  quantity?: number;
  /** Defaults to `total`, which is what a single-line sale looks like. */
  unitPrice?: string;
}

/**
 * Plants one completed sale with money written as `bigint` LITERALS.
 *
 * `$n::bigint` with a string parameter is what keeps the value exact all the
 * way into the column: node-postgres sends the text, PostgreSQL parses it as a
 * 64-bit integer, and no JavaScript number is involved at any point.
 */
async function seedBigSale(ctx: TestApp, input: SeedInput): Promise<number> {
  const iso = (value: Date | null | undefined): string | null =>
    value ? value.toISOString() : null;

  const [row] = await ctx.dataSource.query<Array<{ id: number }>>(
    `INSERT INTO orders
       (channel, status, "fulfillmentState", "paymentMethod",
        "branchId", "branchNameSnapshot", "cashierUserId", "cashierDisplaySnapshot",
        subtotal, total_price, "soldAt", "paidAt", "voidedAt", "refundedAt")
     VALUES ($1, $2, 'fulfilled', 'cash',
             $3, $4, $5, $6,
             $7::bigint, $7::bigint,
             $8::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz)
     RETURNING id`,
    [
      OrderChannel.POS,
      input.status ?? OrderStatusEnum.PAID,
      input.branchId,
      input.branchName,
      input.cashierUserId,
      input.cashierDisplay,
      input.total,
      iso(SALE_AT),
      iso(input.voidedAt),
      iso(input.refundedAt),
    ],
  );

  await ctx.dataSource.query(
    `INSERT INTO order_items
       ("orderId", quantity, unit_price, total_price,
        "productTitleSnapshot", "variantSkuSnapshot")
     VALUES ($1, $2, $3::bigint, $4::bigint, 'Large-value fixture', 'BIG-SKU')`,
    [row.id, input.quantity ?? 1, input.unitPrice ?? input.total, input.total],
  );

  await ctx.dataSource.query(
    `UPDATE orders SET "orderNumber" = $2 WHERE id = $1`,
    [row.id, `BIG-${String(row.id).padStart(6, '0')}`],
  );

  return Number(row.id);
}

describe('Reporting money precision (int)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof loginSuperAdmin>>;
  let branch: Awaited<ReturnType<typeof seedBranch>>;
  let seller: Awaited<ReturnType<typeof loginCashier>>;

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    branch = await seedBranch(ctx, 'Precision');
    seller = await loginCashier(ctx, branch, { username: 'precision_seller' });
    admin = await loginSuperAdmin(ctx);
  });

  const base = () => ({
    branchId: branch.id,
    branchName: 'Precision',
    cashierUserId: seller.userId,
    cashierDisplay: 'precision_seller',
  });

  async function summary(): Promise<{
    totals: Record<string, string & number>;
    dataQuality: {
      refundsWithUnknownEventDate: { count: number; total: string };
    };
    semantics: Record<string, string>;
  }> {
    const response = await as(ctx, admin)
      .get('/reports/sales/summary')
      .query({ from: SALE_DAY, to: SALE_DAY });
    expect(response.status).toBe(200);
    return response.body;
  }

  // =======================================================================
  // 1. The four summary totals
  // =======================================================================

  it('keeps grossSales exact above Number.MAX_SAFE_INTEGER', async () => {
    await seedBigSale(ctx, { ...base(), total: BEYOND_FLOAT });

    const { totals } = await summary();

    expect(typeof totals.grossSales).toBe('string');
    expect(totals.grossSales).toBe(BEYOND_FLOAT);
    // The assertion a float-rounding regression actually fails.
    expect(totals.grossSales).not.toBe(ROUNDED);
    // No scientific notation, no decimal point, no NaN — the three shapes a
    // number that had been through a float would come back as.
    expect(totals.grossSales).toMatch(/^-?\d+$/);
  });

  it('keeps refundedTotal exact, and subtracts it exactly', async () => {
    // A sale of 2^53+1 refunded in the same window. gross keeps it (a refund
    // does not un-sell the sale), refundedTotal carries it, and net is zero —
    // which only comes out as exactly "0" if both operands survived intact.
    await seedBigSale(ctx, {
      ...base(),
      total: BEYOND_FLOAT,
      status: OrderStatusEnum.REFUNDED,
      refundedAt: REVERSAL_AT,
    });

    const { totals } = await summary();

    expect(totals.refundedTotal).toBe(BEYOND_FLOAT);
    expect(totals.refundedTotal).not.toBe(ROUNDED);
    expect(totals.grossSales).toBe(BEYOND_FLOAT);
    expect(totals.netSales).toBe('0');
  });

  it('keeps voidedTotal exact, and subtracts it exactly', async () => {
    // A voided POS sale carries status `canceled` with `paidAt` set: the money
    // really did cross the counter, so it is in gross AND in voidedTotal.
    await seedBigSale(ctx, {
      ...base(),
      total: BEYOND_FLOAT,
      status: OrderStatusEnum.CANCELED,
      voidedAt: REVERSAL_AT,
    });

    const { totals } = await summary();

    expect(totals.voidedTotal).toBe(BEYOND_FLOAT);
    expect(totals.voidedTotal).not.toBe(ROUNDED);
    expect(totals.grossSales).toBe(BEYOND_FLOAT);
    expect(totals.netSales).toBe('0');
  });

  it('keeps netSales exact when the difference is one Rial', async () => {
    /*
     * THE CASE THAT PROVES THE SUBTRACTION, NOT JUST THE OPERANDS.
     *
     * gross = 2^53+3 + 2^53+1, refunded = 2^53+1, so net = 2^53+3.
     * Computed in floating point the two large sales would already collapse
     * onto neighbouring representable values, and the difference would come
     * back as 9007199254740992 rather than 9007199254740995. One Rial is the
     * smallest error this contract can have and the one it must not have.
     */
    await seedBigSale(ctx, { ...base(), total: BEYOND_FLOAT_PLUS_2 });
    await seedBigSale(ctx, {
      ...base(),
      total: BEYOND_FLOAT,
      status: OrderStatusEnum.REFUNDED,
      refundedAt: REVERSAL_AT,
    });

    const { totals } = await summary();

    const expectedGross = (
      BigInt(BEYOND_FLOAT_PLUS_2) + BigInt(BEYOND_FLOAT)
    ).toString();
    expect(totals.grossSales).toBe(expectedGross);
    expect(totals.refundedTotal).toBe(BEYOND_FLOAT);
    expect(totals.netSales).toBe(BEYOND_FLOAT_PLUS_2);

    // Restated as the arithmetic identity the contract promises.
    expect(
      (BigInt(totals.grossSales) - BigInt(totals.refundedTotal)).toString(),
    ).toBe(totals.netSales);
  });

  it('keeps a NEGATIVE netSales exact', async () => {
    // A window that only contains a reversal of an earlier sale. The sale
    // itself is dated outside the range, so gross is 0 and net is negative —
    // and the minus sign must survive as part of the decimal string.
    const [row] = await ctx.dataSource.query<Array<{ id: number }>>(
      `INSERT INTO orders
         (channel, status, "fulfillmentState", "paymentMethod",
          "branchId", "branchNameSnapshot", "cashierUserId", "cashierDisplaySnapshot",
          subtotal, total_price, "soldAt", "paidAt", "refundedAt")
       VALUES ($1, 'refunded', 'fulfilled', 'cash', $2, 'Precision', $3, 'precision_seller',
               $4::bigint, $4::bigint,
               '2026-09-15T09:00:00Z'::timestamptz, '2026-09-15T09:00:00Z'::timestamptz,
               $5::timestamptz)
       RETURNING id`,
      [
        OrderChannel.POS,
        branch.id,
        seller.userId,
        BEYOND_FLOAT,
        REVERSAL_AT.toISOString(),
      ],
    );
    expect(row.id).toBeGreaterThan(0);

    const { totals } = await summary();

    expect(totals.grossSales).toBe('0');
    expect(totals.refundedTotal).toBe(BEYOND_FLOAT);
    expect(totals.netSales).toBe(`-${BEYOND_FLOAT}`);
    expect(totals.netSales).toMatch(/^-\d+$/);
  });

  // =======================================================================
  // 2. Per-cashier totals
  // =======================================================================

  it('keeps per-cashier totals exact, including netSales', async () => {
    const other = await loginCashier(ctx, branch, {
      username: 'precision_two',
    });

    await seedBigSale(ctx, { ...base(), total: BEYOND_FLOAT_PLUS_2 });
    await seedBigSale(ctx, {
      ...base(),
      total: BEYOND_FLOAT,
      status: OrderStatusEnum.CANCELED,
      voidedAt: REVERSAL_AT,
    });
    await seedBigSale(ctx, {
      branchId: branch.id,
      branchName: 'Precision',
      cashierUserId: other.userId,
      cashierDisplay: 'precision_two',
      total: BEYOND_FLOAT,
    });

    const response = await as(ctx, admin)
      .get('/reports/sales/by-cashier')
      .query({ from: SALE_DAY, to: SALE_DAY });
    expect(response.status).toBe(200);

    const rows: any[] = response.body.data;
    const mine = rows.find((r) => r.cashierUserId === seller.userId);
    const theirs = rows.find((r) => r.cashierUserId === other.userId);

    expect(mine.grossSales).toBe(
      (BigInt(BEYOND_FLOAT_PLUS_2) + BigInt(BEYOND_FLOAT)).toString(),
    );
    expect(mine.voidedTotal).toBe(BEYOND_FLOAT);
    expect(mine.netSales).toBe(BEYOND_FLOAT_PLUS_2);
    expect(mine.netSales).not.toBe(ROUNDED);

    expect(theirs.grossSales).toBe(BEYOND_FLOAT);
    expect(theirs.netSales).toBe(BEYOND_FLOAT);

    // Every money field on every row is a decimal integer string, and every
    // count is still a number — the contract in one assertion.
    for (const row of rows) {
      for (const key of [
        'grossSales',
        'refundedTotal',
        'voidedTotal',
        'netSales',
      ]) {
        expect(typeof row[key]).toBe('string');
        expect(row[key]).toMatch(/^-?\d+$/);
      }
      for (const key of ['orderCount', 'salesCount', 'unitsSold']) {
        expect(typeof row[key]).toBe('number');
      }
    }
  });

  it('keeps the reversal-actor totals exact', async () => {
    const sale = await seedBigSale(ctx, {
      ...base(),
      total: BEYOND_FLOAT,
      status: OrderStatusEnum.CANCELED,
      voidedAt: REVERSAL_AT,
    });

    await ctx.dataSource.query(
      `INSERT INTO order_actions
         ("orderId", action, "fromStatus", "toStatus",
          "actorUserId", "actorDisplaySnapshot", reason, "createdAt")
       VALUES ($1, 'void', 'paid', 'canceled', $2, 'supervisor', 'test', $3::timestamptz)`,
      [sale, admin.userId, REVERSAL_AT.toISOString()],
    );

    const response = await as(ctx, admin)
      .get('/reports/sales/by-cashier')
      .query({ from: SALE_DAY, to: SALE_DAY });
    expect(response.status).toBe(200);

    const actor = response.body.reversalsByActor.find(
      (r: any) => r.actorUserId === admin.userId,
    );
    expect(actor.voidedTotal).toBe(BEYOND_FLOAT);
    expect(actor.voidedTotal).not.toBe(ROUNDED);
    expect(actor.refundedTotal).toBe('0');
    expect(typeof actor.reversalCount).toBe('number');
  });

  // =======================================================================
  // 3. The row list
  // =======================================================================

  it('keeps the row list money exact and sums back to the totals', async () => {
    await seedBigSale(ctx, { ...base(), total: BEYOND_FLOAT });
    await seedBigSale(ctx, { ...base(), total: BEYOND_FLOAT_PLUS_2 });

    const list = await as(ctx, admin)
      .get('/reports/sales')
      .query({ from: SALE_DAY, to: SALE_DAY, limit: 200 });
    expect(list.status).toBe(200);

    const totals = (await summary()).totals;

    let summed = 0n;
    const rows = list.body.data as Array<{
      total_price: string;
      subtotal: string;
      unitCount: number;
    }>;
    for (const row of rows) {
      expect(typeof row.total_price).toBe('string');
      expect(typeof row.subtotal).toBe('string');
      expect(row.total_price).toMatch(/^-?\d+$/);
      expect(row.subtotal).toBe(row.total_price);
      // `unitCount` is a bounded count and stays a number.
      expect(typeof row.unitCount).toBe('number');
      summed += BigInt(row.total_price);
    }

    expect(summed.toString()).toBe(totals.grossSales);
    expect(rows.map((r) => r.total_price).sort()).toEqual(
      [BEYOND_FLOAT, BEYOND_FLOAT_PLUS_2].sort(),
    );
  });

  // =======================================================================
  // 4. Sale detail
  // =======================================================================

  it('keeps every monetary field of the sale detail exact', async () => {
    /*
     * THE ROUTE THAT USED TO 500 RATHER THAN ROUND.
     *
     * `detail` read the order through `getRepository(Order).findOne`, and
     * `bigIntTransformer.from` THROWS above `Number.MAX_SAFE_INTEGER` — so for
     * a sale this size the endpoint did not return a rounded figure, it
     * returned a 500. Asserting a 200 here is therefore half the point; the
     * other half is that all four money fields come back as exact strings.
     */
    const id = await seedBigSale(ctx, {
      ...base(),
      total: BEYOND_FLOAT,
      quantity: 1,
      unitPrice: BEYOND_FLOAT,
    });

    const response = await as(ctx, admin).get(`/reports/sales/${id}`);
    expect(response.status).toBe(200);

    const { data } = response.body;
    expect(data.totalPrice).toBe(BEYOND_FLOAT);
    expect(data.subtotal).toBe(BEYOND_FLOAT);
    expect(data.totalPrice).not.toBe(ROUNDED);

    expect(data.items).toHaveLength(1);
    expect(data.items[0].unitPrice).toBe(BEYOND_FLOAT);
    expect(data.items[0].totalPrice).toBe(BEYOND_FLOAT);
    expect(data.items[0].unitPrice).not.toBe(ROUNDED);
    // Quantity is a bounded count and is still a number.
    expect(typeof data.items[0].quantity).toBe('number');

    // The snapshots the route exists to serve are still there.
    expect(data.items[0].productTitle).toBe('Large-value fixture');
    expect(data.items[0].sku).toBe('BIG-SKU');
    expect(data.seller.cashierDisplaySnapshot).toBe('precision_seller');
  });

  // =======================================================================
  // 5. Dashboard / report agreement, at a magnitude a float cannot hold
  // =======================================================================

  it('returns IDENTICAL strings to the dashboard for identical concepts', async () => {
    /*
     * The two screens are reconciled by hand by operators, so a one-Rial
     * disagreement between them is indistinguishable from a data bug. They now
     * share one `subtractRial` helper and one money representation; this is the
     * case that fails if either half is changed alone.
     *
     * The dashboard always reports TODAY, so the fixture is dated to today's
     * Tehran calendar day as PostgreSQL computes it — never from the Node
     * process's clock, which could agree with a broken service by coincidence.
     */
    const [day] = await ctx.dataSource.query<Array<{ d: string }>>(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Tehran')::date, 'YYYY-MM-DD') AS d`,
    );

    await ctx.dataSource.query(
      `INSERT INTO orders
         (channel, status, "fulfillmentState", "paymentMethod",
          "branchId", "branchNameSnapshot", "cashierUserId", "cashierDisplaySnapshot",
          subtotal, total_price, "soldAt", "paidAt")
       VALUES ($1, 'paid', 'fulfilled', 'cash', $2, 'Precision', $3, 'precision_seller',
               $4::bigint, $4::bigint, now(), now())`,
      [OrderChannel.POS, branch.id, seller.userId, BEYOND_FLOAT],
    );

    /*
     * THE DASHBOARD SIDE IS `/admin/dashboard/financial`, NOT `/summary`.
     *
     * This case used to read `/admin/dashboard/summary`, whose `totals` block
     * carried both the counts and the Rial figures. That claim is now simply
     * false: the owner's rule moved every money figure onto the financial
     * route behind `@Roles(super_admin)`, and the summary's `totals` has no
     * `grossSales` at all — reading it would compare the report against
     * `undefined`, which `toBe` would catch only because both sides are not
     * undefined.
     *
     * The counts are still read from `/summary`, so the reconciliation spans
     * BOTH dashboard routes. That is what an operator actually does: the
     * count on one screen, the money on the other, and a one-Rial or one-order
     * disagreement between any two of the three is a support ticket.
     */
    const operational = await as(ctx, admin).get('/admin/dashboard/summary');
    expect(operational.status).toBe(200);

    const financial = await as(ctx, admin).get('/admin/dashboard/financial');
    expect(financial.status).toBe(200);

    // Both dashboard routes must be describing the same business day before
    // their figures are compared against one report range — they resolve it
    // independently now, so it is an assertion rather than a given.
    expect(financial.body.data.period).toEqual(operational.body.data.period);
    expect(financial.body.data.period.date).toBe(day.d);

    const report = await as(ctx, admin)
      .get('/reports/sales/summary')
      .query({ from: day.d, to: day.d });
    expect(report.status).toBe(200);

    const counts = operational.body.data.totals;
    const money = financial.body.data.money;
    const r = report.body.totals;

    expect(r.grossSales).toBe(money.grossSales);
    expect(r.refundedTotal).toBe(money.refundedTotal);
    expect(r.voidedTotal).toBe(money.voidedTotal);
    expect(r.netSales).toBe(money.netSales);

    // Not merely equal — equal AND right.
    expect(r.grossSales).toBe(BEYOND_FLOAT);
    expect(money.grossSales).toBe(BEYOND_FLOAT);

    // The counts agree too, and are still numbers on both sides.
    expect(r.orderCount).toBe(counts.ordersByRevenueDate);
    expect(r.salesCount).toBe(counts.salesCount);
    expect(typeof r.salesCount).toBe('number');
    expect(typeof counts.salesCount).toBe('number');

    // And the figure this case is about is not reachable on the operational
    // route under its old name — a compatibility alias left behind would make
    // the split cosmetic.
    expect(counts.grossSales).toBeUndefined();
    expect(counts.netSales).toBeUndefined();
  });

  // =======================================================================
  // 6. The contract itself
  // =======================================================================

  it('states the string contract in the semantics block it returns', async () => {
    await seedBigSale(ctx, { ...base(), total: BEYOND_FLOAT });
    const body = await summary();

    expect(body.semantics.moneyUnit).toContain('STRING');
    expect(body.semantics.moneyUnit).toContain('Integer Rial');
    // The dataQuality total is money too, and follows the same contract.
    expect(typeof body.dataQuality.refundsWithUnknownEventDate.total).toBe(
      'string',
    );
    expect(typeof body.dataQuality.refundsWithUnknownEventDate.count).toBe(
      'number',
    );
  });
});
