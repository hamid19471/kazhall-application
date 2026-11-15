import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { uniqueSku } from './support/catalog.fixtures';

/**
 * ============================================================================
 * THE UNIFORM SELLABLE-SKU MODEL, over HTTP.
 *
 * `product_variants` is the only sellable unit in the system. A product with
 * no options is not an exception to that -- it gets exactly one DEFAULT
 * variant, created in the same transaction as the product.
 *
 * WHY IT MATTERS. A product with zero variant rows used to be sellable anyway:
 * `CartService` took a `variantId === null` branch that skipped the variant row
 * lock, the availability check and the four-hour reservation entirely, and
 * checkout filtered those lines out before allocating stock. These tests assert
 * that the storefront never sees such a product again.
 *
 * The two properties that carry the most risk of being got wrong silently are
 * asserted explicitly:
 *
 *   STOCK 0  -- a newly created simple product has no counted stock, and no
 *               request shape can give it any. Stock enters only through the
 *               ledgered adjust endpoint.
 *   VISIBLE  -- a 0-stock default is shown as OUT OF STOCK, not hidden. An
 *               invisible SKU would be indistinguishable from the bug.
 * ============================================================================
 */
describe('default variant for simple products (int)', () => {
  let ctx: TestApp;
  let admin: { userId: number; cookie: string };

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    admin = await ctx.loginAs([UserRoleEnum.superAdmin], 'admin-default-sku');
  });

  const variantRows = async (productId: number) =>
    ctx.dataSource.query<
      Array<{
        id: number;
        sku: string;
        stock: number;
        price: string | null;
        isActive: boolean;
        isDefault: boolean;
      }>
    >(
      `SELECT "id","sku","stock","price","isActive","isDefault"
         FROM "product_variants" WHERE "productId" = $1 ORDER BY "id"`,
      [productId],
    );

  // ==========================================================================
  it('creating a product without variants creates exactly one DEFAULT variant', async () => {
    const res = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'Plain notebook',
        description: 'No options at all',
        basePrice: 4_500_000,
        productCode: 'KZ-P-DEFSKU1',
        visibleOnSite: true,
        branchVisibility: 'all',
      })
      .expect(201);

    const productId = res.body.data.id as number;
    const rows = await variantRows(productId);

    expect(rows).toHaveLength(1);
    expect(rows[0].isDefault).toBe(true);
    expect(rows[0].isActive).toBe(true);
    // Deterministic and derived from the product id, matching the shape
    // migration 0012 backfills.
    expect(rows[0].sku).toBe(`DEFAULT-P${productId}`);
    // basePrice and variant price are the SAME money unit (integer Rial):
    // both bigint, both carrying bigIntTransformer. Copied verbatim.
    expect(Number(rows[0].price)).toBe(4_500_000);
    // NOT invented. Nobody has counted this product yet.
    expect(rows[0].stock).toBe(0);
  });

  it('a product created without a basePrice gets a default variant priced 0', async () => {
    const res = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'Priceless',
        description: 'No basePrice given',
        productCode: 'KZ-P-DEFSKU2',
        visibleOnSite: true,
        branchVisibility: 'all',
      })
      .expect(201);

    const rows = await variantRows(res.body.data.id as number);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].price)).toBe(0);
    expect(rows[0].stock).toBe(0);
  });

  it('a product created WITH variants gets no default -- the customer must choose', async () => {
    const attribute = await ctx.dataSource.query<Array<{ id: number }>>(
      `INSERT INTO "product_attribute" ("name") VALUES ('Colour') RETURNING id`,
    );
    const value = await ctx.dataSource.query<Array<{ id: number }>>(
      `INSERT INTO "product_attribute_value" ("value","attributeId")
       VALUES ('Red', $1) RETURNING id`,
      [attribute[0].id],
    );

    const res = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'T-shirt',
        description: 'Sold by colour',
        basePrice: 1_000_000,
        productCode: 'KZ-P-DEFSKU3',
        visibleOnSite: true,
        branchVisibility: 'all',
        variants: [
          {
            sku: uniqueSku('TSHIRT'),
            variantCode: 'KZ-P-DEFSKU3-V1',
            price: 1_200_000,
            stock: 4,
            purchasePrice: 800_000,
            attributeValueIds: [value[0].id],
          },
        ],
      })
      .expect(201);

    const rows = await variantRows(res.body.data.id as number);
    expect(rows).toHaveLength(1);
    expect(rows[0].isDefault).toBe(false);
  });

  // ==========================================================================
  it('a 0-stock default variant is SHOWN as out of stock, never hidden', async () => {
    const created = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'Uncounted mug',
        description: 'Backfill-shaped: live SKU, zero counted stock',
        basePrice: 250_000,
        productCode: 'KZ-P-DEFSKU4',
        visibleOnSite: true,
        branchVisibility: 'all',
      })
      .expect(201);
    const productId = created.body.data.id as number;

    // Public DETAIL: the SKU is listed, and it says out of stock. A hidden
    // variant would be indistinguishable from the old variant-less product.
    const detail = await ctx
      .request()
      .get(`/products/${productId}`)
      .expect(200);
    expect(detail.body.data.variants).toHaveLength(1);
    expect(detail.body.data.variants[0].availability).toEqual(
      expect.objectContaining({
        availableForBasket: 0,
        inStock: false,
        indicative: true,
      }),
    );
    // Stock integers stay admin-only.
    expect(detail.body.data.variants[0]).not.toHaveProperty('stock');

    // Public LIST: present, counted as a variant, flagged out of stock.
    const list = await ctx.request().get('/products?limit=50').expect(200);
    const card = (
      list.body.data as Array<{
        id: number;
        inStock: boolean;
        variantCount: number;
        effectivePrice: number | null;
      }>
    ).find((p) => p.id === productId);
    expect(card).toBeDefined();
    expect(card!.inStock).toBe(false);
    expect(card!.variantCount).toBe(1);
    expect(card!.effectivePrice).toBe(250_000);

    // ...and it is excluded from an explicit in-stock-only search, which is
    // the honest answer rather than a lie in either direction.
    const inStockOnly = await ctx
      .request()
      .get('/products?limit=50&inStockOnly=true')
      .expect(200);
    expect(
      (inStockOnly.body.data as Array<{ id: number }>).map((p) => p.id),
    ).not.toContain(productId);
  });

  // ==========================================================================
  it('opening stock cannot enter through the adjust endpoint on the default variant: it is refused and writes nothing', async () => {
    const created = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'Counted candle',
        description: 'Stock needs a purchase cost',
        basePrice: 90_000,
        productCode: 'KZ-P-DEFSKU5',
        visibleOnSite: true,
        branchVisibility: 'all',
      })
      .expect(201);
    const productId = created.body.data.id as number;
    const [defaultVariant] = await variantRows(productId);

    const adjust = await ctx
      .request()
      .post(`/products/variants/${defaultVariant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 7, reason: 'opening count' })
      .expect(409);
    expect(adjust.body.error).toBe('STOCK_INCREASE_REQUIRES_RECEIPT');

    expect((await variantRows(productId))[0].stock).toBe(0);
    const movements = await ctx.dataSource.query(
      `SELECT "id" FROM "stock_movements" WHERE "variantId" = $1`,
      [defaultVariant.id],
    );
    expect(movements).toHaveLength(0);

    const detail = await ctx
      .request()
      .get(`/products/${productId}`)
      .expect(200);
    expect(detail.body.data.variants[0].availability.inStock).toBe(false);
  });

  // ==========================================================================
  it('opening stock enters valued, on the default variant, and the adjust endpoint then lowers it', async () => {
    const created = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'Counted candle',
        description: 'Stock arrives via the ledger',
        basePrice: 90_000,
        productCode: 'KZ-P-DEFSKU7',
        visibleOnSite: true,
        branchVisibility: 'all',
        initialStock: 7,
        purchasePrice: 40_000,
      })
      .expect(201);
    const productId = created.body.data.id as number;
    const [defaultVariant] = await variantRows(productId);
    expect(defaultVariant.stock).toBe(7);

    // The opening balance is auditable -- one valued movement row with the
    // committed balance.
    const opening = await ctx.dataSource.query<
      Array<{ reason: string; delta: number; balanceAfter: number }>
    >(
      `SELECT "reason","delta","balanceAfter" FROM "stock_movements" WHERE "variantId" = $1`,
      [defaultVariant.id],
    );
    expect(opening).toEqual([
      { reason: 'initial_stock', delta: 7, balanceAfter: 7 },
    ]);

    // The storefront calls it in stock.
    const detail = await ctx
      .request()
      .get(`/products/${productId}`)
      .expect(200);
    expect(detail.body.data.variants[0].availability.inStock).toBe(true);

    // The generic adjust route still addresses the default variant, for a
    // decrease, and reports it by its generated SKU.
    const adjust = await ctx
      .request()
      .post(`/products/variants/${defaultVariant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 5, reason: 'recount' })
      .expect(201);
    expect(adjust.body.data).toEqual(
      expect.objectContaining({
        variantId: defaultVariant.id,
        productId,
        sku: `DEFAULT-P${productId}`,
        previousStock: 7,
        balanceAfter: 5,
      }),
    );
  });

  // ==========================================================================
  it('a product can hold at most one default variant', async () => {
    const created = await ctx
      .request()
      .post('/products')
      .set('Cookie', admin.cookie)
      .send({
        title: 'Only one',
        description: 'guarded by a partial index',
        productCode: 'KZ-P-DEFSKU6',
        visibleOnSite: true,
        branchVisibility: 'all',
      })
      .expect(201);
    const productId = created.body.data.id as number;

    // The guarantee is STRUCTURAL (uq_variant_one_default_per_product), so it
    // is asserted by trying to break it in raw SQL rather than through code
    // that already knows better.
    await expect(
      ctx.dataSource.query(
        `INSERT INTO "product_variants" ("price","stock","sku","productId","isActive","isDefault","variantCode")
         SELECT 0, 0, $1, $2, true, true,
                p."productCode" || '-VDUP' || floor(random()*1000000000)::text
           FROM products p WHERE p."id" = $2`,
        [uniqueSku('SECONDDEFAULT'), productId],
      ),
    ).rejects.toThrow(/uq_variant_one_default_per_product/);

    // A second NON-default variant is of course fine.
    await expect(
      ctx.dataSource.query(
        `INSERT INTO "product_variants" ("price","stock","sku","productId","isActive","isDefault","variantCode")
         SELECT 0, 0, $1, $2, true, false,
                p."productCode" || '-VORD' || floor(random()*1000000000)::text
           FROM products p WHERE p."id" = $2`,
        [uniqueSku('ORDINARY'), productId],
      ),
    ).resolves.toBeDefined();
  });
});
