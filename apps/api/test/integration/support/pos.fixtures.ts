/**
 * POS-specific fixtures on top of workstream A's `seed-helpers`.
 *
 * These go through the real repositories against the real disposable
 * PostgreSQL, so the column types, enums, FKs and unique indexes under test are
 * the ones the application will meet in production.
 */
import { DataSource } from 'typeorm';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import { Order } from 'src/modules/orders/entities/order.entity';
import { OrderItems } from 'src/modules/orders/entities/order-item.entity';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  createBranch,
  createProductWithVariant,
  createUser,
} from '../setup/seed-helpers';
import {
  authenticate,
  CookieClient,
  CookieJar,
  TestApp,
  withCookies,
} from '../setup/test-app';
import { POS_IDEMPOTENCY_HEADER } from 'src/modules/orders/idempotency.helper';
import { buildOrderNumber } from 'src/modules/orders/order-number';
import { fixtureIdempotencyKey } from '../setup/fixture-ids';

/**
 * The zone the production generator stamps an order number with. Fixed here
 * rather than read from the environment so a seeded order number is stable
 * whatever `REPORT_TIMEZONE` a developer has exported.
 */
const REPORT_TIMEZONE = 'Asia/Tehran';

export interface Cashier {
  userId: number;
  username: string;
  password: string;
  branchId: number;
  jar: CookieJar;
}

/** A logged-in `sale` user attached to `branch`. */
export async function loginCashier(
  ctx: TestApp,
  branch: Branch,
  overrides: { username?: string } = {},
): Promise<Cashier> {
  const { user, username, password } = await createUser(ctx.dataSource, {
    roles: [UserRoleEnum.sale],
    branchId: branch.id,
    username: overrides.username,
  });
  const jar = await authenticate(ctx, username, password, 'pos');
  return { userId: user.id, username, password, branchId: branch.id, jar };
}

export async function loginSuperAdmin(
  ctx: TestApp,
  overrides: { username?: string } = {},
): Promise<{ userId: number; jar: CookieJar; username: string }> {
  const { user, username, password } = await createUser(ctx.dataSource, {
    roles: [UserRoleEnum.superAdmin],
    username: overrides.username,
  });
  return {
    userId: user.id,
    username,
    jar: await authenticate(ctx, username, password, 'admin'),
  };
}

/** `POST` targets that require an `Idempotency-Key` header. */
const POS_SALE_ROUTE = '/orders/pos';

/**
 * A fresh POS idempotency key, from the shared fixture allocator.
 *
 * It obeys the production contract the endpoint enforces — `^[A-Za-z0-9._:-]+$`
 * and 8..200 characters (`idempotency.helper.ts`) — and carries the worker, run
 * and sequence, so a failing assertion names which fixture produced the key
 * instead of showing an opaque UUID. The label is sanitised to the accepted
 * charset, so naming a case cannot turn into a 400 that reads like the endpoint
 * rejecting the test's intent.
 */
export function posKey(label?: string): string {
  return fixtureIdempotencyKey(label);
}

/**
 * Cookie-carrying client that behaves like a real POS FRONTEND: it generates a
 * fresh `Idempotency-Key` for every `POST /orders/pos` it sends.
 *
 * WHY THE HELPER DOES THIS. The header is now required, and the client that
 * supplies it in production is the POS application, not a person — so a test
 * client that stands in for that application must supply it too, or every
 * unrelated test that merely needs "a sale to exist" would be asserting the
 * behaviour of a client that does not exist. A fresh key per call also matches
 * the semantics those tests already relied on: two calls are two sales.
 *
 * An explicit `.set('Idempotency-Key', ...)` in a test still wins, because
 * superagent's `set` overwrites — so replay and reuse cases are written exactly
 * as they read. Use `asRaw` when the point of the test is the header's absence
 * or malformedness.
 */
export function as(ctx: TestApp, who: { jar: CookieJar }): CookieClient {
  const client = withCookies(ctx, who.jar);
  return {
    ...client,
    post: (url: string) => {
      const req = client.post(url);
      return url === POS_SALE_ROUTE
        ? req.set(POS_IDEMPOTENCY_HEADER, posKey())
        : req;
    },
  };
}

