import { uniqueSuffix } from '../setup/fixture-ids';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';

import { CartService } from 'src/modules/cart/cart.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { ReservationSweeperService } from 'src/modules/inventory/reservation-sweeper.service';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { FulfilmentRecoveryService } from 'src/modules/payment/fulfilment-recovery.service';
import { FulfilmentService } from 'src/modules/payment/fulfilment.service';
import { StubPaymentGateway } from 'src/modules/payment/gateways/stub.gateway';
import { PaymentConfig } from 'src/modules/payment/payment.config';
import { PaymentService } from 'src/modules/payment/payment.service';
import {
  RealtimeGateway,
  ROOM_SUPER_ADMIN,
} from 'src/modules/realtime/realtime.gateway';

import { getTestDataSource, resetDb } from '../setup/test-db';

/**
 * ============================================================================
 * Workstream D integration harness.
 *
 * It uses workstream A's `test/integration/setup/test-db.ts` for the
 * disposable PostgreSQL container and the migrations, but deliberately does
 * NOT boot `AppModule` through A's `createTestApp()`:
 *
 *  1. Everything under test here is a SERVICE-level transactional invariant.
 *     Driving it through HTTP would add an authentication round trip per case
 *     and would make "run these two transactions genuinely concurrently" much
 *     harder to express.
 *  2. `AppModule` currently cannot be loaded by jest at all: `@nestjs/axios@12`
 *     ships as `"type": "module"` with an ESM-only `dist`, which Node 24 can
 *     `require()` but jest's CommonJS runtime cannot. Reported to the lead.
 *
 * The services are constructed exactly as Nest would construct them, so the
 * wiring under test is the production wiring.
 * ============================================================================
 */

/** Minimal ConfigService stand-in; the real one only ever gets `.get()`. */
export function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

/** RealtimeGateway with no socket.io server attached: emits are no-ops. */
export function fakeRealtime(): RealtimeGateway {
  const emitted: Array<{ event: string; payload: unknown; room?: string }> = [];
  const server = {
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    },
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload, room });
        return true;
      },
    }),
  };
  // Mirror the gateway's SCOPED API. Production code must not call
  // `server.emit` directly (that broadcast order data to every connected
  // socket); a stub exposing only `server` silently permitted it.
  const emitOrderEvent = (
    event: string,
    payload: Record<string, unknown> & { branchId?: number | null },
  ) => {
    emitted.push({
      event,
      payload,
      /*
       * The LABEL a test reads to see who an order event reached. It mirrors
       * the gateway's real room names via the exported constant, because the
       * literal that used to live here (`'admins'`) was the pre-rename name
       * and silently described an audience that no longer exists.
       */
      room:
        payload.branchId === null || payload.branchId === undefined
          ? ROOM_SUPER_ADMIN
          : `${ROOM_SUPER_ADMIN}+branch:${String(payload.branchId)}`,
    });
  };
  const emitStockEvent = (payload: unknown) => {
    emitted.push({ event: 'stock:updated', payload });
  };
  const emitAvailabilityEvent = (payload: unknown) => {
    emitted.push({ event: 'availability:updated', payload });
  };
  const emitToUser = (userId: number, event: string, payload: unknown) => {
    emitted.push({ event, payload, room: `user:${userId}` });
  };
  /*
   * Recorded like an emit even though it is a teardown, so a test can assert
   * that a revocation reached the socket layer. Returns 0 because this harness
   * never has a real socket open.
   */
  /**
   * Mirrors `RealtimeGateway.publishAvailabilityInvalidation`.
   *
   * Recorded as ONE entry per variant with its reason, which is what the
   * reservation-invalidation tests assert on: that a basket change announces
   * `reservation` (storefront only) and a sale announces `stock`. `productId`
   * is not resolved here — the harness has no cache or socket — so it is
   * reported as null and the tests assert on variant and reason.
   */
  const publishAvailabilityInvalidation = (
    variantIds: readonly number[],
    reason: string,
  ) => {
    for (const variantId of [...new Set(variantIds)]) {
      emitted.push({
        event: 'availability:invalidated',
        payload: { variantId, reason },
        room: reason === 'reservation' ? 'public' : 'public+staff',
      });
    }
    return Promise.resolve();
  };
  const disconnectUser = (userId: number, reason: string) => {
    emitted.push({
      event: 'socket:disconnectUser',
      payload: { reason },
      room: `user:${userId}`,
    });
    return Promise.resolve(0);
  };
  return {
    server,
    emitted,
    emitOrderEvent,
    emitStockEvent,
    emitAvailabilityEvent,
    emitPosAvailabilityEvent: emitAvailabilityEvent,
    publishAvailabilityInvalidation,
    emitToUser,
    disconnectUser,
  } as unknown as RealtimeGateway;
}

