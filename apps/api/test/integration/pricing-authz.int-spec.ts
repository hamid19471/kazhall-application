/**
 * Monthly pricing plans are the main administrator's alone
 * (docs/MONTHLY-PRICING.md §7), and nothing about a plan leaks anywhere else.
 *
 * Every route is exercised against: a super_admin (admitted), a delegated
 * administrator holding every grantable capability (403, generic), a cashier,
 * a customer, an anonymous caller and a super_admin on the wrong surface (401).
 * After a refusal nothing changed and no pricing audit row was written.
 */
import { SessionAudience } from 'src/modules/auth/audience';
import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';
import { PricingRunnerService } from 'src/modules/pricing/pricing-runner.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { createProduct, createVariant } from './setup/seed-helpers';
import { fixtureIdempotencyKey, fixtureRoleName } from './setup/fixture-ids';
import {
  applicableOf,
  calculated,
  planOf,
  pricingClient,
  rowOf,
  rowsOf,
  settledRun,
  valueVariant,
} from './support/pricing.fixtures';

const EVERY_GRANTABLE_CAPABILITY = [...PERMISSION_CODES].filter(
  (code) => code !== 'storefront.access',
);

/** Distinctive plan figures: if any of these appears outside the plan API, it leaked. */
const SECRET = {
  revenue: '7777777777',
  tax: '9.87',
  profit: '12.34',
  cost: '987654321',
};
const LEAK = new RegExp(
  [
    SECRET.revenue,
    SECRET.cost,
    '9\\.87',
    '12\\.34',
    'taxRate',
    'targetProfit',
    'monthlyCosts',
    'pricing_plan',
    'costBasis',
  ].join('|'),
);

/**
 * A response body as text for the LEAK check, with ISO timestamps masked:
 * their seconds (e.g. `…:29.876Z`) can otherwise spell `9.87` or `12.34`.
 */
const leakText = (body: unknown): string =>
  JSON.stringify(body).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g,
    '<timestamp>',
  );

type State = 'review' | 'approved' | 'applied';

interface Target {
  planId: number;
  entryId: number;
  itemId: number;
  runId: number;
  variantId: number;
  count: number;
}

interface Route {
  name: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: (t: Target) => string;
  body?: (t: Target) => Record<string, unknown>;
  idempotent?: boolean;
  state?: State;
  ok: number;
}

const P = (t: Target) => `/admin/pricing-plans/${t.planId}`;

const ROUTES: Route[] = [
  {
    name: 'GET list',
    method: 'get',
    path: () => '/admin/pricing-plans',
    ok: 200,
  },
  {
    name: 'POST create',
    method: 'post',
    path: () => '/admin/pricing-plans',
    body: () => ({ title: 'x', effectiveYear: 1405, effectiveMonth: 1 }),
    ok: 201,
  },
  { name: 'GET plan', method: 'get', path: P, ok: 200 },
  {
    name: 'PATCH plan',
    method: 'patch',
    path: P,
    body: () => ({ notes: 'n' }),
    ok: 200,
  },
  { name: 'DELETE plan', method: 'delete', path: P, ok: 200 },
  {
    name: 'POST cost',
    method: 'post',
    path: (t) => `${P(t)}/costs`,
    body: () => ({ title: 'c', amountRial: 1 }),
    ok: 201,
  },
  {
    name: 'PATCH cost',
    method: 'patch',
    path: (t) => `${P(t)}/costs/${t.entryId}`,
    body: () => ({ isActive: false }),
    ok: 200,
  },
  {
    name: 'DELETE cost',
    method: 'delete',
    path: (t) => `${P(t)}/costs/${t.entryId}`,
    ok: 200,
  },
  {
    name: 'PUT cost order',
    method: 'put',
    path: (t) => `${P(t)}/costs/order`,
    body: (t) => ({ entryIds: [t.entryId] }),
    ok: 200,
  },
  {
    name: 'POST calculate',
    method: 'post',
    path: (t) => `${P(t)}/calculate`,
    idempotent: true,
    ok: 202,
  },
  {
    name: 'GET summary',
    method: 'get',
    path: (t) => `${P(t)}/summary`,
    ok: 200,
  },
  {
    name: 'GET items',
    method: 'get',
    path: (t) => `${P(t)}/items?view=all`,
    ok: 200,
  },
  {
    name: 'PATCH item',
    method: 'patch',
    path: (t) => `${P(t)}/items/${t.itemId}`,
    body: () => ({ included: false }),
    ok: 200,
  },
  {
    name: 'POST bulk',
    method: 'post',
    path: (t) => `${P(t)}/items/bulk`,
    body: () => ({ filters: { view: 'all' }, included: false }),
    ok: 201,
  },
  {
    name: 'POST approve',
    method: 'post',
    path: (t) => `${P(t)}/approve`,
    body: (t) => ({ expectedChangeCount: t.count }),
    ok: 201,
  },
  {
    name: 'POST unapprove',
    method: 'post',
    path: (t) => `${P(t)}/unapprove`,
    state: 'approved',
    ok: 201,
  },
  {
    name: 'POST apply',
    method: 'post',
    path: (t) => `${P(t)}/apply`,
    body: (t) => ({ expectedChangeCount: t.count }),
    idempotent: true,
    state: 'approved',
    ok: 202,
  },
  {
    name: 'GET rollback-preview',
    method: 'get',
    path: (t) => `${P(t)}/rollback-preview`,
    state: 'applied',
    ok: 200,
  },
  {
    name: 'POST rollback',
    method: 'post',
    path: (t) => `${P(t)}/rollback`,
    idempotent: true,
    state: 'applied',
    ok: 202,
  },
  { name: 'GET runs', method: 'get', path: (t) => `${P(t)}/runs`, ok: 200 },
  {
    name: 'GET run',
    method: 'get',
    path: (t) => `${P(t)}/runs/${t.runId}`,
    ok: 200,
  },
  {
    name: 'GET changes',
    method: 'get',
    path: (t) => `${P(t)}/changes`,
    state: 'applied',
    ok: 200,
  },
];

