/**
 * ACCEPTANCE 6, 8, 9, 10 -- duplicate lines, idempotency and concurrency.
 *
 * These are the reasons this suite refuses to use mocks. Every case here is a
 * PostgreSQL guarantee: a conditional `UPDATE ... WHERE stock >= :q RETURNING`,
 * a UNIQUE index used as a concurrency primitive, and two genuinely parallel
 * transactions racing for the same row.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  as,
  countMovements,
  countOrders,
  loginCashier,
  seedBranch,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';

describe('POS sale — stock integrity and idempotency (int)', () => {
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

  // -----------------------------------------------------------------------
  // 6. duplicate variant rows are aggregated, so they cannot oversell
  // -----------------------------------------------------------------------
  it('rejects stock=1 with two duplicate rows of qty 1 and leaves no partial sale', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 1 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: variant.id, quantity: 1 },
          { productVariantId: variant.id, quantity: 1 },
        ],
      });

    // The two rows are summed to a single request for 2 units BEFORE the
    // availability check, so they can never each pass a "stock >= 1" test
    // against the same unit.
    expect(res.status).toBe(409);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(1);
    expect(await countOrders(ctx.dataSource)).toBe(0);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
  });

  it('aggregates duplicate rows into one order line when stock is sufficient', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 5 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: variant.id, quantity: 1 },
          { productVariantId: variant.id, quantity: 2 },
        ],
      })
      .expect(201);

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].quantity).toBe(3);
    expect(res.body.data.totalPrice).toBe(1_500_000);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 8. retrying with the same key is one sale
  // -----------------------------------------------------------------------
  it('replays the stored response for a retried Idempotency-Key: one sale, one decrement, same attribution', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });

    const body = {
      paymentMethod: PaymentMethodEnum.CASH,
      items: [{ productVariantId: variant.id, quantity: 2 }],
    };

    const first = await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0001')
      .send(body)
      .expect(201);

    const second = await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0001')
      .send(body)
      .expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);
    expect(second.body.data.cashierUserId).toBe(cashier.userId);
    expect(second.body.data.cashierUserId).toBe(first.body.data.cashierUserId);

    expect(await countOrders(ctx.dataSource)).toBe(1);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(8);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 9. same key, different payload
  // -----------------------------------------------------------------------
  it('rejects the same Idempotency-Key with a different payload, consistently', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });

    await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0002')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);

    const conflicting = {
      paymentMethod: PaymentMethodEnum.CASH,
      items: [{ productVariantId: variant.id, quantity: 3 }],
    };

    const a = await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0002')
      .send(conflicting);
    const b = await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0002')
      .send(conflicting);

    // Consistent: the same rejection every time, not "409 then 201".
    expect(a.status).toBe(409);
    expect(b.status).toBe(409);
    expect(String(a.body.message)).toBe(String(b.body.message));

    expect(await countOrders(ctx.dataSource)).toBe(1);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(8);
  });

  it('treats a reordered but semantically identical payload as the same request', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });

    const first = await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0003')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);

    // Same sale, keys emitted in a different order by a different client lib.
    const second = await as(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', 'terminal-7-sale-0003')
      .send({
        items: [{ quantity: 2, productVariantId: variant.id }],
        paymentMethod: PaymentMethodEnum.CASH,
      })
      .expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await countOrders(ctx.dataSource)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 10. two genuinely concurrent sales of the last unit
  // -----------------------------------------------------------------------
  it('lets exactly one of two concurrent sales take the last unit', async () => {
    const branch = await seedBranch(ctx);
    const a = await loginCashier(ctx, branch, { username: 'race_a' });
    const b = await loginCashier(ctx, branch, { username: 'race_b' });
    const variant = await seedVariant(ctx, { price: 900_000, stock: 1 });

    const body = {
      paymentMethod: PaymentMethodEnum.CASH,
      items: [{ productVariantId: variant.id, quantity: 1 }],
    };

    // Two in-flight HTTP requests => two independent database transactions
    // racing on the same row. No shared JS state can hide a lost update here.
    const [first, second] = await Promise.all([
      as(ctx, a).post('/orders/pos').send(body),
      as(ctx, b).post('/orders/pos').send(body),
    ]);

    const statuses = [first.status, second.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);

    expect(await stockOf(ctx.dataSource, variant.id)).toBe(0);
    expect(await countOrders(ctx.dataSource)).toBe(1);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(1);

    const winner = first.status === 201 ? first : second;
    const [row] = await ctx.dataSource.query(
      `SELECT "cashierUserId" FROM orders WHERE id = $1`,
      [winner.body.data.id],
    );
    expect([a.userId, b.userId]).toContain(Number(row.cashierUserId));
  });

  it('never drives stock negative when five sales race for three units', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 100_000, stock: 3 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        as(ctx, cashier)
          .post('/orders/pos')
          .send({
            paymentMethod: PaymentMethodEnum.CASH,
            items: [{ productVariantId: variant.id, quantity: 1 }],
          }),
      ),
    );

    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(3);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(0);
    expect(await countOrders(ctx.dataSource)).toBe(3);
  });
});