export function emittedEvents(
  realtime: RealtimeGateway,
): Array<{ event: string; payload: unknown; room?: string }> {
  return (
    realtime as unknown as {
      emitted: Array<{ event: string; payload: unknown; room?: string }>;
    }
  ).emitted;
}

export interface InventoryHarness {
  dataSource: DataSource;
  inventory: InventoryService;
  cart: CartService;
  sweeper: ReservationSweeperService;
  fulfilment: FulfilmentService;
  recovery: FulfilmentRecoveryService;
  payment: PaymentService;
  gateway: StubPaymentGateway;
  realtime: RealtimeGateway;
}

export async function createInventoryHarness(
  config: Record<string, string> = {},
): Promise<InventoryHarness> {
  const dataSource = await getTestDataSource();
  await resetDb(dataSource);

  const configService = fakeConfig({
    // Timers off: every test drives the sweeper and the recovery worker
    // explicitly so nothing races the assertions.
    INVENTORY_SWEEPER_ENABLED: 'false',
    FULFILMENT_RECOVERY_ENABLED: 'false',
    PAYMENT_GATEWAY_DRIVER: 'stub',
    ...config,
  });

  const inventory = new InventoryService(configService);
  /*
   * ONE fake gateway for the whole harness, created BEFORE the services that
   * take it.
   *
   * It used to be built just before `PaymentService`, which was the only
   * consumer. The expiry sweeper and the fulfilment recovery worker now publish
   * too, and giving them a second recorder would split `emittedEvents(realtime)`
   * across objects — a test asserting "a rolled-back sweep emitted nothing"
   * would be reading the wrong one and would pass for the wrong reason.
   */
  const realtime = fakeRealtime();
  // `CartService` now publishes a `reservation` invalidation after every
  // committed basket write, so it takes the same recorder as everything else.
  const cart = new CartService(dataSource, inventory, realtime);
  const sweeper = new ReservationSweeperService(
    dataSource,
    inventory,
    configService,
    realtime,
  );
  const fulfilment = new FulfilmentService(dataSource, inventory);
  const paymentConfig = new PaymentConfig(configService);
  const recovery = new FulfilmentRecoveryService(
    dataSource,
    fulfilment,
    paymentConfig,
    realtime,
  );
  const gateway = new StubPaymentGateway();
  const payment = new PaymentService(
    dataSource,
    gateway,
    paymentConfig,
    fulfilment,
    realtime,
  );

  return {
    dataSource,
    inventory,
    cart,
    sweeper,
    fulfilment,
    recovery,
    payment,
    gateway,
    realtime,
  };
}

// ============================================================================
// Fixtures
// ============================================================================

export async function makeUser(
  ds: DataSource | EntityManager,
  username: string,
): Promise<number> {
  const rows: Array<{ id: number }> = await ds.query(
    `INSERT INTO users (username, mobile, password) VALUES ($1, $2, 'x') RETURNING id`,
    [username, `0912${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`],
  );
  return Number(rows[0].id);
}

