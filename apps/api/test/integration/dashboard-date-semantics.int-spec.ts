/**
 * ===========================================================================
 * THE DASHBOARD'S FOUR EVENT DATES
 * ===========================================================================
 *
 * `/admin/dashboard/summary` used to publish a single `totals.orderCount`,
 * rendered as «تعداد سفارش امروز» — "today's order count". It was
 * `COUNT(*) FILTER (WHERE in_revenue_period)`: orders whose REVENUE DATE
 * (`COALESCE("paidAt","soldAt")`) fell today, whatever their status. Three
 * unrelated things therefore moved the same number —
 *
 *   - a sale paid today (revenue),
 *   - an order checked out today and still PENDING, placed by `soldAt`, which
 *     is stamped at CHECKOUT and is not revenue at all,
 *   - nothing whatsoever for an order created today and paid tomorrow,
 *
 * — and a store manager could not tell which. The endpoint now reports the
 * axes separately and names each field after the timestamp that places it.
 *
 * These cases are the ones that can only be argued against a real PostgreSQL:
 * every boundary is `AT TIME ZONE` arithmetic in SQL, `orders.created_at` is a
 * NAIVE timestamp while the money columns are `timestamptz`, and the money is
 * `bigint` that must survive as a string.
 *
 * HOW "DAY A" AND "DAY B" ARE STAGED. The endpoint always reports TODAY, so a
 * cross-day case is staged by placing one event on a neighbouring Tehran day
 * and asserting BOTH directions in the same response: an order created
 * yesterday and paid today proves "revenue lands on the payment day", and an
 * order created today and paid tomorrow proves "the created count lands on the
 * creation day". No clock is mocked and no day boundary is computed in Node.
 *
 * ---------------------------------------------------------------------------
 * THE DAY IS NOW REPORTED BY TWO ROUTES, NOT ONE
 *
 * `/admin/dashboard/summary` used to carry the counts AND the money behind the
 * single delegatable capability `dashboard.read`. The owner's rule is that
 * financial figures belong to the main administrator alone, so the money moved
 * to `/admin/dashboard/financial` behind `@Roles(super_admin)`, and the summary
 * now carries counts, queues and stock only.
 *
 * EVERY CASE BELOW THAT READS A MONEY FIGURE THEREFORE READS THE FINANCIAL
 * ROUTE. The cases that assert a count AND a money figure about the same day
 * fetch BOTH and, via {@link businessDay}, assert the two responses agree on
 * `period` and `timezone` first. That is STRICTER than what these cases claimed
 * when one payload carried both: a single response could not disagree with
 * itself about which day it described, whereas two independently computed
 * responses can — if `financialSummary()` ever stopped sharing the summary's
 * `businessDay()` (a second `now()`, a hard-coded zone, a cached bound), the
 * counts and the money would silently describe different days and every
 * count-versus-money argument in this file would become meaningless. The
 * `period` equality is what makes "the same business day" an assertion rather
 * than an assumption.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import { as, loginSuperAdmin } from './support/pos.fixtures';
import { authenticate, withCookies } from './setup/test-app';
import { createUser } from './setup/seed-helpers';
import { fixtureRoleName } from './setup/fixture-ids';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';

const TEHRAN = 'Asia/Tehran';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * Today's Tehran calendar day and its half-open UTC bounds, computed by
 * PostgreSQL with exactly the expression the service uses.
 *
 * Deliberately NOT computed in Node: the point of the assertions below is that
 * the boundary is the database's, so a test that derived it from the Node
 * process's clock could agree with a broken service for the wrong reason.
 */
interface Day {
  date: string;
  startUtc: Date;
  endUtc: Date;
}

