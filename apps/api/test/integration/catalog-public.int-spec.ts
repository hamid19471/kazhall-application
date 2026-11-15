/**
 * ACCEPTANCE 27 -- the public catalog must be browsable anonymously and must
 * contain no cart rows and no user rows.
 *
 * Plus: search / category / price / in-stock filtering, sorting and
 * pagination must return correctly scoped results.
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import {
  seedAttribute,
  seedCartItem,
  seedBookmark,
  seedCategory,
  seedProduct,
  uniqueSku,
} from './support/catalog.fixtures';

describe('Public catalog (int)', () => {
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

  // -------------------------------------------------------------------------
  // 27. no private data, and no login required
  // -------------------------------------------------------------------------

  it('serves GET /products anonymously and leaks no cart or user data', async () => {
    const mobiles = await seedCategory(ctx.dataSource, 'Mobile');
    const product = await seedProduct(ctx.dataSource, {
      title: 'Galaxy A55',
      basePrice: 120_000_000,
      categories: [mobiles],
      variants: [{ sku: uniqueSku('GA55'), price: 118_000_000, stock: 5 }],
      imageUrls: ['https://cdn.test/a.png'],
    });

    // Another customer has this product in their basket and has bookmarked it.
    const shopper = await ctx.loginAs([UserRoleEnum.site], 'shopper-27');
    await seedCartItem(ctx.dataSource, {
      userId: shopper.userId,
      productId: product.id,
      variantId: product.variants[0].id,
      quantity: 3,
    });
    await seedBookmark(ctx.dataSource, product.id, shopper.userId);

    // NO cookie is sent: this is the anonymous storefront.
    const res = await ctx.request().get('/products').expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('cartItems');
    expect(body).not.toContain('cartItem');
    expect(body).not.toContain('"users"');
    expect(body).not.toContain('bookmark');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: product.id,
        title: 'Galaxy A55',
        inStock: true,
        variantCount: 1,
      }),
    );
    // List cards never expose physical stock.
    expect(res.body.data[0]).not.toHaveProperty('stock');
    expect(res.body.data[0]).not.toHaveProperty('variants');
  });

  it('serves GET /products/:id anonymously with no cart, user or stock fields', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Galaxy A56',
      variants: [
        { sku: uniqueSku('A56'), price: 100, stock: 2 },
        { sku: uniqueSku('A56-OFF'), price: 100, stock: 9, isActive: false },
      ],
    });
    const shopper = await ctx.loginAs([UserRoleEnum.site], 'shopper-27b');
    await seedCartItem(ctx.dataSource, {
      userId: shopper.userId,
      productId: product.id,
      variantId: product.variants[0].id,
      quantity: 7,
    });

    const res = await ctx.request().get(`/products/${product.id}`).expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('cartItems');
    expect(body).not.toContain('"users"');
    expect(res.body.data).not.toHaveProperty('users');
    expect(res.body.data).not.toHaveProperty('cartItems');

    // Deactivated variants are not sellable, so they are not offered.
    expect(res.body.data.variants).toHaveLength(1);
    for (const variant of res.body.data.variants) {
      expect(variant).not.toHaveProperty('stock');
      expect(variant.availability).toEqual(
        expect.objectContaining({ indicative: true, inStock: true }),
      );
    }
  });

  it('caching a detail document cannot resurrect cart data for a later caller', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Cached product',
      variants: [{ sku: uniqueSku('CACHE'), price: 10, stock: 1 }],
    });
    const shopper = await ctx.loginAs([UserRoleEnum.site], 'shopper-27c');
    await seedCartItem(ctx.dataSource, {
      userId: shopper.userId,
      productId: product.id,
      variantId: product.variants[0].id,
    });

    // Warm the cache as the shopper, then read as an anonymous visitor.
    await ctx
      .request()
      .get(`/products/${product.id}`)
      .set('Cookie', shopper.cookie)
      .expect(200);

    const anonymous = await ctx
      .request()
      .get(`/products/${product.id}`)
      .expect(200);

    expect(JSON.stringify(anonymous.body)).not.toContain('cartItems');
  });

  it('serves GET /categories anonymously with a product count, not the products', async () => {
    const mobiles = await seedCategory(ctx.dataSource, 'Mobile');
    await seedProduct(ctx.dataSource, {
      title: 'P1',
      categories: [mobiles],
    });
    await seedProduct(ctx.dataSource, {
      title: 'P2',
      categories: [mobiles],
    });

    const res = await ctx.request().get('/categories').expect(200);

    expect(res.body.data).toEqual([
      expect.objectContaining({
        id: mobiles.id,
        title: 'Mobile',
        productCount: 2,
      }),
    ]);
    expect(res.body.data[0]).not.toHaveProperty('products');
  });

  it('serves GET /attributes anonymously', async () => {
    await seedAttribute(ctx.dataSource, 'color', ['red', 'blue']);
    const res = await ctx.request().get('/attributes').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].values).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // B5 -- querying
  // -------------------------------------------------------------------------

  describe('search / filter / sort / paginate', () => {
    let mobiles: Awaited<ReturnType<typeof seedCategory>>;
    let laptops: Awaited<ReturnType<typeof seedCategory>>;

    beforeEach(async () => {
      mobiles = await seedCategory(ctx.dataSource, 'Mobile');
      laptops = await seedCategory(ctx.dataSource, 'Laptop');

      await seedProduct(ctx.dataSource, {
        title: 'Samsung Galaxy A55',
        categories: [mobiles],
        basePrice: 300,
        variants: [{ sku: uniqueSku('S1'), price: 300, stock: 5 }],
      });
      await seedProduct(ctx.dataSource, {
        title: 'samsung galaxy s24',
        categories: [mobiles],
        basePrice: 900,
        variants: [{ sku: uniqueSku('S2'), price: 900, stock: 0 }],
      });
      await seedProduct(ctx.dataSource, {
        title: 'MacBook Air',
        categories: [laptops],
        basePrice: 100,
        variants: [{ sku: uniqueSku('S3'), price: 100, stock: 2 }],
      });
    });

    it('matches title case-insensitively', async () => {
      const res = await ctx
        .request()
        .get('/products')
        .query({ search: 'GALAXY' })
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(
        res.body.data.map((p: { title: string }) => p.title).sort(),
      ).toEqual(['Samsung Galaxy A55', 'samsung galaxy s24']);
    });

    it('scopes by categoryId', async () => {
      const res = await ctx
        .request()
        .get('/products')
        .query({ categoryId: laptops.id })
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].title).toBe('MacBook Air');
    });

    it('filters by effective price range', async () => {
      const res = await ctx
        .request()
        .get('/products')
        .query({ minPrice: 200, maxPrice: 500 })
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].title).toBe('Samsung Galaxy A55');
    });

    it('filters out products with no in-stock active variant', async () => {
      const res = await ctx
        .request()
        .get('/products')
        .query({ inStockOnly: 'true' })
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.data.every((p: { inStock: boolean }) => p.inStock)).toBe(
        true,
      );
    });

    it('sorts by price ascending and descending', async () => {
      const asc = await ctx
        .request()
        .get('/products')
        .query({ sort: 'price_asc' })
        .expect(200);
      expect(
        asc.body.data.map((p: { effectivePrice: number }) => p.effectivePrice),
      ).toEqual([100, 300, 900]);

      const desc = await ctx
        .request()
        .get('/products')
        .query({ sort: 'price_desc' })
        .expect(200);
      expect(
        desc.body.data.map((p: { effectivePrice: number }) => p.effectivePrice),
      ).toEqual([900, 300, 100]);
    });

    it('paginates without repeating or skipping rows', async () => {
      const page1 = await ctx
        .request()
        .get('/products')
        .query({ page: 1, limit: 2, sort: 'price_asc' })
        .expect(200);
      const page2 = await ctx
        .request()
        .get('/products')
        .query({ page: 2, limit: 2, sort: 'price_asc' })
        .expect(200);

      expect(page1.body).toEqual(
        expect.objectContaining({ total: 3, page: 1, limit: 2, totalPages: 2 }),
      );
      expect(page1.body.data).toHaveLength(2);
      expect(page2.body.data).toHaveLength(1);

      const ids = [...page1.body.data, ...page2.body.data].map(
        (p: { id: number }) => p.id,
      );
      expect(new Set(ids).size).toBe(3);
    });

    it('rejects a page size above the documented maximum', async () => {
      await ctx.request().get('/products').query({ limit: 1000 }).expect(400);
    });
  });
});