export async function makeBranch(
  ds: DataSource | EntityManager,
  name = 'Main store',
): Promise<number> {
  const rows: Array<{ id: number }> = await ds.query(
    `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return Number(rows[0].id);
}

export async function makeProduct(
  ds: DataSource | EntityManager,
  title = 'T-shirt',
): Promise<number> {
  const rows: Array<{ id: number }> = await ds.query(
    `INSERT INTO products (title, description, "basePrice", "productCode",
                           "visibleOnSite", "branchVisibility")
     VALUES ($1, 'desc', 1000000, $2, true, 'all') RETURNING id`,
    [title, `INVP-${uniqueSuffix().toUpperCase().replace(/_/g, '-')}`],
  );
  return Number(rows[0].id);
}

export async function makeVariant(
  ds: DataSource | EntityManager,
  productId: number,
  sku: string,
  stock: number,
  price = 1_000_000,
  opts: { isDefault?: boolean; isActive?: boolean } = {},
): Promise<number> {
  const rows: Array<{ id: number }> = await ds.query(
    /*
     * The variant code is built FROM THE PARENT'S code in SQL rather than from
     * a literal: migration 0033 enforces that relationship with a deferrable
     * constraint trigger, so an unrelated string is no longer insertable.
     */
    `INSERT INTO product_variants (price, stock, sku, "productId", "isActive",
                                   "isDefault", "variantCode")
     SELECT $1, $2, $3, $4, $5, $6,
            p."productCode" || '-V' || $7
       FROM products p WHERE p."id" = $4
     RETURNING id`,
    [
      price,
      stock,
      sku,
      productId,
      opts.isActive ?? true,
      opts.isDefault ?? false,
      uniqueSuffix().replace(/_/g, ''),
    ],
  );
  return Number(rows[0].id);
}

export interface Catalog {
  productId: number;
  variantId: number;
}

export async function makeCatalog(
  ds: DataSource,
  sku: string,
  stock: number,
): Promise<Catalog> {
  const productId = await makeProduct(ds, `Product ${sku}`);
  const variantId = await makeVariant(ds, productId, sku, stock);
  return { productId, variantId };
}

/**
 * A SIMPLE (option-less) product: one variant, flagged `isDefault`.
 *
 * This is the row shape `ProductsService.create()` and migration 0012's
 * backfill both produce. It exists so the suites can prove that a product that
 * used to have NO variant at all -- and therefore skipped every stock check --
 * now behaves exactly like any other SKU: it reserves, it expires, and a POS
 * sale can displace it.
 */
export async function makeSimpleCatalog(
  ds: DataSource,
  sku: string,
  stock: number,
  price = 1_000_000,
): Promise<Catalog> {
  const productId = await makeProduct(ds, `Simple product ${sku}`);
  const variantId = await makeVariant(ds, productId, sku, stock, price, {
    isDefault: true,
  });
  return { productId, variantId };
}

/** Creates a PENDING online order with its line items, ready for checkout. */
export async function makeOnlineOrder(
  ds: DataSource | EntityManager,
  userId: number,
  items: Array<{
    productId: number;
    variantId: number;
    quantity: number;
    price?: number;
  }>,
): Promise<number> {
  const total = items.reduce(
    (sum, i) => sum + (i.price ?? 1_000_000) * i.quantity,
    0,
  );
  const rows: Array<{ id: number }> = await ds.query(
    `INSERT INTO orders (channel, "userId", status, total_price, "fulfillmentState")
     VALUES ($1, $2, $3, $4, 'not_required') RETURNING id`,
    [OrderChannel.ONLINE, userId, OrderStatusEnum.PENDING, total],
  );
  const orderId = Number(rows[0].id);
  for (const item of items) {
    await ds.query(
      `INSERT INTO order_items ("orderId", "productId", "variantId", quantity, unit_price, total_price, "productTitleSnapshot")
       VALUES ($1, $2, $3, $4, $5, $6, 'snapshot')`,
      [
        orderId,
        item.productId,
        item.variantId,
        item.quantity,
        item.price ?? 1_000_000,
        (item.price ?? 1_000_000) * item.quantity,
      ],
    );
  }
  return orderId;
}

/**
 * A PAID/FULFILLED POS order row, with one `order_items` line per sold item.
 *
 * `consumeForPosSale` allocates COGS to the order's PENDING lines of each
 * variant it consumes, and refuses (COST_ALLOCATION_INVARIANT_VIOLATION) when
 * those lines do not add up exactly to the consumed quantity -- which is what
 * `OrdersService.recordPosSale` writes before it calls the primitive. A test
 * that drives `consumeForPosSale` directly must therefore pass here the SAME
 * items it then consumes. The product id and title snapshot are read from the
 * variant, so a caller names only the variant and quantity.
 *
 * With no items the order has no lines: only valid for an order that is never
 * consumed (e.g. a checkout order id used only to hold an allocation).
 */
export async function makePosOrder(
  ds: DataSource | EntityManager,
  branchId: number | null = null,
  items: Array<{ variantId: number; quantity: number; price?: number }> = [],
): Promise<number> {
  const total = items.reduce(
    (sum, i) => sum + (i.price ?? 1_000_000) * i.quantity,
    0,
  );
  const rows: Array<{ id: number }> = await ds.query(
    `INSERT INTO orders (channel, status, total_price, "branchId", "fulfillmentState")
     VALUES ($1, $2, $3, $4, 'fulfilled') RETURNING id`,
    [OrderChannel.POS, OrderStatusEnum.PAID, total, branchId],
  );
  const orderId = Number(rows[0].id);
  for (const item of items) {
    const price = item.price ?? 1_000_000;
    const inserted: Array<{ id: number }> = await ds.query(
      `INSERT INTO order_items ("orderId", "productId", "variantId", quantity,
                                unit_price, total_price, "productTitleSnapshot")
       SELECT $1, v."productId", v.id, $3, $4, $5, p.title
         FROM product_variants v
         JOIN products p ON p.id = v."productId"
        WHERE v.id = $2
       RETURNING id`,
      [orderId, item.variantId, item.quantity, price, price * item.quantity],
    );
    if (inserted.length !== 1) {
      throw new Error(`makePosOrder: variant ${item.variantId} not found`);
    }
  }
  return orderId;
}

/**
 * Puts `quantity` VALUED units on the shelf through the one legitimate intake
 * path, `InventoryService.receiveValued` (a `stock_receipt` movement, pool
 * value += quantity × unitCost), in its own transaction.
 *
 * This is how a test says "stock arrives": a raw `UPDATE ... SET stock` is
 * refused by `trg_product_variants_pool_guard`, and the generic adjust
 * endpoints refuse increases (STOCK_INCREASE_REQUIRES_RECEIPT).
 */
export async function receiveStock(
  ds: DataSource,
  inventory: InventoryService,
  variantId: number,
  quantity: number,
  unitCost = 1_000n,
): Promise<void> {
  await ds.transaction((m) =>
    inventory.receiveValued(m, {
      variantId,
      quantity,
      unitCost,
      reason: StockMovementReason.STOCK_RECEIPT,
      reasonText: null,
      supplierReference: null,
      actorUserId: null,
      actorDisplaySnapshot: 'test receipt',
      now: new Date(),
    }),
  );
}

// ============================================================================
// Assertions / probes
// ============================================================================

export async function physicalStock(
  ds: DataSource | EntityManager,
  variantId: number,
): Promise<number> {
  const rows: Array<{ stock: number }> = await ds.query(
    `SELECT stock FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return Number(rows[0].stock);
}

export async function reservationRows(
  ds: DataSource | EntityManager,
  variantId?: number,
): Promise<
  Array<{
    id: number;
    kind: string;
    status: string;
    quantity: number;
    cartItemId: number | null;
    orderId: number | null;
    expiresAt: Date;
    releaseReason: string | null;
  }>
> {
  const rows = await ds.query(
    `SELECT id, kind, status, quantity, "cartItemId", "orderId", "expiresAt", "releaseReason"
       FROM stock_reservations
      ${variantId === undefined ? '' : 'WHERE "variantId" = $1'}
      ORDER BY id ASC`,
    variantId === undefined ? [] : [variantId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    id: Number(r.id),
    quantity: Number(r.quantity),
    cartItemId: r.cartItemId === null ? null : Number(r.cartItemId),
    orderId: r.orderId === null ? null : Number(r.orderId),
  })) as never;
}