describe('pricing plan authorization and privacy (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  // A run kicked by a test's last request must finish before the next test
  // truncates the tables it is writing.
  afterEach(async () => {
    await ctx.app.get(PricingRunnerService, { strict: false }).idle();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  async function owner(): Promise<string> {
    return (await ctx.loginAs([UserRoleEnum.superAdmin])).cookie;
  }

  /** A calculated plan with distinctive figures, driven to `state`. */
  async function target(state: State = 'review'): Promise<Target> {
    const product = await createProduct(ctx.dataSource);
    // With the secret inputs the denominator is ≈ 65.1 %, so 1 000 000 prices at
    // ≈ 1 537 000: an ordinary READY increase over 1 400 000.
    const variant = await createVariant(ctx.dataSource, product, {
      price: 1_400_000,
    });
    await valueVariant(ctx.dataSource, variant.id, {
      stock: 10,
      unitCost: 1_000_000n,
    });
    const cookie = await owner();
    const client = pricingClient(ctx, cookie);
    const created = await client
      .create({ title: 'محرمانه', effectiveYear: 1405, effectiveMonth: 7 })
      .expect(201);
    const planId = Number(created.body.data.id);
    await client
      .update(planId, {
        targetMonthlyRevenueRial: SECRET.revenue,
        taxRatePercent: SECRET.tax,
        targetProfitMarginPercent: SECRET.profit,
        roundingStepRial: 1000,
      })
      .expect(200);
    const withCost = await client
      .addCost(planId, { title: 'هزینهٔ محرمانه', amountRial: SECRET.cost })
      .expect(201);
    const entryId = planOf(withCost).costEntries[0].id;
    const run = await calculated(ctx, cookie, planId);
    const count = applicableOf(await client.summary(planId).expect(200));
    const [item] = rowsOf(
      await client.items(planId, { view: 'all' }).expect(200),
    );
    if (state !== 'review') await client.approve(planId, count).expect(201);
    if (state === 'applied') {
      const applied = await client.apply(planId, count).expect(202);
      await settledRun(ctx, cookie, planId, rowOf(applied).id);
    }
    return {
      planId,
      entryId,
      itemId: item.id,
      runId: run.id,
      variantId: variant.id,
      count,
    };
  }

  function call(route: Route, t: Target, cookie: string | null) {
    let req = ctx.request()[route.method](route.path(t));
    if (cookie) req = req.set('Cookie', cookie);
    if (route.idempotent)
      req = req.set('Idempotency-Key', fixtureIdempotencyKey('authz'));
    return req.send(route.body ? route.body(t) : {});
  }

  async function snapshot(t: Target) {
    const [plan] = await ctx.dataSource.query(
      `SELECT status, notes, "updatedAt" FROM pricing_plans WHERE id = $1`,
      [t.planId],
    );
    const [counts] = await ctx.dataSource.query(
      `SELECT (SELECT count(*) FROM pricing_plan_runs)::int AS runs,
              (SELECT count(*) FROM pricing_plan_cost_entries)::int AS costs,
              (SELECT count(*) FROM pricing_price_changes)::int AS changes,
              (SELECT count(*) FROM pricing_plans)::int AS plans,
              (SELECT count(*) FROM admin_audit_log WHERE action LIKE 'pricing.%')::int AS audits,
              (SELECT price::text FROM product_variants WHERE id = $1) AS price`,
      [t.variantId],
    );
    return { plan, counts };
  }

  async function delegatedAdmin(): Promise<string> {
    const admin = await owner();
    const role = await ctx
      .request()
      .post('/admin/access/roles')
      .set('Cookie', admin)
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
      .set('Cookie', admin)
      .send({ roleIds: [Number(role.body.data.id)] })
      .expect(200);
    return user.cookie;
  }

  async function cashier(): Promise<string> {
    const [branch] = await ctx.dataSource.query(
      `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
      [fixtureRoleName('branch')],
    );
    return (
      await ctx.loginAs([UserRoleEnum.sale], undefined, {
        branchId: Number(branch.id),
      })
    ).cookie;
  }

  describe.each(ROUTES)('$name', (route) => {
    it('admits a super_admin on an admin session', async () => {
      const t = await target(route.state);
      const res = await call(route, t, await owner());
      expect(res.status).toBe(route.ok);
      expect(res.body.success).toBe(true);
    });

    it('refuses a delegated administrator holding every grantable capability (403, generic)', async () => {
      const t = await target(route.state);
      const before = await snapshot(t);
      const res = await call(route, t, await delegatedAdmin());
      expect(res.status).toBe(403);
      expect(leakText(res.body)).not.toMatch(LEAK);
      expect(await snapshot(t)).toEqual(before);
    });

    it('refuses a cashier, a customer and an anonymous caller (401)', async () => {
      const t = await target(route.state);
      const before = await snapshot(t);
      for (const cookie of [
        await cashier(),
        (await ctx.loginAs([UserRoleEnum.site])).cookie,
        null,
      ]) {
        const res = await call(route, t, cookie);
        expect(res.status).toBe(401);
        expect(leakText(res.body)).not.toMatch(LEAK);
      }
      expect(await snapshot(t)).toEqual(before);
    });

    it.each<SessionAudience>(['pos', 'storefront'])(
      'refuses a super_admin on a %s session — same person, wrong surface',
      async (audience) => {
        const t = await target(route.state);
        const before = await snapshot(t);
        const admin = await ctx.loginAs([UserRoleEnum.superAdmin], undefined, {
          audience,
        });
        const res = await call(route, t, admin.cookie);
        expect(res.status).toBe(401);
        expect(leakText(res.body)).not.toMatch(LEAK);
        expect(await snapshot(t)).toEqual(before);
      },
    );
  });

  // ==========================================================================
  // No leakage
  // ==========================================================================

  it('never exposes plan figures through public, POS, audit, error or realtime surfaces', async () => {
    const realtime = ctx.app.get(RealtimeGateway, { strict: false });
    const frames: unknown[][] = [];
    const spy = jest
      .spyOn(realtime, 'publishAvailabilityInvalidation')
      .mockImplementation((...args: unknown[]) => {
        frames.push(args);
        return Promise.resolve();
      });
    try {
      const t = await target('applied');

      // public catalogue
      const list = await ctx.request().get('/products').expect(200);
      const detail = await ctx
        .request()
        .get(
          `/products/${
            (
              await ctx.dataSource.query(
                `SELECT "productId" FROM product_variants WHERE id = $1`,
                [t.variantId],
              )
            )[0].productId
          }`,
        )
        .expect(200);
      for (const body of [list.body, detail.body])
        expect(leakText(body)).not.toMatch(LEAK);

      // the till
      const till = await cashier();
      const catalog = await ctx
        .request()
        .get('/inventory/catalog')
        .set('Cookie', till);
      expect(catalog.status).toBe(200);
      expect(leakText(catalog.body)).not.toMatch(LEAK);

      // the audit log, readable by a delegated administrator
      const delegated = await delegatedAdmin();
      const audit = await ctx
        .request()
        .get('/admin/audit?limit=100')
        .set('Cookie', delegated)
        .expect(200);
      const auditText = JSON.stringify(audit.body);
      expect(auditText).toContain('pricing.plan.applied');
      expect(auditText).not.toMatch(
        new RegExp(
          [
            SECRET.revenue,
            SECRET.cost,
            '9\\.87',
            '12\\.34',
            '1400000',
            '1537000',
          ].join('|'),
        ),
      );

      // error responses carry codes, never the figures they are about
      const bad = await ctx
        .request()
        .patch(`/admin/pricing-plans/${t.planId}`)
        .set('Cookie', await owner())
        .send({ notes: 'x' })
        .expect(409);
      expect(leakText(bad.body)).not.toMatch(LEAK);

      // realtime: ids and a reason, nothing else
      expect(frames.length).toBeGreaterThan(0);
      for (const [ids, reason, ...rest] of frames) {
        expect(Array.isArray(ids)).toBe(true);
        expect((ids as unknown[]).every((id) => typeof id === 'number')).toBe(
          true,
        );
        expect(reason).toBe('catalogue');
        expect(rest).toEqual([]);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
