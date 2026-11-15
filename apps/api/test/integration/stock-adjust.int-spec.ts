/**
 * B7 -- the admin stock-adjust endpoint must be reservation-aware.
 *
 * It delegates to `IInventoryService.adjustStock` (workstream D). These tests
 * exercise the HTTP contract: mode set/delta, the 409 when the result would
 * fall below the reserved quantity, the `allowBelowReserved` escape hatch, and
 * the `basketReserved` / `orderAllocated` fields in the response.
 *
 * `ProductsModule` imports `InventoryModule` and injects `InventoryService`
 * under the shared `IInventoryService` contract, so these run against D's real
 * implementation rather than a stand-in.
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  ReservationKind,
  ReservationStatus,
} from 'src/modules/inventory/entities/stock-reservation.entity';
import { ProductMessages } from 'src/common/constants/product.messages';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { seedProduct, uniqueSku } from './support/catalog.fixtures';

async function seedReservation(
  ctx: TestApp,
  input: {
    variantId: number;
    kind: ReservationKind;
    quantity: number;
    userId?: number | null;
    orderId?: number | null;
    cartItemId?: number | null;
    expiresInMs?: number;
  },
): Promise<void> {
  await ctx.dataSource.query(
    `INSERT INTO "stock_reservations"
       ("variantId","kind","status","quantity","userId","cartItemId","orderId","expiresAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.variantId,
      input.kind,
      ReservationStatus.ACTIVE,
      input.quantity,
      input.userId ?? null,
      input.cartItemId ?? null,
      input.orderId ?? null,
      new Date(Date.now() + (input.expiresInMs ?? 3_600_000)),
    ],
  );
}

describe('Variant stock adjust (int)', () => {
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
    admin = await ctx.loginAs([UserRoleEnum.superAdmin], 'admin-stock');
  });

  const seedVariant = async (stock: number) => {
    const product = await seedProduct(ctx.dataSource, {
      title: 'Stocked',
      variants: [{ sku: uniqueSku('ST'), price: 1000, stock }],
    });
    return { product, variant: product.variants[0] };
  };

  it('requires an admin session, not merely the superAdmin role', async () => {
    const { variant } = await seedVariant(10);
    const shopper = await ctx.loginAs([UserRoleEnum.site], 'stock-shopper');

    // Stock administration is declared for the admin audience. A shopper's
    // storefront session is refused at 401 before the role is read, so the
    // route cannot be reached by holding the right role on the wrong surface.
    await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', shopper.cookie)
      .send({ mode: 'delta', value: 1 })
      .expect(401);

    await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .send({ mode: 'delta', value: 1 })
      .expect(401);
  });

  it('applies a delta and reports the reserved quantities', async () => {
    const { variant } = await seedVariant(10);

    const res = await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'delta', value: -3, reason: 'shrinkage' })
      .expect(201);

    expect(res.body.data).toEqual(
      expect.objectContaining({
        variantId: variant.id,
        previousStock: 10,
        balanceAfter: 7,
        basketReserved: 0,
        orderAllocated: 0,
        belowReserved: false,
      }),
    );

    const rows = await ctx.dataSource.query(
      `SELECT "stock" FROM "product_variants" WHERE "id" = $1`,
      [variant.id],
    );
    expect(rows[0].stock).toBe(7);
  });

  it('sets an absolute stock value below the current one', async () => {
    const { variant } = await seedVariant(10);

    const res = await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 4 })
      .expect(201);

    expect(res.body.data).toEqual(
      expect.objectContaining({ previousStock: 10, balanceAfter: 4 }),
    );
  });

  it.each([
    ['set above the current stock', { mode: 'set', value: 25 }],
    ['positive delta', { mode: 'delta', value: 3 }],
  ])(
    'refuses a %s with STOCK_INCREASE_REQUIRES_RECEIPT and writes nothing',
    async (_label, body) => {
      const { variant } = await seedVariant(10);

      const res = await ctx
        .request()
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .set('Cookie', admin.cookie)
        .send(body)
        .expect(409);
      // Units entering the shelf need a cost; this endpoint cannot state one.
      expect(res.body.error).toBe('STOCK_INCREASE_REQUIRES_RECEIPT');

      const rows = await ctx.dataSource.query(
        `SELECT "stock" FROM "product_variants" WHERE "id" = $1`,
        [variant.id],
      );
      expect(rows[0].stock).toBe(10);
      const movements = await ctx.dataSource.query(
        `SELECT id FROM "stock_movements" WHERE "variantId" = $1`,
        [variant.id],
      );
      expect(movements).toHaveLength(0);
    },
  );

  it('never allows negative physical stock', async () => {
    const { variant } = await seedVariant(2);

    await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'delta', value: -5 })
      .expect(400);

    await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: -1 })
      .expect(400);
  });

  it('rejects an adjustment that would fall below the reserved quantity', async () => {
    const { variant } = await seedVariant(10);
    const shopper = await ctx.loginAs([UserRoleEnum.site], 'stock-holder');

    await seedReservation(ctx, {
      variantId: variant.id,
      kind: ReservationKind.BASKET,
      quantity: 4,
      userId: shopper.userId,
    });
    await seedReservation(ctx, {
      variantId: variant.id,
      kind: ReservationKind.ORDER,
      quantity: 2,
    });

    const res = await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 5 })
      .expect(409);

    // The shared error envelope only carries `message` and `error`, so the
    // reserved quantities are reported inside the message.
    expect(res.body.error).toBe('STOCK_BELOW_RESERVED');
    expect(res.body.message).toContain(ProductMessages.STOCK_BELOW_RESERVED);
    expect(res.body.message).toContain('basketReserved=4');
    expect(res.body.message).toContain('orderAllocated=2');

    // Nothing was changed.
    const rows = await ctx.dataSource.query(
      `SELECT "stock" FROM "product_variants" WHERE "id" = $1`,
      [variant.id],
    );
    expect(rows[0].stock).toBe(10);
  });

  it('performs the adjustment anyway when allowBelowReserved is passed', async () => {
    const { variant } = await seedVariant(10);
    await seedReservation(ctx, {
      variantId: variant.id,
      kind: ReservationKind.BASKET,
      quantity: 6,
    });

    const res = await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 2, allowBelowReserved: true })
      .expect(201);

    expect(res.body.data).toEqual(
      expect.objectContaining({
        balanceAfter: 2,
        basketReserved: 6,
        belowReserved: true,
      }),
    );
  });

  it('does not count expired reservations against the adjustment', async () => {
    const { variant } = await seedVariant(10);
    await seedReservation(ctx, {
      variantId: variant.id,
      kind: ReservationKind.BASKET,
      quantity: 8,
      expiresInMs: -1_000, // already expired
    });

    await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 1 })
      .expect(201);
  });

  it('makes the new availability visible on the next public read', async () => {
    const { product, variant } = await seedVariant(5);

    const before = await ctx
      .request()
      .get(`/products/${product.id}`)
      .expect(200);
    expect(before.body.data.variants[0].availability.inStock).toBe(true);

    await ctx
      .request()
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .set('Cookie', admin.cookie)
      .send({ mode: 'set', value: 0 })
      .expect(201);

    const after = await ctx
      .request()
      .get(`/products/${product.id}`)
      .expect(200);
    expect(after.body.data.variants[0].availability.inStock).toBe(false);

    // ...and the cached list page was retired too.
    const list = await ctx.request().get('/products').expect(200);
    expect(list.body.data[0].inStock).toBe(false);
  });

  it('404s for an unknown variant', async () => {
    await ctx
      .request()
      .post('/products/variants/999999/stock/adjust')
      .set('Cookie', admin.cookie)
      .send({ mode: 'delta', value: 1 })
      .expect(404);
  });
});
