/**
 * ============================================================================
 * NO COST ESCAPES THROUGH A NON-COST SURFACE (docs/PURCHASE-COST-ACCOUNTING.md §8)
 *
 * A valued product is created, received a second time, sold at the till and
 * sold on the web. Then every JSON body a customer, an anonymous visitor, a
 * cashier and a delegated administrator holding EVERY grantable capability
 * can reach — plus the product, inventory, movement and order views of a
 * super_admin, which must not carry cost either — is scanned recursively:
 *
 *   - no object KEY may look like a cost field, and
 *   - no VALUE (string or number) may equal a purchase-cost figure that exists
 *     in the database (unit costs, pool values, movement cost evidence, COGS).
 *
 * Realtime frames the stubbed gateway was asked to publish are scanned too.
 * ============================================================================
 */
import * as request from 'supertest';
import { EntityManager } from 'typeorm';

import { PERMISSION_CODES } from 'src/modules/auth/permissions/permission.catalog';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import { CookieJar, authenticate, withCookies } from './setup/test-app';
import { getTestDataSource, resetDb } from './setup/test-db';
import { createCategory, createUser, seedRoles } from './setup/seed-helpers';
import { fixtureRoleName } from './setup/fixture-ids';
import {
  createPosTestApp,
  posEmitted,
  resetPosEmitted,
  TestApp,
} from './support/pos.harness';
import {
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
} from './support/pos.fixtures';
import { makeOnlineOrder } from './support/inventory.harness';

const EVERY_GRANTABLE_CAPABILITY = [...PERMISSION_CODES].filter(
  (code) => code !== 'storefront.access',
);

const FORBIDDEN_KEY =
  /cost|cogs|profit|margin|valuation|inventoryvalue|purchase|unvalued/i;

interface Violation {
  surface: string;
  path: string;
  kind: 'key' | 'value';
  detail: string;
}

function scan(
  surface: string,
  node: unknown,
  figures: ReadonlySet<string>,
  out: Violation[],
  path = '$',
): void {
  if (node === null || node === undefined) return;
  if (
    typeof node === 'string' ||
    typeof node === 'number' ||
    typeof node === 'bigint'
  ) {
    if (figures.has(String(node))) {
      out.push({ surface, path, kind: 'value', detail: String(node) });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) =>
      scan(surface, child, figures, out, `${path}[${i}]`),
    );
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEY.test(key)) {
        out.push({ surface, path: `${path}.${key}`, kind: 'key', detail: key });
      }
      scan(surface, value, figures, out, `${path}.${key}`);
    }
  }
}

