/**
 * The PUBLIC variant contract the storefront sells from.
 *
 * These exist because the storefront's variant picker was already written and
 * correct, and still rendered nothing: it groups options by
 * `attributeValues[].attribute.name`, and the public detail query loaded
 * `variants.attributeValues` WITHOUT the nested `attribute`. The admin query
 * loaded it, so the field was in the view type, in the mapper and in Swagger —
 * just never on the public wire. The result was a multi-variant product whose
 * "add to basket" button was enabled with no variant chosen.
 *
 * Nothing here asserts a shape someone might like. Each case pins a fact the
 * storefront cannot sell correctly without.
 */
import { CATALOG_NAMESPACES, CacheService } from 'src/database/cache.service';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import {
  seedAttribute,
  seedCategory,
  seedProduct,
  uniqueSku,
} from './support/catalog.fixtures';

interface WireAttributeValue {
  id: number;
  value: string;
  attribute?: { id: number; name: string };
}
interface WireVariant {
  id: number;
  sku: string;
  price: number | null;
  attributeValues: WireAttributeValue[];
  availability?: { inStock: boolean };
}

describe('Public variant contract (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    /*
     * `resetDatabase` TRUNCATEs with RESTART IDENTITY, so the next test's first
     * product is id 1 again — and the detail document is cached under
     * `productDetail(version, id)`. Without bumping the version, one test reads
     * the PREVIOUS test's product. This is the same invalidation the write
     * paths perform in production, not a test-only trick.
     */
    await ctx.app
      .get(CacheService, { strict: false })
      .bumpVersion(CATALOG_NAMESPACES.PRODUCTS);
  });

  // -------------------------------------------------------------------------
  // Attribute NAMES on the public detail response
  // -------------------------------------------------------------------------

  it('names the attribute each variant value belongs to, so a picker can group them', async () => {
    const colour = await seedAttribute(ctx.dataSource, 'رنگ', [
      'مشکی',
      'سرمه‌ای',
    ]);
    const size = await seedAttribute(ctx.dataSource, 'ظرفیت', [
      '۵۰ لیتر',
      '۷۰ لیتر',
    ]);

    const product = await seedProduct(ctx.dataSource, {
      title: 'کوله دو-محوره',
      variants: [
        {
          sku: uniqueSku('AXIS'),
          price: 87_500_000,
          stock: 4,
          attributeValueIds: [colour.values[0].id, size.values[0].id],
        },
        {
          sku: uniqueSku('AXIS'),
          price: 104_000_000,
          stock: 2,
          attributeValueIds: [colour.values[1].id, size.values[1].id],
        },
      ],
    });

    const res = await ctx.request().get(`/products/${product.id}`).expect(200);
    const variants: WireVariant[] = res.body.data.variants;
    expect(variants).toHaveLength(2);

    for (const variant of variants) {
      expect(variant.attributeValues.length).toBeGreaterThan(0);
      for (const value of variant.attributeValues) {
        // The value alone is not enough: "مشکی" and "۵۰ لیتر" are two
        // different AXES, and only the name distinguishes them.
        expect(value.attribute).toBeDefined();
        expect(typeof value.attribute?.name).toBe('string');
        expect(value.attribute?.name.length).toBeGreaterThan(0);
      }
    }

    const axes = new Set(
      variants.flatMap((v) => v.attributeValues.map((a) => a.attribute?.name)),
    );
    expect(axes).toEqual(new Set(['رنگ', 'ظرفیت']));
  });

  // -------------------------------------------------------------------------
  // Price inheritance
  // -------------------------------------------------------------------------

  it('reports an inheriting variant price as null and carries the basePrice to inherit from', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'جوراب پشمی',
      basePrice: 12_500_000,
      variants: [{ sku: uniqueSku('SOCK'), price: 0, stock: 9 }],
    });
    // `seedProduct` coerces an omitted price to 0; a genuinely inheriting
    // variant is NULL, which is the case that used to render as "free".
    await ctx.dataSource
      .getRepository(ProductVariant)
      .update({ id: product.variants[0].id }, { price: null as never });

    const res = await ctx.request().get(`/products/${product.id}`).expect(200);
    const variant: WireVariant = res.body.data.variants[0];

    expect(variant.price).toBeNull();
    expect(res.body.data.basePrice).toBe(12_500_000);
    // Never zero: a client applying `price ?? basePrice` must land on 12.5M,
    // and must never be handed a 0 it would render as a free product.
    expect(variant.price).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // Inactive variants are not sellable
  // -------------------------------------------------------------------------

  it('omits inactive variants from the public projection entirely', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'چادر بازنشسته',
      variants: [
        { sku: uniqueSku('LIVE'), price: 10_000_000, stock: 3, isActive: true },
        {
          sku: uniqueSku('DEAD'),
          price: 20_000_000,
          stock: 3,
          isActive: false,
        },
      ],
    });

    const res = await ctx.request().get(`/products/${product.id}`).expect(200);
    const variants: WireVariant[] = res.body.data.variants;
    expect(variants).toHaveLength(1);
    expect(variants[0].sku).toMatch(/^LIVE/);
  });

  // -------------------------------------------------------------------------
  // The listing card's "from" price signal
  // -------------------------------------------------------------------------

  it('exposes the dearest active price so a card knows whether to say "from"', async () => {
    const category = await seedCategory(ctx.dataSource, 'ranged');

    const spread = await seedProduct(ctx.dataSource, {
      title: 'کاپشن چند-قیمته',
      categories: [category],
      variants: [
        { sku: uniqueSku('SPREAD'), price: 189_000_000, stock: 2 },
        { sku: uniqueSku('SPREAD'), price: 195_000_000, stock: 2 },
      ],
    });
    const flat = await seedProduct(ctx.dataSource, {
      title: 'شلوار تک-قیمته',
      categories: [category],
      variants: [
        { sku: uniqueSku('FLAT'), price: 58_000_000, stock: 2 },
        { sku: uniqueSku('FLAT'), price: 58_000_000, stock: 2 },
      ],
    });

    const res = await ctx
      .request()
      .get(`/products?categoryId=${category.id}&limit=50`)
      .expect(200);
    const rows = res.body.data as Array<{
      id: number;
      effectivePrice: number;
      maxEffectivePrice: number;
    }>;
    const byId = new Map(rows.map((p) => [p.id, p]));

    const ranged = byId.get(spread.id)!;
    expect(ranged.effectivePrice).toBe(189_000_000);
    expect(ranged.maxEffectivePrice).toBe(195_000_000);

    // Two variants, one price. `variantCount > 1` would wrongly say "from";
    // the min/max pair is what tells the card there is no range.
    const single = byId.get(flat.id)!;
    expect(single.effectivePrice).toBe(58_000_000);
    expect(single.maxEffectivePrice).toBe(58_000_000);
  });
});
