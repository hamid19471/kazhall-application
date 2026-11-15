import { MAX_RIAL } from 'src/common/money/rial';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { resetDb } from './setup/test-db';
import { createCategory, createUser, seedRoles } from './setup/seed-helpers';
import { uniqueSuffix } from './setup/fixture-ids';
import { seedAttribute } from './support/catalog.fixtures';
import { loginSuperAdmin } from './support/pos.fixtures';

/**
 * ============================================================================
 * OPENING STOCK ENTERS AT ITS PURCHASE COST (docs/PURCHASE-COST-ACCOUNTING.md
 * §6, §8, §11).
 *
 * Every figure below is an exact integer: a pool is `{stock, unvaluedQuantity,
 * inventoryCostValue}` and the value is compared as the bigint's text, never
 * as a JavaScript number.
 * ============================================================================
 */
describe('purchase cost on product create / update (int)', () => {
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

  // --------------------------------------------------------------- helpers

  interface PoolRow {
    stock: number;
    unvaluedQuantity: number;
    inventoryCostValue: string;
    lastPurchaseUnitCost: string | null;
    costStatus: string;
  }

  async function poolOf(variantId: number): Promise<PoolRow> {
    const [row] = await ctx.dataSource.query(
      `SELECT stock, "unvaluedQuantity",
              "inventoryCostValue"::text AS "inventoryCostValue",
              "lastPurchaseUnitCost"::text AS "lastPurchaseUnitCost",
              "costStatus"
         FROM product_variants WHERE id = $1`,
      [variantId],
    );
    return {
      stock: Number(row.stock),
      unvaluedQuantity: Number(row.unvaluedQuantity),
      inventoryCostValue: row.inventoryCostValue,
      lastPurchaseUnitCost: row.lastPurchaseUnitCost,
      costStatus: row.costStatus,
    };
  }

  async function variantsOf(
    productId: number,
  ): Promise<Array<{ id: number; sku: string; isDefault: boolean }>> {
    const rows = await ctx.dataSource.query(
      `SELECT id, sku, "isDefault" FROM product_variants
        WHERE "productId" = $1 ORDER BY id`,
      [productId],
    );
    return rows.map((r: { id: number; sku: string; isDefault: boolean }) => ({
      ...r,
      id: Number(r.id),
    }));
  }

  async function movementsOf(variantId: number) {
    const rows = await ctx.dataSource.query(
      `SELECT id, delta, "balanceAfter", reason::text AS reason,
              "unitCost"::text AS "unitCost",
              "costDelta"::text AS "costDelta",
              "inventoryValueAfter"::text AS "inventoryValueAfter",
              "unvaluedQuantityDelta", "unvaluedQuantityAfter",
              "actorUserId", "actorDisplaySnapshot", "orderId"
         FROM stock_movements WHERE "variantId" = $1 ORDER BY id`,
      [variantId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      delta: Number(r.delta),
      balanceAfter: Number(r.balanceAfter),
      actorUserId: r.actorUserId === null ? null : Number(r.actorUserId),
    }));
  }

  async function counts(): Promise<{
    products: number;
    variants: number;
    movements: number;
    value: string;
    remembered: number;
  }> {
    const [row] = await ctx.dataSource.query(
      `SELECT (SELECT count(*)::int FROM products) AS products,
              (SELECT count(*)::int FROM product_variants) AS variants,
              (SELECT count(*)::int FROM stock_movements) AS movements,
              (SELECT COALESCE(SUM("inventoryCostValue"), 0)::text FROM product_variants) AS value,
              (SELECT count(*)::int FROM product_variants
                WHERE "lastPurchaseUnitCost" IS NOT NULL) AS remembered`,
    );
    return row;
  }

  const NOTHING = {
    products: 0,
    variants: 0,
    movements: 0,
    value: '0',
    remembered: 0,
  };

  let codeCounter = 0;
  function nextCode(): string {
    codeCounter += 1;
    return `KZ-PC-${String(codeCounter).padStart(4, '0')}`;
  }

  async function createProduct(
    jar: CookieJar,
    body: Record<string, unknown>,
    code = nextCode(),
  ) {
    const category = await createCategory(ctx.dataSource);
    return withCookies(ctx, jar)
      .post('/products')
      .send({
        title: `کالای ${code}`,
        description: 'purchase-cost fixture',
        basePrice: 2_500_000,
        categoryIds: [category.id],
        productCode: code,
        ...body,
      });
  }

  async function delegatedAdmin(
    superJar: CookieJar,
    permissions: string[],
  ): Promise<CookieJar> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const role = await withCookies(ctx, superJar)
      .post('/admin/access/roles')
      .send({
        name: `role_${suffix}`,
        titleFa: 'نقش آزمایشی',
        permissions: ['admin.access', ...permissions],
      });
    expect(role.status).toBe(201);
    const created = await createUser(ctx.dataSource, { roles: [] });
    const assign = await withCookies(ctx, superJar)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [Number(role.body.data.id)] });
    expect(assign.status).toBe(200);
    return authenticate(ctx, created.username, created.password, 'admin');
  }

  async function colourValues(n: number): Promise<number[]> {
    const { values } = await seedAttribute(
      ctx.dataSource,
      `colour_${uniqueSuffix()}`,
      Array.from({ length: n }, (_, i) => `c${i}_${uniqueSuffix()}`),
    );
    return values.map((v) => v.id);
  }

  // =======================================================================
  // simple product
  // =======================================================================

  describe('simple product', () => {
    it('values the opening stock at q × c on the default variant with one initial_stock movement', async () => {
      const admin = await loginSuperAdmin(ctx);
      const res = await createProduct(admin.jar, {
        initialStock: 7,
        purchasePrice: 123_457,
      });
      expect(res.status).toBe(201);
      const productId = Number(res.body.data.id);

      const variants = await variantsOf(productId);
      expect(variants).toHaveLength(1);
      expect(variants[0].isDefault).toBe(true);

      expect(await poolOf(variants[0].id)).toEqual({
        stock: 7,
        unvaluedQuantity: 0,
        inventoryCostValue: '864199', // 7 × 123 457
        lastPurchaseUnitCost: '123457',
        costStatus: 'valued',
      });

      const movements = await movementsOf(variants[0].id);
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        reason: 'initial_stock',
        delta: 7,
        balanceAfter: 7,
        unitCost: '123457',
        costDelta: '864199',
        inventoryValueAfter: '864199',
        unvaluedQuantityDelta: 0,
        unvaluedQuantityAfter: 0,
        actorUserId: admin.userId,
        orderId: null,
      });
      expect(typeof movements[0].actorDisplaySnapshot).toBe('string');
      expect(
        (movements[0].actorDisplaySnapshot as string).length,
      ).toBeGreaterThan(0);
    });

    it('accepts the cost as a base-10 integer string', async () => {
      const admin = await loginSuperAdmin(ctx);
      const res = await createProduct(admin.jar, {
        initialStock: 3,
        purchasePrice: '45035996273', // MAX_RIAL, as a string
      });
      expect(res.status).toBe(201);
      const [variant] = await variantsOf(Number(res.body.data.id));
      expect(await poolOf(variant.id)).toMatchObject({
        stock: 3,
        unvaluedQuantity: 0,
        inventoryCostValue: (3n * BigInt(MAX_RIAL)).toString(),
        lastPurchaseUnitCost: String(MAX_RIAL),
      });
    });

    it('zero stock + purchasePrice remembers the price only: no movement, no value', async () => {
      const admin = await loginSuperAdmin(ctx);
      const res = await createProduct(admin.jar, {
        initialStock: 0,
        purchasePrice: 88_000,
      });
      expect(res.status).toBe(201);
      const [variant] = await variantsOf(Number(res.body.data.id));
      expect(await poolOf(variant.id)).toEqual({
        stock: 0,
        unvaluedQuantity: 0,
        inventoryCostValue: '0',
        lastPurchaseUnitCost: '88000',
        costStatus: 'valued',
      });
      expect(await movementsOf(variant.id)).toEqual([]);
    });

    it('an explicit zero cost is a KNOWN cost of 0 (valued), not unknown', async () => {
      const admin = await loginSuperAdmin(ctx);
      const res = await createProduct(admin.jar, {
        initialStock: 4,
        purchasePrice: 0,
      });
      expect(res.status).toBe(201);
      const [variant] = await variantsOf(Number(res.body.data.id));
      expect(await poolOf(variant.id)).toEqual({
        stock: 4,
        unvaluedQuantity: 0,
        inventoryCostValue: '0',
        lastPurchaseUnitCost: '0',
        costStatus: 'valued',
      });
      const [movement] = await movementsOf(variant.id);
      expect(movement).toMatchObject({
        reason: 'initial_stock',
        delta: 4,
        unitCost: '0',
        costDelta: '0',
        inventoryValueAfter: '0',
        unvaluedQuantityDelta: 0,
        unvaluedQuantityAfter: 0,
      });
    });

    it('a missing cost with stock is 400 INITIAL_STOCK_REQUIRES_PURCHASE_COST and writes nothing', async () => {
      const admin = await loginSuperAdmin(ctx);
      const before = await counts();
      expect(before).toEqual(NOTHING);

      const res = await createProduct(admin.jar, { initialStock: 5 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INITIAL_STOCK_REQUIRES_PURCHASE_COST');
      expect(await counts()).toEqual(before);
    });

    it.each<[string, unknown, string]>([
      ['a fraction', 1.5, 'PURCHASE_COST_INVALID'],
      ['an exponent string', '1e3', 'PURCHASE_COST_INVALID'],
      ['a decimal string', '12.0', 'PURCHASE_COST_INVALID'],
      ['an empty string', '', 'PURCHASE_COST_INVALID'],
      ['null', null, 'PURCHASE_COST_INVALID'],
      ['a boolean', true, 'PURCHASE_COST_INVALID'],
      ['an unsafe integer', 2 ** 53, 'PURCHASE_COST_INVALID'],
      ['a negative number', -1, 'PURCHASE_COST_OUT_OF_RANGE'],
      ['a negative string', '-1', 'PURCHASE_COST_OUT_OF_RANGE'],
      ['MAX_RIAL + 1', MAX_RIAL + 1, 'PURCHASE_COST_OUT_OF_RANGE'],
      [
        'MAX_RIAL + 1 as a string',
        String(MAX_RIAL + 1),
        'PURCHASE_COST_OUT_OF_RANGE',
      ],
    ])(
      'refuses %s (%p) with a stable 400 code and writes nothing',
      async (_label, price, code) => {
        const admin = await loginSuperAdmin(ctx);
        const res = await createProduct(admin.jar, {
          initialStock: 2,
          purchasePrice: price,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(code);
        expect(await counts()).toEqual(NOTHING);
      },
    );

    it('refuses a malformed price even with zero stock', async () => {
      const admin = await loginSuperAdmin(ctx);
      const res = await createProduct(admin.jar, { purchasePrice: '1e3' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PURCHASE_COST_INVALID');
      expect(await counts()).toEqual(NOTHING);
    });
  });

  // =======================================================================
  // variant product
  // =======================================================================

  describe('variant product', () => {
    it('values each variant independently with its own price and one movement each', async () => {
      const admin = await loginSuperAdmin(ctx);
      const [red, blue, green] = await colourValues(3);
      const code = nextCode();
      const res = await createProduct(
        admin.jar,
        {
          variants: [
            {
              sku: `SKU-R-${uniqueSuffix()}`,
              variantCode: `${code}-R`,
              price: 1_000_000,
              stock: 3,
              purchasePrice: 100_001,
              attributeValueIds: [red],
            },
            {
              sku: `SKU-B-${uniqueSuffix()}`,
              variantCode: `${code}-B`,
              price: 1_000_000,
              stock: 2,
              purchasePrice: '250000',
              attributeValueIds: [blue],
            },
            {
              sku: `SKU-G-${uniqueSuffix()}`,
              variantCode: `${code}-G`,
              price: 1_000_000,
              stock: 0,
              purchasePrice: 90_000,
              attributeValueIds: [green],
            },
          ],
        },
        code,
      );
      expect(res.status).toBe(201);
      const variants = await variantsOf(Number(res.body.data.id));
      // No default variant is created for an option product.
      expect(variants).toHaveLength(3);
      expect(variants.every((v) => v.isDefault === false)).toBe(true);
      const [r, b, g] = variants;

      expect(await poolOf(r.id)).toEqual({
        stock: 3,
        unvaluedQuantity: 0,
        inventoryCostValue: '300003',
        lastPurchaseUnitCost: '100001',
        costStatus: 'valued',
      });
      expect(await poolOf(b.id)).toEqual({
        stock: 2,
        unvaluedQuantity: 0,
        inventoryCostValue: '500000',
        lastPurchaseUnitCost: '250000',
        costStatus: 'valued',
      });
      expect(await poolOf(g.id)).toEqual({
        stock: 0,
        unvaluedQuantity: 0,
        inventoryCostValue: '0',
        lastPurchaseUnitCost: '90000',
        costStatus: 'valued',
      });

      const mr = await movementsOf(r.id);
      const mb = await movementsOf(b.id);
      expect(mr).toHaveLength(1);
      expect(mb).toHaveLength(1);
      expect(await movementsOf(g.id)).toEqual([]);
      expect(mr[0]).toMatchObject({
        reason: 'initial_stock',
        delta: 3,
        unitCost: '100001',
        costDelta: '300003',
        inventoryValueAfter: '300003',
        unvaluedQuantityAfter: 0,
        actorUserId: admin.userId,
      });
      expect(mb[0]).toMatchObject({
        reason: 'initial_stock',
        delta: 2,
        unitCost: '250000',
        costDelta: '500000',
        inventoryValueAfter: '500000',
        unvaluedQuantityAfter: 0,
        actorUserId: admin.userId,
      });
      // Nothing was spread across the product: the total is exactly Σ q×c.
      expect((await counts()).value).toBe('800003');
    });

    it('refuses a product-level purchasePrice alongside variants (no cost spreading)', async () => {
      const admin = await loginSuperAdmin(ctx);
      const [red] = await colourValues(1);
      const code = nextCode();
      const res = await createProduct(
        admin.jar,
        {
          purchasePrice: 50_000,
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-R`,
              stock: 2,
              purchasePrice: 50_000,
              attributeValueIds: [red],
            },
          ],
        },
        code,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PURCHASE_COST_INVALID');
      expect(await counts()).toEqual(NOTHING);
    });

    it('a variant with stock but no purchasePrice is 400 and writes nothing — even when its sibling is priced', async () => {
      const admin = await loginSuperAdmin(ctx);
      const [red, blue] = await colourValues(2);
      const code = nextCode();
      const res = await createProduct(
        admin.jar,
        {
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-R`,
              stock: 2,
              purchasePrice: 10_000,
              attributeValueIds: [red],
            },
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-B`,
              stock: 1,
              attributeValueIds: [blue],
            },
          ],
        },
        code,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INITIAL_STOCK_REQUIRES_PURCHASE_COST');
      expect(res.body.details?.field).toBe('variants[1].purchasePrice');
      expect(await counts()).toEqual(NOTHING);
    });

    it('a variant with an explicit 0 cost is valued at 0', async () => {
      const admin = await loginSuperAdmin(ctx);
      const [red] = await colourValues(1);
      const code = nextCode();
      const res = await createProduct(
        admin.jar,
        {
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-R`,
              stock: 6,
              purchasePrice: 0,
              attributeValueIds: [red],
            },
          ],
        },
        code,
      );
      expect(res.status).toBe(201);
      const [v] = await variantsOf(Number(res.body.data.id));
      expect(await poolOf(v.id)).toEqual({
        stock: 6,
        unvaluedQuantity: 0,
        inventoryCostValue: '0',
        lastPurchaseUnitCost: '0',
        costStatus: 'valued',
      });
      expect(await movementsOf(v.id)).toHaveLength(1);
    });
  });

  // =======================================================================
  // authorization
  // =======================================================================

  describe('authorization', () => {
    it('a delegated admin sending purchasePrice is 403 PURCHASE_COST_FORBIDDEN and writes nothing', async () => {
      const admin = await loginSuperAdmin(ctx);
      const delegated = await delegatedAdmin(admin.jar, [
        'products.create',
        'products.read',
        'inventory.adjust',
      ]);
      const before = await counts();

      const withStock = await createProduct(delegated, {
        initialStock: 2,
        purchasePrice: 10_000,
      });
      expect(withStock.status).toBe(403);
      expect(withStock.body.error).toBe('PURCHASE_COST_FORBIDDEN');

      const withoutStock = await createProduct(delegated, {
        purchasePrice: 10_000,
      });
      expect(withoutStock.status).toBe(403);
      expect(withoutStock.body.error).toBe('PURCHASE_COST_FORBIDDEN');

      const onVariant = await createProduct(delegated, {
        variants: [
          {
            sku: `SKU-${uniqueSuffix()}`,
            variantCode: `${nextCode()}-R`,
            stock: 0,
            purchasePrice: 1,
            attributeValueIds: await colourValues(1),
          },
        ],
      });
      expect(onVariant.status).toBe(403);
      expect(onVariant.body.error).toBe('PURCHASE_COST_FORBIDDEN');

      expect(await counts()).toEqual(before);
    });

    it('a delegated admin may still create a product with zero stock and no cost', async () => {
      const admin = await loginSuperAdmin(ctx);
      const delegated = await delegatedAdmin(admin.jar, [
        'products.create',
        'products.read',
      ]);
      const res = await createProduct(delegated, {});
      expect(res.status).toBe(201);
      const [v] = await variantsOf(Number(res.body.data.id));
      expect(await poolOf(v.id)).toEqual({
        stock: 0,
        unvaluedQuantity: 0,
        inventoryCostValue: '0',
        lastPurchaseUnitCost: null,
        costStatus: 'valued',
      });
    });
  });

  // =======================================================================
  // atomicity
  // =======================================================================

  describe('atomic rollback', () => {
    it('a create that fails AFTER the valued opening balance was written leaves nothing behind', async () => {
      const admin = await loginSuperAdmin(ctx);
      await seedRoles(ctx.dataSource);
      const before = await counts();
      // `applyImageContract` runs after `recordInitialStock` inside the same
      // transaction; an unknown image id aborts it there.
      const res = await createProduct(admin.jar, {
        initialStock: 9,
        purchasePrice: 77_777,
        images: [987_654],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await counts()).toEqual(before);
      expect(before).toEqual(NOTHING);
    });

    it('a variant create failing on an unknown category leaves no product, variant, movement or value', async () => {
      const admin = await loginSuperAdmin(ctx);
      const [red] = await colourValues(1);
      const code = nextCode();
      const res = await withCookies(ctx, admin.jar)
        .post('/products')
        .send({
          title: 'will roll back',
          description: 'x',
          basePrice: 1_000,
          productCode: code,
          categoryIds: [999_999],
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-R`,
              stock: 4,
              purchasePrice: 5_000,
              attributeValueIds: [red],
            },
          ],
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await counts()).toEqual(NOTHING);
    });
  });

  // =======================================================================
  // PATCH
  // =======================================================================

  describe('PATCH /products/:id', () => {
    async function variantProduct(admin: { jar: CookieJar }) {
      const [red, blue] = await colourValues(2);
      const code = nextCode();
      const res = await createProduct(
        admin.jar,
        {
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-R`,
              stock: 2,
              purchasePrice: 40_000,
              attributeValueIds: [red],
            },
          ],
        },
        code,
      );
      expect(res.status).toBe(201);
      const productId = Number(res.body.data.id);
      const [existing] = await variantsOf(productId);
      return { productId, code, blue, existing };
    }

    it('creating a variant WITH stock requires purchasePrice; with it the variant is valued', async () => {
      const admin = await loginSuperAdmin(ctx);
      const { productId, code, blue, existing } = await variantProduct(admin);
      const snapshot = await counts();

      const missing = await withCookies(ctx, admin.jar)
        .patch(`/products/${productId}`)
        .send({
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-B`,
              stock: 5,
              attributeValueIds: [blue],
            },
          ],
        });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('INITIAL_STOCK_REQUIRES_PURCHASE_COST');
      expect(await counts()).toEqual(snapshot);

      const ok = await withCookies(ctx, admin.jar)
        .patch(`/products/${productId}`)
        .send({
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-B`,
              stock: 5,
              purchasePrice: 33_333,
              attributeValueIds: [blue],
            },
          ],
        });
      expect(ok.status).toBe(200);
      const variants = await variantsOf(productId);
      expect(variants).toHaveLength(2);
      const created = variants.find((v) => v.id !== existing.id)!;
      expect(await poolOf(created.id)).toEqual({
        stock: 5,
        unvaluedQuantity: 0,
        inventoryCostValue: '166665',
        lastPurchaseUnitCost: '33333',
        costStatus: 'valued',
      });
      const [movement] = await movementsOf(created.id);
      expect(movement).toMatchObject({
        reason: 'initial_stock',
        delta: 5,
        unitCost: '33333',
        costDelta: '166665',
        inventoryValueAfter: '166665',
        unvaluedQuantityDelta: 0,
        unvaluedQuantityAfter: 0,
        actorUserId: admin.userId,
      });
      // The existing variant is untouched.
      expect(await poolOf(existing.id)).toMatchObject({
        stock: 2,
        inventoryCostValue: '80000',
      });
    });

    it('purchasePrice on an EXISTING variant is 400 PURCHASE_COST_NOT_UPDATABLE', async () => {
      const admin = await loginSuperAdmin(ctx);
      const { productId, existing } = await variantProduct(admin);
      const before = await poolOf(existing.id);

      const res = await withCookies(ctx, admin.jar)
        .patch(`/products/${productId}`)
        .send({ variants: [{ id: existing.id, purchasePrice: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PURCHASE_COST_NOT_UPDATABLE');
      expect(await poolOf(existing.id)).toEqual(before);
      expect(await movementsOf(existing.id)).toHaveLength(1);
    });

    it('a product PATCH can change neither stock nor cost', async () => {
      const admin = await loginSuperAdmin(ctx);
      const { productId, existing } = await variantProduct(admin);
      const before = await poolOf(existing.id);
      const snapshot = await counts();

      const attempts = [
        { purchasePrice: 5 },
        { initialStock: 5 },
        { variants: [{ id: existing.id, stock: 9 }] },
        { inventoryCostValue: '1' },
        { variants: [{ id: existing.id, inventoryCostValue: '1' }] },
      ];
      for (const body of attempts) {
        const res = await withCookies(ctx, admin.jar)
          .patch(`/products/${productId}`)
          .send(body);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      expect(await poolOf(existing.id)).toEqual(before);
      expect(await counts()).toEqual(snapshot);
    });

    it('a delegated editor creating a zero-stock variant with purchasePrice via PATCH is 403', async () => {
      const admin = await loginSuperAdmin(ctx);
      const { productId, code, blue } = await variantProduct(admin);
      const delegated = await delegatedAdmin(admin.jar, [
        'products.update',
        'products.read',
      ]);
      const snapshot = await counts();
      const res = await withCookies(ctx, delegated)
        .patch(`/products/${productId}`)
        .send({
          variants: [
            {
              sku: `SKU-${uniqueSuffix()}`,
              variantCode: `${code}-B`,
              purchasePrice: 10,
              attributeValueIds: [blue],
            },
          ],
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('PURCHASE_COST_FORBIDDEN');
      expect(await counts()).toEqual(snapshot);
    });
  });
});
