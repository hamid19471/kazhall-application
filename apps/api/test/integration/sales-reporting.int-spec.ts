/**
 * ACCEPTANCE 3, 4, 5 -- retention of seller/product snapshots, correctly scoped
 * report filters, and totals that follow the documented cancellation/refund
 * rules.
 *
 * Also covers the timezone boundary: a date range is INCLUSIVE LOCAL CALENDAR
 * DAYS in REPORT_TIMEZONE, so a sale at 20:45Z on 1 September belongs to
 * 2 September in Asia/Tehran (+03:30) and must not appear in a 1 September
 * report. That is only assertable against a real PostgreSQL, because the
 * conversion is done by `AT TIME ZONE` in SQL.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import {
  authenticate,
  CookieJar,
  createPosTestApp,
  TestApp,
} from './support/pos.harness';
import {
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
  seedSale,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';
import {
  confirmOnlinePayment,
  moneyEventsOf,
  seedReportingSale,
} from './support/reporting.fixtures';
import { record, redactBody } from './support/diagnostics';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';

/**
 * Exact sum of the `total_price` column over a set of report rows.
 *
 * Every money field on every reporting route is now a DECIMAL INTEGER STRING,
 * so the obvious `reduce((sum, row) => sum + row.total_price, 0)` concatenates
 * instead of adding. `BigInt` is the only arithmetic that reproduces what the
 * server did, and it is exact at every magnitude — which is the point of the
 * contract these tests are asserting.
 */
interface ReportRow {
  countsAsSale: boolean;
  soldInRange: boolean;
  refundedInRange: boolean;
  voidedInRange: boolean;
  unitCount: number;
  /** Integer Rial as a decimal string — never a number. */
  total_price: string;
}

function sumMoney(rows: Array<{ total_price: string }>): string {
  let total = 0n;
  for (const row of rows) total += BigInt(row.total_price);
  return total.toString();
}

