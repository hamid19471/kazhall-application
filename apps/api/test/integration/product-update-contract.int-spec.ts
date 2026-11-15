/**
 * ACCEPTANCE 30 -- category, image and variant changes must persist, per the
 * contracts documented on `UpdateProductDto`.
 *
 * Also covers the two correctness defects behind it: category assignment was
 * followed by `Repository.update()` (which can never write a many-to-many),
 * and the whole update ran without a transaction so a mid-loop failure left
 * the product half-updated.
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ProductMessages } from 'src/common/constants/product.messages';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import {
  reloadProduct,
  seedAttribute,
  seedCategory,
  seedDetachedImage,
  seedProduct,
  uniqueSku,
} from './support/catalog.fixtures';

describe('Product update contract (int)', () => {
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
    admin = await ctx.loginAs([UserRoleEnum.superAdmin], 'admin-30');
  });

  // -------------------------------------------------------------------------
  // categories
  // -------------------------------------------------------------------------

  describe('category contract', () => {
    it('persists a category change (the complete desired set)', async () => {
      const mobiles = await seedCategory(ctx.dataSource, 'Mobile');
      const laptops = await seedCategory(ctx.dataSource, 'Laptop');
      const product = await seedProduct(ctx.dataSource, {
        title: 'Reclassify me',
        categories: [mobiles],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ categoryIds: [laptops.id] })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      expect(reloaded.categories.map((c) => c.id)).toEqual([laptops.id]);
    });

    it('clears every category when given an empty array', async () => {
      const mobiles = await seedCategory(ctx.dataSource, 'Mobile');
      const product = await seedProduct(ctx.dataSource, {
        title: 'Uncategorise me',
        categories: [mobiles],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ categoryIds: [] })
        .expect(200);

      expect(
        (await reloadProduct(ctx.dataSource, product.id)).categories,
      ).toHaveLength(0);
    });

    it('leaves categories untouched when the field is omitted', async () => {
      const mobiles = await seedCategory(ctx.dataSource, 'Mobile');
      const product = await seedProduct(ctx.dataSource, {
        title: 'Keep my categories',
        categories: [mobiles],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ title: 'Renamed' })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      expect(reloaded.title).toBe('Renamed');
      expect(reloaded.categories.map((c) => c.id)).toEqual([mobiles.id]);
    });

    it('rolls the whole update back when a category id is unknown', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Original title',
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ title: 'Should not stick', categoryIds: [999_999] })
        .expect(404);

      expect((await reloadProduct(ctx.dataSource, product.id)).title).toBe(
        'Original title',
      );
    });
  });

  // -------------------------------------------------------------------------
  // images
  // -------------------------------------------------------------------------

  describe('image contract', () => {
    it('re-parents, orders and persists sortOrder from the array index', async () => {
      const product = await seedProduct(ctx.dataSource, { title: 'Gallery' });
      const a = await seedDetachedImage(ctx.dataSource, 'https://cdn/a.png');
      const b = await seedDetachedImage(ctx.dataSource, 'https://cdn/b.png');
      const c = await seedDetachedImage(ctx.dataSource, 'https://cdn/c.png');

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ images: [c.id, a.id, b.id] })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      const ordered = [...reloaded.images].sort(
        (x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0),
      );
      expect(ordered.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
      expect(ordered.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    });

    it('deletes attached images that are absent from the desired set', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Shrinking gallery',
        imageUrls: ['https://cdn/1.png', 'https://cdn/2.png'],
      });
      const keep = product.images[0].id;

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ images: [keep] })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      expect(reloaded.images.map((i) => i.id)).toEqual([keep]);

      const remaining = await ctx.dataSource.query(
        `SELECT COUNT(*)::text AS count FROM "product_images"`,
      );
      expect(Number(remaining[0].count)).toBe(1);
    });

    it('clears every image when given an empty array', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Emptying gallery',
        imageUrls: ['https://cdn/1.png'],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ images: [] })
        .expect(200);

      expect(
        (await reloadProduct(ctx.dataSource, product.id)).images,
      ).toHaveLength(0);
    });

    it('leaves images untouched when the field is omitted', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Untouched gallery',
        imageUrls: ['https://cdn/1.png'],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ title: 'Renamed again' })
        .expect(200);

      expect(
        (await reloadProduct(ctx.dataSource, product.id)).images,
      ).toHaveLength(1);
    });

    it('rejects an unknown image id and rolls back', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Before image failure',
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ title: 'Should not stick', images: [999_999] })
        .expect(404);

      expect((await reloadProduct(ctx.dataSource, product.id)).title).toBe(
        'Before image failure',
      );
    });

    it('rejects an image owned by another product', async () => {
      const owner = await seedProduct(ctx.dataSource, {
        title: 'Image owner',
        imageUrls: ['https://cdn/owned.png'],
      });
      const thief = await seedProduct(ctx.dataSource, { title: 'Image thief' });

      const res = await ctx
        .request()
        .patch(`/products/${thief.id}`)
        .set('Cookie', admin.cookie)
        .send({ images: [owner.images[0].id] })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        ProductMessages.PRODUCT_IMAGE_OWNED_BY_OTHER_PRODUCT,
      );
      expect(
        (await reloadProduct(ctx.dataSource, owner.id)).images,
      ).toHaveLength(1);
    });

    it('rejects duplicate image ids', async () => {
      const product = await seedProduct(ctx.dataSource, { title: 'Dup' });
      const a = await seedDetachedImage(ctx.dataSource, 'https://cdn/a.png');

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ images: [a.id, a.id] })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // variants
  // -------------------------------------------------------------------------

  describe('variant lifecycle contract', () => {
    it('updates a named variant and leaves unnamed ones untouched', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Two variants',
        variants: [
          { sku: uniqueSku('V1'), price: 100, stock: 1 },
          { sku: uniqueSku('V2'), price: 200, stock: 1 },
        ],
      });
      const [first, second] = product.variants;

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ variants: [{ id: first.id, price: 111 }] })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      const byId = new Map(reloaded.variants.map((v) => [v.id, v]));
      expect(byId.get(first.id)!.price).toBe(111);
      expect(byId.get(second.id)!.price).toBe(200);
      expect(reloaded.variants).toHaveLength(2);
    });

    it('creates a variant when the entry has no id', async () => {
      const { values } = await seedAttribute(ctx.dataSource, 'color', ['red']);
      const product = await seedProduct(ctx.dataSource, { title: 'Growing' });
      const sku = uniqueSku('NEW');

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({
          variants: [
            {
              sku,
              // A CREATE entry (no `id`) must carry «کد گونه» since 0031, and
              // it must sit under the parent's «کد محصول».
              variantCode: `${product.productCode}-VNEW1`,
              price: 555,
              stock: 4,
              // Opening units need their purchase cost (super_admin only).
              purchasePrice: 300,
              attributeValueIds: [values[0].id],
            },
          ],
        })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      expect(reloaded.variants).toHaveLength(1);
      expect(reloaded.variants[0]).toEqual(
        expect.objectContaining({ sku, price: 555, stock: 4, isActive: true }),
      );
      // The opening units arrived as ONE valued ledger row, not on the INSERT.
      const movements = await ctx.dataSource.query(
        `SELECT reason, delta, "unitCost"::text AS "unitCost"
           FROM stock_movements WHERE "variantId" = $1`,
        [reloaded.variants[0].id],
      );
      expect(movements).toEqual([
        { reason: 'initial_stock', delta: 4, unitCost: '300' },
      ]);
    });

    it('deactivates rather than deletes, keeping the row for order history', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Retiring',
        variants: [{ sku: uniqueSku('OLD'), price: 100, stock: 3 }],
      });
      const variantId = product.variants[0].id;

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ variants: [{ id: variantId, isActive: false }] })
        .expect(200);

      // The row survives.
      const rows = await ctx.dataSource.query(
        `SELECT "isActive" FROM "product_variants" WHERE "id" = $1`,
        [variantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].isActive).toBe(false);

      // It is gone from the public catalog...
      const publicRes = await ctx
        .request()
        .get(`/products/${product.id}`)
        .expect(200);
      expect(publicRes.body.data.variants).toHaveLength(0);

      // ...but still visible to an admin.
      const adminRes = await ctx
        .request()
        .get(`/products/admin/${product.id}`)
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(adminRes.body.data.variants).toHaveLength(1);
      expect(adminRes.body.data.variants[0].isActive).toBe(false);
    });

    it('reactivates a retired variant', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Returning',
        variants: [
          { sku: uniqueSku('BACK'), price: 100, stock: 3, isActive: false },
        ],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ variants: [{ id: product.variants[0].id, isActive: true }] })
        .expect(200);

      const publicRes = await ctx
        .request()
        .get(`/products/${product.id}`)
        .expect(200);
      expect(publicRes.body.data.variants).toHaveLength(1);
    });

    it('refuses to set stock through the product update endpoint', async () => {
      const product = await seedProduct(ctx.dataSource, {
        title: 'Stock guard',
        variants: [{ sku: uniqueSku('SG'), price: 100, stock: 3 }],
      });

      const res = await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({ variants: [{ id: product.variants[0].id, stock: 99 }] })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        'POST /products/variants/:variantId/stock/adjust',
      );

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      expect(reloaded.variants[0].stock).toBe(3);
    });

    it('replaces the attribute value set of a variant', async () => {
      const { values } = await seedAttribute(ctx.dataSource, 'color', [
        'red',
        'blue',
      ]);
      const product = await seedProduct(ctx.dataSource, {
        title: 'Recolour',
        variants: [
          {
            sku: uniqueSku('COL'),
            price: 1,
            stock: 1,
            attributeValueIds: [values[0].id],
          },
        ],
      });

      await ctx
        .request()
        .patch(`/products/${product.id}`)
        .set('Cookie', admin.cookie)
        .send({
          variants: [
            {
              id: product.variants[0].id,
              attributeValueIds: [values[1].id],
            },
          ],
        })
        .expect(200);

      const reloaded = await reloadProduct(ctx.dataSource, product.id);
      expect(reloaded.variants[0].attributeValues.map((v) => v.id)).toEqual([
        values[1].id,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // atomicity
  // -------------------------------------------------------------------------

  it('rolls back every variant write when a later variant fails', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Atomic',
      variants: [
        { sku: uniqueSku('A1'), price: 100, stock: 1 },
        { sku: uniqueSku('A2'), price: 200, stock: 1 },
      ],
    });
    const [first, second] = product.variants;

    await ctx
      .request()
      .patch(`/products/${product.id}`)
      .set('Cookie', admin.cookie)
      .send({
        title: 'Atomic renamed',
        variants: [
          { id: first.id, price: 999 },
          // unknown attribute value -> throws AFTER the first variant was saved
          { id: second.id, attributeValueIds: [999_999] },
        ],
      })
      .expect(404);

    const reloaded = await reloadProduct(ctx.dataSource, product.id);
    expect(reloaded.title).toBe('Atomic');
    const byId = new Map(reloaded.variants.map((v) => [v.id, v]));
    expect(byId.get(first.id)!.price).toBe(100);
  });

  it('does not let a stale cached document overwrite authoritative values', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Cache poisoning guard',
      basePrice: 100,
    });

    // Warm the public cache.
    await ctx.request().get(`/products/${product.id}`).expect(200);

    // Change the row behind the cache's back (simulating another writer).
    await ctx.dataSource.query(
      `UPDATE "products" SET "description" = 'authoritative' WHERE "id" = $1`,
      [product.id],
    );

    // An update that touches only the title must not resurrect the cached
    // description.
    await ctx
      .request()
      .patch(`/products/${product.id}`)
      .set('Cookie', admin.cookie)
      .send({ title: 'Renamed' })
      .expect(200);

    const reloaded = await reloadProduct(ctx.dataSource, product.id);
    expect(reloaded.description).toBe('authoritative');
    expect(reloaded.title).toBe('Renamed');
  });

  it('invalidates the public detail cache after an update', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Before',
      basePrice: 1,
    });

    await ctx.request().get(`/products/${product.id}`).expect(200);

    await ctx
      .request()
      .patch(`/products/${product.id}`)
      .set('Cookie', admin.cookie)
      .send({ title: 'After' })
      .expect(200);

    const res = await ctx.request().get(`/products/${product.id}`).expect(200);
    expect(res.body.data.title).toBe('After');
  });
});
