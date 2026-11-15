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
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * POS INVENTORY VISIBILITY
 * ===========================================================================
 *
 * THE GAP THESE ENDPOINTS CLOSE. Before them, a `sale` cashier could not see a
 * stock number anywhere in the API — every endpoint carrying one was
 * `super_admin` — and `GET /products` searches product TITLES only
 * (`LOWER(p.title) LIKE ...`), so a scanned barcode matched nothing. A till
 * could not look up a SKU and could not tell whether it had the units.
 *
 * Both routes are READS of facts the accepted contracts already define: the
 * globally unique `product_variants.sku`, the variant's own price, and
 * `AvailabilitySnapshot`. No pricing rule, no reservation and no financial
 * policy is introduced.
 */
describe('POS inventory visibility', () => {
  let app: TestApp;
  let cashier: CookieJar;
  let admin: CookieJar;
  let customer: CookieJar;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();

    const branch = await createBranch(app.dataSource);
    const sale = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    cashier = await authenticate(app, sale.username, sale.password);

    const su = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    admin = await authenticate(app, su.username, su.password);

    const site = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    customer = await authenticate(app, site.username, site.password);
  });

  // =========================================================================
  // GET /inventory/lookup
  // =========================================================================

  it('lets a CASHIER look up a SKU and see price and availability', async () => {
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      { title: 'Till Kettle' },
      { sku: 'TILL-KETTLE-01', stock: 7, price: 450_000 },
    );

    const response = await withCookies(app, cashier).get(
      '/inventory/lookup?sku=TILL-KETTLE-01',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      productId: product.id,
      productTitle: 'Till Kettle',
      variantId: variant.id,
      sku: 'TILL-KETTLE-01',
      unitPrice: 450_000,
      isActive: true,
      availability: {
        variantId: variant.id,
        physicalStock: 7,
        basketReserved: 0,
        orderAllocated: 0,
        availableForBasket: 7,
        availableForPos: 7,
      },
    });
  });

  it('reflects a basket hold: POS may still take those units, ecommerce may not', async () => {
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { sku: 'TILL-HELD-01', stock: 5, price: 100_000 },
    );
    // A customer holds 2 units in their basket.
    const held = await withCookies(app, customer)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 2 });
    expect([200, 201]).toContain(held.status);

    const response = await withCookies(app, cashier).get(
      '/inventory/lookup?sku=TILL-HELD-01',
    );

    /**
     * THE GAP BETWEEN THE TWO AVAILABILITIES IS THE POINT. Ecommerce may only
     * take 3, but the till may take all 5 — a POS sale outranks a basket hold.
     * A till that displayed `availableForBasket` would refuse sales it is
     * entitled to make.
     */
    expect(response.body.data.availability).toMatchObject({
      physicalStock: 5,
      basketReserved: 2,
      orderAllocated: 0,
      availableForBasket: 3,
      availableForPos: 5,
    });
  });

  it('returns a retired SKU with isActive false rather than 404', async () => {
    const { variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { sku: 'TILL-RETIRED-01', stock: 2, price: 100_000 },
    );
    await app.dataSource.query(
      `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
      [variant.id],
    );

    const response = await withCookies(app, cashier).get(
      '/inventory/lookup?sku=TILL-RETIRED-01',
    );

    // "This SKU is retired" is a different message at the till from
    // "unknown SKU", and the cashier needs to be able to tell them apart.
    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);
  });

  it('answers 404 for an unknown SKU', async () => {
    const response = await withCookies(app, cashier).get(
      '/inventory/lookup?sku=NOPE-DOES-NOT-EXIST',
    );
    expect(response.status).toBe(404);
  });

  it('requires the sku parameter', async () => {
    const response = await withCookies(app, cashier).get('/inventory/lookup');
    expect(response.status).toBe(400);
  });

  // =========================================================================
  // GET /inventory/availability
  // =========================================================================

  it('returns availability for a batch of variants', async () => {
    const a = await createProductWithVariant(
      app.dataSource,
      {},
      { sku: 'BATCH-A', stock: 4, price: 100_000 },
    );
    const b = await createProductWithVariant(
      app.dataSource,
      {},
      { sku: 'BATCH-B', stock: 9, price: 200_000 },
    );

    const response = await withCookies(app, cashier).get(
      `/inventory/availability?variantIds=${a.variant.id},${b.variant.id}`,
    );

    expect(response.status).toBe(200);
    const byId = new Map(
      (response.body.data as Array<{ variantId: number }>).map((row) => [
        row.variantId,
        row,
      ]),
    );
    expect(byId.get(a.variant.id)).toMatchObject({ physicalStock: 4 });
    expect(byId.get(b.variant.id)).toMatchObject({ physicalStock: 9 });
  });

  it('fails the whole request with 404 when an id is unknown, naming it', async () => {
    const a = await createProductWithVariant(
      app.dataSource,
      {},
      { sku: 'BATCH-C', stock: 3, price: 100_000 },
    );

    const response = await withCookies(app, cashier).get(
      `/inventory/availability?variantIds=${a.variant.id},999999`,
    );

    /**
     * THE EXISTING INVENTORY CONTRACT, not a choice made for this endpoint.
     * `computeAvailability` throws for ids it cannot resolve and `lockVariants`
     * does the same, because every consuming path — checkout, POS — must fail
     * loudly rather than silently price a basket it could not fully resolve.
     * A first draft of this test expected the unknown id to be omitted; that
     * would have meant changing accepted production behaviour to suit a test.
     */
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain('999999');
  });

  it('rejects an empty or oversized id list', async () => {
    expect(
      (await withCookies(app, cashier).get('/inventory/availability')).status,
    ).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    expect(
      (
        await withCookies(app, cashier).get(
          `/inventory/availability?variantIds=${tooMany}`,
        )
      ).status,
    ).toBe(400);
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it('allows super_admin and refuses a customer', async () => {
    const { variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { sku: 'ROLE-CHECK', stock: 1, price: 100_000 },
    );

    expect(
      (await withCookies(app, admin).get('/inventory/lookup?sku=ROLE-CHECK'))
        .status,
    ).toBe(200);
    expect(
      (
        await withCookies(app, admin).get(
          `/inventory/availability?variantIds=${variant.id}`,
        )
      ).status,
    ).toBe(200);

    // A `site` customer must never see stock integers: the public catalog
    // deliberately exposes only `inStock`. The refusal is now 401 rather than
    // 403 because these routes serve the till and the admin console, and a
    // shopper's storefront session is turned away at the audience layer first.
    expect(
      (await withCookies(app, customer).get('/inventory/lookup?sku=ROLE-CHECK'))
        .status,
    ).toBe(401);
    expect(
      (
        await withCookies(app, customer).get(
          `/inventory/availability?variantIds=${variant.id}`,
        )
      ).status,
    ).toBe(401);
  });
});
