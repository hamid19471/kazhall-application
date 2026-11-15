/**
 * ============================================================================
 * PRODUCT CHANNEL VISIBILITY — «محل عرضه محصول» (migration 0030).
 *
 * Proves the two independent dimensions actually GATE the four surfaces, and
 * that no direct API call gets round them:
 *
 *   storefront list / detail   `visibleOnSite`
 *   POS catalogue / lookup     `branchVisibility` + the cashier's branch
 *   basket / checkout          `visibleOnSite`, refused server-side
 *   `POST /orders/pos`         `branchVisibility`, refused under lock
 *
 * THE DOMAIN BOUNDARY IS ALSO ASSERTED HERE: selecting branches must not
 * create per-branch stock. A product visible in two branches sells out of ONE
 * global quantity, and this file pins that.
 * ============================================================================
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';

import {
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { resetDb } from './setup/test-db';
import {
  createBranch,
  createProductWithVariant,
  createUser,
  seedRoles,
} from './setup/seed-helpers';
import { fixtureIdempotencyKey } from './setup/fixture-ids';

/** `branchVisibility` written directly, bypassing the service. */
async function setVisibility(
  ctx: TestApp,
  productId: number,
  visibleOnSite: boolean,
  mode: 'none' | 'all' | 'selected',
  branchIds: number[] = [],
): Promise<void> {
  await ctx.dataSource.transaction(async (manager) => {
    await manager.query(
      `UPDATE "products"
          SET "visibleOnSite" = $2,
              "branchVisibility" = $3::"public"."products_branchvisibility_enum"
        WHERE "id" = $1`,
      [productId, visibleOnSite, mode],
    );
    await manager.query(
      `DELETE FROM "product_branch_visibility" WHERE "productId" = $1`,
      [productId],
    );
    if (mode === 'selected' && branchIds.length > 0) {
      await manager.query(
        `INSERT INTO "product_branch_visibility" ("productId", "branchId")
         SELECT $1, unnest($2::int[])`,
        [productId, branchIds],
      );
    }
  });
}