/**
 * Verbatim client: sends exactly the headers the test sets and nothing else.
 * Required for the "no key at all" and "malformed key" cases — `as()` would
 * paper over precisely the bug under test.
 */
export function asRaw(ctx: TestApp, who: { jar: CookieJar }): CookieClient {
  return withCookies(ctx, who.jar);
}

export async function seedBranch(ctx: TestApp, name?: string): Promise<Branch> {
  return createBranch(ctx.dataSource, name ? { name } : {});
}

export async function seedVariant(
  ctx: TestApp,
  opts: { title?: string; price?: number; stock: number; sku?: string },
): Promise<ProductVariant> {
  const { variant } = await createProductWithVariant(
    ctx.dataSource,
    { title: opts.title },
    { price: opts.price ?? 1_000_000, stock: opts.stock, sku: opts.sku },
  );
  return variant;
}

export async function stockOf(
  ds: DataSource,
  variantId: number,
): Promise<number> {
  const [row]: Array<{ stock: number }> = await ds.query(
    `SELECT stock FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return Number(row.stock);
}

export async function countOrders(ds: DataSource): Promise<number> {
  const [row]: Array<{ count: string }> = await ds.query(
    `SELECT COUNT(*)::text AS count FROM orders`,
  );
  return Number(row.count);
}

export async function countMovements(
  ds: DataSource,
  variantId: number,
): Promise<number> {
  const [row]: Array<{ count: string }> = await ds.query(
    `SELECT COUNT(*)::text AS count FROM stock_movements WHERE "variantId" = $1`,
    [variantId],
  );
  return Number(row.count);
}

/**
 * Plants a completed sale straight into the database at a chosen `soldAt`.
 *
 * Reporting tests need sales at specific UTC instants (timezone-boundary
 * cases), and the HTTP endpoint deliberately stamps `soldAt = now()`. Going
 * through repositories keeps the row shape identical to a real sale.
 */
export async function seedSale(
  ds: DataSource,
  input: {
    soldAt: Date;
    branchId: number;
    branchName: string;
    cashierUserId: number;
    cashierDisplay: string;
    total: number;
    quantity?: number;
    variantId?: number | null;
    status?: OrderStatusEnum;
    voidedAt?: Date | null;
    channel?: OrderChannel;
    productTitle?: string;
  },
): Promise<Order> {
  const orderRepo = ds.getRepository(Order);
  const order = await orderRepo.save(
    orderRepo.create({
      channel: input.channel ?? OrderChannel.POS,
      status: input.status ?? OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      paymentMethod: PaymentMethodEnum.CASH,
      branchId: input.branchId,
      branchNameSnapshot: input.branchName,
      cashierUserId: input.cashierUserId,
      cashierDisplaySnapshot: input.cashierDisplay,
      subtotal: input.total,
      total_price: input.total,
      soldAt: input.soldAt,
      paid_at: input.soldAt,
      voidedAt: input.voidedAt ?? null,
    }),
  );
  /*
   * THE PRODUCTION ORDER-NUMBER FORMAT, from the production generator.
   *
   * This used to write `SEED-000001`, which is not a shape the application can
   * produce and would not have caught a regression in the real format or its
   * 40-character bound. `buildOrderNumber` is the same function
   * `OrdersService` calls, so a fixture sale now carries exactly what a real
   * one carries — and `orders."orderNumber"` is UNIQUE, which the per-order id
   * keeps true.
   */
  await orderRepo.update(order.id, {
    orderNumber: buildOrderNumber(
      input.channel ?? OrderChannel.POS,
      order.id,
      input.soldAt,
      REPORT_TIMEZONE,
    ),
  });

  const itemRepo = ds.getRepository(OrderItems);
  await itemRepo.save(
    itemRepo.create({
      orderId: order.id,
      variantId: input.variantId ?? null,
      productId: null,
      productTitleSnapshot: input.productTitle ?? 'Seeded product',
      variantSkuSnapshot: 'SEED-SKU',
      attributesSnapshot: null,
      quantity: input.quantity ?? 1,
      unit_price: input.total,
      total_price: input.total,
    }),
  );

  return order;
}
