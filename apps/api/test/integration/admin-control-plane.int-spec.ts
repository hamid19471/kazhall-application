import * as request from 'supertest';

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
  fixtureMobile,
  uniqueSuffix,
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * THE ADMIN CONTROL PLANE — lifecycle, bounds, and the things that must
 * REFUSE
 * ===========================================================================
 *
 * `rbac-permissions.int-spec.ts` proves the authorisation model. This proves
 * the management surface built on it, and every case is one of the three
 * shapes that actually break in production:
 *
 *   - a LIST that is not bounded (the old `GET /orders` returned the whole
 *     table with four relations hydrated);
 *   - a LIFECYCLE change that leaves a session, a branch or an account in a
 *     state nobody can get out of;
 *   - a REFUSAL that is only in the UI, so the API happily does the thing the
 *     screen said it would not.
 */
describe('admin control plane', () => {
  let app: TestApp;
  let admin: CookieJar;
  let adminUserId: number;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    const created = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    adminUserId = created.user.id;
    admin = await authenticate(
      app,
      created.username,
      created.password,
      'admin',
    );
  });

  // =========================================================================
  // Bounded lists
  // =========================================================================

  describe('every admin collection is bounded', () => {
    it('pages GET /orders instead of returning the table', async () => {
      for (let index = 0; index < 15; index += 1) {
        await seedOrder(app, { channel: 'pos' });
      }

      const firstPage = await withCookies(app, admin).get('/orders?limit=10');
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data).toHaveLength(10);
      expect(firstPage.body.total).toBe(15);
      expect(firstPage.body.totalPages).toBe(2);

      const secondPage = await withCookies(app, admin).get(
        '/orders?limit=10&page=2',
      );
      expect(secondPage.body.data).toHaveLength(5);

      // NO ROW APPEARS TWICE AND NONE IS SKIPPED. That is the whole reason the
      // ordering carries a unique tiebreaker: `soldAt` collides, and without
      // `id DESC` an operator working a queue page by page silently misses one.
      const ids = [
        ...(firstPage.body.data as Array<{ id: number }>).map((row) => row.id),
        ...(secondPage.body.data as Array<{ id: number }>).map((row) => row.id),
      ];
      expect(new Set(ids).size).toBe(15);
    });

    it('refuses a limit above the cap rather than honouring it', async () => {
      const response = await withCookies(app, admin).get('/orders?limit=5000');
      expect(response.status).toBe(400);
    });

    it('returns a PROJECTION, never the order entity', async () => {
      await seedOrder(app, { channel: 'pos' });
      const response = await withCookies(app, admin).get('/orders?limit=1');
      const row = (response.body.data as Array<Record<string, unknown>>)[0];

      // Columns that exist on `orders` and have no business in a list an
      // operator opens to scan order numbers.
      expect(row).not.toHaveProperty('fulfillmentLastError');
      expect(row).not.toHaveProperty('addressSnapshot');
      expect(row).not.toHaveProperty('discount_code');
      // Money is a STRING: these are bigint columns and must not round.
      expect(typeof row.totalPrice).toBe('string');
    });

    it('bounds the order action history too', async () => {
      const orderId = await seedOrder(app, { channel: 'pos' });
      const response = await withCookies(app, admin).get(
        `/orders/${orderId}/actions?limit=5`,
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('limit', 5);
    });
  });

  describe('order filters', () => {
    it('filters by channel, status and payment state', async () => {
      const posOrder = await seedOrder(app, { channel: 'pos' });
      const webOrder = await seedOrder(app, {
        channel: 'online',
        status: 'pending',
      });

      const pos = await withCookies(app, admin).get('/orders?channel=pos');
      const posIds = (pos.body.data as Array<{ id: number }>).map((r) => r.id);
      expect(posIds).toContain(posOrder);
      expect(posIds).not.toContain(webOrder);

      const pending = await withCookies(app, admin).get(
        '/orders?status=pending',
      );
      const pendingIds = (pending.body.data as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(pendingIds).toEqual([webOrder]);

      // No receipts were written, so every order reads `none` — and `none` is
      // a real value rather than "filter absent", which is what lets an
      // operator find an order the gateway never confirmed.
      const none = await withCookies(app, admin).get(
        '/orders?paymentState=none',
      );
      expect((none.body.data as unknown[]).length).toBe(2);
    });

    it('reads from/to as inclusive Tehran calendar days', async () => {
      // 20:00 UTC on the 1st is 23:30 Tehran on the SAME day; 21:00 UTC is
      // 00:30 Tehran on the NEXT one. A UTC-day filter would put both in the
      // 1st, which is the bug this asserts against.
      const sameDay = await seedOrder(app, {
        channel: 'pos',
        soldAt: '2026-03-01T20:00:00Z',
      });
      const nextDay = await seedOrder(app, {
        channel: 'pos',
        soldAt: '2026-03-01T21:00:00Z',
      });

      const first = await withCookies(app, admin).get(
        '/orders?from=2026-03-01&to=2026-03-01',
      );
      const firstIds = (first.body.data as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(firstIds).toEqual([sameDay]);

      const second = await withCookies(app, admin).get(
        '/orders?from=2026-03-02&to=2026-03-02',
      );
      const secondIds = (second.body.data as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(secondIds).toEqual([nextDay]);
    });
  });

  // =========================================================================
  // User lifecycle
  // =========================================================================

  describe('deactivating a staff account', () => {
    it('kills every open session in the same breath', async () => {
      const branch = await createBranch(app.dataSource);
      const cashier = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const till = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );

      expect((await withCookies(app, till).get('/auth/pos/me')).status).toBe(
        200,
      );

      const deactivate = await withCookies(app, admin)
        .patch(`/admin/users/${cashier.user.id}/active`)
        .send({ isActive: false });
      expect(deactivate.status).toBe(200);

      // The access token is refused on the NEXT request, and the refresh token
      // is revoked in the same transaction — without that, reactivating later
      // would silently resurrect a session that was open when the account was
      // suspended.
      const after = await withCookies(app, till).get('/auth/pos/me');
      expect(after.status).toBe(401);

      const rotate = await withCookies(app, till).post('/auth/pos/refresh');
      expect(rotate.status).toBe(401);

      const [{ live }] = await app.dataSource.query<Array<{ live: number }>>(
        `SELECT COUNT(*)::int AS live FROM refresh_tokens
          WHERE "userId" = $1 AND revoked = false`,
        [cashier.user.id],
      );
      expect(live).toBe(0);
    });

    it('is refused for the last administrator who can still sign in', async () => {
      const response = await withCookies(app, admin)
        .patch(`/admin/users/${adminUserId}/active`)
        .send({ isActive: false });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('LAST_SUPER_ADMIN');

      // And the refusal really refused: the caller is still signed in.
      expect((await withCookies(app, admin).get('/auth/admin/me')).status).toBe(
        200,
      );
    });

    it('never hard-deletes an account — there is no route that could', async () => {
      const cashier = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });
      const response = await withCookies(app, admin).delete(
        `/admin/users/${cashier.user.id}`,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('an administrator-set temporary password', () => {
    it('cuts every session and then admits exactly one sign-in that must change it', async () => {
      const staff = await createUser(app.dataSource, {
        roles: [UserRoleEnum.superAdmin],
      });
      const before = await authenticate(
        app,
        staff.username,
        staff.password,
        'admin',
      );
      expect(
        (await withCookies(app, before).get('/auth/admin/me')).status,
      ).toBe(200);

      const reset = await withCookies(app, admin)
        .post(`/admin/users/${staff.user.id}/password`)
        .send({ temporaryPassword: 'Temp!Passw0rd' });
      expect(reset.status).toBe(200);
      expect(reset.body.revoked).toBeGreaterThanOrEqual(1);

      // The old session is dead, and so is the old password.
      expect(
        (await withCookies(app, before).get('/auth/admin/me')).status,
      ).toBe(401);
      const oldPassword = await request(app.server)
        .post('/auth/admin/login')
        .send({ username: staff.username, password: staff.password });
      expect(oldPassword.status).toBe(401);

      // The reset stamped `passwordChangedAt`, so the same fail-closed `iat`
      // comparison applies here as after a self-service change. See the note
      // further down.
      await waitForNextSecond();

      // The temporary one works exactly once, and the resulting session can do
      // nothing except introspect, rotate, sign out, and change the password.
      const jar = await authenticate(
        app,
        staff.username,
        'Temp!Passw0rd',
        'admin',
      );
      const me = await withCookies(app, jar).get('/auth/admin/me');
      expect(me.status).toBe(200);
      expect(me.body.data.mustChangePassword).toBe(true);

      const blocked = await withCookies(app, jar).get('/orders');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe('PASSWORD_CHANGE_REQUIRED');

      // The change is reachable — a forced state with no exit is a lockout.
      const changed = await withCookies(app, jar)
        .post('/auth/admin/change-password')
        .send({
          currentPassword: 'Temp!Passw0rd',
          newPassword: 'Chosen!Passw0rd',
        });
      expect(changed.status).toBe(200);

      // Changing it destroys this session too, deliberately.
      expect((await withCookies(app, jar).get('/auth/admin/me')).status).toBe(
        401,
      );

      /*
       * THE SUB-SECOND WINDOW, asserted rather than slept past by accident.
       *
       * A JWT's `iat` is in whole SECONDS while `users.passwordChangedAt` has
       * millisecond precision, so a token minted in the SAME second as the
       * change cannot be placed relative to it. `auth.types.ts` resolves that
       * ambiguity FAIL-CLOSED on purpose — the alternative keeps a compromised
       * session alive for its full lifetime at exactly the moment it is meant
       * to be cut off — which means a sign-in inside that same second is
       * refused once and succeeds on retry.
       *
       * Waiting for the second boundary is what a human does by simply being
       * slower than a test. It is documented here so the behaviour is a known
       * property rather than an intermittent failure somebody later "fixes" by
       * loosening the comparison.
       */
      await waitForNextSecond();

      const fresh = await authenticate(
        app,
        staff.username,
        'Chosen!Passw0rd',
        'admin',
      );
      const freshMe = await withCookies(app, fresh).get('/auth/admin/me');
      expect(freshMe.body.data.mustChangePassword).toBe(false);
      expect((await withCookies(app, fresh).get('/orders')).status).toBe(200);
    });

    it('refuses a customer account, which has no password at all', async () => {
      const [row] = await app.dataSource.query<Array<{ id: number }>>(
        `INSERT INTO users (mobile) VALUES ($1) RETURNING id`,
        // Production format, from the allocator — never a truncated string.
        [fixtureMobile()],
      );

      const response = await withCookies(app, admin)
        .post(`/admin/users/${row.id}/password`)
        .send({ temporaryPassword: 'Temp!Passw0rd' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('NOT_A_STAFF_ACCOUNT');
    });
  });

  describe('administrative session revocation', () => {
    it('signs a user out everywhere without touching their account', async () => {
      const branch = await createBranch(app.dataSource);
      const cashier = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const till = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );

      const [{ before }] = await app.dataSource.query<
        Array<{ before: number }>
      >(
        `SELECT COUNT(*)::int AS before FROM refresh_tokens
          WHERE "userId" = $1 AND revoked = false`,
        [cashier.user.id],
      );

      const revoke = await withCookies(app, admin).post(
        `/admin/users/${cashier.user.id}/revoke-sessions`,
      );
      expect(revoke.status).toBe(200);
      // Whatever was live is what gets revoked — asserted against the table
      // rather than against an assumption about how many sessions a sign-in
      // creates, so the number stays meaningful if that ever changes.
      expect(revoke.body.revoked).toBe(before);
      expect(before).toBeGreaterThanOrEqual(1);

      const [{ after }] = await app.dataSource.query<Array<{ after: number }>>(
        `SELECT COUNT(*)::int AS after FROM refresh_tokens
          WHERE "userId" = $1 AND revoked = false`,
        [cashier.user.id],
      );
      expect(after).toBe(0);

      expect(
        (await withCookies(app, till).post('/auth/pos/refresh')).status,
      ).toBe(401);

      // The ACCOUNT is untouched: they can sign straight back in. That is the
      // difference from deactivation, and the reason both exist.
      const again = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      expect((await withCookies(app, again).get('/auth/pos/me')).status).toBe(
        200,
      );
    });
  });

  // =========================================================================
  // Branch lifecycle
  // =========================================================================

  describe('branch lifecycle', () => {
    it('stops a cashier at a deactivated branch from completing a sale', async () => {
      const branch = await createBranch(app.dataSource);
      const cashier = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const { variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 5, price: 1000 },
      );
      const till = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );

      const sell = (key: string) =>
        withCookies(app, till)
          .post('/orders/pos')
          .set('Idempotency-Key', key)
          .send({
            paymentMethod: 'cash',
            items: [{ productVariantId: variant.id, quantity: 1 }],
          });

      expect((await sell(`sale-${uniqueSuffix()}`)).status).toBe(201);

      const deactivate = await withCookies(app, admin)
        .patch(`/branch/${branch.id}/active`)
        .send({ isActive: false });
      expect(deactivate.status).toBe(200);

      // ENFORCED AT THE SALE, not at login and not in the till's UI. The
      // cashier still holds a valid session — they were mid-shift — and the
      // thing that has to be refused is the sale.
      const refused = await sell(`sale-${uniqueSuffix()}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('BRANCH_INACTIVE');

      // Nothing was written: stock is untouched and no order exists.
      const [{ stock }] = await app.dataSource.query<Array<{ stock: number }>>(
        `SELECT stock FROM product_variants WHERE id = $1`,
        [variant.id],
      );
      expect(stock).toBe(4);

      // Reactivating restores selling immediately.
      await withCookies(app, admin)
        .patch(`/branch/${branch.id}/active`)
        .send({ isActive: true });
      expect((await sell(`sale-${uniqueSuffix()}`)).status).toBe(201);
    });

    it('refuses to delete a branch that staff or orders reference', async () => {
      const branch = await createBranch(app.dataSource);
      await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });

      const response = await withCookies(app, admin).delete(
        `/branch/${branch.id}`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('BRANCH_IN_USE');
      expect(response.body.details.staffCount).toBe(1);

      // Refused, not partially applied.
      const [{ alive }] = await app.dataSource.query<Array<{ alive: number }>>(
        `SELECT COUNT(*)::int AS alive FROM branches WHERE id = $1`,
        [branch.id],
      );
      expect(alive).toBe(1);
    });

    it('deletes a branch nothing points at', async () => {
      const branch = await createBranch(app.dataSource);
      const response = await withCookies(app, admin).delete(
        `/branch/${branch.id}`,
      );
      expect(response.status).toBe(200);
    });

    it('lets the till read its OWN branch, which the console-only routes do not serve', async () => {
      const branch = await createBranch(app.dataSource);
      const cashier = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const till = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );

      const mine = await withCookies(app, till).get('/branch/mine');
      expect(mine.status).toBe(200);
      expect(mine.body.data.id).toBe(branch.id);

      // The directory itself is still admin-audience only.
      expect((await withCookies(app, till).get('/branch')).status).toBe(401);
    });
  });

  // =========================================================================
  // Dashboard
  // =========================================================================

  describe('the dashboard summary', () => {
    it('agrees with the sales report for the same day, figure for figure', async () => {
      await seedOrder(app, { channel: 'pos', total: 500_000 });
      await seedOrder(app, { channel: 'pos', total: 250_000 });
      await seedOrder(app, {
        channel: 'online',
        status: 'pending',
        total: 999,
      });

      const dashboard = await withCookies(app, admin).get(
        '/admin/dashboard/summary',
      );
      expect(dashboard.status).toBe(200);

      /*
       * THE MONEY HALF IS A SECOND ROUTE NOW.
       *
       * This case used to read `grossSales` and `netSales` out of
       * `/admin/dashboard/summary`, because that payload carried the counts
       * and the Rial figures together behind one delegatable capability. The
       * owner's rule moved every money figure to
       * `/admin/dashboard/financial`, gated on the built-in `super_admin`
       * role, so the old reads now resolve to `undefined` and the claim they
       * made ("the summary agrees with the report about money") is about a
       * field the summary no longer has.
       *
       * `admin` here is a `super_admin`, which is the only principal that can
       * fetch both halves — so this case reconciles all three responses, and
       * asserts first that the two dashboard routes agree on the day. They
       * each resolve "today" themselves; nothing but this assertion stops a
       * future change from having them resolve it differently, at which point
       * every count-against-money comparison below would be comparing two
       * different days and still passing.
       */
      const financial = await withCookies(app, admin).get(
        '/admin/dashboard/financial',
      );
      expect(financial.status).toBe(200);
      expect(financial.body.data.period).toEqual(dashboard.body.data.period);

      const day = (dashboard.body.data.period as { date: string }).date;
      const report = await withCookies(app, admin).get(
        `/reports/sales/summary?from=${day}&to=${day}`,
      );

      // The dashboard imports the report's definition of a completed sale
      // rather than restating it; these assertions are what keeps that true.
      //
      // BOTH SIDES ARE NOW BASE-10 INTEGER STRINGS. The `String(...)` wrapper
      // that used to sit on the report side existed only because the report
      // returned JS numbers, and it hid the very thing worth asserting: that
      // the two endpoints return the SAME representation, not merely values
      // that stringify alike.
      expect(typeof report.body.totals.grossSales).toBe('string');
      expect(report.body.totals.grossSales).toBe(
        financial.body.data.money.grossSales,
      );
      expect(report.body.totals.netSales).toBe(
        financial.body.data.money.netSales,
      );
      // `orderCount` on the report is `ordersByRevenueDate` on the dashboard:
      // the same figure, renamed there to say WHICH timestamp placed it. The
      // dashboard no longer has a field called `orderCount` at all, because a
      // count on the revenue-date axis under that name was read as "orders
      // placed today" and is not.
      expect(dashboard.body.data.totals.orderCount).toBeUndefined();
      // And it no longer has the money under its old names either — an alias
      // left behind on the delegatable route would undo the split silently.
      expect(dashboard.body.data.totals.grossSales).toBeUndefined();
      expect(dashboard.body.data.totals.netSales).toBeUndefined();
      expect(report.body.totals.orderCount).toBe(
        dashboard.body.data.totals.ordersByRevenueDate,
      );
      expect(report.body.totals.unitsSold).toBe(
        dashboard.body.data.totals.unitsSold,
      );
      expect(report.body.totals.salesCount).toBe(
        dashboard.body.data.totals.salesCount,
      );
      expect(report.body.totals.pendingCount).toBe(
        dashboard.body.data.totals.pendingByRevenueDate,
      );
      // The pending online order is counted, and counted as NOT a sale.
      expect(dashboard.body.data.pipeline.pendingWebOrders).toBe(1);
      expect(dashboard.body.data.totals.salesCount).toBe(2);

      // The created-at axis is a SEPARATE number over the same three orders:
      // all three rows were written today, but only two are revenue.
      expect(dashboard.body.data.totals.ordersCreated).toBe(3);
      expect(dashboard.body.data.totals.ordersCreatedPaid).toBe(2);
      expect(dashboard.body.data.totals.ordersCreatedPending).toBe(1);
      expect(dashboard.body.data.totals.ordersCreatedFailedOrCanceled).toBe(0);
    });

    it('never reports profit, because cost of goods is not modelled', async () => {
      const response = await withCookies(app, admin).get(
        '/admin/dashboard/summary',
      );
      expect(JSON.stringify(response.body).toLowerCase()).not.toContain(
        'profit',
      );
      expect(JSON.stringify(response.body).toLowerCase()).not.toContain(
        'margin',
      );
    });

    it('declares stock as GLOBAL rather than implying per-branch figures', async () => {
      const response = await withCookies(app, admin).get(
        '/admin/dashboard/summary',
      );
      expect(response.body.data.inventory.scope).toBe('global');
    });
  });

  // =========================================================================
  // Reconciliation, simplified
  // =========================================================================

  describe('the reconciliation queue', () => {
    it('partitions every case across the three stages', async () => {
      // Paid with its goods never allocated — a case by predicate, not by flag.
      await seedOrder(app, {
        channel: 'online',
        status: 'paid',
        fulfillmentState: 'pending',
      });
      const tracked = await seedOrder(app, {
        channel: 'online',
        status: 'paid',
        fulfillmentState: 'awaiting_stock',
      });
      await app.dataSource.query(
        `UPDATE orders SET "reconciliationState" = 'backordered' WHERE id = $1`,
        [tracked],
      );
      const closed = await seedOrder(app, { channel: 'pos' });
      await app.dataSource.query(
        `UPDATE orders SET "reconciliationState" = 'resolved',
                           "reconciliationResolvedAt" = now()
          WHERE id = $1`,
        [closed],
      );

      const summary = await withCookies(app, admin).get(
        '/payment/admin/reconciliation/summary',
      );
      expect(summary.status).toBe(200);
      const counts = summary.body.data as Record<string, number>;
      expect(counts.needsAction).toBe(1);
      expect(counts.tracking).toBe(1);
      expect(counts.closed).toBe(1);

      // The stages PARTITION the queue: the three add up to every case, so a
      // manager who empties all three has handled everything.
      const all = await withCookies(app, admin).get(
        '/payment/admin/reconciliation?limit=100',
      );
      expect(all.body.data.total).toBe(
        counts.needsAction + counts.tracking + counts.closed,
      );

      for (const [stage, expected] of [
        ['needs_action', counts.needsAction],
        ['tracking', counts.tracking],
        ['closed', counts.closed],
      ] as const) {
        const page = await withCookies(app, admin).get(
          `/payment/admin/reconciliation?stage=${stage}&limit=100`,
        );
        expect(page.body.data.total).toBe(expected);
      }
    });

    it('serves the summary route rather than treating it as an order id', async () => {
      // `/summary` is declared BEFORE `/:orderId`; the other order would make
      // this a 400 from ParseIntPipe.
      const response = await withCookies(app, admin).get(
        '/payment/admin/reconciliation/summary',
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('needsAction');
    });
  });
});

/** A minimal order row, written straight to the table. */
async function seedOrder(
  app: TestApp,
  options: {
    channel: 'pos' | 'online';
    status?: string;
    fulfillmentState?: string;
    total?: number;
    soldAt?: string;
  },
): Promise<number> {
  const status = options.status ?? 'paid';
  const fulfillmentState =
    options.fulfillmentState ?? (status === 'paid' ? 'fulfilled' : 'pending');
  const total = options.total ?? 1000;
  const soldAt = options.soldAt ?? new Date().toISOString();
  // `paidAt` is the revenue axis; a pending order has never been paid.
  const paidAt = status === 'pending' ? null : soldAt;

  const [row] = await app.dataSource.query<Array<{ id: number }>>(
    `INSERT INTO orders (channel, status, "fulfillmentState", total_price,
                         subtotal, "soldAt", "paidAt")
     VALUES ($1, $2, $3, $4, $4, $5, $6)
     RETURNING id`,
    [options.channel, status, fulfillmentState, total, soldAt, paidAt],
  );
  return Number(row.id);
}

/**
 * Sleeps to just past the next whole-second boundary.
 *
 * Needed only by the password-change case, and only because the fail-closed
 * `iat` comparison is deliberate. See the comment at the call site.
 */
function waitForNextSecond(): Promise<void> {
  const now = Date.now();
  return new Promise((resolve) => setTimeout(resolve, 1000 - (now % 1000) + 5));
}
