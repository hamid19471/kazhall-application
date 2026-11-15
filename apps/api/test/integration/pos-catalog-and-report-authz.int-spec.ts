/**
 * The till's three contracts with the server.
 *
 * 1. WHO MAY READ SALES REPORTS. The owner's rule is that full reporting is the
 *    main administrator's. The reports controller used to read
 *    `@Roles(superAdmin, sale)` and pin a `sale` caller to their own branch in
 *    the service — but branch-pinning is not confidentiality: a cashier could
 *    still read `by-cashier` and see every colleague's gross and net takings,
 *    plus the branch's refund and void totals. These cases fail if that role is
 *    ever re-added, which is the only reason they are worth writing.
 *
 * 2. WHAT A TILL MAY SEE OF A SALE. A cashier may reprint the slip for a sale
 *    they performed themselves, and nothing wider: not the order list, not a
 *    colleague's slip at the same branch, not an order's action history.
 *
 * 3. WHAT A TILL MAY BROWSE. The shop has no barcode scanner, so the cashier
 *    browses and searches. `GET /products` cannot serve that: it is `@Public()`
 *    (so it must never carry `availableForPos`) and it searches titles only.
 *    `GET /inventory/catalog` is the `sale`-gated answer, and the cases below
 *    pin the three things a counter actually depends on — searching by the SKU
 *    or the colour a customer is holding, and never being offered something
 *    that cannot be sold.
 */
import { createBranch } from './setup/seed-helpers';
import { randomUUID } from 'node:crypto';

import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';
import { fixtureRoleName } from './setup/fixture-ids';

/**
 * EVERY CAPABILITY A `super_admin` CAN ACTUALLY CONFER ON A STAFF ROLE.
 *
 * The catalogue's 44 codes minus `storefront.access`, which is the CUSTOMER
 * door and which `super_admin` does not itself hold — `assertNoEscalation`
 * therefore refuses to grant it, with `PERMISSION_ESCALATION`. Excluding it is
 * not weakening the case: a delegated administrator cannot be given it either,
 * so this really is the most privileged delegated role that can exist.
 *
 * Derived from the catalogue rather than listed, so a capability added
 * tomorrow is automatically part of the claim "no capability opens reporting".
 */
const EVERY_GRANTABLE_CAPABILITY = [...PERMISSION_CODES].filter(
  (code) => code !== 'storefront.access',
);

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';

import { CATALOG_NAMESPACES, CacheService } from 'src/database/cache.service';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import {
  seedAttribute,
  seedCategory,
  seedProduct,
  uniqueSku,
} from './support/catalog.fixtures';
import { seedReportingSale } from './support/reporting.fixtures';

const RANGE = { from: '2026-01-01', to: '2026-12-31' };

const REPORT_ROUTES = [
  `/reports/sales/summary?from=${RANGE.from}&to=${RANGE.to}`,
  `/reports/sales?from=${RANGE.from}&to=${RANGE.to}`,
  `/reports/sales/by-cashier?from=${RANGE.from}&to=${RANGE.to}`,
  '/reports/sales/1',
  // Gross profit (docs/PURCHASE-COST-ACCOUNTING.md §8): the same rule, by
  // role and audience, never by a delegable capability.
  `/reports/profit/summary?from=${RANGE.from}&to=${RANGE.to}`,
  `/reports/profit/breakdown?groupBy=product&from=${RANGE.from}&to=${RANGE.to}`,
  `/reports/profit/orders?from=${RANGE.from}&to=${RANGE.to}`,
  '/reports/profit/orders/1',
];

interface CatalogVariant {
  id: number;
  sku: string;
  price: number | null;
  availableForPos: number;
  inStock: boolean;
  attributeValues: Array<{
    id: number;
    value: string;
    attribute?: { id: number; name: string };
  }>;
}
interface CatalogProduct {
  id: number;
  title: string;
  variants: CatalogVariant[];
  inStock: boolean;
  effectivePrice: number | null;
  maxEffectivePrice: number | null;
}

