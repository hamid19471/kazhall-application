/**
 * ============================================================================
 * MONEY BOUNDARIES ON THE WRITE PATHS (int)
 * ============================================================================
 *
 * The unit suite (src/common/money/money-write-bounds.spec.ts) enumerates the
 * decorators and the guarded arithmetic in isolation. This file asserts the
 * three things a unit test cannot:
 *
 *   1. The global `ValidationPipe` actually turns those decorators into a
 *      STABLE 400 on the real route, rather than a 500 from somewhere deeper.
 *   2. The guarded multiply and fold actually REFUSE A SALE when a price that
 *      predates the DTO bounds is already sitting in the database — the one
 *      case a validator structurally cannot cover, because nothing revalidates
 *      a row on the way back out.
 *   3. `bigIntTransformer.to` refuses the write against a REAL `bigint` column
 *      through TypeORM, not against a hand-called function.
 *
 * NOTHING IS CLAMPED ANYWHERE. Every rejection case also asserts that no order,
 * no stock movement and no product row appeared, because "rejected" and
 * "rejected without side effects" are different claims and only the second one
 * is worth anything after a partial write.
 *
 * Fixture identifiers come from setup/fixture-ids.ts via the shared helpers;
 * none are hand-rolled.
 * ============================================================================
 */
import * as request from 'supertest';

import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp, withCookies } from './support/pos.harness';
import {
  as,
  countMovements,
  countOrders,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';
import { fixtureSku } from './setup/fixture-ids';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  MAX_RIAL,
} from 'src/common/money/rial';
import { Order } from 'src/modules/orders/entities/order.entity';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { Product } from 'src/modules/products/entities/product.entity';

