/**
 * WHO MAY READ OR MOVE A PURCHASE COST (docs/PURCHASE-COST-ACCOUNTING.md §8).
 *
 * Cost is super_admin-only BY ROLE, not by a delegable permission — owner
 * decision B-2, the same rule the sales reports follow. So the claim is not
 * "a role without X is refused" but "NO delegated role is admitted", which is
 * asserted with a delegated administrator holding EVERY grantable capability
 * the catalogue publishes (derived, not listed, so a capability added tomorrow
 * is automatically part of the claim).
 *
 * Every route is exercised for every principal, and every refusal also
 * asserts that nothing changed and that no cost figure came back with it.
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';
import { SessionAudience } from 'src/modules/auth/audience';

import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { createProductWithVariant } from './setup/seed-helpers';
import { fixtureIdempotencyKey, fixtureRoleName } from './setup/fixture-ids';
import { movementsOf, poolOf } from './support/costing.fixtures';

const EVERY_GRANTABLE_CAPABILITY = [...PERMISSION_CODES].filter(
  (code) => code !== 'storefront.access',
);

interface Target {
  productId: number;
  variantId: number;
}

interface Route {
  name: string;
  method: 'get' | 'post' | 'put';
  path: (t: Target) => string;
  body?: Record<string, unknown>;
  idempotent?: boolean;
  /** What super_admin gets. */
  ok: number;
}

/** A legacy variant holding 3 UNVALUED units — every route has work to do. */
const ROUTES: Route[] = [
  {
    name: 'GET variant',
    method: 'get',
    path: (t) => `/admin/costing/variants/${t.variantId}`,
    ok: 200,
  },
  {
    name: 'GET product',
    method: 'get',
    path: (t) => `/admin/costing/products/${t.productId}`,
    ok: 200,
  },
  {
    name: 'GET unvalued',
    method: 'get',
    path: () => '/admin/costing/unvalued?page=1&limit=10',
    ok: 200,
  },
  {
    name: 'POST receipts',
    method: 'post',
    path: (t) => `/admin/costing/variants/${t.variantId}/receipts`,
    body: { quantity: 2, unitCost: 1_000 },
    idempotent: true,
    ok: 201,
  },
  {
    name: 'POST corrections',
    method: 'post',
    path: (t) => `/admin/costing/variants/${t.variantId}/corrections`,
    body: { quantityDelta: -1, reason: 'آزمون دسترسی' },
    idempotent: true,
    ok: 201,
  },
  {
    name: 'POST valuation',
    method: 'post',
    path: (t) => `/admin/costing/variants/${t.variantId}/valuation`,
    body: { expectedUnvaluedQuantity: 3, unitCost: 1_000 },
    idempotent: true,
    ok: 201,
  },
  {
    name: 'PUT purchase-price',
    method: 'put',
    path: (t) => `/admin/costing/variants/${t.variantId}/purchase-price`,
    body: { unitCost: 1_000 },
    ok: 200,
  },
];

describe('costing authorization (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  async function target(): Promise<Target> {
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 3 },
    );
    return { productId: product.id, variantId: variant.id };
  }

  function call(route: Route, t: Target, cookie: string | null) {
    let req = ctx.request()[route.method](route.path(t));
    if (cookie) req = req.set('Cookie', cookie);
    if (route.idempotent) {
      req = req.set('Idempotency-Key', fixtureIdempotencyKey('authz'));
    }
    return route.body ? req.send(route.body) : req;
  }

  async function assertUntouched(t: Target): Promise<void> {
    expect(await poolOf(ctx.dataSource, t.variantId)).toEqual({
      stock: 3,
      unvaluedQuantity: 3,
      inventoryCostValue: '0',
      lastPurchaseUnitCost: null,
      costStatus: 'unvalued',
    });
    expect(await movementsOf(ctx.dataSource, t.variantId)).toHaveLength(0);
    const [{ count }] = await ctx.dataSource.query(
      `SELECT count(*)::int AS count FROM admin_audit_log WHERE action LIKE 'inventory.%'`,
    );
    expect(count).toBe(0);
  }

  function assertNoCost(body: unknown): void {
    expect(JSON.stringify(body)).not.toMatch(
      /inventoryCostValue|averageUnitCost|lastPurchaseUnitCost|unitCost/,
    );
  }

  async function delegatedAdmin(): Promise<string> {
    const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
    const role = await ctx
      .request()
      .post('/admin/access/roles')
      .set('Cookie', admin.cookie)
      .send({
        name: fixtureRoleName('delegated'),
        titleFa: 'نقش واگذارشده',
        permissions: EVERY_GRANTABLE_CAPABILITY,
      })
      .expect(201);
    const user = await ctx.loginAs([], undefined, {
      branchId: null,
      audience: 'admin',
    });
    await ctx
      .request()
      .put(`/admin/access/users/${user.userId}/roles`)
      .set('Cookie', admin.cookie)
      .send({ roleIds: [Number(role.body.data.id)] })
      .expect(200);
    return user.cookie;
  }

  describe.each(ROUTES)('$name', (route) => {
    it('admits a super_admin on an admin session', async () => {
      const t = await target();
      const admin = await ctx.loginAs([UserRoleEnum.superAdmin]);
      const res = await call(route, t, admin.cookie);
      expect(res.status).toBe(route.ok);
      expect(res.body.success).toBe(true);
    });

    it('refuses a delegated administrator holding every grantable capability (403)', async () => {
      const t = await target();
      const cookie = await delegatedAdmin();
      const res = await call(route, t, cookie);
      expect(res.status).toBe(403);
      assertNoCost(res.body);
      await assertUntouched(t);
    });

    it('refuses a cashier on a till session', async () => {
      const t = await target();
      const [branch] = await ctx.dataSource.query<Array<{ id: number }>>(
        `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
        [fixtureRoleName('branch')],
      );
      const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId: Number(branch.id),
      });
      const res = await call(route, t, cashier.cookie);
      // The till is not admitted to an admin-audience controller at all:
      // `JwtStrategy` finds no admin cookie, so this is 401 before any role
      // is consulted — a stronger refusal than 403.
      expect(res.status).toBe(401);
      assertNoCost(res.body);
      await assertUntouched(t);
    });

    it('refuses a customer on a storefront session', async () => {
      const t = await target();
      const customer = await ctx.loginAs([UserRoleEnum.site]);
      const res = await call(route, t, customer.cookie);
      expect(res.status).toBe(401);
      assertNoCost(res.body);
      await assertUntouched(t);
    });

    it('refuses an anonymous caller (401)', async () => {
      const t = await target();
      const res = await call(route, t, null);
      expect(res.status).toBe(401);
      assertNoCost(res.body);
      await assertUntouched(t);
    });

    it.each<SessionAudience>(['pos', 'storefront'])(
      'refuses a super_admin on a %s session — same person, wrong surface',
      async (audience) => {
        const t = await target();
        const admin = await ctx.loginAs([UserRoleEnum.superAdmin], undefined, {
          audience,
        });
        const res = await call(route, t, admin.cookie);
        expect(res.status).toBe(401);
        assertNoCost(res.body);
        await assertUntouched(t);
      },
    );
  });
});