describe('Sales reporting (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
  });

  // =======================================================================
  // 3. history survives renames, deactivation and later reversals
  // =======================================================================
  it('keeps the seller and product snapshots after the cashier is renamed and deactivated', async () => {
    const branch = await seedBranch(ctx, 'Karaj');
    const cashier = await loginCashier(ctx, branch, { username: 'sara_old' });
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, {
      title: 'Leather belt',
      price: 1_200_000,
      stock: 3,
      sku: 'BELT-BRN',
    });

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    // Permitted edits after the fact: the cashier is renamed, the branch is
    // renamed, the product is renamed and re-priced, and the cashier leaves.
    await as(ctx, admin)
      .patch(`/users/${cashier.userId}`)
      .send({ username: 'sara_new' })
      .expect(200);
    await ctx.dataSource.query(
      `UPDATE branches SET name = 'Karaj North' WHERE id = $1`,
      [branch.id],
    );
    await ctx.dataSource.query(
      `UPDATE products SET title = 'Leather belt (2027 range)' WHERE id = (SELECT "productId" FROM product_variants WHERE id = $1)`,
      [variant.id],
    );
    await ctx.dataSource.query(
      `UPDATE product_variants SET sku = 'BELT-BRN-V2', price = 1 WHERE id = $1`,
      [variant.id],
    );

    // Deleting a cashier who has sales must be impossible; DELETE soft
    // deactivates instead.
    const deleted = await as(ctx, admin)
      .delete(`/users/${cashier.userId}`)
      .expect(200);
    expect(deleted.body.data.softDeactivated).toBe(true);

    const [userRow] = await ctx.dataSource.query(
      `SELECT id, "deactivatedAt" FROM users WHERE id = $1`,
      [cashier.userId],
    );
    expect(userRow).toBeDefined();
    expect(userRow.deactivatedAt).not.toBeNull();

    const detail = await as(ctx, admin)
      .get(`/reports/sales/${sale.body.data.id}`)
      .expect(200);

    expect(detail.body.data.seller).toEqual(
      expect.objectContaining({
        cashierUserId: cashier.userId,
        cashierDisplaySnapshot: 'sara_old',
        branchNameSnapshot: 'Karaj',
      }),
    );
    expect(detail.body.data.items[0]).toEqual(
      expect.objectContaining({
        productTitle: 'Leather belt',
        sku: 'BELT-BRN',
        // The sale-time snapshot, as an exact decimal string — the same
        // contract as every other money field on this controller.
        unitPrice: '1200000',
      }),
    );
  });

  it('keeps the original cashier when someone else voids the sale, and records who did', async () => {
    const branch = await seedBranch(ctx, 'Rasht');
    const seller = await loginCashier(ctx, branch, { username: 'seller_1' });
    // Reversals are the administrator's: a cashier may not void, not even a
    // colleague's sale. What this case pins is that voiding does not move the
    // sale onto whoever reversed it.
    const supervisor = await loginSuperAdmin(ctx, {
      username: 'supervisor_1',
    });
    const variant = await seedVariant(ctx, { price: 400_000, stock: 4 });

    const sale = await as(ctx, seller)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(2);

    await as(ctx, supervisor)
      .post(`/orders/${sale.body.data.id}/void`)
      .send({ reason: 'rung up on the wrong account' })
      .expect(200);

    const [order] = await ctx.dataSource.query(
      `SELECT "cashierUserId", "cashierDisplaySnapshot", "voidedAt", status FROM orders WHERE id = $1`,
      [sale.body.data.id],
    );
    expect(Number(order.cashierUserId)).toBe(seller.userId);
    expect(order.cashierDisplaySnapshot).toBe('seller_1');
    expect(order.voidedAt).not.toBeNull();
    expect(order.status).toBe(OrderStatusEnum.CANCELED);

    const actions = await ctx.dataSource.query(
      `SELECT action, "actorUserId", "actorDisplaySnapshot", reason FROM order_actions WHERE "orderId" = $1`,
      [sale.body.data.id],
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('void');
    expect(Number(actions[0].actorUserId)).toBe(supervisor.userId);
    expect(actions[0].actorDisplaySnapshot).toBe('supervisor_1');
    expect(actions[0].reason).toBe('rung up on the wrong account');

    // Stock came back.
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);

    // A voided sale is frozen.
    const frozen = await as(ctx, supervisor)
      .patch(`/orders/status/${sale.body.data.id}`)
      .send({ status: OrderStatusEnum.SHIPPED });
    expect(frozen.status).toBe(409);
  });

  it('enforces the status state machine instead of accepting any enum value', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    // The cashier rings the sale up; only the administrator may move it on.
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { price: 100_000, stock: 4 });

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);
    const id = sale.body.data.id;

    // paid -> shipped -> delivered is allowed...
    await as(ctx, admin)
      .patch(`/orders/status/${id}`)
      .send({ status: OrderStatusEnum.SHIPPED })
      .expect(200);
    await as(ctx, admin)
      .patch(`/orders/status/${id}`)
      .send({ status: OrderStatusEnum.DELIVERED })
      .expect(200);

    // ...but delivered -> pending is not.
    const back = await as(ctx, admin)
      .patch(`/orders/status/${id}`)
      .send({ status: OrderStatusEnum.PENDING });
    expect(back.status).toBe(400);

    // ...and canceling through this endpoint is refused because it would skip
    // the stock restore.
    const cancel = await as(ctx, admin)
      .patch(`/orders/status/${id}`)
      .send({ status: OrderStatusEnum.CANCELED });
    expect(cancel.status).toBe(400);
    expect(String(cancel.body.message)).toMatch(/void|return/i);

    const actions = await ctx.dataSource.query(
      `SELECT "fromStatus", "toStatus", "actorUserId" FROM order_actions WHERE "orderId" = $1 ORDER BY id`,
      [id],
    );
    expect(actions.map((a: any) => [a.fromStatus, a.toStatus])).toEqual([
      ['paid', 'shipped'],
      ['shipped', 'delivered'],
    ]);
    // The actor on each transition is whoever made it -- the administrator --
    // while the sale itself stays attributed to the cashier who rang it up.
    expect(
      actions.every((a: any) => Number(a.actorUserId) === admin.userId),
    ).toBe(true);
    const [order] = await ctx.dataSource.query(
      `SELECT "cashierUserId" FROM orders WHERE id = $1`,
      [id],
    );
    expect(Number(order.cashierUserId)).toBe(cashier.userId);
  });

  it('restores stock and marks the order refunded on a return', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { price: 250_000, stock: 5 });

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(3);

    await as(ctx, admin)
      .post(`/orders/${sale.body.data.id}/return`)
      .send({ reason: 'faulty zip' })
      .expect(200);

    const [order] = await ctx.dataSource.query(
      `SELECT status, "voidedAt", "refundedAt", "paidAt", "cashierUserId" FROM orders WHERE id = $1`,
      [sale.body.data.id],
    );
    expect(order.status).toBe(OrderStatusEnum.REFUNDED);
    // A return is counted through refundedTotal, never through voidedTotal:
    // stamping both would subtract the same sale twice from netSales.
    expect(order.voidedAt).toBeNull();
    // The refund event has its OWN date, recorded at the moment of the return.
    // Without it the report could only date the refund by the sale, which is
    // what made "an October return reduces October" undeliverable.
    expect(order.refundedAt).not.toBeNull();
    expect(order.paidAt).not.toBeNull();
    expect(new Date(order.refundedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(order.paidAt).getTime(),
    );
    expect(Number(order.cashierUserId)).toBe(cashier.userId);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(5);

    const [payment] = await ctx.dataSource.query(
      `SELECT status FROM payment WHERE "orderId" = $1`,
      [sale.body.data.id],
    );
    expect(payment.status).toBe('refunded');
  });

  // =======================================================================
  // 4. filters return correctly scoped results
  // =======================================================================
  describe('filters', () => {
    async function scenario() {
      const north = await seedBranch(ctx, 'North');
      const south = await seedBranch(ctx, 'South');
      const anna = await loginCashier(ctx, north, { username: 'anna' });
      const bijan = await loginCashier(ctx, north, { username: 'bijan' });
      const cyrus = await loginCashier(ctx, south, { username: 'cyrus' });
      const admin = await loginSuperAdmin(ctx);

      // 2026-09-01 12:00 Tehran == 2026-09-01T08:30Z
      const sept1 = new Date('2026-09-01T08:30:00.000Z');
      // 2026-09-05 12:00 Tehran
      const sept5 = new Date('2026-09-05T08:30:00.000Z');

      await seedSale(ctx.dataSource, {
        soldAt: sept1,
        branchId: north.id,
        branchName: 'North',
        cashierUserId: anna.userId,
        cashierDisplay: 'anna',
        total: 1_000_000,
      });
      await seedSale(ctx.dataSource, {
        soldAt: sept5,
        branchId: north.id,
        branchName: 'North',
        cashierUserId: bijan.userId,
        cashierDisplay: 'bijan',
        total: 2_000_000,
      });
      await seedSale(ctx.dataSource, {
        soldAt: sept5,
        branchId: south.id,
        branchName: 'South',
        cashierUserId: cyrus.userId,
        cashierDisplay: 'cyrus',
        total: 4_000_000,
      });
      await seedSale(ctx.dataSource, {
        soldAt: sept5,
        branchId: north.id,
        branchName: 'North',
        cashierUserId: anna.userId,
        cashierDisplay: 'anna',
        total: 8_000_000,
        channel: OrderChannel.ONLINE,
      });

      return { north, south, anna, bijan, cyrus, admin };
    }

    it('filters by cashier', async () => {
      const { anna, admin } = await scenario();
      const res = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ cashierUserId: anna.userId })
        .expect(200);
      expect(res.body.totals.grossSales).toBe('9000000');
      expect(res.body.totals.orderCount).toBe(2);
    });

    it('filters by inclusive local date range', async () => {
      const { admin } = await scenario();
      const oneDay = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ from: '2026-09-01', to: '2026-09-01' })
        .expect(200);
      expect(oneDay.body.totals.grossSales).toBe('1000000');

      const wholeWeek = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ from: '2026-09-01', to: '2026-09-05' })
        .expect(200);
      expect(wholeWeek.body.totals.grossSales).toBe('15000000');
    });

    it('filters by branch for a super_admin', async () => {
      const { south, admin } = await scenario();
      const res = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ branchId: south.id })
        .expect(200);
      expect(res.body.totals.grossSales).toBe('4000000');
    });

    it('filters by channel and by status', async () => {
      const { admin } = await scenario();
      const pos = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ channel: OrderChannel.POS })
        .expect(200);
      expect(pos.body.totals.grossSales).toBe('7000000');

      const online = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ channel: OrderChannel.ONLINE })
        .expect(200);
      expect(online.body.totals.grossSales).toBe('8000000');
    });

    /**
     * This used to assert that a `sale` user reads their OWN branch's totals
     * and is refused another branch's. Branch-pinning turned out not to be
     * confidentiality: within her own branch anna could still read
     * `by-cashier` and see every colleague's gross and net takings, and the
     * branch's refund and void totals. The owner's rule is that full reporting
     * belongs to the administrator, so the whole controller is now
     * `super_admin` on the `admin` audience alone.
     *
     * 401 RATHER THAN 403, AND THAT IS THE POINT. The controller used to
     * declare `@Audiences('admin', 'pos')`, so a till session reached the
     * handler and was turned away by the role check. It now declares `admin`
     * only, so a POS session is not admitted to the surface at all and
     * `JwtStrategy` refuses before any role is consulted. A cashier cannot get
     * far enough to be forbidden.
     */
    it("refuses a sale user outright, for their own branch as much as anyone else's", async () => {
      const { south, anna } = await scenario();

      for (const request of [
        as(ctx, anna).get('/reports/sales/summary'),
        as(ctx, anna).get('/reports/sales/by-cashier'),
        as(ctx, anna)
          .get('/reports/sales/summary')
          .query({ branchId: south.id }),
      ]) {
        const response = await request;
        expect(response.status).toBe(401);
        expect(JSON.stringify(response.body)).not.toMatch(
          /grossSales|netSales/,
        );
      }
    });

    it('lets an administrator filter by any branch', async () => {
      const { south, admin } = await scenario();
      const res = await as(ctx, admin)
        .get('/reports/sales/summary')
        .query({ branchId: south.id })
        .expect(200);
      expect(res.body.filters.branchId).toBe(south.id);
    });

    it('paginates the sale list', async () => {
      const { admin } = await scenario();
      const page1 = await as(ctx, admin)
        .get('/reports/sales')
        .query({ page: 1, limit: 2 })
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.total).toBe(4);
      expect(page1.body.totalPages).toBe(2);

      const page2 = await as(ctx, admin)
        .get('/reports/sales')
        .query({ page: 2, limit: 2 })
        .expect(200);
      expect(page2.body.data).toHaveLength(2);
      const ids = [...page1.body.data, ...page2.body.data].map(
        (r: any) => r.id,
      );
      expect(new Set(ids).size).toBe(4);
    });
  });

  // =======================================================================
  // Timezone boundary
  // =======================================================================
  it('assigns a sale to the local calendar day, not the UTC day', async () => {
    const branch = await seedBranch(ctx, 'Tehran');
    const cashier = await loginCashier(ctx, branch, { username: 'tz_cashier' });
    const admin = await loginSuperAdmin(ctx);

    // 2026-09-01T20:45Z == 2026-09-02T00:15+03:30 -> belongs to 2 September.
    await seedSale(ctx.dataSource, {
      soldAt: new Date('2026-09-01T20:45:00.000Z'),
      branchId: branch.id,
      branchName: 'Tehran',
      cashierUserId: cashier.userId,
      cashierDisplay: 'tz_cashier',
      total: 5_000_000,
    });
    // 2026-09-01T20:15Z == 2026-09-01T23:45+03:30 -> still 1 September.
    await seedSale(ctx.dataSource, {
      soldAt: new Date('2026-09-01T20:15:00.000Z'),
      branchId: branch.id,
      branchName: 'Tehran',
      cashierUserId: cashier.userId,
      cashierDisplay: 'tz_cashier',
      total: 3_000_000,
    });

    const first = await as(ctx, admin)
      .get('/reports/sales/summary')
      .query({ from: '2026-09-01', to: '2026-09-01' })
      .expect(200);
    expect(first.body.timezone).toBe('Asia/Tehran');
    expect(first.body.range.startUtc).toBe('2026-08-31T20:30:00.000Z');
    expect(first.body.range.endUtc).toBe('2026-09-01T20:30:00.000Z');
    expect(first.body.totals.grossSales).toBe('3000000');

    const second = await as(ctx, admin)
      .get('/reports/sales/summary')
      .query({ from: '2026-09-02', to: '2026-09-02' })
      .expect(200);
    expect(second.body.totals.grossSales).toBe('5000000');
  });

  // =======================================================================
  // 5. totals follow the documented cancellation / refund rules
  // =======================================================================
  it('computes gross, refunded, voided and net exactly as documented', async () => {
    const branch = await seedBranch(ctx, 'Totals');
    const cashier = await loginCashier(ctx, branch, {
      username: 'totals_cashier',
    });
    const admin = await loginSuperAdmin(ctx);
    const day = new Date('2026-10-10T09:00:00.000Z'); // 12:30 Tehran

    const base = {
      branchId: branch.id,
      branchName: 'Totals',
      cashierUserId: cashier.userId,
      cashierDisplay: 'totals_cashier',
    };

    // A plain sale.
    await seedReportingSale(ctx.dataSource, {
      ...base,
      soldAt: day,
      total: 10_000_000,
      quantity: 2,
    });
    // A refunded sale, returned the SAME day: stays in gross, subtracted
    // through refundedTotal because its refund event is in this range too.
    await seedReportingSale(ctx.dataSource, {
      ...base,
      soldAt: day,
      total: 4_000_000,
      quantity: 1,
      status: OrderStatusEnum.REFUNDED,
      refundedAt: day,
    });
    // A voided sale: status CANCELED plus voidedAt, still in gross because the
    // money WAS taken at the till (paidAt), subtracted once through voidedTotal.
    await seedReportingSale(ctx.dataSource, {
      ...base,
      soldAt: day,
      total: 3_000_000,
      quantity: 1,
      status: OrderStatusEnum.CANCELED,
      voidedAt: day,
    });
    // A cancelled sale that was never voided: no money ever moved, so it
    // contributes to nothing but the cancelled count.
    await seedReportingSale(ctx.dataSource, {
      ...base,
      soldAt: day,
      total: 7_000_000,
      quantity: 5,
      status: OrderStatusEnum.CANCELED,
    });
    // A failed online payment: likewise excluded.
    await seedReportingSale(ctx.dataSource, {
      ...base,
      soldAt: day,
      total: 9_000_000,
      quantity: 3,
      status: OrderStatusEnum.FAILED,
      channel: OrderChannel.ONLINE,
    });
    // An online basket the customer abandoned: still PENDING, no money taken.
    // This is the case the old "status NOT IN (canceled, failed)" predicate
    // booked as revenue.
    await seedReportingSale(ctx.dataSource, {
      ...base,
      soldAt: day,
      total: 12_000_000,
      quantity: 6,
      status: OrderStatusEnum.PENDING,
      channel: OrderChannel.ONLINE,
    });

    const res = await as(ctx, admin)
      .get('/reports/sales/summary')
      .query({ from: '2026-10-10', to: '2026-10-10' })
      .expect(200);

    const t = res.body.totals;
    expect(t.grossSales).toBe('17000000'); // 10m + 4m + 3m
    expect(t.refundedTotal).toBe('4000000');
    expect(t.voidedTotal).toBe('3000000');
    expect(t.netSales).toBe('10000000');
    expect(t.unitsSold).toBe(4); // 2 + 1 + 1
    expect(t.unitsRefunded).toBe(1);
    expect(t.unitsVoided).toBe(1);
    expect(t.canceledOrFailedCount).toBe(2);
    expect(t.pendingCount).toBe(1);
    expect(t.nonSaleCount).toBe(3);
    expect(t.salesCount).toBe(3);
    expect(t.orderCount).toBe(6);
    // The counts partition the period exactly; there is nowhere for an order to
    // hide between them.
    expect(t.salesCount + t.nonSaleCount).toBe(t.orderCount);
    expect(t.pendingCount + t.canceledOrFailedCount).toBe(t.nonSaleCount);

    // The response documents itself, and never reports a profit figure.
    expect(res.body.semantics.profit).toMatch(/NOT REPORTED/);
    // The only mention of "profit" anywhere is the note explaining its absence.
    expect(Object.keys(t).filter((k) => /profit|margin|cost/i.test(k))).toEqual(
      [],
    );
  });

  it('groups totals by cashier', async () => {
    const branch = await seedBranch(ctx, 'ByCashier');
    const one = await loginCashier(ctx, branch, { username: 'c_one' });
    const two = await loginCashier(ctx, branch, { username: 'c_two' });
    const admin = await loginSuperAdmin(ctx);
    const day = new Date('2026-10-11T09:00:00.000Z');

    await seedSale(ctx.dataSource, {
      soldAt: day,
      branchId: branch.id,
      branchName: 'ByCashier',
      cashierUserId: one.userId,
      cashierDisplay: 'c_one',
      total: 5_000_000,
    });
    await seedSale(ctx.dataSource, {
      soldAt: day,
      branchId: branch.id,
      branchName: 'ByCashier',
      cashierUserId: two.userId,
      cashierDisplay: 'c_two',
      total: 2_000_000,
    });

    const res = await as(ctx, admin)
      .get('/reports/sales/by-cashier')
      .query({ from: '2026-10-11', to: '2026-10-11' })
      .expect(200);

    /*
     * EVIDENCE FOR THE ONE FAILURE NOBODY CAPTURED.
     *
     * This case failed once in five full runs and passed on every focused run,
     * and the response was gone by the time anyone looked. It is recorded
     * unconditionally — before the assertion, so a failure cannot skip it —
     * together with the two cashier ids the assertion is about and every row
     * the database actually held in the window. `res.body` carries no
     * credential; `redactBody` removes anything secret-shaped regardless.
     * Inert unless KAZHAL_INT_DIAG_FILE is set.
     */
    record('report:by-cashier', {
      status: res.status,
      expectedCashierIds: [one.userId, two.userId],
      body: redactBody(res.body as unknown),
      ordersInDb: await ctx.dataSource.query(
        `SELECT id, "cashierUserId", "cashierDisplaySnapshot", "branchId",
                total_price::text AS total_price, status::text AS status,
                "soldAt", "paidAt", "voidedAt", "refundedAt"
           FROM orders ORDER BY id`,
      ),
      usersInDb: await ctx.dataSource.query(
        `SELECT id, username, "branchId" FROM users ORDER BY id`,
      ),
    });

    expect(res.body.data).toEqual([
      expect.objectContaining({
        cashierUserId: one.userId,
        cashierDisplaySnapshot: 'c_one',
        grossSales: '5000000',
        netSales: '5000000',
      }),
      expect.objectContaining({
        cashierUserId: two.userId,
        cashierDisplaySnapshot: 'c_two',
        grossSales: '2000000',
      }),
    ]);
    // Nobody reversed anything, so the reversal actor breakdown is empty --
    // it is a separate list, never folded into the seller rows.
    expect(res.body.reversalsByActor).toEqual([]);
  });

  // =======================================================================
  // Money events have their OWN dates
  //
  // Everything below exists because every report figure used to range on ONE
  // column, `orders."soldAt"`. That made two things impossible at the same
  // time: the documented rule "an October return of a September sale reduces
  // October", and excluding an ONLINE order that is still PENDING (and whose
  // `soldAt` is stamped at checkout, long before any money arrives).
  // =======================================================================
  describe('event-dated totals', () => {
    // 12:30 Tehran on each day, safely inside the local calendar day.
    const SEPT_SALE = new Date('2026-09-15T09:00:00.000Z');
    const OCT_REVERSAL = new Date('2026-10-20T09:00:00.000Z');

    async function actors(name: string) {
      const branch = await seedBranch(ctx, name);
      const seller = await loginCashier(ctx, branch, {
        username: `${name}_seller`,
      });
      const admin = await loginSuperAdmin(ctx);
      return {
        branch,
        admin,
        base: {
          branchId: branch.id,
          branchName: name,
          cashierUserId: seller.userId,
          cashierDisplay: `${name}_seller`,
        },
        seller,
      };
    }

    const summaryFor = (
      who: { jar: CookieJar },
      from: string,
      to: string,
      extra: Record<string, unknown> = {},
    ) =>
      as(ctx, who)
        .get('/reports/sales/summary')
        .query({ from, to, ...extra })
        .expect(200);

    it('books a September sale in September and its October refund in October', async () => {
      const { admin, base } = await actors('CrossPeriod');

      await seedReportingSale(ctx.dataSource, {
        ...base,
        soldAt: SEPT_SALE,
        paidAt: SEPT_SALE,
        total: 6_000_000,
        quantity: 3,
        status: OrderStatusEnum.REFUNDED,
        refundedAt: OCT_REVERSAL,
      });

      const sept = await summaryFor(admin, '2026-09-01', '2026-09-30');
      // September sold it. September must NOT also absorb the return.
      expect(sept.body.totals.grossSales).toBe('6000000');
      expect(sept.body.totals.salesCount).toBe(1);
      expect(sept.body.totals.unitsSold).toBe(3);
      expect(sept.body.totals.refundedTotal).toBe('0');
      expect(sept.body.totals.refundedCount).toBe(0);
      expect(sept.body.totals.unitsRefunded).toBe(0);
      expect(sept.body.totals.netSales).toBe('6000000');

      const oct = await summaryFor(admin, '2026-10-01', '2026-10-31');
      // October did not sell anything; it only gave money back.
      expect(oct.body.totals.grossSales).toBe('0');
      expect(oct.body.totals.salesCount).toBe(0);
      expect(oct.body.totals.unitsSold).toBe(0);
      expect(oct.body.totals.orderCount).toBe(0);
      expect(oct.body.totals.refundedTotal).toBe('6000000');
      expect(oct.body.totals.refundedCount).toBe(1);
      expect(oct.body.totals.unitsRefunded).toBe(3);
      expect(oct.body.totals.netSales).toBe('-6000000');

      // Spanning both periods counts the sale once and the refund once.
      const both = await summaryFor(admin, '2026-09-01', '2026-10-31');
      expect(both.body.totals.grossSales).toBe('6000000');
      expect(both.body.totals.refundedTotal).toBe('6000000');
      expect(both.body.totals.netSales).toBe('0');
      expect(both.body.totals.orderCount).toBe(1);

      // The block returned verbatim to consumers has to say what the code does.
      expect(sept.body.semantics.refundDate).toMatch(/reduces OCTOBER/);
      expect(sept.body.semantics.refundDate).toMatch(/NOT by the sale date/);

      // And the October list can explain October's refundedTotal: the order is
      // there, flagged as a refund event and explicitly not a sale of October.
      const octList = await as(ctx, admin)
        .get('/reports/sales')
        .query({ from: '2026-10-01', to: '2026-10-31' })
        .expect(200);
      expect(octList.body.total).toBe(1);
      expect(octList.body.data[0]).toEqual(
        expect.objectContaining({
          refundedInRange: true,
          soldInRange: false,
          countsAsSale: true,
        }),
      );
    });

    it('books a September sale in September and its October void in October', async () => {
      const { admin, base } = await actors('CrossVoid');

      await seedReportingSale(ctx.dataSource, {
        ...base,
        soldAt: SEPT_SALE,
        paidAt: SEPT_SALE,
        total: 2_500_000,
        quantity: 5,
        status: OrderStatusEnum.CANCELED,
        voidedAt: OCT_REVERSAL,
      });

      const sept = await summaryFor(admin, '2026-09-01', '2026-09-30');
      expect(sept.body.totals.grossSales).toBe('2500000');
      expect(sept.body.totals.unitsSold).toBe(5);
      expect(sept.body.totals.voidedTotal).toBe('0');
      expect(sept.body.totals.voidedCount).toBe(0);
      expect(sept.body.totals.netSales).toBe('2500000');
      // A voided sale is CANCELED, but it is not a "cancellation" in the
      // money-never-moved sense, so it must not be counted as one.
      expect(sept.body.totals.canceledOrFailedCount).toBe(0);

      const oct = await summaryFor(admin, '2026-10-01', '2026-10-31');
      expect(oct.body.totals.grossSales).toBe('0');
      expect(oct.body.totals.voidedTotal).toBe('2500000');
      expect(oct.body.totals.voidedCount).toBe(1);
      expect(oct.body.totals.unitsVoided).toBe(5);
      expect(oct.body.totals.netSales).toBe('-2500000');
    });

    it('voiding an order nobody ever paid for moves no money in either direction', async () => {
      const { admin, base } = await actors('VoidUnpaid');

      // An online basket voided while still PENDING: `voidedAt` is set and the
      // status becomes CANCELED, exactly like a voided till sale. The
      // difference that matters is `paidAt` -- no money was ever taken, so
      // re-including it in gross (and then subtracting it) would invent a sale
      // and a reversal that never happened.
      await seedReportingSale(ctx.dataSource, {
        ...base,
        soldAt: SEPT_SALE,
        paidAt: null,
        total: 8_000_000,
        quantity: 4,
        status: OrderStatusEnum.CANCELED,
        channel: OrderChannel.ONLINE,
        voidedAt: SEPT_SALE,
      });

      const sept = await summaryFor(admin, '2026-09-01', '2026-09-30');
      expect(sept.body.totals.grossSales).toBe('0');
      expect(sept.body.totals.voidedTotal).toBe('0');
      expect(sept.body.totals.unitsSold).toBe(0);
      expect(sept.body.totals.netSales).toBe('0');
      expect(sept.body.totals.orderCount).toBe(1);
      expect(sept.body.totals.nonSaleCount).toBe(1);
    });

    it('excludes a PENDING online order from every sale figure, and shows it only as a non-sale', async () => {
      const { admin, base } = await actors('Pending');

      await seedReportingSale(ctx.dataSource, {
        ...base,
        soldAt: SEPT_SALE,
        total: 5_000_000,
        quantity: 2,
        status: OrderStatusEnum.PENDING,
        channel: OrderChannel.ONLINE,
        paidAt: null,
      });

      const res = await summaryFor(admin, '2026-09-15', '2026-09-15');
      const t = res.body.totals;
      expect(t.grossSales).toBe('0');
      expect(t.salesCount).toBe(0);
      expect(t.unitsSold).toBe(0);
      expect(t.netSales).toBe('0');
      // Visible, but only as a non-sale.
      expect(t.orderCount).toBe(1);
      expect(t.pendingCount).toBe(1);
      expect(t.nonSaleCount).toBe(1);
      expect(t.canceledOrFailedCount).toBe(0);
    });

    it('includes the same online order once payment is confirmed, dated by the payment', async () => {
      const { admin, base } = await actors('Confirm');

      const order = await seedReportingSale(ctx.dataSource, {
        ...base,
        soldAt: SEPT_SALE,
        total: 5_000_000,
        quantity: 2,
        status: OrderStatusEnum.PENDING,
        channel: OrderChannel.ONLINE,
        paidAt: null,
      });

      // The gateway confirms. Same statement shape PaymentService runs, so the
      // payment instant is stamped by the database, not by a fixture.
      await confirmOnlinePayment(ctx.dataSource, order.id);
      const stamped = await moneyEventsOf(ctx.dataSource, order.id);
      expect(stamped.status).toBe(OrderStatusEnum.PAID);
      expect(stamped.paidAt).not.toBeNull();

      // Now pin it to a known calendar day so the range assertion is exact.
      await confirmOnlinePayment(ctx.dataSource, order.id, OCT_REVERSAL);

      const res = await summaryFor(admin, '2026-10-20', '2026-10-20');
      expect(res.body.totals.grossSales).toBe('5000000');
      expect(res.body.totals.salesCount).toBe(1);
      expect(res.body.totals.unitsSold).toBe(2);
      expect(res.body.totals.pendingCount).toBe(0);

      // ...and it is NOT revenue on the day the basket was checked out, which
      // is the day `soldAt` records and the day the old code used.
      const checkoutDay = await summaryFor(admin, '2026-09-15', '2026-09-15');
      expect(checkoutDay.body.totals.grossSales).toBe('0');
      expect(checkoutDay.body.totals.orderCount).toBe(0);
    });

    it('keeps the sale on the original seller when a different user reverses it', async () => {
      const branch = await seedBranch(ctx, 'Reversal');
      const seller = await loginCashier(ctx, branch, { username: 'r_seller' });
      const supervisor = await loginSuperAdmin(ctx, {
        username: 'r_supervisor',
      });
      const admin = await loginSuperAdmin(ctx);
      const toVoid = await seedVariant(ctx, { price: 400_000, stock: 10 });
      const toReturn = await seedVariant(ctx, { price: 300_000, stock: 10 });

      const voided = await as(ctx, seller)
        .post('/orders/pos')
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: toVoid.id, quantity: 2 }],
        })
        .expect(201);
      const returned = await as(ctx, seller)
        .post('/orders/pos')
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: toReturn.id, quantity: 1 }],
        })
        .expect(201);

      // Someone ELSE processes both reversals.
      await as(ctx, supervisor)
        .post(`/orders/${voided.body.data.id}/void`)
        .send({ reason: 'wrong item' })
        .expect(200);
      await as(ctx, supervisor)
        .post(`/orders/${returned.body.data.id}/return`)
        .send({ reason: 'faulty' })
        .expect(200);

      const res = await as(ctx, admin)
        .get('/reports/sales/by-cashier')
        .expect(200);

      // ONE seller row, and it is the seller's -- the supervisor never sold
      // anything, so re-attributing the reversal to them would invent a
      // negative salesperson out of thin air.
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          cashierUserId: seller.userId,
          cashierDisplaySnapshot: 'r_seller',
          grossSales: '1100000', // 800_000 voided + 300_000 returned
          voidedTotal: '800000',
          refundedTotal: '300000',
          netSales: '0',
        }),
      );

      // "Who reversed it" is answered separately, from order_actions.
      expect(res.body.reversalsByActor).toEqual([
        expect.objectContaining({
          actorUserId: supervisor.userId,
          actorDisplaySnapshot: 'r_supervisor',
          reversalCount: 2,
          voidCount: 1,
          refundCount: 1,
          voidedTotal: '800000',
          refundedTotal: '300000',
        }),
      ]);

      // The sale detail says both things at once and never confuses them.
      const detail = await as(ctx, admin)
        .get(`/reports/sales/${voided.body.data.id}`)
        .expect(200);
      expect(detail.body.data.seller.cashierUserId).toBe(seller.userId);
      expect(detail.body.data.reversedBy).toEqual(
        expect.objectContaining({
          action: 'void',
          actorUserId: supervisor.userId,
        }),
      );
    });

    it('agrees between the money figures, the counts and the row list', async () => {
      const { admin, base } = await actors('NoDrift');
      const day = '2026-09-15';

      const rows = [
        { total: 1_000_000, quantity: 1, status: OrderStatusEnum.PAID },
        { total: 2_000_000, quantity: 2, status: OrderStatusEnum.DELIVERED },
        { total: 4_000_000, quantity: 4, status: OrderStatusEnum.SHIPPED },
        {
          total: 8_000_000,
          quantity: 8,
          status: OrderStatusEnum.REFUNDED,
          refundedAt: SEPT_SALE,
        },
        {
          total: 16_000_000,
          quantity: 16,
          status: OrderStatusEnum.CANCELED,
          voidedAt: SEPT_SALE,
        },
        { total: 32_000_000, quantity: 32, status: OrderStatusEnum.CANCELED },
        { total: 64_000_000, quantity: 64, status: OrderStatusEnum.PENDING },
      ];
      for (const row of rows) {
        await seedReportingSale(ctx.dataSource, {
          ...base,
          soldAt: SEPT_SALE,
          ...row,
        });
      }
      // An eligible sale with NO line items at all: it must score 0 units
      // rather than dropping out of the count, which is what an inner join on
      // order_items would have done.
      await ctx.dataSource.query(
        `INSERT INTO orders (channel, status, "fulfillmentState", "paymentMethod",
                             "branchId", "branchNameSnapshot", "cashierUserId",
                             "cashierDisplaySnapshot", subtotal, total_price,
                             "soldAt", "paidAt")
         VALUES ('pos', 'paid', 'fulfilled', 'cash', $1, $2, $3, $4, 500000, 500000, $5, $5)`,
        [
          base.branchId,
          base.branchName,
          base.cashierUserId,
          base.cashierDisplay,
          SEPT_SALE,
        ],
      );

      const summary = await summaryFor(admin, day, day);
      const t = summary.body.totals;

      // 1m + 2m + 4m + 8m (refunded) + 16m (voided) + 0.5m (no items)
      expect(t.grossSales).toBe('31500000');
      expect(t.salesCount).toBe(6);
      expect(t.unitsSold).toBe(31); // 1 + 2 + 4 + 8 + 16 + 0
      expect(t.nonSaleCount).toBe(2); // plain canceled + pending
      expect(t.orderCount).toBe(8);

      const list = await as(ctx, admin)
        .get('/reports/sales')
        .query({ from: day, to: day, limit: 200 })
        .expect(200);

      // Recomputing the money from the ROWS must reproduce the aggregate
      // exactly. The counts and the totals are built from one shared predicate
      // precisely so that this can never disagree.
      /*
       * TYPED, NOT `any[]`.
       *
       * `total_price` is now a decimal integer STRING, and the whole point of
       * these assertions is that it stays one. Reading the rows through `any`
       * would let a future change hand `sumMoney` numbers again without the
       * compiler saying a word — which is exactly the regression this block
       * exists to catch.
       */
      const listRows = list.body.data as ReportRow[];
      const sales = listRows.filter((r) => r.countsAsSale && r.soldInRange);
      expect(sales).toHaveLength(t.salesCount);
      // MONEY IS SUMMED IN BigInt, NOT WITH `+`.
      // `total_price` is now a decimal integer STRING, so `reduce((s, r) => s +
      // r.total_price, 0)` would concatenate ("0" + "5000000" + ...) and the
      // assertion would fail for a reason that has nothing to do with the
      // report. `unitCount` is still an integer and still adds with `+`.
      expect(sumMoney(sales)).toBe(t.grossSales);
      expect(sales.reduce((sum, r) => sum + r.unitCount, 0)).toBe(t.unitsSold);

      const refunds = listRows.filter((r) => r.refundedInRange);
      expect(refunds).toHaveLength(t.refundedCount);
      expect(sumMoney(refunds)).toBe(t.refundedTotal);

      const voids = listRows.filter((r) => r.voidedInRange);
      expect(voids).toHaveLength(t.voidedCount);
      expect(sumMoney(voids)).toBe(t.voidedTotal);

      // The per-cashier breakdown is the same set again, sliced by seller.
      const byCashier = await as(ctx, admin)
        .get('/reports/sales/by-cashier')
        .query({ from: day, to: day })
        .expect(200);
      expect(byCashier.body.data[0]).toEqual(
        expect.objectContaining({
          grossSales: t.grossSales,
          unitsSold: t.unitsSold,
          salesCount: t.salesCount,
          refundedTotal: t.refundedTotal,
          voidedTotal: t.voidedTotal,
        }),
      );
    });

    it('reports a refund whose event date was never recorded instead of dating it from the sale', async () => {
      const { admin, base } = await actors('UnknownDate');

      // Migration 0009 leaves `refundedAt` NULL when there is no audit row to
      // recover it from. Dating it from `soldAt` is exactly the bug being
      // fixed, so the money is surfaced as a data-quality figure instead.
      await seedReportingSale(ctx.dataSource, {
        ...base,
        soldAt: SEPT_SALE,
        total: 9_000_000,
        quantity: 1,
        status: OrderStatusEnum.REFUNDED,
        refundedAt: null,
      });

      const sept = await summaryFor(admin, '2026-09-01', '2026-09-30');
      expect(sept.body.totals.grossSales).toBe('9000000');
      expect(sept.body.totals.refundedTotal).toBe('0');
      expect(sept.body.dataQuality.refundsWithUnknownEventDate).toEqual(
        expect.objectContaining({ count: 1, total: '9000000' }),
      );

      // An all-time query needs no date to place it, so it is counted there.
      const allTime = await as(ctx, admin)
        .get('/reports/sales/summary')
        .expect(200);
      expect(allTime.body.totals.refundedTotal).toBe('9000000');
      expect(allTime.body.totals.netSales).toBe('0');
    });
  });

  /**
   * Reporting is closed to cashiers, but a cashier must still be able to
   * reprint the slip for the sale they just rang up — that is what
   * `GET /orders/:id` is for, and it is where the branch guarantee now lives.
   * The reporting route is shut to both of them.
   */
  it('gives a cashier their own sale through the orders route, never the reporting one', async () => {
    const north = await seedBranch(ctx, 'DetailNorth');
    const south = await seedBranch(ctx, 'DetailSouth');
    const northCashier = await loginCashier(ctx, north, {
      username: 'd_north',
    });
    const southCashier = await loginCashier(ctx, south, {
      username: 'd_south',
    });
    const variant = await seedVariant(ctx, { price: 100_000, stock: 3 });

    const sale = await as(ctx, southCashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    // The REPORTING route is shut to every cashier, including the seller —
    // at the AUDIENCE layer, so a till session never reaches the handler.
    await as(ctx, northCashier)
      .get(`/reports/sales/${sale.body.data.id}`)
      .expect(401);
    await as(ctx, southCashier)
      .get(`/reports/sales/${sale.body.data.id}`)
      .expect(401);

    // The seller still gets their own slip, with the attribution on it.
    const own = await as(ctx, southCashier)
      .get(`/orders/${sale.body.data.id}`)
      .expect(200);
    expect(own.body.data.cashierUserId).toBe(southCashier.userId);
    expect(own.body.data.branchId).toBe(south.id);

    // And branch scoping still keeps it out of the other branch's hands.
    const foreign = await as(ctx, northCashier).get(
      `/orders/${sale.body.data.id}`,
    );
    expect([403, 404]).toContain(foreign.status);
  });

  it('records passwordChangedAt when a password is changed', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch, { username: 'pw_user' });
    const admin = await loginSuperAdmin(ctx);

    await as(ctx, admin)
      .patch(`/users/${cashier.userId}`)
      .send({ password: 'BrandNewPassw0rd!' })
      .expect(200);

    const [row] = await ctx.dataSource.query(
      `SELECT "passwordChangedAt" FROM users WHERE id = $1`,
      [cashier.userId],
    );
    expect(row.passwordChangedAt).not.toBeNull();

    // Sanity: the new password really is in force.
    await expect(
      authenticate(ctx, cashier.username, 'BrandNewPassw0rd!'),
    ).resolves.toBeDefined();
  });
});