export async function movementRows(
  ds: DataSource | EntityManager,
  variantId?: number,
): Promise<
  Array<{
    id: number;
    variantId: number;
    delta: number;
    balanceAfter: number;
    reason: string;
    orderId: number | null;
  }>
> {
  const rows = await ds.query(
    `SELECT id, "variantId", delta, "balanceAfter", reason, "orderId"
       FROM stock_movements
      ${variantId === undefined ? '' : 'WHERE "variantId" = $1'}
      ORDER BY id ASC`,
    variantId === undefined ? [] : [variantId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    id: Number(r.id),
    variantId: Number(r.variantId),
    delta: Number(r.delta),
    balanceAfter: Number(r.balanceAfter),
    orderId: r.orderId === null ? null : Number(r.orderId),
  })) as never;
}

export async function cartRows(
  ds: DataSource | EntityManager,
  userId?: number,
): Promise<
  Array<{
    id: number;
    userId: number;
    variantId: number | null;
    quantity: number;
    status: string;
    lastChangeReason: string | null;
    lastChangeQtyDelta: number | null;
  }>
> {
  const rows = await ds.query(
    `SELECT id, "userId", "variantId", quantity, status, "lastChangeReason", "lastChangeQtyDelta"
       FROM cart_items
      ${userId === undefined ? '' : 'WHERE "userId" = $1'}
      ORDER BY id ASC`,
    userId === undefined ? [] : [userId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    id: Number(r.id),
    userId: Number(r.userId),
    variantId: r.variantId === null ? null : Number(r.variantId),
    quantity: Number(r.quantity),
    lastChangeQtyDelta:
      r.lastChangeQtyDelta === null ? null : Number(r.lastChangeQtyDelta),
  })) as never;
}

