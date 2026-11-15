/**
 * ACCEPTANCE 1, 2, 7 -- seller attribution cannot be forged, the branch comes
 * from the token, and an empty sale is rejected.
 *
 * Runs against the real disposable PostgreSQL from workstream A's harness: the
 * FK to `users`, the enum columns and the jsonb snapshot column are the real
 * ones, and every assertion below reads the committed row back out of the
 * database rather than trusting the HTTP response alone.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  as,
  Cashier,
  loginCashier,
  seedBranch,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';

describe('POS sale — seller attribution (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    // Applies the migrations once per process before the app boots.
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
  });

  async function twoCashiersInOneBranch(): Promise<{
    branchId: number;
    branchName: string;
    a: Cashier;
    b: Cashier;
  }> {
    const branch = await seedBranch(ctx, 'Central');
    const a = await loginCashier(ctx, branch, { username: 'cashier_a' });
    const b = await loginCashier(ctx, branch, { username: 'cashier_b' });
    return { branchId: branch.id, branchName: branch.name, a, b };
  }

  // -----------------------------------------------------------------------
  // 1. cashier B cannot forge attribution to cashier A
  // -----------------------------------------------------------------------
  it('attributes the sale to the authenticated cashier, ignoring a forged cashierId in the body', async () => {
    const { a, b } = await twoCashiersInOneBranch();
    const variant = await seedVariant(ctx, { price: 250_000, stock: 5 });

    const res = await as(ctx, b)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        // B claims the sale belongs to A. This must have no effect whatsoever.
        cashierId: a.userId,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    expect(res.body.data.cashierUserId).toBe(b.userId);
    expect(res.body.data.cashierUserId).not.toBe(a.userId);
    expect(res.body.data.cashierDisplaySnapshot).toBe('cashier_b');

    const [row] = await ctx.dataSource.query(
      `SELECT "cashierUserId", "cashierDisplaySnapshot", "branchNameSnapshot", channel, status, "paymentMethod", "orderNumber", "soldAt"
         FROM orders WHERE id = $1`,
      [res.body.data.id],
    );
    expect(Number(row.cashierUserId)).toBe(b.userId);
    expect(row.cashierDisplaySnapshot).toBe('cashier_b');
    expect(row.branchNameSnapshot).toBe('Central');
    expect(row.channel).toBe(OrderChannel.POS);
    expect(row.status).toBe(OrderStatusEnum.PAID);
    expect(row.paymentMethod).toBe(PaymentMethodEnum.CASH);
    expect(row.orderNumber).toMatch(/^POS-\d{8}-\d{6}$/);
    expect(row.soldAt).toBeInstanceOf(Date);
  });

  // -----------------------------------------------------------------------
  // 2. the authenticated branch is enforced
  // -----------------------------------------------------------------------
  it('takes the branch from the token and ignores branchId in the body', async () => {
    const home = await seedBranch(ctx, 'Home branch');
    const other = await seedBranch(ctx, 'Other branch');
    const cashier = await loginCashier(ctx, home);
    const variant = await seedVariant(ctx, { price: 100_000, stock: 3 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CARD_TERMINAL,
        branchId: other.id, // must be ignored
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    expect(res.body.data.branchId).toBe(home.id);
    expect(res.body.data.branchNameSnapshot).toBe('Home branch');

    const [row] = await ctx.dataSource.query(
      `SELECT "branchId", "branchNameSnapshot" FROM orders WHERE id = $1`,
      [res.body.data.id],
    );
    expect(Number(row.branchId)).toBe(home.id);
    expect(Number(row.branchId)).not.toBe(other.id);
    expect(row.branchNameSnapshot).toBe('Home branch');
  });

  it('refuses a POS sale from a user who has no branch', async () => {
    const branch = await seedBranch(ctx, 'Some branch');
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 100_000, stock: 3 });

    // Detach the cashier from the branch, then re-authenticate so the token
    // reflects it.
    await ctx.dataSource.query(
      `UPDATE users SET "branchId" = NULL WHERE id = $1`,
      [cashier.userId],
    );
    const { authenticate } = await import('./setup/test-app');
    const jar = await authenticate(ctx, cashier.username, cashier.password);

    const res = await as(ctx, { jar })
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/branch/i);
  });

  // -----------------------------------------------------------------------
  // 7. an empty sale is rejected
  // -----------------------------------------------------------------------
  it('rejects a sale with an empty items array and writes nothing', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({ paymentMethod: PaymentMethodEnum.CASH, items: [] });

    expect(res.status).toBe(400);
    const [{ count }] = await ctx.dataSource.query(
      `SELECT COUNT(*)::text AS count FROM orders`,
    );
    expect(Number(count)).toBe(0);
  });

  it('rejects a sale with no items key at all', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({ paymentMethod: PaymentMethodEnum.CASH });

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Walk-in sale: no customer details at all
  // -----------------------------------------------------------------------
  it('records a walk-in sale with no customer details', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 75_000, stock: 2 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);

    expect(res.body.data.customerId).toBeNull();
    expect(res.body.data.totalPrice).toBe(150_000);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(0);

    const [{ count }] = await ctx.dataSource.query(
      `SELECT COUNT(*)::text AS count FROM customers`,
    );
    expect(Number(count)).toBe(0);
  });

  it('links a customer when a mobile number is supplied, inside the sale transaction', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 75_000, stock: 2 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        mobile: '09123456789',
        name: 'Ali Ahmadi',
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    expect(res.body.data.customerId).toEqual(expect.any(Number));
    const [customer] = await ctx.dataSource.query(
      `SELECT mobile, name FROM customers WHERE id = $1`,
      [res.body.data.customerId],
    );
    expect(customer).toEqual({ mobile: '09123456789', name: 'Ali Ahmadi' });
  });

  it('does not leave an orphan customer behind when the sale fails', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 75_000, stock: 1 });

    // Asking for more than exists fails AFTER the customer upsert would have
    // run. Because the upsert now uses the transaction's EntityManager, the
    // rollback takes the customer with it.
    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        mobile: '09120000000',
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 5 }],
      });

    expect(res.status).toBe(409);
    const [{ count }] = await ctx.dataSource.query(
      `SELECT COUNT(*)::text AS count FROM customers`,
    );
    expect(Number(count)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Line snapshots and the shared payment ledger
  // -----------------------------------------------------------------------
  it('writes immutable line snapshots and a SUCCESS payment row', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, {
      title: 'Wool scarf',
      price: 480_000,
      stock: 4,
      sku: 'SCARF-RED',
    });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CARD_TERMINAL,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);

    const [line] = await ctx.dataSource.query(
      `SELECT "productTitleSnapshot", "variantSkuSnapshot", quantity, unit_price, total_price
         FROM order_items WHERE "orderId" = $1`,
      [res.body.data.id],
    );
    expect(line.productTitleSnapshot).toBe('Wool scarf');
    expect(line.variantSkuSnapshot).toBe('SCARF-RED');
    expect(Number(line.quantity)).toBe(2);
    expect(Number(line.unit_price)).toBe(480_000);
    expect(Number(line.total_price)).toBe(960_000);

    const [payment] = await ctx.dataSource.query(
      `SELECT amount, status FROM payment WHERE "orderId" = $1`,
      [res.body.data.id],
    );
    expect(Number(payment.amount)).toBe(960_000);
    expect(payment.status).toBe('success');
  });

  it('reports the committed stock balance, not a pre-lock snapshot', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 10_000, stock: 7 });

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 3 }],
      })
      .expect(201);

    expect(res.body.data.stock).toEqual([
      expect.objectContaining({
        variantId: variant.id,
        quantityConsumed: 3,
        balanceAfter: 4,
      }),
    ]);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);
  });
});