describe('POS catalogue and report authorization (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    await ctx.app
      .get(CacheService, { strict: false })
      .bumpVersion(CATALOG_NAMESPACES.PRODUCTS);
  });

  // =========================================================================
  // Reports belong to the administrator
  // =========================================================================

  describe('sales reports', () => {
    /*
     * 401, NOT 403 — AND THAT IS THE STRONGER ANSWER.
     *
     * `ReportsController` now declares `@Audiences('admin')` alone. It used to
     * declare `('admin', 'pos')`, which meant a cashier's till session reached
     * the route and was turned away by the role check. The till is no longer
     * admitted to the controller at all, so the refusal happens in
     * `JwtStrategy` — it looks for the `kz_admin_*` cookie, a POS session does
     * not carry one, and the request is unauthenticated for this surface.
     *
     * The cases assert the refusal AND that no report body comes back with it,
     * so a future change that reinstated the POS audience and relied on the
     * role check alone would still be visible here as a status change.
     */
    it.each(REPORT_ROUTES)('refuses a `sale` cashier: %s', async (route) => {
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId: null,
      });
      const response = await ctx
        .request()
        .get(route)
        .set('Cookie', cashier.cookie);
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(
        /grossSales|netSales|grossProfit|cogs/i,
      );
    });

    it('refuses a cashier even when they have a branch of their own', async () => {
      const branch = await ctx.dataSource.query(
        `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
        [`branch-${Date.now()}`],
      );
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId: Number(branch[0].id),
      });
      // Branch scoping was the OLD defence. It is not a substitute for the
      // rule: a branch-scoped cashier still saw colleagues' takings.
      await ctx
        .request()
        .get(`/reports/sales/by-cashier?from=${RANGE.from}&to=${RANGE.to}`)
        .set('Cookie', cashier.cookie)
        .expect(401);
    });

    it('refuses a `site` customer', async () => {
      // Reports are declared for the admin audience only; a shopper's
      // storefront session is not it, so the refusal is 401 at the audience
      // layer before the role is even consulted.
      const customer = await ctx.loginAs([UserRoleEnum.site]);
      for (const route of REPORT_ROUTES) {
        await ctx
          .request()
          .get(route)
          .set('Cookie', customer.cookie)
          .expect(401);
      }
    });

    it('refuses an anonymous caller', async () => {
      for (const route of REPORT_ROUTES) {
        await ctx.request().get(route).expect(401);
      }
    });

    it('allows a super_admin', async () => {
      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      const res = await ctx
        .request()
        .get(REPORT_ROUTES[0])
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(res.body.success).toBe(true);
    });

    it('allows a super_admin on an admin session through every gross-profit route', async () => {
      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      for (const route of REPORT_ROUTES.filter(
        (r) => r.startsWith('/reports/profit/') && !/\/\d+$/.test(r),
      )) {
        await ctx.request().get(route).set('Cookie', admin.cookie).expect(200);
      }
      // The detail route answers 404 for a missing order, not 403.
      await ctx
        .request()
        .get('/reports/profit/orders/999999')
        .set('Cookie', admin.cookie)
        .expect(404);
    });

    it('allows a BRANCHLESS super_admin — reporting does not need a branch', async () => {
      const admin = await ctx.loginAs([UserRoleEnum.superAdmin], undefined, {
        branchId: null,
      });
      await ctx
        .request()
        .get(`/reports/sales/by-cashier?from=${RANGE.from}&to=${RANGE.to}`)
        .set('Cookie', admin.cookie)
        .expect(200);
    });

    /**
     * ======================================================================
     * THE FULL MATRIX — every principal that is not the main administrator
     * ======================================================================
     *
     * THE OWNER'S RULE, VERBATIM: "Sales reports must be available only to the
     * main administrator, represented by the built-in `super_admin` role."
     *
     * WHAT USED TO BE HERE, AND WHY IT IS GONE. This file previously contained
     * a `describe('a delegated reports.read holder who is not super_admin')`
     * block asserting the OPPOSITE of the rule above: that an accountant given
     * a custom role carrying `admin.access` + `reports.read` could read
     * `/reports/sales/summary`, unscoped when branchless and branch-pinned
     * otherwise. It was written in good faith — a delegatable "accountant"
     * capability is a reasonable design — but it is not the design the owner
     * asked for, and a passing test asserting the wrong rule is worse than no
     * test at all: it would have blocked the correction.
     *
     * `reports.read` no longer exists. It is absent from `PERMISSION_CATALOG`
     * and retired in the database by migration 0028, so a role cannot be
     * created or edited to carry it (`assertKnownPermissions` rejects the code)
     * and a STALE `role_permissions` row naming it resolves to nothing
     * (`PermissionService` filters `retiredAt IS NULL`). The case below proves
     * that last sentence against a row written directly into the database,
     * because that is the only path a real upgraded deployment can take.
     *
     * BRANCH SCOPING IS NOT PART OF THIS RULE ANY MORE. There is no principal
     * left who is allowed reports but only some of them, so
     * `resolveBranchScope` no longer refuses a branchless caller and no longer
     * pins anyone: `super_admin` reports across the whole business, and
     * everybody else is refused outright.
     */
    describe('every principal that is not a super_admin', () => {
      /** A custom role carrying whatever the RBAC editor will accept. */
      async function customRole(
        adminCookie: string,
        permissions: string[],
      ): Promise<number> {
        const res = await ctx
          .request()
          .post('/admin/access/roles')
          .set('Cookie', adminCookie)
          .send({
            name: fixtureRoleName('delegated'),
            titleFa: 'نقش واگذارشده',
            permissions,
          })
          .expect(201);
        return Number(res.body.data.id);
      }

      async function adminWithRole(
        permissions: string[],
        branchId: number | null = null,
      ): Promise<{ cookie: string; userId: number }> {
        const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
        const roleId = await customRole(admin.cookie, permissions);
        const user = await ctx.loginAs([], undefined, {
          branchId,
          audience: 'admin',
        });
        await ctx
          .request()
          .put(`/admin/access/users/${user.userId}/roles`)
          .set('Cookie', admin.cookie)
          .send({ roleIds: [roleId] })
          .expect(200);
        return { cookie: user.cookie, userId: user.userId };
      }

      it.each(REPORT_ROUTES)(
        'refuses a delegated administrator holding every grantable capability: %s',
        async (route) => {
          /*
           * NOT a hand-picked list: every code the catalogue publishes. If a
           * future capability could open a reporting route, this fails — which
           * is the only way to assert "no capability grants this" without
           * restating the catalogue here and letting the two drift.
           */
          const delegated = await adminWithRole(EVERY_GRANTABLE_CAPABILITY);
          await ctx
            .request()
            .get(route)
            .set('Cookie', delegated.cookie)
            .expect(403);
        },
      );

      it.each(REPORT_ROUTES)(
        'refuses a delegated administrator WITH a branch: %s',
        async (route) => {
          const [branch] = await ctx.dataSource.query<Array<{ id: number }>>(
            `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
            [`delegated-branch-${randomUUID().slice(0, 8)}`],
          );
          // Having a branch is not a narrower kind of access; it is none.
          const delegated = await adminWithRole(
            EVERY_GRANTABLE_CAPABILITY,
            Number(branch.id),
          );
          await ctx
            .request()
            .get(route)
            .set('Cookie', delegated.cookie)
            .expect(403);
        },
      );

      it('refuses a branch manager', async () => {
        const [branch] = await ctx.dataSource.query<Array<{ id: number }>>(
          `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
          [`managed-branch-${randomUUID().slice(0, 8)}`],
        );
        const manager = await adminWithRole(
          [
            'admin.access',
            'branches.read',
            'branches.update',
            'orders.read',
            'orders.status.update',
          ],
          Number(branch.id),
        );
        await ctx
          .request()
          .get(`/reports/sales/by-cashier?from=${RANGE.from}&to=${RANGE.to}`)
          .set('Cookie', manager.cookie)
          .expect(403);
      });

      it('refuses a catalogue manager', async () => {
        const manager = await adminWithRole([
          'admin.access',
          'products.read',
          'products.create',
          'products.update',
          'categories.read',
          'categories.create',
          'categories.update',
        ]);
        await ctx
          .request()
          .get(REPORT_ROUTES[0])
          .set('Cookie', manager.cookie)
          .expect(403);
      });

      /**
       * THE UPGRADED-DEPLOYMENT CASE.
       *
       * A database that ran the old code has `role_permissions` rows naming
       * `reports.read`. Migration 0028 retires the permission rather than
       * deleting it (deleting would CASCADE the grants away and destroy the
       * audit trail), so those rows survive — and must be INERT.
       *
       * The row is written with raw SQL on purpose: the API cannot produce it
       * any more, and going through `POST /admin/access/roles` would only prove
       * that the editor rejects the code, which is a different claim.
       */
      it('is not opened by a STALE reports.read grant left in the database', async () => {
        const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
        const roleId = await customRole(admin.cookie, ['admin.access']);

        const [permission] = await ctx.dataSource.query<
          Array<{ id: number; retiredAt: string | null }>
        >(
          `SELECT id, "retiredAt" FROM permissions WHERE code = 'reports.read'`,
        );
        // The migration ran, and the code is still on the shelf, retired.
        expect(permission).toBeDefined();
        expect(permission.retiredAt).not.toBeNull();

        await ctx.dataSource.query(
          `INSERT INTO role_permissions ("roleId", "permissionId")
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, Number(permission.id)],
        );

        const stale = await ctx.loginAs([], undefined, { audience: 'admin' });
        await ctx
          .request()
          .put(`/admin/access/users/${stale.userId}/roles`)
          .set('Cookie', admin.cookie)
          .send({ roleIds: [roleId] })
          .expect(200);

        for (const route of REPORT_ROUTES) {
          await ctx
            .request()
            .get(route)
            .set('Cookie', stale.cookie)
            .expect(403);
        }

        // And the session never even reports holding it.
        const session = await ctx
          .request()
          .get('/auth/admin/me')
          .set('Cookie', stale.cookie)
          .expect(200);
        expect(session.body.data.permissions).not.toContain('reports.read');
      });

      /**
       * AUDIENCE, NOT ONLY ROLE.
       *
       * `ReportsController` declares `@Audiences('admin')` alone. The same
       * human holding `super_admin` who signs in at the till gets a POS-cookie
       * session, and that session must not reach reporting — otherwise the
       * figures are one shared workstation away from the shop floor.
       */
      it('refuses a super_admin holding a POS-audience session', async () => {
        const atTheTill = await ctx.loginAs(
          [UserRoleEnum.superAdmin],
          undefined,
          {
            audience: 'pos',
          },
        );
        for (const route of REPORT_ROUTES) {
          await ctx
            .request()
            .get(route)
            .set('Cookie', atTheTill.cookie)
            .expect(401);
        }
      });

      it('refuses a storefront session belonging to a super_admin', async () => {
        const shopping = await ctx.loginAs(
          [UserRoleEnum.superAdmin],
          undefined,
          { audience: 'storefront' },
        );
        for (const route of REPORT_ROUTES) {
          await ctx
            .request()
            .get(route)
            .set('Cookie', shopping.cookie)
            .expect(401);
        }
      });
    });
  });

  // =========================================================================
  // A cashier keeps their own sale, and only their own
  // =========================================================================

  describe('the immediate receipt', () => {
    /**
     * Locking reports down must not take the slip away with them.
     *
     * The receipt screen used to re-read `/reports/sales/:id`, so restricting
     * reports to `super_admin` silently broke a cashier's ability to reprint
     * the sale they had just rung up. The slip now reads `GET /orders/:id`.
     *
     * WHY BRANCH SCOPING WAS NOT ENOUGH. That route used to admit any `sale`
     * caller whose branch matched the order's, which made every colleague at
     * the same till readable: one shop, one branch id, so `dev_cashier2` could
     * open `dev_cashier1`'s slip and read the customer, the payment rows and
     * the takings. The owner's line is narrower than a branch -- it is the
     * sale you performed -- so the gate is now cashier identity AND branch,
     * both taken from the verified session, never from the request.
     *
     * A refusal is 404, not 403, matching the project's non-enumeration policy:
     * 403 would confirm that an order with that id exists.
     */
    async function posSaleBy(cashierCookie: string) {
      const product = await seedProduct(ctx.dataSource, {
        title: 'کالای فروش حضوری',
        variants: [{ sku: uniqueSku('TILL'), price: 12_000_000, stock: 5 }],
      });
      const res = await ctx
        .request()
        .post('/orders/pos')
        .set('Cookie', cashierCookie)
        .set('Idempotency-Key', `receipt-case-${randomUUID()}`)
        .send({
          paymentMethod: 'cash',
          items: [{ productVariantId: product.variants[0].id, quantity: 2 }],
        })
        .expect(201);
      return res.body.data as { id: number };
    }

    async function makeBranch(name: string): Promise<number> {
      const rows = await ctx.dataSource.query(
        `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
        [`${name}-${randomUUID().slice(0, 8)}`],
      );
      return Number(rows[0].id);
    }

    async function onlineOrderIn(branchId: number) {
      const order = await seedReportingSale(ctx.dataSource, {
        soldAt: new Date('2026-03-04T10:00:00Z'),
        branchId,
        branchName: 'فروشگاه اینترنتی',
        cashierUserId: (await ctx.loginAs([UserRoleEnum.superAdmin])).userId,
        cashierDisplay: 'سفارش آنلاین',
        total: 30_000_000,
        channel: OrderChannel.ONLINE,
      });
      return order;
    }

    it('lets the cashier who rang it up re-read the sale, while reports stay shut', async () => {
      const branchId = await makeBranch('till');
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      const sale = await posSaleBy(cashier.cookie);

      // The slip: allowed, and carrying everything the paper needs.
      const receipt = await ctx
        .request()
        .get(`/orders/${sale.id}`)
        .set('Cookie', cashier.cookie)
        .expect(200);
      const order = receipt.body.data;
      expect(order.cashierDisplaySnapshot).toBeTruthy();
      expect(order.branchNameSnapshot).toBeTruthy();
      expect(order.items[0].variantSkuSnapshot).toMatch(/^TILL/);
      expect(order.items[0].quantity).toBe(2);

      // The books: still shut, for the very same order. 401 rather than 403
      // because the till session is not admitted to the admin surface at all.
      await ctx
        .request()
        .get(`/reports/sales/${sale.id}`)
        .set('Cookie', cashier.cookie)
        .expect(401);
    });

    it('gives the cashier a receipt, not an order record', async () => {
      const branchId = await makeBranch('fields');
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      const sale = await posSaleBy(cashier.cookie);

      const slip = await ctx
        .request()
        .get(`/orders/${sale.id}`)
        .set('Cookie', cashier.cookie)
        .expect(200);

      // Reading your own sale is not reading the order: the fields a till has
      // no business with are absent from the payload, not merely unrendered.
      for (const withheld of [
        'user',
        'customer',
        'address',
        'addressSnapshot',
        'payments',
        'cashierUser',
        'reconciliationState',
        'fulfillmentAttempts',
      ]) {
        expect(slip.body.data).not.toHaveProperty(withheld);
      }

      // The administrator still gets the whole record, so the narrowing is a
      // projection for one role and not a change to what the order is.
      const full = await ctx
        .request()
        .get(`/orders/${sale.id}`)
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(full.body.data).toHaveProperty('reconciliationState');
      const fullKeys = Object.keys(full.body.data as object);
      const slipKeys = Object.keys(slip.body.data as object);
      expect(fullKeys.length).toBeGreaterThan(slipKeys.length);
    });

    it("does not let a cashier read a colleague's sale at the same branch", async () => {
      // The case branch scoping could not catch: one shop, one branch id.
      const branchId = await makeBranch('shared-till');
      const mine = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      const colleague = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });

      const theirSale = await posSaleBy(colleague.cookie);

      await ctx
        .request()
        .get(`/orders/${theirSale.id}`)
        .set('Cookie', mine.cookie)
        .expect(404);

      // And the reverse, so the case cannot pass by one of them being broken.
      const mySale = await posSaleBy(mine.cookie);
      await ctx
        .request()
        .get(`/orders/${mySale.id}`)
        .set('Cookie', colleague.cookie)
        .expect(404);
      await ctx
        .request()
        .get(`/orders/${mySale.id}`)
        .set('Cookie', mine.cookie)
        .expect(200);
    });

    it("does not let a cashier read another branch's sale", async () => {
      const mineId = await makeBranch('mine');
      const theirsId = await makeBranch('theirs');
      const mine = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId: mineId,
      });
      const theirs = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId: theirsId,
      });

      const sale = await posSaleBy(theirs.cookie);

      await ctx
        .request()
        .get(`/orders/${sale.id}`)
        .set('Cookie', mine.cookie)
        .expect(404);
    });

    it('does not let a cashier read an online customer order', async () => {
      const branchId = await makeBranch('online-host');
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      // Seeded into the cashier's own branch on purpose: the refusal must come
      // from the channel and the seller, not from the branch happening to differ.
      const online = await onlineOrderIn(branchId);

      await ctx
        .request()
        .get(`/orders/${online.id}`)
        .set('Cookie', cashier.cookie)
        .expect(404);
    });

    it('does not let the next cashier on the terminal read the last one’s slip', async () => {
      // Account switching at one till: the second session is a different
      // principal, and the server is what decides -- not the browser cache.
      const branchId = await makeBranch('handover');
      const outgoing = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      const sale = await posSaleBy(outgoing.cookie);
      await ctx
        .request()
        .get(`/orders/${sale.id}`)
        .set('Cookie', outgoing.cookie)
        .expect(200);

      const incoming = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      await ctx
        .request()
        .get(`/orders/${sale.id}`)
        .set('Cookie', incoming.cookie)
        .expect(404);

      // A signed-out terminal is not a reader at all.
      await ctx.request().get(`/orders/${sale.id}`).expect(401);
    });
  });

  // =========================================================================
  // Sales history and order administration
  // =========================================================================

  describe('order history and administration', () => {
    /**
     * `GET /orders` used to be `@Roles(super_admin, sale)`, branch-scoped, so a
     * cashier could list every sale their shop had ever made -- colleagues'
     * takings included -- which is the reporting the owner reserved for the
     * administrator. Browsing history is not the same right as reprinting the
     * slip you just produced, and these cases hold the two apart.
     */
    async function tillWithASale() {
      const branchId = await ctx.dataSource
        .query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [
          `history-${randomUUID().slice(0, 8)}`,
        ])
        .then((rows: Array<{ id: number }>) => Number(rows[0].id));
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId,
      });
      const product = await seedProduct(ctx.dataSource, {
        title: 'کالای سابقه',
        variants: [{ sku: uniqueSku('HIST'), price: 9_000_000, stock: 5 }],
      });
      const res = await ctx
        .request()
        .post('/orders/pos')
        .set('Cookie', cashier.cookie)
        .set('Idempotency-Key', `history-case-${randomUUID()}`)
        .send({
          paymentMethod: 'cash',
          items: [{ productVariantId: product.variants[0].id, quantity: 1 }],
        })
        .expect(201);
      return { cashier, saleId: (res.body.data as { id: number }).id };
    }

    it('refuses a `sale` cashier the order list, and serves the administrator', async () => {
      const { cashier } = await tillWithASale();
      // The management list is declared Admin-only. A till session is refused
      // for being the wrong APPLICATION, not merely the wrong role — which is
      // the guarantee the owner asked for: a valid role in the wrong audience
      // is not enough.
      await ctx
        .request()
        .get('/orders')
        .set('Cookie', cashier.cookie)
        .expect(401);

      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      const listed = await ctx
        .request()
        .get('/orders')
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(Array.isArray(listed.body.data)).toBe(true);
      expect(listed.body.data.length).toBeGreaterThan(0);
    });

    it('refuses the order list to a customer and to a caller with no session', async () => {
      const customer = await ctx.loginAs([UserRoleEnum.site]);
      await ctx
        .request()
        .get('/orders')
        .set('Cookie', customer.cookie)
        .expect(401);
      await ctx.request().get('/orders').expect(401);
    });

    it('keeps order history out of the till, and open to the administrator', async () => {
      const { cashier, saleId } = await tillWithASale();

      // Even for the cashier's OWN sale: the slip is the right to reprint,
      // not a window onto who voided, returned or re-priced what.
      await ctx
        .request()
        .get(`/orders/${saleId}/actions`)
        .set('Cookie', cashier.cookie)
        .expect(401);

      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      const actions = await ctx
        .request()
        .get(`/orders/${saleId}/actions`)
        .set('Cookie', admin.cookie)
        .expect(200);
      /*
       * `GET /orders/{id}/actions` IS NOW PAGINATED, so `data` is the page
       * object rather than a bare array.
       *
       * It used to return every action row an order had ever accumulated with
       * no bound at all. That is fine for an order with three rows and is a
       * response nobody can render for one that has been through a hundred
       * status changes — and it is the same unbounded shape the brief required
       * be removed from `GET /orders`. The rows are at `data.data`; `total`
       * says how many exist.
       */
      expect(Array.isArray(actions.body.data.data)).toBe(true);
      expect(actions.body.data).toEqual(
        expect.objectContaining({
          total: expect.any(Number),
          page: expect.any(Number),
          limit: expect.any(Number),
          totalPages: expect.any(Number),
        }),
      );

      await ctx
        .request()
        .get(`/orders/${saleId}`)
        .set('Cookie', admin.cookie)
        .expect(200);
    });

    it('refuses a cashier every order mutation, including on their own sale', async () => {
      const { cashier, saleId } = await tillWithASale();

      await ctx
        .request()
        .patch(`/orders/status/${saleId}`)
        .set('Cookie', cashier.cookie)
        .send({ status: 'canceled' })
        .expect(401);
      await ctx
        .request()
        .post(`/orders/${saleId}/void`)
        .set('Cookie', cashier.cookie)
        .send({ reason: 'تست' })
        .expect(401);
      await ctx
        .request()
        .post(`/orders/${saleId}/return`)
        .set('Cookie', cashier.cookie)
        .send({ reason: 'تست' })
        .expect(401);

      // The refusals are refusals, not silent no-ops.
      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      const after = await ctx
        .request()
        .get(`/orders/${saleId}`)
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(after.body.data.voidedAt).toBeNull();
      expect(after.body.data.refundedAt).toBeNull();
    });
  });

  // =========================================================================
  // The till's catalogue
  // =========================================================================

  describe('GET /inventory/catalog', () => {
    async function seedShop() {
      const colour = await seedAttribute(ctx.dataSource, 'رنگ', [
        'مشکی',
        'سرمه‌ای',
      ]);
      const size = await seedAttribute(ctx.dataSource, 'ظرفیت', [
        '۵۰ لیتر',
        '۷۰ لیتر',
      ]);
      const packs = await seedCategory(ctx.dataSource, 'کوله‌پشتی');
      const tents = await seedCategory(ctx.dataSource, 'چادر');

      const pack = await seedProduct(ctx.dataSource, {
        title: 'کوله‌پشتی کوهنوردی آروند',
        categories: [packs],
        variants: [
          {
            sku: 'PACK-50-BLK',
            price: 87_500_000,
            stock: 4,
            attributeValueIds: [colour.values[0].id, size.values[0].id],
          },
          {
            sku: 'PACK-70-NVY',
            price: 104_000_000,
            stock: 0, // out of stock, still sellable catalogue context
            attributeValueIds: [colour.values[1].id, size.values[1].id],
          },
        ],
      });

      const tent = await seedProduct(ctx.dataSource, {
        title: 'چادر دو نفره قله',
        categories: [tents],
        variants: [{ sku: uniqueSku('TENT'), price: 128_500_000, stock: 3 }],
      });

      return { pack, tent, packs, tents };
    }

    /*
     * A cashier WITH A BRANCH. Since migration 0030 the till catalogue is
     * scoped to the caller's branch, and a branchless `sale` account is a
     * misconfigured cashier that `POST /orders/pos` already refused — the two
     * surfaces now agree. The fixture gives them a real shop to stand in.
     */
    const asCashier = async () => {
      const branch = await createBranch(ctx.dataSource);
      return (
        await ctx.loginAs([UserRoleEnum.sale], undefined, {
          branchId: branch.id,
        })
      ).cookie;
    };

    it('refuses anonymous and `site` callers, allows `sale`', async () => {
      await seedShop();
      await ctx.request().get('/inventory/catalog').expect(401);

      // A customer holds a STOREFRONT session. The till's routes declare the
      // POS audience, so the refusal now lands at the audience layer (401)
      // rather than the role layer (403) — and 401 is the better answer: 403
      // would confirm the route exists for somebody.
      const customer = await ctx.loginAs([UserRoleEnum.site]);
      await ctx
        .request()
        .get('/inventory/catalog')
        .set('Cookie', customer.cookie)
        .expect(401);

      await ctx
        .request()
        .get('/inventory/catalog')
        .set('Cookie', await asCashier())
        .expect(200);
    });

    it('returns each variant with its SKU, effective price and availableForPos', async () => {
      const { pack } = await seedShop();
      const res = await ctx
        .request()
        .get('/inventory/catalog?limit=50')
        .set('Cookie', await asCashier())
        .expect(200);

      const found: CatalogProduct = res.body.data.find(
        (p: CatalogProduct) => p.id === pack.id,
      );
      expect(found.variants).toHaveLength(2);

      const black = found.variants.find((v) => v.sku === 'PACK-50-BLK')!;
      expect(black.price).toBe(87_500_000);
      expect(black.availableForPos).toBe(4);
      expect(black.inStock).toBe(true);
      // The axis NAME matters: "مشکی" and "۵۰ لیتر" are different questions,
      // and a picker cannot group them without it.
      expect(
        black.attributeValues.map((a) => a.attribute?.name).sort(),
      ).toEqual(['رنگ', 'ظرفیت']);

      const navy = found.variants.find((v) => v.sku === 'PACK-70-NVY')!;
      expect(navy.availableForPos).toBe(0);
      expect(navy.inStock).toBe(false);
      // Present, not hidden: the cashier must be able to tell the customer
      // "we stock that one, it is just gone".
      expect(navy.price).toBe(104_000_000);

      expect(found.effectivePrice).toBe(87_500_000);
      expect(found.maxEffectivePrice).toBe(104_000_000);
    });

    it('searches by product title, by variant SKU and by attribute value', async () => {
      await seedShop();
      const cookie = await asCashier();
      const search = async (term: string): Promise<CatalogProduct[]> => {
        const res = await ctx
          .request()
          .get(`/inventory/catalog?limit=50&search=${encodeURIComponent(term)}`)
          .set('Cookie', cookie)
          .expect(200);
        return res.body.data;
      };

      expect((await search('کوله')).map((p) => p.title)).toEqual([
        'کوله‌پشتی کوهنوردی آروند',
      ]);
      // A cashier reads the SKU off a label, in either case.
      expect((await search('PACK-50-BLK')).map((p) => p.title)).toEqual([
        'کوله‌پشتی کوهنوردی آروند',
      ]);
      expect((await search('pack-50')).map((p) => p.title)).toEqual([
        'کوله‌پشتی کوهنوردی آروند',
      ]);
      // Or the customer says "the navy one".
      expect((await search('سرمه‌ای')).map((p) => p.title)).toEqual([
        'کوله‌پشتی کوهنوردی آروند',
      ]);
      expect(await search('  کوله  ')).toHaveLength(1);
      expect(await search('zzz-no-such-thing')).toHaveLength(0);
    });

    it('filters by category and combines the filter with a search', async () => {
      const { tents } = await seedShop();
      const cookie = await asCashier();

      const all = await ctx
        .request()
        .get('/inventory/catalog?limit=50')
        .set('Cookie', cookie)
        .expect(200);
      expect(all.body.total).toBe(2);

      const tentsOnly = await ctx
        .request()
        .get(`/inventory/catalog?limit=50&categoryId=${tents.id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(tentsOnly.body.data.map((p: CatalogProduct) => p.title)).toEqual([
        'چادر دو نفره قله',
      ]);

      // A category that cannot contain the term yields nothing, rather than
      // the category ignoring the search or vice versa.
      const both = await ctx
        .request()
        .get(`/inventory/catalog?limit=50&categoryId=${tents.id}&search=کوله`)
        .set('Cookie', cookie)
        .expect(200);
      expect(both.body.total).toBe(0);
    });

    it('paginates and reports the page envelope', async () => {
      await seedShop();
      const cookie = await asCashier();

      const page1 = await ctx
        .request()
        .get('/inventory/catalog?limit=1&page=1')
        .set('Cookie', cookie)
        .expect(200);
      expect(page1.body).toEqual(
        expect.objectContaining({ total: 2, page: 1, limit: 1, totalPages: 2 }),
      );
      expect(page1.body.data).toHaveLength(1);

      const page2 = await ctx
        .request()
        .get('/inventory/catalog?limit=1&page=2')
        .set('Cookie', cookie)
        .expect(200);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);

      // The cap is what stops a client asking for the whole shop at once.
      await ctx
        .request()
        .get('/inventory/catalog?limit=101')
        .set('Cookie', cookie)
        .expect(400);
    });

    it('omits inactive variants, and products left with none', async () => {
      await seedProduct(ctx.dataSource, {
        title: 'محصول بازنشسته',
        variants: [
          {
            sku: uniqueSku('DEAD'),
            price: 10_000_000,
            stock: 5,
            isActive: false,
          },
        ],
      });
      const mixed = await seedProduct(ctx.dataSource, {
        title: 'محصول نیمه‌بازنشسته',
        variants: [
          { sku: 'LIVE-ONE', price: 20_000_000, stock: 5, isActive: true },
          { sku: 'DEAD-ONE', price: 30_000_000, stock: 5, isActive: false },
        ],
      });

      const res = await ctx
        .request()
        .get('/inventory/catalog?limit=50')
        .set('Cookie', await asCashier())
        .expect(200);

      const titles = res.body.data.map((p: CatalogProduct) => p.title);
      expect(titles).not.toContain('محصول بازنشسته');

      const half = res.body.data.find((p: CatalogProduct) => p.id === mixed.id);
      expect(half.variants.map((v: CatalogVariant) => v.sku)).toEqual([
        'LIVE-ONE',
      ]);
    });
  });
});
