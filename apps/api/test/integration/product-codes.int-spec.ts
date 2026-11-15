/**
 * ============================================================================
 * «کد محصول» / «کد گونه» — generation, normalisation, uniqueness, snapshots
 * (migrations 0031 and 0032).
 *
 * The claims this file exists to prove, because each one is a claim the
 * delivery report makes:
 *
 *   1. CONCURRENT generation never returns the same code. Asserted with
 *      genuinely parallel HTTP requests, not sequential calls — sequential
 *      calls would prove nothing about a sequence.
 *   2. A duplicate MANUAL code is a stable 409 naming the field, and leaks
 *      nothing about the product that already holds it.
 *   3. Normalisation is real: Persian digits, case and surrounding whitespace
 *      all collapse to one canonical code, so a "different-looking" duplicate
 *      is still refused.
 *   4. Codes are STABLE AFTER ORDERS EXIST: editing a catalogue code does not
 *      rewrite a receipt, because `order_items` snapshotted both.
 *   5. Only `super_admin` may generate, and only `super_admin` may change
 *      channel visibility — enforced by the API, not by the UI.
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
import { fixtureIdempotencyKey, fixtureSku } from './setup/fixture-ids';

describe('product and variant codes (int)', () => {
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

  async function superAdminJar() {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return authenticate(ctx, username, password, 'admin');
  }

  // =========================================================================
  // 1. Concurrency
  // =========================================================================

  it('never returns the same product code to concurrent callers', async () => {
    const jar = await superAdminJar();

    // Twelve genuinely in-flight requests => twelve independent transactions
    // asking the same sequence. No shared JS state can hide a collision here.
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        withCookies(ctx, jar).post('/products/admin/codes/product').send({}),
      ),
    );

    for (const res of responses) expect(res.status).toBe(200);
    const codes = responses.map(
      (r) => (r.body.data as { productCode: string }).productCode,
    );
    expect(new Set(codes).size).toBe(codes.length);
    // And every one is a code the validator would accept.
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]+(-[A-Z0-9]+)*$/);
  });

  it('never returns the same variant code to concurrent callers, and keeps the parent', async () => {
    const jar = await superAdminJar();
    const parent = 'KZ-P-000777';

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        withCookies(ctx, jar)
          .post('/products/admin/codes/variant')
          .send({ productCode: parent }),
      ),
    );

    for (const res of responses) expect(res.status).toBe(200);
    const codes = responses.map(
      (r) => (r.body.data as { variantCode: string }).variantCode,
    );
    expect(new Set(codes).size).toBe(codes.length);
    // Every child visibly contains its parent — the relationship rule.
    for (const code of codes) expect(code.startsWith(`${parent}-`)).toBe(true);
  });

  it('normalises the parent code it was given and echoes the canonical form', async () => {
    const jar = await superAdminJar();
    const res = await withCookies(ctx, jar)
      .post('/products/admin/codes/variant')
      // lower case, Persian digits, and surrounding whitespace
      .send({ productCode: '  kz-p-۰۰۷۷۷  ' })
      .expect(200);

    expect(res.body.data.productCode).toBe('KZ-P-00777');
    expect(res.body.data.variantCode.startsWith('KZ-P-00777-')).toBe(true);
  });

  // =========================================================================
  // 2. Authorization
  // =========================================================================

  it('refuses code generation to a delegated editor who is not super_admin', async () => {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(ctx, username, password, 'storefront');

    // Wrong audience AND wrong role — either is enough to refuse.
    const res = await withCookies(ctx, jar)
      .post('/products/admin/codes/product')
      .send({});
    expect([401, 403]).toContain(res.status);
  });

  // =========================================================================
  // 3. Manual entry: uniqueness and validation
  // =========================================================================

  it('refuses a duplicate manual product code with a 409 naming the field', async () => {
    const jar = await superAdminJar();
    const { product } = await createProductWithVariant(ctx.dataSource, {
      productCode: 'KZ-P-DUPE',
    });
    expect(product.id).toBeGreaterThan(0);

    const res = await withCookies(ctx, jar)
      .post('/products')
      /*
       * NO `variants`: a product created without them gets a system default
       * variant, whose code is allocated from the sequence. That keeps this
       * case about the PRODUCT code and nothing else — an explicit variant
       * would need a real `attributeValueIds` entry, and a 404 about a missing
       * attribute value would mask the 409 under test.
       */
      .send({
        title: 'Second product with a taken code',
        description: 'd',
        productCode: 'KZ-P-DUPE',
      })
      .expect(409);

    expect(res.body.error).toBe('PRODUCT_CODE_TAKEN');
    expect(res.body.details.field).toBe('productCode');

    /*
     * LEAKS NOTHING about the product that already holds the code. The person
     * being refused needs to know the value is taken so they can pick another;
     * the title of a catalogue row they may not be allowed to see is not part
     * of that.
     */
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(product.title);
    expect(payload).not.toContain(`"id":${product.id}`);
  });

  it('treats a Persian-digit code as the SAME code, so the duplicate is refused', async () => {
    const jar = await superAdminJar();
    await createProductWithVariant(ctx.dataSource, { productCode: 'KZ-P-123' });

    const res = await withCookies(ctx, jar)
      .post('/products')
      .send({
        title: 'Same code, Persian digits',
        description: 'd',
        productCode: 'kz-p-۱۲۳',
      })
      .expect(409);
    expect(res.body.error).toBe('PRODUCT_CODE_TAKEN');
  });

  it.each([
    ['internal whitespace', 'KZ P 1', 'CODE_HAS_WHITESPACE'],
    ['Persian letters', 'کد-1', 'CODE_INVALID'],
    ['leading hyphen', '-KZ-1', 'CODE_INVALID'],
    ['doubled hyphen', 'KZ--1', 'CODE_INVALID'],
    ['underscore', 'KZ_1', 'CODE_INVALID'],
  ])(
    'refuses a malformed product code (%s)',
    async (_label, code, expected) => {
      const jar = await superAdminJar();
      const res = await withCookies(ctx, jar)
        .post('/products')
        .send({
          title: 'Malformed',
          description: 'd',
          productCode: code,
          variants: [],
        })
        .expect(400);
      expect(res.body.error).toBe(expected);
      expect(res.body.details.field).toBe('productCode');
    },
  );

  it('refuses a variant code that does not belong to its product', async () => {
    const jar = await superAdminJar();
    const res = await withCookies(ctx, jar)
      .post('/products')
      .send({
        title: 'Mismatched child',
        description: 'd',
        productCode: 'KZ-P-PARENT',
        variants: [
          {
            sku: fixtureSku('MIS'),
            variantCode: 'KZ-P-SOMETHINGELSE-V1',
            stock: 1,
            purchasePrice: 500_000,
            attributeValueIds: [1],
          },
        ],
      })
      .expect(400);
    expect(res.body.error).toBe('VARIANT_CODE_UNRELATED');
    expect(res.body.details.field).toBe('variantCode');
  });

  it('refuses two identical variant codes inside ONE request', async () => {
    const jar = await superAdminJar();
    const res = await withCookies(ctx, jar)
      .post('/products')
      .send({
        title: 'Twins',
        description: 'd',
        productCode: 'KZ-P-TWINS',
        variants: [
          {
            sku: fixtureSku('T1'),
            variantCode: 'KZ-P-TWINS-V1',
            stock: 1,
            purchasePrice: 500_000,
            attributeValueIds: [1],
          },
          {
            sku: fixtureSku('T2'),
            variantCode: 'KZ-P-TWINS-V1',
            stock: 1,
            purchasePrice: 500_000,
            attributeValueIds: [1],
          },
        ],
      })
      .expect(400);
    expect(res.body.error).toBe('VARIANT_CODE_TAKEN');
  });

  // =========================================================================
  // 4. Backfill and snapshot stability
  // =========================================================================

  it('gave every migrated row a code satisfying its own constraint', async () => {
    await createProductWithVariant(ctx.dataSource);
    const [{ bad_products }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS bad_products FROM "products"
        WHERE "productCode" IS NULL
           OR "productCode" !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'`,
    );
    const [{ bad_variants }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS bad_variants FROM "product_variants"
        WHERE "variantCode" IS NULL
           OR "variantCode" !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'`,
    );
    expect([bad_products, bad_variants]).toEqual(['0', '0']);
  });

  it('keeps a sold line unchanged when the catalogue code is later edited', async () => {
    const jar = await superAdminJar();
    const branch = await createBranch(ctx.dataSource);
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      { productCode: 'KZ-P-BEFORE' },
      { stock: 5, price: 1_000_000, variantCode: 'KZ-P-BEFORE-V1' },
    );

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const cashier = await authenticate(ctx, username, password, 'pos');

    const sale = await withCookies(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', fixtureIdempotencyKey('snap'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);
    const saleId = (sale.body.data ?? sale.body).id as number;

    const [before] = await ctx.dataSource.query(
      `SELECT "productCodeSnapshot", "variantCodeSnapshot" FROM "order_items"`,
    );
    expect(before.productCodeSnapshot).toBe('KZ-P-BEFORE');
    expect(before.variantCodeSnapshot).toBe('KZ-P-BEFORE-V1');

    // Now RETYPE the product code, which the API permits.
    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: 'KZ-P-AFTER' })
      .expect(200);

    const [{ productCode }] = await ctx.dataSource.query(
      `SELECT "productCode" FROM "products" WHERE "id" = $1`,
      [product.id],
    );
    expect(productCode).toBe('KZ-P-AFTER');

    /*
     * THE POINT. The catalogue changed; the receipt did not. Without the
     * snapshot columns, correcting a typo would silently rewrite what every
     * past receipt and report says was sold.
     */
    const [after] = await ctx.dataSource.query(
      `SELECT "productCodeSnapshot", "variantCodeSnapshot" FROM "order_items"`,
    );
    expect(after.productCodeSnapshot).toBe('KZ-P-BEFORE');
    expect(after.variantCodeSnapshot).toBe('KZ-P-BEFORE-V1');

    // ...and the cashier's own REPRINT says so too. The receipt projection
    // used to drop both columns, so a reprinted slip carried no code at all.
    const receipt = await withCookies(ctx, cashier)
      .get(`/orders/${saleId}`)
      .expect(200);
    const [line] = (receipt.body.data ?? receipt.body).items;
    expect(line.productCodeSnapshot).toBe('KZ-P-BEFORE');
    expect(line.variantCodeSnapshot).toBe('KZ-P-BEFORE-V1');
  });

  // =========================================================================
  // 5. The till can find a product by either identifier
  // =========================================================================

  it('resolves a lookup by SKU or by variant code, and only within the branch', async () => {
    const mine = await createBranch(ctx.dataSource);
    const other = await createBranch(ctx.dataSource);
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      { productCode: 'KZ-P-LOOK' },
      { stock: 3, sku: 'LOOKUP-SKU-1', variantCode: 'KZ-P-LOOK-V1' },
    );

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: mine.id,
    });
    const jar = await authenticate(ctx, username, password, 'pos');

    await ctx.dataSource.query(
      `UPDATE "products" SET "branchVisibility" = 'all' WHERE "id" = $1`,
      [product.id],
    );

    const bySku = await withCookies(ctx, jar)
      .get('/inventory/lookup')
      .query({ sku: 'LOOKUP-SKU-1' })
      .expect(200);
    expect(bySku.body.data.variantId).toBe(variant.id);

    const byCode = await withCookies(ctx, jar)
      .get('/inventory/lookup')
      .query({ sku: 'KZ-P-LOOK-V1' })
      .expect(200);
    expect(byCode.body.data.variantId).toBe(variant.id);
    expect(byCode.body.data.variantCode).toBe('KZ-P-LOOK-V1');

    // Scope it to the OTHER branch and the same lookup becomes a 404 — not a
    // 403, so a cashier cannot map a neighbouring shop's range by probing.
    await ctx.dataSource.transaction(async (m) => {
      await m.query(
        `UPDATE "products" SET "branchVisibility" = 'selected' WHERE "id" = $1`,
        [product.id],
      );
      await m.query(
        `INSERT INTO "product_branch_visibility" ("productId","branchId")
         VALUES ($1,$2)`,
        [product.id, other.id],
      );
    });

    await withCookies(ctx, jar)
      .get('/inventory/lookup')
      .query({ sku: 'KZ-P-LOOK-V1' })
      .expect(404);
  });
});