describe('Money write-path boundaries (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
  });

  async function admin() {
    const who = await loginSuperAdmin(ctx);
    return withCookies(ctx, who.jar);
  }

  /** Anonymous client, for the public catalogue query filters. */
  const anon = () => request(ctx.server);

  const productBody = (basePrice: number) => ({
    title: `bound-${fixtureSku('P')}`,
    description: 'money boundary fixture',
    basePrice,
    // «کد محصول» is NOT NULL and required by the DTO since 0031. Each case
    // runs against a freshly reset database, so one fixed literal is unique.
    productCode: 'KZ-P-MONEYBOUND1',
  });

  // -----------------------------------------------------------------------
  // basePrice — exactly at the bound, and one above
  // -----------------------------------------------------------------------

  it('accepts a product whose basePrice is exactly MAX_RIAL', async () => {
    const client = await admin();
    const res = await client.post('/products').send(productBody(MAX_RIAL));

    expect(res.status).toBe(201);
    // Round-tripped through a `bigint` column and back, digit for digit. A
    // clamp or a truncation would show up here and nowhere else.
    const [row]: Array<{ basePrice: string }> = await ctx.dataSource.query(
      `SELECT "basePrice"::text AS "basePrice" FROM products ORDER BY id DESC LIMIT 1`,
    );
    expect(row.basePrice).toBe(String(MAX_RIAL));
  });

  it('rejects basePrice = MAX_RIAL + 1 with a 400 and writes nothing', async () => {
    const client = await admin();
    const before = await ctx.dataSource.getRepository(Product).count();

    const res = await client.post('/products').send(productBody(MAX_RIAL + 1));

    expect(res.status).toBe(400);
    expect(await ctx.dataSource.getRepository(Product).count()).toBe(before);
  });

  // -----------------------------------------------------------------------
  // minPrice / maxPrice — the query filters
  // -----------------------------------------------------------------------

  it('accepts minPrice at the bound and rejects one above it', async () => {
    await anon().get(`/products?minPrice=${MAX_RIAL}`).expect(200);
    await anon()
      .get(`/products?minPrice=${MAX_RIAL + 1}`)
      .expect(400);
    await anon()
      .get(`/products?maxPrice=${MAX_RIAL + 1}`)
      .expect(400);
  });

  // -----------------------------------------------------------------------
  // POS quantity — exactly at the bound, and one above
  // -----------------------------------------------------------------------

  it('sells exactly MAX_LINE_QUANTITY units on one line', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, {
      price: 1_000,
      stock: MAX_LINE_QUANTITY,
    });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: MAX_LINE_QUANTITY }],
      });

    expect(res.status).toBe(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(0);

    // The subtotal is the exact product, read back from the `bigint` column.
    const [order]: Array<{ subtotal: string }> = await ctx.dataSource.query(
      `SELECT subtotal::text AS subtotal FROM orders ORDER BY id DESC LIMIT 1`,
    );
    expect(order.subtotal).toBe(String(1_000 * MAX_LINE_QUANTITY));
  });

  it('rejects quantity = MAX_LINE_QUANTITY + 1 with a 400 and no movement', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, {
      price: 1_000,
      stock: MAX_LINE_QUANTITY + 1,
    });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: variant.id, quantity: MAX_LINE_QUANTITY + 1 },
        ],
      });

    // Not clamped to MAX_LINE_QUANTITY: a till that meant 1 001 must be told,
    // not quietly sold 1 000 and left with a stock count nobody can explain.
    expect(res.status).toBe(400);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(
      MAX_LINE_QUANTITY + 1,
    );
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
    expect(await countOrders(ctx.dataSource)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // items array size — the other divisor behind MAX_RIAL
  // -----------------------------------------------------------------------

  it('rejects more than MAX_ORDER_LINES items with a 400', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 1_000, stock: 5 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: Array.from({ length: MAX_ORDER_LINES + 1 }, () => ({
          productVariantId: variant.id,
          quantity: 1,
        })),
      });

    // Refused BEFORE aggregation and before any stock work: `MAX_RIAL` is
    // `MAX_SAFE_INTEGER / (MAX_ORDER_LINES * MAX_LINE_QUANTITY)`, so without
    // this cap the unit-price ceiling proves nothing about the order total.
    expect(res.status).toBe(400);
    expect(await countOrders(ctx.dataSource)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // THE MULTIPLICATION CASE — a price the DTO would now refuse, already stored
  // -----------------------------------------------------------------------

  it('refuses a sale whose line total would be a rounded product', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);

    /*
     * 2^52 + 1 Rial. It is a SAFE INTEGER, so `bigIntTransformer.to` stores it
     * happily and nothing about the row looks wrong — this is exactly the shape
     * of a price written before MAX_RIAL existed. Multiplied by 3 the true
     * product is odd and above 2^53, where doubles step in twos, so `*` returns
     * its neighbour and the receipt would be off by one Rial with no record.
     */
    const unsafePrice = 4_503_599_627_370_497;
    const variant = await seedVariant(ctx, { price: unsafePrice, stock: 10 });
    expect(BigInt(unsafePrice * 3)).not.toEqual(BigInt(unsafePrice) * 3n);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 3 }],
      });

    // The status is whatever the global filter makes of a RangeError; the
    // CONTRACT being asserted is that the sale did not happen and the stock did
    // not move, not which 5xx/4xx code it chose.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countOrders(ctx.dataSource)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(10);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // THE AGGREGATION CASE — every line fine, the subtotal not
  // -----------------------------------------------------------------------

  it('refuses a sale whose SUBTOTAL would be rounded though every line is exact', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);

    /*
     * Three lines of 4 000 000 000 000 000 Rial each. Every line total is well
     * inside the safe range and would pass any per-field check; their sum,
     * 1.2e16, is above 2^53. This is the failure a per-field bound cannot see,
     * and the one the old `purchasable.reduce((s, i) => s + ...)` produced
     * silently and stored as `orders.subtotal`.
     */
    const linePrice = 4_000_000_000_000_000;
    expect(Number.isSafeInteger(linePrice)).toBe(true);

    const variants: ProductVariant[] = [];
    for (let i = 0; i < 3; i += 1) {
      variants.push(
        await seedVariant(ctx, {
          price: linePrice,
          stock: 2,
          sku: fixtureSku('AGG'),
        }),
      );
    }

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: variants.map((v) => ({ productVariantId: v.id, quantity: 1 })),
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countOrders(ctx.dataSource)).toBe(0);
    for (const v of variants) {
      expect(await stockOf(ctx.dataSource, v.id)).toBe(2);
    }
  });

  // -----------------------------------------------------------------------
  // THE TRANSFORMER'S WRITE DIRECTION, against a real bigint column
  // -----------------------------------------------------------------------

  describe('bigIntTransformer.to against real columns', () => {
    it('stores the largest exactly representable amount unchanged', async () => {
      const repo = ctx.dataSource.getRepository(Order);
      const saved = await repo.save(
        repo.create({
          channel: OrderChannel.POS,
          subtotal: Number.MAX_SAFE_INTEGER,
          total_price: Number.MAX_SAFE_INTEGER,
        }),
      );

      const [row]: Array<{ total_price: string }> = await ctx.dataSource.query(
        `SELECT total_price::text AS total_price FROM orders WHERE id = $1`,
        [saved.id],
      );
      // Compared as TEXT. Reading it back as a number would round it with the
      // same error the write guard exists to prevent.
      expect(row.total_price).toBe(String(Number.MAX_SAFE_INTEGER));
    });

    it('throws rather than writing an unsafe integer', async () => {
      const repo = ctx.dataSource.getRepository(Order);
      await expect(
        repo.save(
          repo.create({
            // Every NOT NULL column supplied, so the only thing that can refuse
            // this row is the transformer — not a constraint further down.
            channel: OrderChannel.POS,
            subtotal: 0,
            // 2^53 — representable as a double, but its neighbours collapse
            // onto it, so `Number.isSafeInteger` is false.
            total_price: Number.MAX_SAFE_INTEGER + 1,
          }),
        ),
      ).rejects.toThrow(/Number\.MAX_SAFE_INTEGER/);

      expect(await countOrders(ctx.dataSource)).toBe(0);
    });

    it('throws rather than truncating a fractional Rial', async () => {
      /*
       * The old `to` was `Math.trunc(value)`: this row would have been stored
       * as 1234 and the 0.56 would have vanished with nothing recording that it
       * had existed. A fractional Rial means the producer was working in a
       * different unit, which has to be resolved where it arose.
       */
      const repo = ctx.dataSource.getRepository(ProductVariant);
      const product = await ctx.dataSource.getRepository(Product).save(
        ctx.dataSource.getRepository(Product).create({
          title: `frac-${fixtureSku('V')}`,
          description: 'fractional rial fixture',
          basePrice: 1_000,
          productCode: 'KZ-P-MONEYFRAC1',
        }),
      );

      await expect(
        repo.save(
          repo.create({
            product,
            sku: fixtureSku(),
            // A VALID «کد گونه» under the parent, so the rejection below is
            // the transformer refusing the fraction and not a NOT NULL column.
            variantCode: 'KZ-P-MONEYFRAC1-V1',
            price: 1_234.56,
            stock: 1,
          }),
        ),
      ).rejects.toThrow();

      expect(await repo.count()).toBe(0);
    });
  });
});
