/**
 * ACCEPTANCE 28 -- a variant that does not belong to the given product must be
 * rejected with a clear error.
 *
 * `ProductsService.assertVariantBelongsToProduct` is the reusable check that
 * cart (workstream D) and POS (workstream C) call, so it is tested both
 * directly and through the HTTP surface that already uses it.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ProductsService } from 'src/modules/products/services/products.service';
import { ProductMessages } from 'src/common/constants/product.messages';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { seedProduct, uniqueSku } from './support/catalog.fixtures';

describe('Variant / product integrity (int)', () => {
  let ctx: TestApp;
  let service: ProductsService;

  beforeAll(async () => {
    ctx = await createTestApp();
    service = ctx.app.get(ProductsService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  it('accepts a variant that really belongs to the product', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Owner',
      variants: [{ sku: uniqueSku('OWN'), price: 10, stock: 1 }],
    });

    const variant = await service.assertVariantBelongsToProduct(
      undefined,
      product.id,
      product.variants[0].id,
    );

    expect(variant.id).toBe(product.variants[0].id);
  });

  it('rejects a variant belonging to a different product', async () => {
    const a = await seedProduct(ctx.dataSource, {
      title: 'Cheap product',
      variants: [{ sku: uniqueSku('CHEAP'), price: 10, stock: 1 }],
    });
    const b = await seedProduct(ctx.dataSource, {
      title: 'Expensive product',
      variants: [{ sku: uniqueSku('EXP'), price: 10_000_000, stock: 1 }],
    });

    await expect(
      service.assertVariantBelongsToProduct(undefined, a.id, b.variants[0].id),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.assertVariantBelongsToProduct(undefined, a.id, b.variants[0].id),
    ).rejects.toThrow(ProductMessages.VARIANT_DOES_NOT_BELONG_TO_PRODUCT);
  });

  it('reports an unknown variant as not found', async () => {
    const a = await seedProduct(ctx.dataSource, { title: 'Solo' });
    await expect(
      service.assertVariantBelongsToProduct(undefined, a.id, 999_999),
    ).rejects.toThrow(NotFoundException);
  });

  it('can require the variant to still be sellable', async () => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Retired variant holder',
      variants: [
        { sku: uniqueSku('RET'), price: 10, stock: 1, isActive: false },
      ],
    });

    // Without requireActive the check passes: order history must still be able
    // to resolve a retired variant.
    await expect(
      service.assertVariantBelongsToProduct(
        undefined,
        product.id,
        product.variants[0].id,
      ),
    ).resolves.toBeDefined();

    await expect(
      service.assertVariantBelongsToProduct(
        undefined,
        product.id,
        product.variants[0].id,
        { requireActive: true },
      ),
    ).rejects.toThrow(ProductMessages.VARIANT_INACTIVE);
  });

  it('composes into the caller transaction and sees its uncommitted writes', async () => {
    const product = await seedProduct(ctx.dataSource, { title: 'Tx product' });

    await ctx.dataSource.transaction(async (manager) => {
      const inserted = await manager.query(
        `INSERT INTO "product_variants" ("price","stock","sku","isActive","productId","variantCode")
         SELECT 1, 1, $1, true, $2,
                p."productCode" || '-VFIX' || floor(random()*1000000000)::text
           FROM products p WHERE p."id" = $2
         RETURNING "id"`,
        [uniqueSku('TX'), product.id],
      );
      const variantId = Number(inserted[0].id);

      await expect(
        service.assertVariantBelongsToProduct(manager, product.id, variantId),
      ).resolves.toBeDefined();
    });
  });

  it('rejects a foreign variant id through PATCH /products/:id', async () => {
    const admin = await ctx.loginAs([UserRoleEnum.superAdmin], 'admin-28');
    const a = await seedProduct(ctx.dataSource, {
      title: 'Product A',
      variants: [{ sku: uniqueSku('PA'), price: 10, stock: 1 }],
    });
    const b = await seedProduct(ctx.dataSource, {
      title: 'Product B',
      variants: [{ sku: uniqueSku('PB'), price: 20, stock: 1 }],
    });

    const res = await ctx
      .request()
      .patch(`/products/${a.id}`)
      .set('Cookie', admin.cookie)
      .send({ variants: [{ id: b.variants[0].id, price: 1 }] })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain(
      ProductMessages.VARIANT_DOES_NOT_BELONG_TO_PRODUCT,
    );

    // ...and the foreign variant's price was NOT changed.
    const untouched = await ctx.dataSource.query(
      `SELECT "price"::text AS price FROM "product_variants" WHERE "id" = $1`,
      [b.variants[0].id],
    );
    expect(Number(untouched[0].price)).toBe(20);
  });
});