async function tehranToday(ctx: TestApp): Promise<Day> {
  const [row] = await ctx.dataSource.query<
    Array<{ day: string; start_utc: Date; end_utc: Date }>
  >(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
            (CAST((now() AT TIME ZONE $1)::date AS timestamp) AT TIME ZONE $1) AS start_utc,
            (CAST((now() AT TIME ZONE $1)::date + INTERVAL '1 day' AS timestamp) AT TIME ZONE $1) AS end_utc`,
    [TEHRAN],
  );
  return { date: row.day, startUtc: row.start_utc, endUtc: row.end_utc };
}

/** An instant `hours` after the start of today's Tehran day. May be negative. */
function tehranOffset(day: Day, hours: number): Date {
  return new Date(day.startUtc.getTime() + hours * HOUR);
}

interface SeedOrder {
  status: OrderStatusEnum;
  /** Integer Rial as a STRING. Never a JS number: these are bigint columns. */
  total: string;
  createdAt: Date;
  soldAt: Date | null;
  paidAt: Date | null;
  voidedAt?: Date | null;
  refundedAt?: Date | null;
  channel?: OrderChannel;
  quantity?: number;
}

/**
 * Plants one order with EVERY event column stated explicitly.
 *
 * TWO THINGS THAT WOULD OTHERWISE GO WRONG SILENTLY:
 *
 * 1. `created_at` is a naive `TIMESTAMP`. Handing node-postgres a JS `Date`
 *    for it writes the Node process's LOCAL wall clock, not UTC, so the test
 *    would pass or fail depending on the developer's `TZ`. It is written as
 *    `$n::timestamptz AT TIME ZONE 'UTC'` instead — the exact inverse of the
 *    `(created_at AT TIME ZONE 'UTC')` the service reads it back with.
 * 2. Migration 0009 installs a BEFORE INSERT trigger that invents `paidAt` for
 *    a row inserted already PAID. Every case here supplies `paidAt` itself
 *    (possibly NULL), which is exactly the condition that leaves the trigger
 *    alone.
 */
async function seedOrder(ctx: TestApp, input: SeedOrder): Promise<number> {
  const iso = (value: Date | null | undefined): string | null =>
    value ? value.toISOString() : null;

  const [row] = await ctx.dataSource.query<Array<{ id: number }>>(
    `INSERT INTO orders
       (channel, status, "fulfillmentState", total_price, subtotal,
        created_at, "soldAt", "paidAt", "voidedAt", "refundedAt")
     VALUES ($1, $2, $3, $4::bigint, $4::bigint,
             ($5::timestamptz AT TIME ZONE 'UTC'),
             $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::timestamptz)
     RETURNING id`,
    [
      input.channel ?? OrderChannel.POS,
      input.status,
      input.status === OrderStatusEnum.PAID ? 'fulfilled' : 'pending',
      input.total,
      iso(input.createdAt),
      iso(input.soldAt),
      iso(input.paidAt),
      iso(input.voidedAt),
      iso(input.refundedAt),
    ],
  );

  await ctx.dataSource.query(
    `INSERT INTO order_items
       ("orderId", quantity, unit_price, total_price,
        "productTitleSnapshot", "variantSkuSnapshot")
     VALUES ($1, $2, $3::bigint, $3::bigint, 'Seeded product', 'SEED-SKU')`,
    [row.id, input.quantity ?? 1, input.total],
  );

  return Number(row.id);
}

describe('Dashboard date semantics (int)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof loginSuperAdmin>>;
  let today: Day;

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    admin = await loginSuperAdmin(ctx);
    today = await tehranToday(ctx);
  });

  /** The OPERATIONAL half: counts, queues and stock. Carries no money. */
  async function dashboard() {
    const response = await as(ctx, admin).get('/admin/dashboard/summary');
    expect(response.status).toBe(200);
    return response.body.data;
  }

  /**
   * The FINANCIAL half: today's gross, refunds, voids, net and the breakdowns.
   *
   * `admin` here is a `super_admin` on an `admin`-audience session, which is
   * the only principal this route serves — see the authorisation cases at the
   * end of this file, which pin that a delegated `dashboard.read` holder is
   * refused it.
   */
  async function financial() {
    const response = await as(ctx, admin).get('/admin/dashboard/financial');
    expect(response.status).toBe(200);
    return response.body.data;
  }

  /**
   * BOTH halves of one business day, with the agreement asserted rather than
   * assumed.
   *
   * The counts and the money used to arrive in a single payload, so "these
   * figures describe the same day" was structurally true and needed no
   * assertion. Split across two routes it is no longer structural: each route
   * resolves the day itself. The `period`/`timezone` equality below is the
   * check that they still resolve it from the SAME `businessDay()` — without
   * it, a case like "created yesterday, paid today" could pass while the two
   * responses were talking about different days.
   */
  async function businessDay() {
    const operational = await dashboard();
    const money = await financial();

    expect(money.period).toEqual(operational.period);
    expect(money.timezone).toBe(operational.timezone);

    return {
      period: operational.period,
      /** Counts only — `/admin/dashboard/summary`. */
      totals: operational.totals,
      /** Integer-Rial strings — `/admin/dashboard/financial`. */
      money: money.money,
      pipeline: operational.pipeline,
      byChannel: money.byChannel,
      byBranch: money.byBranch,
      topVariants: money.topVariants,
    };
  }

  async function report(day: string) {
    const response = await as(ctx, admin).get(
      `/reports/sales/summary?from=${day}&to=${day}`,
    );
    expect(response.status).toBe(200);
    return response.body;
  }

  // =======================================================================
  // 1. created on day A, paid on day B
  // =======================================================================
  it('counts an order on the day it was CREATED and its money on the day it was PAID', async () => {
    // Checked out yesterday at midday Tehran, gateway confirmed today at
    // midday Tehran. Revenue belongs to TODAY; the order does not.
    const paidToday = await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '500000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, -12),
      soldAt: tehranOffset(today, -12),
      paidAt: tehranOffset(today, 12),
    });

    // The mirror image: created today, gateway confirms tomorrow. The ORDER
    // belongs to today; the money does not. This is the case the old
    // `orderCount` missed entirely — it reported neither the order nor the
    // money, because it was ranged on the revenue date.
    const paidTomorrow = await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '700000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, 12),
      soldAt: tehranOffset(today, 12),
      paidAt: tehranOffset(today, 36),
    });

    expect(paidToday).toBeGreaterThan(0);
    expect(paidTomorrow).toBeGreaterThan(0);

    // The whole claim of this case is "the COUNT lands on one day and the
    // MONEY on another", and those two figures now live on two routes. Reading
    // only the summary would leave the money half unasserted; `businessDay()`
    // fetches both and first proves they are arguing about the same day.
    const { totals, money } = await businessDay();

    // Created-at axis: only the one whose ROW was written today.
    expect(totals.ordersCreated).toBe(1);
    expect(totals.ordersCreatedPaid).toBe(1);
    expect(totals.ordersCreatedPending).toBe(0);
    expect(totals.ordersCreatedFailedOrCanceled).toBe(0);

    // Revenue axis: only the one whose MONEY arrived today. The count side of
    // this axis stays on the summary; the Rial figures moved to the financial
    // route, and asserting them together is what pins that the split did not
    // put the count and the money on different days.
    expect(totals.salesCount).toBe(1);
    expect(money.grossSales).toBe('500000');
    expect(money.netSales).toBe('500000');
    expect(totals.unitsSold).toBe(1);

    // And the two axes are genuinely different orders — the counts happen to
    // be equal here, the money proves they are not the same row.
    expect(totals.ordersByRevenueDate).toBe(1);
  });

  // =======================================================================
  // 2. created on day A, failed later — never revenue
  // =======================================================================
  it('reports a failed order on the day it was created and never as revenue', async () => {
    // Created yesterday, payment never completed. There is NO failure
    // timestamp in this schema — `orders` has `paidAt`, `refundedAt` and
    // `voidedAt` and nothing for a failure — so the only honest axis for a
    // failed order is the day its row was written. It must not surface today.
    await seedOrder(ctx, {
      status: OrderStatusEnum.FAILED,
      total: '900000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, -12),
      soldAt: tehranOffset(today, -12),
      paidAt: null,
    });

    // Created today, failed today.
    await seedOrder(ctx, {
      status: OrderStatusEnum.FAILED,
      total: '300000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, 9),
      soldAt: tehranOffset(today, 9),
      paidAt: null,
    });

    // Created today, cancelled today with nothing ever paid.
    await seedOrder(ctx, {
      status: OrderStatusEnum.CANCELED,
      total: '400000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, 10),
      soldAt: tehranOffset(today, 10),
      paidAt: null,
    });

    // "Never as revenue" is a claim about the money route as much as about the
    // counts, so both halves of the day are read — a failure that moved a
    // failed order into gross would now be caught on the route that actually
    // publishes gross.
    const { totals, money } = await businessDay();

    expect(totals.ordersCreated).toBe(2);
    expect(totals.ordersCreatedFailedOrCanceled).toBe(2);
    expect(totals.ordersCreatedPaid).toBe(0);

    // Not one Rial of any of the three, on any axis.
    expect(totals.salesCount).toBe(0);
    expect(money.grossSales).toBe('0');
    expect(money.netSales).toBe('0');
    expect(totals.unitsSold).toBe(0);
    expect(money.refundedTotal).toBe('0');
    expect(money.voidedTotal).toBe('0');

    // Yesterday's failure is not attributed to today by ANY axis; today's two
    // are, but only as non-sales placed by `soldAt` on the revenue axis.
    expect(totals.canceledOrFailedByRevenueDate).toBe(2);
    expect(totals.nonSaleCount).toBe(2);
  });

  // =======================================================================
  // 3. sold on day A, voided on day B
  // =======================================================================
  it('subtracts a void from the day it was VOIDED, not the day it was sold', async () => {
    // Rung up yesterday, voided today. Its gross belongs to yesterday; the
    // reversal belongs to today.
    await seedOrder(ctx, {
      status: OrderStatusEnum.CANCELED,
      total: '1000000',
      createdAt: tehranOffset(today, -12),
      soldAt: tehranOffset(today, -12),
      paidAt: tehranOffset(today, -12),
      voidedAt: tehranOffset(today, 11),
    });

    // Rung up today, voided tomorrow. Its gross belongs to today; the reversal
    // does not, so today must still show the full sale.
    await seedOrder(ctx, {
      status: OrderStatusEnum.CANCELED,
      total: '250000',
      createdAt: tehranOffset(today, 13),
      soldAt: tehranOffset(today, 13),
      paidAt: tehranOffset(today, 13),
      voidedAt: tehranOffset(today, 37),
    });

    // The count of voids is operational (how many reversals happened) and the
    // value of them is financial. They are on two routes now, and the pairing
    // `voidedCount: 1` / `voidedTotal: "1000000"` only means something if both
    // describe the same day — which `businessDay()` checks before returning.
    const { totals, money } = await businessDay();

    // Today's gross is the sale rung up today — a void of a LATER day does not
    // reach back and erase it.
    expect(totals.salesCount).toBe(1);
    expect(money.grossSales).toBe('250000');

    // Today's void is yesterday's sale.
    expect(totals.voidedCount).toBe(1);
    expect(money.voidedTotal).toBe('1000000');
    expect(totals.unitsVoided).toBe(1);

    // 250000 - 0 - 1000000. Net sales can be negative on a day of reversals,
    // and that is the truthful answer rather than a clamped zero.
    expect(money.netSales).toBe('-750000');

    // A voided sale is NOT a cancellation: the money really did cross the
    // counter, so it must never appear in the "failed or cancelled" count.
    expect(totals.ordersCreated).toBe(1);
    expect(totals.ordersCreatedFailedOrCanceled).toBe(0);
    expect(totals.ordersCreatedPaid).toBe(1);
  });

  // =======================================================================
  // 4. sold on day A, refunded on day B
  // =======================================================================
  it('subtracts a refund from the day it was REFUNDED, not the day it was sold', async () => {
    await seedOrder(ctx, {
      status: OrderStatusEnum.REFUNDED,
      total: '1200000',
      quantity: 3,
      createdAt: tehranOffset(today, -12),
      soldAt: tehranOffset(today, -12),
      paidAt: tehranOffset(today, -12),
      refundedAt: tehranOffset(today, 14),
    });

    // Sold today, refunded tomorrow: today shows the sale at full value.
    await seedOrder(ctx, {
      status: OrderStatusEnum.REFUNDED,
      total: '600000',
      quantity: 2,
      createdAt: tehranOffset(today, 15),
      soldAt: tehranOffset(today, 15),
      paidAt: tehranOffset(today, 15),
      refundedAt: tehranOffset(today, 39),
    });

    // Same reason as the void case: `refundedCount` and `unitsRefunded` stayed
    // on the operational route, `refundedTotal` went to the financial one, and
    // the assertion is only worth making about ONE day.
    const { totals, money } = await businessDay();

    // REFUNDED is an eligible sale status: the money WAS taken, and the return
    // is subtracted separately rather than silently cancelling the sale.
    expect(totals.salesCount).toBe(1);
    expect(money.grossSales).toBe('600000');
    expect(totals.unitsSold).toBe(2);

    expect(totals.refundedCount).toBe(1);
    expect(money.refundedTotal).toBe('1200000');
    expect(totals.unitsRefunded).toBe(3);

    expect(money.netSales).toBe('-600000');

    // Yesterday's sale is not in today's created count, and today's refund
    // does not put it there.
    expect(totals.ordersCreated).toBe(1);
    expect(totals.ordersCreatedPaid).toBe(1);
  });

  // =======================================================================
  // 5. the dashboard and the sales report cannot disagree
  // =======================================================================
  it('agrees with /reports/sales/summary for the same day, field by field', async () => {
    // A deliberately awkward mix: revenue today, revenue attributed elsewhere,
    // a reversal of an earlier day, a basket, and a failure.
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '500000',
      quantity: 2,
      createdAt: tehranOffset(today, 8),
      soldAt: tehranOffset(today, 8),
      paidAt: tehranOffset(today, 8),
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.DELIVERED,
      total: '330000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, -12),
      soldAt: tehranOffset(today, -12),
      paidAt: tehranOffset(today, 9),
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.REFUNDED,
      total: '120000',
      createdAt: tehranOffset(today, -36),
      soldAt: tehranOffset(today, -36),
      paidAt: tehranOffset(today, -36),
      refundedAt: tehranOffset(today, 10),
    });
    // Rung up today and voided today: it is in gross AND in voidedTotal, so
    // net is reduced without the reversal disappearing from view.
    await seedOrder(ctx, {
      status: OrderStatusEnum.CANCELED,
      total: '75000',
      createdAt: tehranOffset(today, 11),
      soldAt: tehranOffset(today, 11),
      paidAt: tehranOffset(today, 11),
      voidedAt: tehranOffset(today, 11.5),
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.PENDING,
      total: '999',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, 12),
      soldAt: tehranOffset(today, 12),
      paidAt: null,
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.FAILED,
      total: '888',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, 13),
      soldAt: tehranOffset(today, 13),
      paidAt: null,
    });

    // THREE responses now describe this one day: the operational counts, the
    // financial figures, and the sales report. `businessDay()` reconciles the
    // first two on `period` before either is read.
    const { period, totals: actual, money } = await businessDay();
    expect(period.date).toBe(today.date);
    expect(period.startUtc).toBe(today.startUtc.toISOString());
    expect(period.endUtc).toBe(today.endUtc.toISOString());

    const { totals: expected } = await report(String(period.date));

    // IDENTICAL STRINGS FOR IDENTICAL CONCEPTS.
    //
    // Both endpoints now return every money figure as a base-10 integer
    // string, and both compute `netSales` with the SAME `subtractRial` helper.
    // This block used to wrap the report side in `String(...)` because the
    // report returned JS numbers — which meant the two screens agreed only up
    // to whatever `Number` had already done to the report's value. `toBe` on
    // the raw values is now the stronger assertion: it fails if either side
    // changes type as well as if either changes value.
    //
    // The COUNTS are compared against `/admin/dashboard/summary` and the MONEY
    // against `/admin/dashboard/financial`: the report's single `totals` block
    // is now reconciled against two dashboard routes rather than one, which is
    // what the split made necessary and is also a tighter claim — it says the
    // report agrees with BOTH halves, not merely with a combined payload.
    expect(actual.ordersByRevenueDate).toBe(expected.orderCount);
    expect(actual.salesCount).toBe(expected.salesCount);
    expect(actual.nonSaleCount).toBe(expected.nonSaleCount);
    expect(actual.pendingByRevenueDate).toBe(expected.pendingCount);
    expect(actual.canceledOrFailedByRevenueDate).toBe(
      expected.canceledOrFailedCount,
    );
    expect(actual.unitsSold).toBe(expected.unitsSold);
    expect(actual.refundedCount).toBe(expected.refundedCount);
    expect(actual.unitsRefunded).toBe(expected.unitsRefunded);
    expect(actual.voidedCount).toBe(expected.voidedCount);
    expect(actual.unitsVoided).toBe(expected.unitsVoided);
    expect(money.grossSales).toBe(expected.grossSales);
    expect(money.refundedTotal).toBe(expected.refundedTotal);
    expect(money.voidedTotal).toBe(expected.voidedTotal);
    expect(money.netSales).toBe(expected.netSales);

    // Pin the actual figures, so a change that moves BOTH endpoints in the
    // same wrong direction still fails here.
    expect(actual.salesCount).toBe(3); // paid + delivered + the voided sale
    expect(money.grossSales).toBe('905000'); // 500000 + 330000 + 75000
    expect(money.refundedTotal).toBe('120000');
    expect(money.voidedTotal).toBe('75000');
    expect(money.netSales).toBe('710000');
    expect(actual.ordersByRevenueDate).toBe(5);
    expect(actual.unitsSold).toBe(4); // 2 + 1 + 1

    // The figure the report does NOT have, and the reason this task existed.
    // FIVE orders are attributed to today by revenue date and FOUR rows were
    // written today, and they are not the same four: the delivered order was
    // created yesterday, the pending basket and the failure are today's rows
    // but no money, and the refund of a two-day-old sale is in neither count.
    expect(actual.ordersCreated).toBe(4);
    expect(actual.ordersCreatedPaid).toBe(2); // the POS sale and the voided one
    expect(actual.ordersCreatedPending).toBe(1);
    expect(actual.ordersCreatedFailedOrCanceled).toBe(1);
  });

  // =======================================================================
  // 6. money is a string, and it is exact
  // =======================================================================
  it('returns money as exact strings, past the point a float would round', async () => {
    // 2^53 + 1 — the first integer a JavaScript `number` cannot represent.
    // `Number(9007199254740993)` is 9007199254740992, so any pipeline that
    // parsed this figure anywhere would return the wrong Rial amount.
    const beyondFloat = '9007199254740993';

    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: beyondFloat,
      createdAt: tehranOffset(today, 8),
      soldAt: tehranOffset(today, 8),
      paidAt: tehranOffset(today, 8),
    });

    // EVERY figure this case is about is a money figure, so all of it now
    // comes from `/admin/dashboard/financial`. `byChannel`, `byBranch` and
    // `topVariants` moved wholesale — they are revenue breakdowns, so there is
    // no operational half of them left to read.
    const { money, byChannel, byBranch, topVariants } = await financial();

    expect(typeof money.grossSales).toBe('string');
    expect(typeof money.netSales).toBe('string');
    expect(typeof money.refundedTotal).toBe('string');
    expect(typeof money.voidedTotal).toBe('string');

    expect(money.grossSales).toBe(beyondFloat);
    expect(money.netSales).toBe(beyondFloat);
    // The proof that it never became a float on the way out.
    expect(money.grossSales).not.toBe(String(Number(beyondFloat)));

    // The breakdowns carry the same figure and must not round it either.
    expect(byChannel[0].grossSales).toBe(beyondFloat);
    expect(byChannel[0].netSales).toBe(beyondFloat);
    expect(byBranch[0].grossSales).toBe(beyondFloat);
    expect(topVariants[0].grossSales).toBe(beyondFloat);

    // And subtraction stays exact: a refund of 1 Rial must move the last digit.
    await ctx.dataSource.query(
      `UPDATE orders SET status = 'refunded', "refundedAt" = $1::timestamptz`,
      [tehranOffset(today, 9).toISOString()],
    );
    const after = await financial();
    expect(after.money.refundedTotal).toBe(beyondFloat);
    expect(after.money.netSales).toBe('0');
  });

  // =======================================================================
  // 7. the Tehran day boundary itself
  // =======================================================================
  it('splits 23:59 and 00:01 Tehran across two different days, on every axis', async () => {
    // One minute BEFORE today began in Tehran, and one minute after. In UTC
    // these are 20:29 and 20:31 on the PREVIOUS date (Tehran is +03:30), which
    // is exactly why the boundary may not be computed from a UTC calendar day.
    const justBefore = new Date(today.startUtc.getTime() - MINUTE);
    const justAfter = new Date(today.startUtc.getTime() + MINUTE);

    // Yesterday, 23:59 Tehran: created, sold and paid. Nothing of it is today.
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '111000',
      createdAt: justBefore,
      soldAt: justBefore,
      paidAt: justBefore,
    });

    // Today, 00:01 Tehran: created, sold and paid. All of it is today.
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '222000',
      createdAt: justAfter,
      soldAt: justAfter,
      paidAt: justAfter,
    });

    // The boundary must be the same boundary on BOTH routes: this case is the
    // one that would expose a financial route that resolved its own day with,
    // say, a UTC calendar date — the counts would show one sale and the money
    // the other. `businessDay()` compares `period` across the two responses
    // before either figure is read, which the old single-payload form could
    // not do at all.
    const { totals, money, period } = await businessDay();

    expect(period.date).toBe(today.date);
    expect(totals.salesCount).toBe(1);
    expect(money.grossSales).toBe('222000');
    expect(totals.ordersCreated).toBe(1);
    expect(totals.ordersCreatedPaid).toBe(1);

    // The upper bound is half-open the same way: one minute before midnight
    // tonight is today, one minute after it is not.
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '333000',
      createdAt: new Date(today.endUtc.getTime() - MINUTE),
      soldAt: new Date(today.endUtc.getTime() - MINUTE),
      paidAt: new Date(today.endUtc.getTime() - MINUTE),
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '444000',
      createdAt: new Date(today.endUtc.getTime() + MINUTE),
      soldAt: new Date(today.endUtc.getTime() + MINUTE),
      paidAt: new Date(today.endUtc.getTime() + MINUTE),
    });

    const edged = await businessDay();
    expect(edged.totals.salesCount).toBe(2);
    expect(edged.money.grossSales).toBe('555000'); // 222000 + 333000
    expect(edged.totals.ordersCreated).toBe(2);

    // The exact instant midnight begins belongs to the NEW day, not the old
    // one: the interval is [startUtc, endUtc).
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '1000',
      createdAt: today.startUtc,
      soldAt: today.startUtc,
      paidAt: today.startUtc,
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '2000',
      createdAt: today.endUtc,
      soldAt: today.endUtc,
      paidAt: today.endUtc,
    });

    const closed = await businessDay();
    expect(closed.totals.salesCount).toBe(3);
    expect(closed.money.grossSales).toBe('556000'); // + the 1000 only
    expect(closed.totals.ordersCreated).toBe(3);
  });

  // =======================================================================
  // The contract itself
  // =======================================================================
  it('no longer publishes an order count whose axis has to be guessed', async () => {
    const data = await dashboard();

    // The ambiguous field is GONE, not renamed alongside a compatibility
    // alias: a consumer still reading it must fail loudly.
    expect(data.totals.orderCount).toBeUndefined();

    // Every replacement carries its axis in its own name.
    //
    // `grossSales`, `refundedTotal`, `voidedTotal` and `netSales` used to be in
    // this list. They are not "missing" — they moved to
    // `/admin/dashboard/financial`, and this exact list is what makes that a
    // contract rather than a coincidence: `toEqual` on the sorted key set fails
    // if a money field is reinstated here under any name, which is precisely
    // the regression the owner's rule forbids.
    expect(Object.keys(data.totals as Record<string, unknown>).sort()).toEqual(
      [
        'canceledOrFailedByRevenueDate',
        'nonSaleCount',
        'ordersByRevenueDate',
        'ordersCreated',
        'ordersCreatedFailedOrCanceled',
        'ordersCreatedPaid',
        'ordersCreatedPending',
        'pendingByRevenueDate',
        'refundedCount',
        'salesCount',
        'unitsRefunded',
        'unitsReturnedByLine',
        'unitsSold',
        'unitsVoided',
        'voidedCount',
      ].sort(),
    );

    // Every count in `totals` is a NUMBER. Stated as a type assertion over the
    // whole block rather than field by field, because the thing that would go
    // wrong is a `bigint` sum leaking back in as a string — which is exactly
    // what a returning money field looks like.
    for (const [key, value] of Object.entries(
      data.totals as Record<string, unknown>,
    )) {
      expect([key, typeof value]).toEqual([key, 'number']);
    }

    // And the four that left are all present on the other route, so the split
    // moved them rather than dropping them — alongside lineRefundedTotal, the
    // partial-refund figure netSales now also subtracts.
    const { money } = await financial();
    expect(Object.keys(money as Record<string, unknown>).sort()).toEqual(
      [
        'grossSales',
        'lineRefundedTotal',
        'netSales',
        'refundedTotal',
        'voidedTotal',
      ].sort(),
    );

    // And the response says which timestamp does what, so no consumer has to
    // read this source file to find out.
    expect(data.semantics.createdDate).toContain('orders.created_at');
    expect(data.semantics.revenueDate).toContain('paidAt');
    expect(data.semantics.refundDate).toContain('refundedAt');
    expect(data.semantics.voidDate).toContain('voidedAt');
    expect(data.timezone).toBe(TEHRAN);
  });

  it('counts pending web orders of ANY age and never calls them revenue', async () => {
    await seedOrder(ctx, {
      status: OrderStatusEnum.PENDING,
      total: '10000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, -100),
      soldAt: tehranOffset(today, -100),
      paidAt: null,
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.PENDING,
      total: '20000',
      channel: OrderChannel.ONLINE,
      createdAt: tehranOffset(today, 6),
      soldAt: tehranOffset(today, 6),
      paidAt: null,
    });

    // "Never calls them revenue" has to be checked where revenue is published,
    // which is no longer the route the queue depth comes from.
    const { totals, pipeline, money } = await businessDay();

    // The work queue is not a figure about today.
    expect(pipeline.pendingWebOrders).toBe(2);
    // Today's created count is.
    expect(totals.ordersCreatedPending).toBe(1);
    expect(totals.ordersCreated).toBe(1);
    // Neither is revenue, on any axis.
    expect(totals.salesCount).toBe(0);
    expect(money.grossSales).toBe('0');
    expect(money.netSales).toBe('0');
    expect(totals.unitsSold).toBe(0);
  });

  // =======================================================================
  // The split itself: no money on the operational route, and the financial
  // route is the main administrator's alone
  // =======================================================================

  /**
   * A delegated administrator: a custom role carrying `admin.access` and
   * `dashboard.read` and NOTHING else. This is the shift supervisor the
   * capability exists for, and the principal whose console must never see a
   * money figure.
   */
  async function delegatedDashboardReader() {
    const role = await as(ctx, admin)
      .post('/admin/access/roles')
      .send({
        name: fixtureRoleName('dashreader'),
        titleFa: 'سرپرست شیفت',
        permissions: ['admin.access', 'dashboard.read'],
      });
    expect(role.status).toBe(201);

    const created = await createUser(ctx.dataSource, { roles: [] });
    const assigned = await as(ctx, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [Number(role.body.data.id)] });
    expect(assigned.status).toBe(200);

    return authenticate(ctx, created.username, created.password, 'admin');
  }

  /**
   * NO MONEY ANYWHERE IN THE OPERATIONAL PAYLOAD — asserted STRUCTURALLY.
   *
   * A list of forbidden field names would only catch the fields that exist
   * today: reinstating the figure as `totals.takings` or
   * `recentOrders[].amountPaid` would sail past it. Money in this API has a
   * recognisable SHAPE instead — an integer-Rial base-10 STRING, because these
   * are `bigint` sums, while every count is a JSON NUMBER — so the walk below
   * flags any key whose name talks about money and whose value is a digit
   * string, whatever it is called and however deep it sits.
   *
   * `semantics` is excluded because it is prose ABOUT the figures: it names
   * `grossSales` in order to explain which timestamp places it, and its values
   * are sentences, not digit strings. Excluding the subtree rather than
   * relying on the digit-string test keeps the exclusion explicit.
   */
  it('carries no money field at any depth on the operational summary', async () => {
    // A day with real money in it, so "no money field" cannot pass merely
    // because every figure happened to be absent or zero: these same orders
    // produce a non-zero gross on the financial route, asserted below.
    await seedOrder(ctx, {
      status: OrderStatusEnum.PAID,
      total: '4800000',
      quantity: 2,
      createdAt: tehranOffset(today, 8),
      soldAt: tehranOffset(today, 8),
      paidAt: tehranOffset(today, 8),
    });
    await seedOrder(ctx, {
      status: OrderStatusEnum.REFUNDED,
      total: '900000',
      createdAt: tehranOffset(today, 9),
      soldAt: tehranOffset(today, 9),
      paidAt: tehranOffset(today, 9),
      refundedAt: tehranOffset(today, 10),
    });

    const data = await dashboard();

    // Money-ish NAME, money-shaped VALUE. `refundedCount: 2` is a count and
    // survives; `refundedTotal: "900000"` is money and must not be here.
    const MONEY_NAME = /gross|net|total|refunded|voided|amount|price|sales/i;
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        if (here === 'semantics' || here.startsWith('semantics.')) continue;
        if (
          MONEY_NAME.test(key) &&
          typeof value === 'string' &&
          /^-?\d+$/.test(value)
        ) {
          offenders.push(`${here} = ${value}`);
        }
        walk(value, here);
      }
    };
    walk(data, '');

    // Named in the message so a regression says WHICH field came back.
    expect(offenders).toEqual([]);

    // The walk is only meaningful if it would fire — run it against the
    // financial payload, which is all money, and require that it DOES. A
    // detector that silently matched nothing would make the assertion above
    // vacuous, and the whole owner requirement with it.
    const moneyData = await financial();
    const proof: string[] = [];
    const walkProof = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, index) => walkProof(item, `${path}[${index}]`));
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        if (here === 'semantics' || here.startsWith('semantics.')) continue;
        if (
          MONEY_NAME.test(key) &&
          typeof value === 'string' &&
          /^-?\d+$/.test(value)
        ) {
          proof.push(here);
        }
        walkProof(value, here);
      }
    };
    walkProof(moneyData, '');
    expect(proof).toContain('money.grossSales');
    expect(moneyData.money.grossSales).toBe('5700000'); // 4800000 + 900000

    // `recentOrders` is the specific place the figure used to hide: the list
    // carried `totalPrice` per row, so eight order amounts were readable by a
    // `dashboard.read` holder even with the totals removed.
    expect(data.recentOrders.length).toBeGreaterThan(0);
    for (const order of data.recentOrders as Array<Record<string, unknown>>) {
      expect(order).not.toHaveProperty('totalPrice');
    }
  });

  /**
   * THE GATE ON THE FINANCIAL ROUTE, both directions.
   *
   * 403 with `ROLE_REQUIRED` rather than `PERMISSION_DENIED` is the point: the
   * console reads the code to decide what to tell the operator, and there is
   * no capability to go and ask for — by design, because the owner's rule is
   * that this is not delegable. Answering `PERMISSION_DENIED` would send a
   * shift supervisor to request a permission that cannot exist.
   */
  it('refuses the financial route to a dashboard.read holder and serves it to a super_admin', async () => {
    const supervisor = await delegatedDashboardReader();

    // The capability really does work — otherwise the refusal below would
    // prove nothing about the financial route in particular.
    const operational = await withCookies(ctx, supervisor).get(
      '/admin/dashboard/summary',
    );
    expect(operational.status).toBe(200);

    const refused = await withCookies(ctx, supervisor).get(
      '/admin/dashboard/financial',
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('ROLE_REQUIRED');
    expect(refused.body.details.requiredRoles).toEqual(['super_admin']);

    // The refusal names the rule and nothing else: no figure leaks out beside
    // the error, which is how a "helpful" handler that attached a partial
    // payload to its 403 would be caught.
    expect(refused.body).not.toHaveProperty('data');
    expect(JSON.stringify(refused.body)).not.toMatch(
      /grossSales|netSales|refundedTotal|voidedTotal/,
    );

    // And the other half of the rule: the main administrator is not locked out
    // by the change that locked everybody else out.
    const allowed = await as(ctx, admin).get('/admin/dashboard/financial');
    expect(allowed.status).toBe(200);
    expect(typeof allowed.body.data.money.grossSales).toBe('string');
  });
});