export async function orderState(
  ds: DataSource | EntityManager,
  orderId: number,
): Promise<{ status: string; fulfillmentState: string }> {
  const rows: Array<{ status: string; fulfillmentState: string }> =
    await ds.query(
      `SELECT status::text AS status, "fulfillmentState"::text AS "fulfillmentState"
         FROM orders WHERE id = $1`,
      [orderId],
    );
  return rows[0];
}

/**
 * Backdates a reservation's `expiresAt` so a test can reach the expiry path in
 * milliseconds instead of four hours.
 *
 * This is a TEST-ONLY back door that writes `expiresAt` directly in SQL. No
 * production code path may ever do this -- R4 makes `expiresAt` immutable after
 * insert, and every test that asserts on immutability checks the value the
 * SERVICE produced, never one written here.
 */
export async function backdateReservations(
  ds: DataSource | EntityManager,
  where: { cartItemId?: number; orderId?: number; reservationId?: number },
  at: Date = new Date(Date.now() - 1000),
): Promise<void> {
  if (where.reservationId !== undefined) {
    await ds.query(
      `UPDATE stock_reservations SET "expiresAt" = $2 WHERE id = $1`,
      [where.reservationId, at],
    );
    return;
  }
  if (where.cartItemId !== undefined) {
    await ds.query(
      `UPDATE stock_reservations SET "expiresAt" = $2 WHERE "cartItemId" = $1 AND status = 'active'`,
      [where.cartItemId, at],
    );
    return;
  }
  if (where.orderId !== undefined) {
    await ds.query(
      `UPDATE stock_reservations SET "expiresAt" = $2 WHERE "orderId" = $1 AND status = 'active'`,
      [where.orderId, at],
    );
  }
}