describe('purchase cost never leaks through non-cost surfaces (int)', () => {
  let ctx: TestApp;
  let inventory: InventoryService;

  beforeAll(async () => {
    // The storefront's password door (see createTestApp) — the POS harness
    // does not open it itself, and a customer session is needed below.
    process.env.KAZHAL_ENABLE_REVIEW_LOGIN = 'true';
    await getTestDataSource();
    ctx = await createPosTestApp();
    inventory = ctx.app.get(InventoryService, { strict: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  interface World {
    superJar: CookieJar;
    delegated: CookieJar;
    customer: CookieJar;
    cashier: { jar: CookieJar };
    productId: number;
    variantId: number;
    sku: string;
    posOrderId: number;
    webOrderId: number;
    /** Every body collected during setup (mutation responses). */
    setupBodies: Array<[string, unknown]>;
  }

  let world: World;

  async function build(): Promise<World> {
    await seedRoles(ctx.dataSource);
    const setupBodies: Array<[string, unknown]> = [];
    const keep = (surface: string, res: { status: number; body: unknown }) => {
      setupBodies.push([`${surface} (${res.status})`, res.body]);
      return res;
    };

    const superAdmin = await loginSuperAdmin(ctx);
    const superJar = superAdmin.jar;

    // ---- a delegated admin holding every grantable capability ------------
    const role = await withCookies(ctx, superJar)
      .post('/admin/access/roles')
      .send({
        name: fixtureRoleName('everything'),
        titleFa: 'همه‌کاره',
        permissions: EVERY_GRANTABLE_CAPABILITY,
      });
    expect(role.status).toBe(201);
    const staff = await createUser(ctx.dataSource, { roles: [] });
    const assigned = await withCookies(ctx, superJar)
      .put(`/admin/access/users/${staff.user.id}/roles`)
      .send({ roleIds: [Number(role.body.data.id)] });
    expect(assigned.status).toBe(200);
    const delegated = await authenticate(
      ctx,
      staff.username,
      staff.password,
      'admin',
    );

    // ---- a valued, published product ------------------------------------
    const category = await createCategory(ctx.dataSource);
    const created = keep(
      'POST /products (super_admin)',
      await withCookies(ctx, superJar)
        .post('/products')
        .send({
          title: 'کالای ارزش‌گذاری‌شده',
          description: 'leak fixture',
          basePrice: 1_000_000,
          categoryIds: [category.id],
          productCode: 'KZ-LEAK-0001',
          initialStock: 5,
          purchasePrice: 373_737,
          visibleOnSite: true,
          branchVisibility: 'all',
        }),
    );
    expect(created.status).toBe(201);
    const productId = Number(
      (created.body as { data: { id: number } }).data.id,
    );
    const [variant] = await ctx.dataSource.query(
      `SELECT id, sku FROM product_variants WHERE "productId" = $1`,
      [productId],
    );
    const variantId = Number(variant.id);

    await ctx.dataSource.transaction((m: EntityManager) =>
      inventory.receiveValued(m, {
        variantId,
        quantity: 3,
        unitCost: 404_040n,
        reason: StockMovementReason.STOCK_RECEIPT,
        reasonText: null,
        supplierReference: 'SUPPLIER-LEAK',
        actorUserId: superAdmin.userId,
        actorDisplaySnapshot: superAdmin.username,
        now: new Date(),
      }),
    );

    keep(
      'PATCH /products/:id (super_admin)',
      await withCookies(ctx, superJar)
        .patch(`/products/${productId}`)
        .send({ title: 'کالای ارزش‌گذاری‌شده ۲' }),
    );

    // ---- a POS sale, with realtime frames recorded ------------------------
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    resetPosEmitted();
    const posSale = keep(
      'POST /orders/pos (cashier)',
      await as(ctx, cashier)
        .post('/orders/pos')
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variantId, quantity: 2 }],
        }),
    );
    expect(posSale.status).toBe(201);
    const posOrderId = Number(
      (posSale.body as { data: { id: number } }).data.id,
    );

    // ---- a paid, fulfilled web order ------------------------------------
    const shopper = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const customer = await authenticate(
      ctx,
      shopper.username,
      shopper.password,
      'storefront',
    );
    const webOrderId = await makeOnlineOrder(ctx.dataSource, shopper.user.id, [
      { productId, variantId, quantity: 1 },
    ]);
    const started = keep(
      'POST /payment/start (customer)',
      await withCookies(ctx, customer)
        .post('/payment/start')
        .send({ orderId: webOrderId }),
    );
    expect(started.status).toBe(201);
    const verified = keep(
      'POST /payment/verify (customer)',
      await withCookies(ctx, customer)
        .post('/payment/verify')
        .send({
          trackId: (started.body as { data: { trackId: string } }).data.trackId,
        }),
    );
    expect(verified.status).toBe(201);

    // A basket line and a quote (not converted into an order).
    keep(
      'POST /cart (customer)',
      await withCookies(ctx, customer)
        .post('/cart')
        .send({ productId, variantId, quantity: 1 }),
    );

    // A negative stock adjust by the delegated admin (audited).
    keep(
      'POST /admin/inventory/variants/:id/adjust (delegated)',
      await withCookies(ctx, delegated)
        .post(`/admin/inventory/variants/${variantId}/adjust`)
        .send({ mode: 'delta', value: -1, reason: 'damaged unit' }),
    );

    // Sanity: the cost really was recognised, so the scan has figures to find.
    const lines = await ctx.dataSource.query(
      `SELECT "costStatus" FROM order_items WHERE "orderId" IN ($1, $2)`,
      [posOrderId, webOrderId],
    );
    expect(lines.map((l: { costStatus: string }) => l.costStatus)).toEqual([
      'known',
      'known',
    ]);

    return {
      superJar,
      delegated,
      customer,
      cashier,
      productId,
      variantId,
      sku: variant.sku,
      posOrderId,
      webOrderId,
      setupBodies,
    };
  }

  /** Every purchase-cost figure that exists in the database, as text. */
  async function costFigures(): Promise<Set<string>> {
    const rows: Array<{ v: string | null }> = await ctx.dataSource.query(
      `SELECT "inventoryCostValue"::text AS v FROM product_variants
       UNION SELECT "lastPurchaseUnitCost"::text FROM product_variants
       UNION SELECT "unitCost"::text FROM stock_movements
       UNION SELECT "costDelta"::text FROM stock_movements
       UNION SELECT (-"costDelta")::text FROM stock_movements
       UNION SELECT "inventoryValueAfter"::text FROM stock_movements
       UNION SELECT "cogsTotal"::text FROM order_items
       UNION SELECT (-"cogsTotal")::text FROM order_items`,
    );
    const figures = new Set(
      rows
        .map((r) => r.v)
        .filter((v): v is string => v !== null && v !== '0' && v !== '-0'),
    );
    // The fixture's own figures must be among them, or the scan proves nothing.
    for (const known of [
      '373737',
      '404040',
      '1868685',
      '3080805',
      '770201',
      '385100',
    ]) {
      expect(figures).toContain(known);
    }
    return figures;
  }

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    ctx.redis.flush();
    world = await build();
  });

  async function collect(
    requests: Array<
      [string, () => PromiseLike<{ status: number; body: unknown }>]
    >,
    expectOk = true,
  ): Promise<Array<[string, unknown]>> {
    const bodies: Array<[string, unknown]> = [];
    for (const [surface, send] of requests) {
      const res = await send();
      if (expectOk) {
        // The surface is in the assertion so a failure names the route.
        expect({ surface, ok: [200, 201].includes(res.status) }).toEqual({
          surface,
          ok: true,
        });
      }
      bodies.push([`${surface} (${res.status})`, res.body]);
    }
    return bodies;
  }

  async function assertClean(bodies: Array<[string, unknown]>): Promise<void> {
    const figures = await costFigures();
    const violations: Violation[] = [];
    for (const [surface, body] of bodies)
      scan(surface, body, figures, violations);
    expect(violations).toEqual([]);
  }

  // =========================================================================

  it('anonymous visitors: public catalogue list and detail', async () => {
    const bodies = await collect([
      ['GET /products (anonymous)', () => request(ctx.server).get('/products')],
      [
        'GET /products/:id (anonymous)',
        () => request(ctx.server).get(`/products/${world.productId}`),
      ],
    ]);
    await assertClean(bodies);
  });

  it('customers: catalogue, cart, quote, orders list and detail, payment responses', async () => {
    const c = withCookies(ctx, world.customer);
    const bodies = await collect([
      ['GET /products (customer)', () => c.get('/products')],
      [
        'GET /products/:id (customer)',
        () => c.get(`/products/${world.productId}`),
      ],
      ['GET /cart (customer)', () => c.get('/cart')],
      ['POST /orders/quote (customer)', () => c.post('/orders/quote').send({})],
      ['GET /me/orders (customer)', () => c.get('/me/orders')],
      [
        'GET /me/orders/:id (customer)',
        () => c.get(`/me/orders/${world.webOrderId}`),
      ],
    ]);
    await assertClean([
      ...bodies,
      ...world.setupBodies.filter(([s]) => s.includes('(customer)')),
    ]);
  });

  it('cashiers: POS catalogue, SKU lookup, availability, the receipt and the sale response', async () => {
    const t = withCookies(ctx, world.cashier.jar);
    const bodies = await collect([
      ['GET /inventory/catalog (cashier)', () => t.get('/inventory/catalog')],
      [
        'GET /inventory/lookup (cashier)',
        () => t.get(`/inventory/lookup?sku=${encodeURIComponent(world.sku)}`),
      ],
      [
        'GET /inventory/availability (cashier)',
        () => t.get(`/inventory/availability?variantIds=${world.variantId}`),
      ],
      [
        'GET /orders/:id receipt (cashier)',
        () => t.get(`/orders/${world.posOrderId}`),
      ],
    ]);
    await assertClean([
      ...bodies,
      ...world.setupBodies.filter(([s]) => s.includes('(cashier)')),
    ]);
  });

  it('a delegated admin holding EVERY grantable capability: products, orders, inventory, movements, dashboard, audit', async () => {
    const d = withCookies(ctx, world.delegated);
    const bodies = await collect([
      ['GET /products/admin (delegated)', () => d.get('/products/admin')],
      [
        'GET /products/admin/:id (delegated)',
        () => d.get(`/products/admin/${world.productId}`),
      ],
      ['GET /orders (delegated)', () => d.get('/orders')],
      [
        'GET /orders/:id pos (delegated)',
        () => d.get(`/orders/${world.posOrderId}`),
      ],
      [
        'GET /orders/:id web (delegated)',
        () => d.get(`/orders/${world.webOrderId}`),
      ],
      ['GET /admin/inventory (delegated)', () => d.get('/admin/inventory')],
      [
        'GET /admin/inventory/variants/:id (delegated)',
        () => d.get(`/admin/inventory/variants/${world.variantId}`),
      ],
      [
        'GET /admin/inventory/movements (delegated)',
        () => d.get('/admin/inventory/movements'),
      ],
      [
        'GET /admin/inventory/movements?variantId (delegated)',
        () => d.get(`/admin/inventory/movements?variantId=${world.variantId}`),
      ],
      [
        'GET /admin/dashboard/summary (delegated)',
        () => d.get('/admin/dashboard/summary'),
      ],
      ['GET /admin/audit (delegated)', () => d.get('/admin/audit?limit=100')],
    ]);
    // The audit trail really has rows about the valued product.
    const audit = bodies.find(([s]) =>
      s.startsWith('GET /admin/audit'),
    )![1] as {
      data: unknown[];
    };
    expect(audit.data.length).toBeGreaterThan(0);
    await assertClean([
      ...bodies,
      ...world.setupBodies.filter(([s]) => s.includes('(delegated)')),
    ]);
  });

  it('a super_admin: product, order, inventory and movement views carry no cost either', async () => {
    const s = withCookies(ctx, world.superJar);
    const bodies = await collect([
      ['GET /products/admin (super_admin)', () => s.get('/products/admin')],
      [
        'GET /products/admin/:id (super_admin)',
        () => s.get(`/products/admin/${world.productId}`),
      ],
      [
        'GET /products/:id (super_admin)',
        () => s.get(`/products/${world.productId}`),
      ],
      ['GET /orders (super_admin)', () => s.get('/orders')],
      [
        'GET /orders/:id pos (super_admin)',
        () => s.get(`/orders/${world.posOrderId}`),
      ],
      [
        'GET /orders/:id web (super_admin)',
        () => s.get(`/orders/${world.webOrderId}`),
      ],
      ['GET /admin/inventory (super_admin)', () => s.get('/admin/inventory')],
      [
        'GET /admin/inventory/variants/:id (super_admin)',
        () => s.get(`/admin/inventory/variants/${world.variantId}`),
      ],
      [
        'GET /admin/inventory/movements (super_admin)',
        () => s.get('/admin/inventory/movements'),
      ],
      ['GET /admin/audit (super_admin)', () => s.get('/admin/audit?limit=100')],
    ]);
    await assertClean([
      ...bodies,
      ...world.setupBodies.filter(([s2]) => s2.includes('(super_admin)')),
    ]);
  });

  it('error bodies of refused requests carry no cost', async () => {
    const d = withCookies(ctx, world.delegated);
    const s = withCookies(ctx, world.superJar);
    const t = as(ctx, world.cashier);
    const bodies = await collect(
      [
        [
          'POST /products with purchasePrice (delegated → 403)',
          () =>
            d.post('/products').send({
              title: 'x',
              description: 'x',
              productCode: 'KZ-LEAK-0002',
              purchasePrice: 373_737,
            }),
        ],
        [
          'POST /products without cost (super_admin → 400)',
          () =>
            s.post('/products').send({
              title: 'x',
              description: 'x',
              productCode: 'KZ-LEAK-0003',
              initialStock: 1,
            }),
        ],
        [
          'POST /products malformed cost (super_admin → 400)',
          () =>
            s.post('/products').send({
              title: 'x',
              description: 'x',
              productCode: 'KZ-LEAK-0004',
              initialStock: 1,
              purchasePrice: '373737.5',
            }),
        ],
        [
          'PATCH purchasePrice on existing variant (super_admin → 400)',
          () =>
            s.patch(`/products/${world.productId}`).send({
              variants: [{ id: world.variantId, purchasePrice: 404_040 }],
            }),
        ],
        [
          'positive adjust (delegated → 409)',
          () =>
            d
              .post(`/admin/inventory/variants/${world.variantId}/adjust`)
              .send({ mode: 'delta', value: 1, reason: 'found one' }),
        ],
        [
          'oversold POS sale (cashier → 409)',
          () =>
            t.post('/orders/pos').send({
              paymentMethod: PaymentMethodEnum.CASH,
              items: [{ productVariantId: world.variantId, quantity: 999 }],
            }),
        ],
        [
          'financial dashboard (delegated → 403)',
          () => d.get('/admin/dashboard/financial'),
        ],
        [
          'sales report (delegated → 403)',
          () => d.get('/reports/sales/summary?from=2026-01-01&to=2026-12-31'),
        ],
        [
          'admin products (anonymous → 401)',
          () => request(ctx.server).get('/products/admin'),
        ],
      ],
      false,
    );
    for (const [surface] of bodies) {
      expect(surface).toMatch(/\((4\d\d)\)$/);
    }
    await assertClean(bodies);
  });

  it('positive control: the scanner does find cost in the raw rows, and the scanned surfaces really carry the product', async () => {
    const figures = await costFigures();
    const raw = await ctx.dataSource.query(
      `SELECT * FROM product_variants WHERE id = $1`,
      [world.variantId],
    );
    const found: Violation[] = [];
    scan('raw product_variants row', raw, figures, found);
    expect(found.map((v) => v.detail)).toEqual(
      expect.arrayContaining([
        'unvaluedQuantity',
        'inventoryCostValue',
        'lastPurchaseUnitCost',
        'costStatus',
        '404040',
      ]),
    );

    // The views scanned above are not empty shells: they describe this SKU.
    const s = withCookies(ctx, world.superJar);
    const d = withCookies(ctx, world.delegated);
    const t = withCookies(ctx, world.cashier.jar);
    for (const [surface, res] of [
      [
        'public detail',
        await request(ctx.server).get(`/products/${world.productId}`),
      ],
      ['admin detail', await d.get(`/products/admin/${world.productId}`)],
      [
        'admin inventory variant',
        await s.get(`/admin/inventory/variants/${world.variantId}`),
      ],
      [
        'movements',
        await d.get(`/admin/inventory/movements?variantId=${world.variantId}`),
      ],
      ['pos catalogue', await t.get('/inventory/catalog')],
      ['receipt', await t.get(`/orders/${world.posOrderId}`)],
    ] as const) {
      expect({
        surface,
        carriesSku: JSON.stringify(res.body).includes(world.sku),
      }).toEqual({
        surface,
        carriesSku: true,
      });
    }
  });

  it('realtime frames published during the sale carry no cost', async () => {
    const frames = posEmitted();
    expect(frames.length).toBeGreaterThan(0);
    await assertClean(
      frames.map((f, i) => [`frame[${i}] ${f.event}`, f] as [string, unknown]),
    );
  });
});