describe('product channel visibility (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    ctx.redis.flush();
  });

  // =========================================================================
  // A. The storefront reads only what is published to the site
  // =========================================================================

  it('hides a non-site product from the public list AND the public detail', async () => {
    const { product } = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, product.id, false, 'all');

    const list = await withCookies(ctx, (await anonJar()) as never)
      .get('/products')
      .expect(200);
    expect(
      (list.body.data as Array<{ id: number }>).map((p) => p.id),
    ).not.toContain(product.id);

    // 404, never 403: a withdrawn product must be indistinguishable from one
    // that never existed, or the detail route enumerates the private catalogue.
    await withCookies(ctx, (await anonJar()) as never)
      .get(`/products/${product.id}`)
      .expect(404);
  });

  it('shows a site-visible product even when no branch carries it', async () => {
    const { product } = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, product.id, true, 'none');

    const detail = await withCookies(ctx, (await anonJar()) as never)
      .get(`/products/${product.id}`)
      .expect(200);
    expect(detail.body.data.id).toBe(product.id);

    // The two dimensions are INDEPENDENT: website-only is a real state.
    const list = await withCookies(ctx, (await anonJar()) as never)
      .get('/products')
      .expect(200);
    expect(
      (list.body.data as Array<{ id: number }>).map((p) => p.id),
    ).toContain(product.id);
  });

  it('keeps a withdrawn product out of SEARCH and CATEGORY filtering too', async () => {
    const { product } = await createProductWithVariant(ctx.dataSource, {
      title: 'Uniquely Findable Lantern',
    });
    await setVisibility(ctx, product.id, false, 'all');

    const search = await withCookies(ctx, (await anonJar()) as never)
      .get('/products')
      .query({ search: 'Uniquely Findable' })
      .expect(200);
    expect(search.body.data).toHaveLength(0);
  });

  /** An anonymous cookie jar — the storefront list is `@Public()`. */
  async function anonJar() {
    const { CookieJar } = await import('./setup/test-app');
    return new CookieJar();
  }

  // =========================================================================
  // B. The till reads only what its own branch carries
  // =========================================================================

  it('gives two branches two different catalogues from the same data', async () => {
    const branchA = await createBranch(ctx.dataSource);
    const branchB = await createBranch(ctx.dataSource);

    const everywhere = await createProductWithVariant(ctx.dataSource);
    const onlyA = await createProductWithVariant(ctx.dataSource);
    const onlyB = await createProductWithVariant(ctx.dataSource);
    const nowhere = await createProductWithVariant(ctx.dataSource);

    await setVisibility(ctx, everywhere.product.id, false, 'all');
    await setVisibility(ctx, onlyA.product.id, false, 'selected', [branchA.id]);
    await setVisibility(ctx, onlyB.product.id, false, 'selected', [branchB.id]);
    await setVisibility(ctx, nowhere.product.id, true, 'none');

    const seen = async (branchId: number): Promise<number[]> => {
      const { user, username, password } = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId,
      });
      expect(user.id).toBeGreaterThan(0);
      const jar = await authenticate(ctx, username, password, 'pos');
      const res = await withCookies(ctx, jar)
        .get('/inventory/catalog')
        .query({ limit: 100 })
        .expect(200);
      return (res.body.data as Array<{ id: number }>).map((p) => Number(p.id));
    };

    const inA = await seen(branchA.id);
    const inB = await seen(branchB.id);

    // `all` reaches both tills.
    expect(inA).toContain(everywhere.product.id);
    expect(inB).toContain(everywhere.product.id);

    // `selected` reaches exactly the branch that was chosen.
    expect(inA).toContain(onlyA.product.id);
    expect(inB).not.toContain(onlyA.product.id);
    expect(inB).toContain(onlyB.product.id);
    expect(inA).not.toContain(onlyB.product.id);

    // Website-only reaches NEITHER till.
    expect(inA).not.toContain(nowhere.product.id);
    expect(inB).not.toContain(nowhere.product.id);
  });

  it('gives a FUTURE branch the `all` products and none of the `selected` ones', async () => {
    const existing = await createBranch(ctx.dataSource);

    const everywhere = await createProductWithVariant(ctx.dataSource);
    const scoped = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, everywhere.product.id, false, 'all');
    await setVisibility(ctx, scoped.product.id, false, 'selected', [
      existing.id,
    ]);

    // The branch is created AFTER both products were configured.
    const future = await createBranch(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: future.id,
    });
    const jar = await authenticate(ctx, username, password, 'pos');
    const res = await withCookies(ctx, jar)
      .get('/inventory/catalog')
      .query({ limit: 100 })
      .expect(200);
    const ids = (res.body.data as Array<{ id: number }>).map((p) =>
      Number(p.id),
    );

    // `all` is a MODE, evaluated at read time — so it covers a branch that did
    // not exist when the product was configured. This is the whole reason it
    // is not materialised as rows.
    expect(ids).toContain(everywhere.product.id);
    // `selected` is the deliberate opposite.
    expect(ids).not.toContain(scoped.product.id);
  });

  it('exposes nothing through a DEACTIVATED branch, and restores on reactivation', async () => {
    const branch = await createBranch(ctx.dataSource);
    const { product } = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, product.id, false, 'selected', [branch.id]);

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const jar = await authenticate(ctx, username, password, 'pos');

    await ctx.dataSource.query(
      `UPDATE "branches" SET "isActive" = false WHERE "id" = $1`,
      [branch.id],
    );

    // A closed shop is REFUSED, not shown an empty grid: an empty grid is
    // indistinguishable from a shop that stocks nothing.
    await withCookies(ctx, jar).get('/inventory/catalog').expect(409);

    await ctx.dataSource.query(
      `UPDATE "branches" SET "isActive" = true WHERE "id" = $1`,
      [branch.id],
    );

    const after = await withCookies(ctx, jar)
      .get('/inventory/catalog')
      .query({ limit: 100 })
      .expect(200);
    // The mapping rows were never deleted, so reactivation restores exactly
    // the previous visibility with no administrative replay.
    expect(
      (after.body.data as Array<{ id: number }>).map((p) => Number(p.id)),
    ).toContain(product.id);
  });

  // =========================================================================
  // C. The direct POS API cannot be talked past
  // =========================================================================

  it('refuses a direct POS sale of a product the branch does not carry, atomically', async () => {
    const mine = await createBranch(ctx.dataSource);
    const other = await createBranch(ctx.dataSource);
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 5, price: 1_000_000 },
    );
    await setVisibility(ctx, product.id, false, 'selected', [other.id]);

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: mine.id,
    });
    const jar = await authenticate(ctx, username, password, 'pos');

    const res = await withCookies(ctx, jar)
      .post('/orders/pos')
      .set('Idempotency-Key', fixtureIdempotencyKey('vis'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(409);

    expect(res.body.error).toBe('PRODUCT_NOT_AVAILABLE_IN_BRANCH');
    expect(res.body.details.retryable).toBe(false);
    expect(res.body.details.branchId).toBe(mine.id);
    expect(res.body.details.variantId).toBe(variant.id);

    /*
     * SAFE DETAILS ONLY — asserted as an exact key set rather than by
     * substring-searching the JSON, which is unreliable: a branch id of `2`
     * appears inside the ISO timestamp "2026-…" and would fail a naive
     * `not.toContain('2')`.
     *
     * The rule being pinned is that the payload names the cashier's OWN branch
     * and the line they are looking at, and says nothing about which OTHER
     * branches carry the product, nor the mode, nor the selected list.
     */
    expect(Object.keys(res.body.details).sort()).toEqual([
      'branchId',
      'code',
      'productCode',
      'productId',
      'retryable',
      'variantCode',
      'variantId',
    ]);
    expect(res.body.details.branchId).not.toBe(other.id);
    const payload = JSON.stringify(res.body).toLowerCase();
    expect(payload).not.toContain('branchvisibility');
    expect(payload).not.toContain('product_branch_visibility');

    // ATOMIC: nothing at all was written.
    const [{ count: orders }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "orders"`,
    );
    const [{ count: items }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "order_items"`,
    );
    const [{ count: payments }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "payment"`,
    );
    const [{ count: movements }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "stock_movements"`,
    );
    expect([orders, items, payments, movements]).toEqual(['0', '0', '0', '0']);

    const [{ stock }] = await ctx.dataSource.query(
      `SELECT "stock"::text AS stock FROM "product_variants" WHERE "id" = $1`,
      [variant.id],
    );
    expect(stock).toBe('5');
  });

  it('rolls back EVERY line when only the second one is unavailable', async () => {
    const mine = await createBranch(ctx.dataSource);
    const other = await createBranch(ctx.dataSource);

    const ok = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 5, price: 1_000_000 },
    );
    const bad = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 5, price: 1_000_000 },
    );
    await setVisibility(ctx, ok.product.id, false, 'all');
    await setVisibility(ctx, bad.product.id, false, 'selected', [other.id]);

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: mine.id,
    });
    const jar = await authenticate(ctx, username, password, 'pos');

    await withCookies(ctx, jar)
      .post('/orders/pos')
      .set('Idempotency-Key', fixtureIdempotencyKey('multi'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: ok.variant.id, quantity: 1 },
          { productVariantId: bad.variant.id, quantity: 1 },
        ],
      })
      .expect(409);

    // The GOOD line's stock is untouched — the refusal is not partial.
    const [{ stock }] = await ctx.dataSource.query(
      `SELECT "stock"::text AS stock FROM "product_variants" WHERE "id" = $1`,
      [ok.variant.id],
    );
    expect(stock).toBe('5');
    const [{ count }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "orders"`,
    );
    expect(count).toBe('0');
  });

  it('SELLS a product the branch does carry, proving the gate is not blanket', async () => {
    const mine = await createBranch(ctx.dataSource);
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 5, price: 1_000_000 },
    );
    await setVisibility(ctx, product.id, false, 'selected', [mine.id]);

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: mine.id,
    });
    const jar = await authenticate(ctx, username, password, 'pos');

    await withCookies(ctx, jar)
      .post('/orders/pos')
      .set('Idempotency-Key', fixtureIdempotencyKey('sell'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);

    const [{ stock }] = await ctx.dataSource.query(
      `SELECT "stock"::text AS stock FROM "product_variants" WHERE "id" = $1`,
      [variant.id],
    );
    expect(stock).toBe('3');
  });

  // =========================================================================
  // D. THE DOMAIN BOUNDARY — visibility is not inventory
  // =========================================================================

  it('sells ONE global quantity across two branches that both carry the product', async () => {
    const branchA = await createBranch(ctx.dataSource);
    const branchB = await createBranch(ctx.dataSource);
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 1, price: 1_000_000 },
    );
    await setVisibility(ctx, product.id, false, 'selected', [
      branchA.id,
      branchB.id,
    ]);

    const cashier = async (branchId: number) => {
      const { username, password } = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId,
      });
      return authenticate(ctx, username, password, 'pos');
    };
    const jarA = await cashier(branchA.id);
    const jarB = await cashier(branchB.id);

    const body = {
      paymentMethod: PaymentMethodEnum.CASH,
      items: [{ productVariantId: variant.id, quantity: 1 }],
    };

    const [first, second] = await Promise.all([
      withCookies(ctx, jarA)
        .post('/orders/pos')
        .set('Idempotency-Key', fixtureIdempotencyKey('gA'))
        .send(body),
      withCookies(ctx, jarB)
        .post('/orders/pos')
        .set('Idempotency-Key', fixtureIdempotencyKey('gB'))
        .send(body),
    ]);

    /*
     * THE POINT OF THIS TEST. Two SELECTED branches do NOT get one unit each.
     * They share the single global `product_variants.stock`, so exactly one of
     * them sells and the other is refused for lack of stock — precisely as two
     * cashiers standing in the same shop would be.
     */
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);

    const [{ stock }] = await ctx.dataSource.query(
      `SELECT "stock"::text AS stock FROM "product_variants" WHERE "id" = $1`,
      [variant.id],
    );
    expect(stock).toBe('0');
    const [{ count }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "orders"`,
    );
    expect(count).toBe('1');
  });

  // =========================================================================
  // E. The database refuses states the service would never write
  // =========================================================================

  it('cannot commit `selected` with no branches, in either direction', async () => {
    const branch = await createBranch(ctx.dataSource);
    const { product } = await createProductWithVariant(ctx.dataSource);

    // mode without rows
    await expect(
      ctx.dataSource.transaction(async (manager) => {
        await manager.query(
          `UPDATE "products" SET "branchVisibility" = 'selected' WHERE "id" = $1`,
          [product.id],
        );
      }),
    ).rejects.toThrow();

    // rows without the mode
    await expect(
      ctx.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO "product_branch_visibility" ("productId", "branchId")
           VALUES ($1, $2)`,
          [product.id, branch.id],
        );
      }),
    ).rejects.toThrow();

    // and removing the LAST row of a selected product
    await setVisibility(ctx, product.id, false, 'selected', [branch.id]);
    await expect(
      ctx.dataSource.transaction(async (manager) => {
        await manager.query(
          `DELETE FROM "product_branch_visibility" WHERE "productId" = $1`,
          [product.id],
        );
      }),
    ).rejects.toThrow();
  });

  // =========================================================================
  // F. The basket and checkout cannot be talked past either
  // =========================================================================

  async function shopperJar() {
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.site],
    });
    return authenticate(ctx, username, password, 'storefront');
  }

  it('refuses to ADD a withdrawn product to a basket, as a 404', async () => {
    const { product, variant } = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, product.id, false, 'all');
    const jar = await shopperJar();

    /*
     * 404 and not 403: a refusal that distinguished "withdrawn" from "never
     * existed" would let a customer enumerate the private catalogue by POSTing
     * ids and reading the difference.
     */
    await withCookies(ctx, jar)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 1 })
      .expect(404);
  });

  it('keeps an EXISTING basket line but marks it channel_unavailable and blocks checkout', async () => {
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 5, price: 1_000_000 },
    );
    await setVisibility(ctx, product.id, true, 'all');
    const jar = await shopperJar();

    await withCookies(ctx, jar)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 1 })
      .expect(201);

    // The shop withdraws it from the website while the basket is open.
    await setVisibility(ctx, product.id, false, 'all');

    const cart = await withCookies(ctx, jar).get('/cart').expect(200);
    const line = (cart.body.data as Array<Record<string, any>>).find(
      (l) => Number(l.variant?.id) === variant.id,
    );

    /*
     * THE LINE IS STILL THERE. It is not silently deleted — the customer is
     * told what happened and asked to remove it — and its units are still
     * held.
     */
    expect(line).toBeDefined();
    expect(line!.change.reason).toBe('channel_unavailable');
    // NOT `not_sellable`: the variant is still active and may be selling in
    // the shops. Conflating the two would tell the customer it is discontinued.
    expect(line!.change.reason).not.toBe('not_sellable');
    expect(line!.change.at).toBeNull();
    expect(line!.change.quantityDelta).toBeNull();

    // And checkout is refused, authoritatively, with a stable code.
    const quote = await withCookies(ctx, jar).post('/orders/quote').send({});
    expect(quote.status).toBe(409);
    expect(quote.body.error).toBe('channel_unavailable');

    // Nothing about the retail channel travels to a storefront caller.
    const payload = JSON.stringify(quote.body);
    expect(payload.toLowerCase()).not.toContain('branchvisibility');
    expect(payload).not.toContain('product_branch_visibility');
  });

  it('reports variant_inactive, NOT channel_unavailable, when the SKU is retired', async () => {
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 5, price: 1_000_000 },
    );
    await setVisibility(ctx, product.id, true, 'all');
    const jar = await shopperJar();

    await withCookies(ctx, jar)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 1 })
      .expect(201);

    // Retire the SKU *and* withdraw the product: the broader condition wins,
    // because "cannot be sold at all" is more useful than "not on the site".
    await ctx.dataSource.query(
      `UPDATE "product_variants" SET "isActive" = false WHERE "id" = $1`,
      [variant.id],
    );
    await setVisibility(ctx, product.id, false, 'all');

    const cart = await withCookies(ctx, jar).get('/cart').expect(200);
    const line = (cart.body.data as Array<Record<string, any>>).find(
      (l) => Number(l.variant?.id) === variant.id,
    );
    expect(line!.change.reason).toBe('not_sellable');
  });

  // =========================================================================
  // G. Only super_admin may change visibility — enforced by the API
  // =========================================================================

  it('refuses a delegated catalogue editor any visibility change, in EITHER direction', async () => {
    const { product } = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, product.id, true, 'all');

    // A custom role holding the ordinary catalogue permissions but NOT
    // super_admin. `site` is used as a stand-in staff role here only to prove
    // the SERVICE refuses; the route decorator is a second, independent gate.
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(ctx, username, password, 'storefront');

    // WIDENING is refused...
    const widen = await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ visibleOnSite: true, branchVisibility: 'all' });
    expect([401, 403]).toContain(widen.status);

    // ...and so is NARROWING. Unpublishing looks harmless because it removes
    // reach rather than granting it, but it takes a product off the storefront
    // and out of every till.
    const narrow = await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ visibleOnSite: false, branchVisibility: 'none' });
    expect([401, 403]).toContain(narrow.status);

    // The stored configuration is untouched.
    const [row] = await ctx.dataSource.query(
      `SELECT "visibleOnSite", "branchVisibility"::text AS mode
         FROM "products" WHERE "id" = $1`,
      [product.id],
    );
    expect(row.visibleOnSite).toBe(true);
    expect(row.mode).toBe('all');
  });

  // =========================================================================
  // H. Visibility written THROUGH THE API round-trips correctly
  // =========================================================================

  it('round-trips every visibility state through PATCH and GET', async () => {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    const jar = await authenticate(ctx, username, password, 'admin');
    const branch = await createBranch(ctx.dataSource);
    const { product } = await createProductWithVariant(ctx.dataSource);

    /*
     * REGRESSION GUARD. Until this was written, no test drove these columns
     * through `PATCH /products/:id` at all — the suite set them with direct
     * SQL, and the one PATCH case expected a 403. That gap hid a bug where
     * `productRepo.save()` wrote the STALE in-memory visibility back over the
     * value just persisted, which surfaced as a 500 from the 0030 consistency
     * trigger whenever the join rows landed and the mode reverted.
     */
    const cases: Array<{
      label: string;
      body: Record<string, unknown>;
      expect: { visibleOnSite: boolean; mode: string; branches: number[] };
    }> = [
      {
        label: 'website only',
        body: { visibleOnSite: true, branchVisibility: 'none' },
        expect: { visibleOnSite: true, mode: 'none', branches: [] },
      },
      {
        label: 'selected branches',
        body: {
          visibleOnSite: false,
          branchVisibility: 'selected',
          branchIds: [branch.id],
        },
        expect: {
          visibleOnSite: false,
          mode: 'selected',
          branches: [branch.id],
        },
      },
      {
        label: 'all channels',
        body: { visibleOnSite: true, branchVisibility: 'all' },
        expect: { visibleOnSite: true, mode: 'all', branches: [] },
      },
      {
        label: 'hidden / draft',
        body: { visibleOnSite: false, branchVisibility: 'none' },
        expect: { visibleOnSite: false, mode: 'none', branches: [] },
      },
    ];

    for (const testCase of cases) {
      await withCookies(ctx, jar)
        .patch(`/products/${product.id}`)
        .send(testCase.body)
        .expect(200);

      // 1. What the API reports back.
      const read = await withCookies(ctx, jar)
        .get(`/products/admin/${product.id}`)
        .expect(200);
      const visibility = read.body.data.visibility as {
        visibleOnSite: boolean;
        branchVisibility: string;
        branches: Array<{ id: number }>;
        hiddenDraft: boolean;
      };
      expect([testCase.label, visibility.visibleOnSite]).toEqual([
        testCase.label,
        testCase.expect.visibleOnSite,
      ]);
      expect([testCase.label, visibility.branchVisibility]).toEqual([
        testCase.label,
        testCase.expect.mode,
      ]);
      expect(visibility.branches.map((b) => b.id)).toEqual(
        testCase.expect.branches,
      );
      expect(visibility.hiddenDraft).toBe(
        !testCase.expect.visibleOnSite && testCase.expect.mode === 'none',
      );

      // 2. What is actually in the database, including the join rows.
      const [row] = await ctx.dataSource.query(
        `SELECT p."visibleOnSite", p."branchVisibility"::text AS mode,
                (SELECT count(*)::int FROM "product_branch_visibility" pbv
                  WHERE pbv."productId" = p."id") AS rows
           FROM "products" p WHERE p."id" = $1`,
        [product.id],
      );
      expect([testCase.label, row.visibleOnSite, row.mode, row.rows]).toEqual([
        testCase.label,
        testCase.expect.visibleOnSite,
        testCase.expect.mode,
        testCase.expect.branches.length,
      ]);
    }
  });

  it('makes a duplicate branch mapping impossible', async () => {
    const branch = await createBranch(ctx.dataSource);
    const { product } = await createProductWithVariant(ctx.dataSource);
    await setVisibility(ctx, product.id, false, 'selected', [branch.id]);

    await expect(
      ctx.dataSource.query(
        `INSERT INTO "product_branch_visibility" ("productId", "branchId")
         VALUES ($1, $2)`,
        [product.id, branch.id],
      ),
    ).rejects.toThrow();
  });
});
