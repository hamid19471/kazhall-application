import { randomUUID } from 'node:crypto';

import { CartItemStatus } from 'src/modules/cart/entities/cart-item.entity';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import {
  ReservationKind,
  ReservationStatus,
  ReservationReleaseReason,
} from 'src/modules/inventory/entities/stock-reservation.entity';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { CheckoutConflictCode } from 'src/common/constants/checkout.messages';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  createBranch,
  createOrderLine,
  createProductWithVariant,
  createUser,
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * ONLINE CHECKOUT — API INTEGRATION (workstream C)
 * ===========================================================================
 *
 * Every case here goes through the REAL HTTP surface: the guards, the
 * ValidationPipe, the response envelope and the exception filter, against the
 * migrated PostgreSQL. That matters because each defect this file covers was
 * invisible at the unit level:
 *
 *  - `OrdersService.create` loaded EVERY `cart_items` row for the user with no
 *    `status` filter, so soft-removed TOMBSTONES — lines whose units a POS sale
 *    had already taken — were billed at their pre-displacement quantity.
 *  - It then trusted `cart_items.quantity`, a derived cache, instead of the
 *    reservations that are the holds actually held.
 *  - It called `addressService.findOne(dto.address)`, which checks nothing, so
 *    any customer could ship to any other customer's saved address.
 *  - It hard-deleted the whole basket afterwards, destroying notices the
 *    customer had not been shown.
 *  - It had no idempotency at all, so a client retry placed a second order.
 */
describe('online checkout (workstream C)', () => {
  let app: TestApp;

  /** A logged-in customer plus one saved address. */
  interface Shopper {
    userId: number;
    jar: CookieJar;
    addressId: number;
  }

  const KEY = () => `chk-${randomUUID()}`;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
  });

  async function makeShopper(): Promise<Shopper> {
    const { user, username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(app, username, password);

    const created = await withCookies(app, jar).post('/me/addresses').send({
      province: 'Tehran',
      city: 'Tehran',
      address: 'Somewhere 12',
      postal_code: '1234567890',
      reciver_mobile: '09120000000',
    });
    expect([200, 201]).toContain(created.status);

    return {
      userId: user.id,
      jar,
      addressId: Number(created.body.data.id),
    };
  }

  async function addToBasket(
    shopper: Shopper,
    productId: number,
    variantId: number,
    quantity: number,
  ): Promise<number> {
    const response = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId, variantId, quantity });
    expect([200, 201]).toContain(response.status);
    return Number(response.body.data.id);
  }

  function checkout(
    shopper: Shopper,
    body: Record<string, unknown>,
    key: string,
  ) {
    return withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ address: shopper.addressId, ...body });
  }

  /** The review step: price the basket and get the signed quote. */
  async function quoteOf(shopper: Shopper): Promise<{
    token: string;
    basketVersion: string;
    subtotal: number;
    total: number;
  }> {
    const response = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(response.status).toBe(200);
    return {
      ...response.body.data.quote,
      subtotal: response.body.data.basket.subtotal,
      total: response.body.data.basket.total,
    };
  }

  /** Quote, then immediately place the order against that quote. */
  async function reviewAndCheckout(
    shopper: Shopper,
    key = KEY(),
    extra: Record<string, unknown> = {},
  ) {
    const quote = await quoteOf(shopper);
    return checkout(shopper, { quoteToken: quote.token, ...extra }, key);
  }

  /** Runs a POS-style consumption straight through InventoryService. */
  async function posConsume(variantId: number, quantity: number) {
    const inventory = app.app.get(InventoryService);
    const branch = await createBranch(app.dataSource);
    const cashier = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });

    const [order] = await app.dataSource.query(
      `INSERT INTO orders (channel, status, "branchId", "cashierUserId", subtotal, total_price, "soldAt")
       VALUES ('pos', 'paid', $1, $2, 0, 0, now()) RETURNING id`,
      [branch.id, cashier.user.id],
    );
    // The sale's line: consumeForPosSale allocates COGS to the order's
    // pending lines and requires they cover exactly the consumed quantity.
    await createOrderLine(
      app.dataSource,
      Number(order.id),
      variantId,
      quantity,
    );

    await app.dataSource.transaction((manager) =>
      inventory.consumeForPosSale(manager, {
        items: [{ variantId, quantity }],
        orderId: Number(order.id),
        actorUserId: cashier.user.id,
        actorDisplaySnapshot: 'Cashier',
        branchId: branch.id,
      }),
    );
  }

  // =========================================================================
  // Contract basics
  // =========================================================================

  it('places an order from the active basket and converts the holds to order allocations', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 10, price: 250_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 3);

    const response = await reviewAndCheckout(shopper);

    expect(response.status).toBe(201);
    const order = response.body.data;
    expect(order.status).toBe(OrderStatusEnum.PENDING);
    expect(order.subtotal).toBe(750_000);
    expect(order.totalPrice).toBe(750_000);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(3);
    expect(order.items[0].unitPrice).toBe(250_000);

    // The delivery address is FROZEN on the order, not read back through the FK.
    expect(order.address).toMatchObject({
      addressId: shopper.addressId,
      city: 'Tehran',
      postalCode: '1234567890',
    });
    expect(order.address.capturedAt).not.toBeNull();

    // The basket hold became an ORDER allocation bound to this order, and no
    // basket reservation for the line survives.
    const reservations = await app.dataSource.query(
      `SELECT kind, status, quantity, "orderId"
         FROM stock_reservations WHERE "variantId" = $1 ORDER BY id`,
      [variant.id],
    );
    const active = reservations.filter(
      (r) => r.status === ReservationStatus.ACTIVE,
    );
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe(ReservationKind.ORDER);
    expect(Number(active[0].quantity)).toBe(3);
    expect(Number(active[0].orderId)).toBe(Number(order.id));

    // Physical stock is NOT decremented at checkout — that happens at
    // fulfilment, after the money is confirmed.
    const [row] = await app.dataSource.query(
      `SELECT stock FROM product_variants WHERE id = $1`,
      [variant.id],
    );
    expect(Number(row.stock)).toBe(10);
  });

  it('rejects a checkout with no Idempotency-Key', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(app.dataSource);
    await addToBasket(shopper, product.id, variant.id, 1);

    const quote = await quoteOf(shopper);
    const response = await withCookies(app, shopper.jar)
      .post('/orders')
      .send({ address: shopper.addressId, quoteToken: quote.token });

    expect(response.status).toBe(400);

    const [{ count }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM orders`,
    );
    expect(count).toBe(0);
  });

  it('rejects an effectively empty basket with a 400 and no quote, from both endpoints', async () => {
    const shopper = await makeShopper();

    /**
     * EMPTINESS IS DECIDED BEFORE THE QUOTE GATE, and it is a 400 rather than a
     * 409 with a quote — the documented exception to "every 409 carries a fresh
     * quote". There is nothing to price, so there is no quote to hand back, and
     * the client's recovery is to send the customer to the basket rather than to
     * re-confirm anything.
     */
    const quoteAttempt = await withCookies(app, shopper.jar).post(
      '/orders/quote',
    );
    expect(quoteAttempt.status).toBe(400);

    // Same answer with no token at all, and with a syntactically fine one:
    // emptiness wins over the quote gate either way.
    for (const body of [
      {},
      { quoteToken: 'kq1.eyJ2IjoxfQ.notarealsignature' },
    ]) {
      const response = await checkout(shopper, body, KEY());
      expect(response.status).toBe(400);
      expect(response.body.details?.quote).toBeUndefined();
    }

    const [{ count }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM orders`,
    );
    expect(count).toBe(0);
  });

  // =========================================================================
  // Removed rows
  // =========================================================================

  it('never bills a soft-removed tombstone row, and preserves its unshown notice', async () => {
    const shopper = await makeShopper();
    const stale = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 4, price: 100_000 },
    );
    const good = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 10, price: 200_000 },
    );

    await addToBasket(shopper, stale.product.id, stale.variant.id, 4);
    await addToBasket(shopper, good.product.id, good.variant.id, 2);

    // An in-store sale takes every unit the first line was holding, which
    // soft-removes the line and leaves an explanation on it.
    await posConsume(stale.variant.id, 4);

    const tombstone = await app.dataSource.query(
      `SELECT id, status, quantity, "lastChangeReason"
         FROM cart_items WHERE "variantId" = $1`,
      [stale.variant.id],
    );
    expect(tombstone[0].status).toBe(CartItemStatus.REMOVED);
    expect(tombstone[0].lastChangeReason).toBe(
      ReservationReleaseReason.SOLD_IN_STORE,
    );

    // The customer has not been shown that notice yet, so checkout stops and
    // says so rather than quietly charging the corrected basket.
    // No quote yet: checkout refuses and hands back one for the CORRECTED
    // basket, with the notice explaining why it shrank.
    const blocked = await checkout(shopper, { quoteToken: 'kq1.x.y' }, KEY());
    expect(blocked.status).toBe(409);
    // GlobalExceptionFilter promotes `error` and moves the rest into `details`.
    expect(blocked.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
    expect(blocked.body.details.confirmationRequired).toBe(true);
    expect(blocked.body.details.quote.token).toBeTruthy();
    expect(blocked.body.details.basket.subtotal).toBe(400_000);

    // After confirming, ONLY the surviving line is billed. The tombstone's
    // quantity of 4 is nowhere in the money.
    const confirmed = await checkout(
      shopper,
      { quoteToken: blocked.body.details.quote.token },
      KEY(),
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.items).toHaveLength(1);
    expect(confirmed.body.data.subtotal).toBe(400_000);

    // The notice SURVIVES checkout. The old implementation hard-deleted every
    // row it had loaded, so the customer was charged a corrected basket and the
    // explanation of the correction was destroyed in the same transaction.
    const stillThere = await app.dataSource.query(
      `SELECT "lastChangeReason" FROM cart_items WHERE id = $1`,
      [tombstone[0].id],
    );
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].lastChangeReason).toBe(
      ReservationReleaseReason.SOLD_IN_STORE,
    );
  });

  // =========================================================================
  // Partial displacement
  // =========================================================================

  it('a POS sale that displaced part of the basket forces confirmation and sells only the units still held', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 300_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 5);

    // The customer reviews and accepts 5 units at 1,500,000.
    const accepted = await quoteOf(shopper);
    expect(accepted.total).toBe(1_500_000);

    // POS priority: the till then takes 3 of the 5 units the basket was holding.
    await posConsume(variant.id, 3);

    const blocked = await checkout(
      shopper,
      { quoteToken: accepted.token },
      KEY(),
    );
    expect(blocked.status).toBe(409);
    const body = blocked.body.details;
    expect(blocked.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(body.confirmationRequired).toBe(true);
    expect(body.basket.subtotal).toBe(600_000); // 2 units, not 5
    // PRIVACY: the explanation says what happened, never who or where.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/cashier/i);
    expect(text).not.toMatch(/branch/i);

    const confirmed = await checkout(
      shopper,
      { quoteToken: body.quote.token },
      KEY(),
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.items[0].quantity).toBe(2);
    expect(confirmed.body.data.subtotal).toBe(600_000);
  });

  // =========================================================================
  // Expiry
  // =========================================================================

  it('a line whose hold expired is reported and excluded, never sold', async () => {
    const shopper = await makeShopper();
    const expired = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 6, price: 500_000 },
    );
    const fresh = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 6, price: 700_000 },
    );

    await addToBasket(shopper, expired.product.id, expired.variant.id, 2);
    await addToBasket(shopper, fresh.product.id, fresh.variant.id, 1);

    // Push one line's 4-hour hold into the past. `expiresAt` is immutable in
    // normal operation (R4); a test fixture is the only thing that may move it.
    await app.dataSource.query(
      `UPDATE stock_reservations
          SET "expiresAt" = now() - interval '1 minute'
        WHERE "variantId" = $1 AND kind = 'basket' AND status = 'active'`,
      [expired.variant.id],
    );

    const blocked = await checkout(shopper, { quoteToken: 'kq1.x.y' }, KEY());
    expect(blocked.status).toBe(409);

    const confirmed = await checkout(
      shopper,
      { quoteToken: blocked.body.details.quote.token },
      KEY(),
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.items).toHaveLength(1);
    expect(confirmed.body.data.items[0].variantId).toBe(fresh.variant.id);
    expect(confirmed.body.data.subtotal).toBe(700_000);
  });

  // =========================================================================
  // Checkout races
  // =========================================================================

  it('two concurrent checkouts with different keys place exactly one order for the basket', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 3, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 3);

    // Both racers hold the SAME accepted quote — the realistic shape of a
    // double-submitted review page.
    const accepted = await quoteOf(shopper);
    const [a, b] = await Promise.all([
      checkout(shopper, { quoteToken: accepted.token }, KEY()),
      checkout(shopper, { quoteToken: accepted.token }, KEY()),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(201);
    // The loser has nothing left to buy: its holds became the winner's order
    // allocation, which POS and checkout alike must not take.
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const orders = await app.dataSource.query(
      `SELECT id FROM orders WHERE channel = 'online'`,
    );
    expect(orders).toHaveLength(1);

    const active = await app.dataSource.query(
      `SELECT kind, quantity FROM stock_reservations
        WHERE "variantId" = $1 AND status = 'active'`,
      [variant.id],
    );
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe(ReservationKind.ORDER);
    expect(Number(active[0].quantity)).toBe(3);
  });

  it('a retried checkout with the SAME key returns the SAME order and allocates once', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 2);

    const accepted = await quoteOf(shopper);
    const key = KEY();
    const first = await checkout(shopper, { quoteToken: accepted.token }, key);
    expect(first.status).toBe(201);

    const retry = await checkout(shopper, { quoteToken: accepted.token }, key);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(retry.body.data.orderNumber).toBe(first.body.data.orderNumber);

    const orders = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM orders WHERE channel = 'online'`,
    );
    expect(orders[0].count).toBe(1);

    const allocations = await app.dataSource.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM stock_reservations
        WHERE "variantId" = $1 AND kind = 'order' AND status = 'active'`,
      [variant.id],
    );
    expect(allocations[0].total).toBe(2);
  });

  // =========================================================================
  // Address ownership
  // =========================================================================

  it("refuses another user's address with a 404 and places no order", async () => {
    const victim = await makeShopper();
    const attacker = await makeShopper();

    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5 },
    );
    await addToBasket(attacker, product.id, variant.id, 1);

    const response = await withCookies(app, attacker.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({
        address: victim.addressId,
        quoteToken: (await quoteOf(attacker)).token,
      });

    // 404, not 403: a 403 would confirm the id is real and let anyone walk the
    // address table one integer at a time.
    expect(response.status).toBe(404);

    const [{ count }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM orders`,
    );
    expect(count).toBe(0);
  });

  it("does not expose another user's address or order through the owner-scoped routes", async () => {
    const victim = await makeShopper();
    const attacker = await makeShopper();

    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5 },
    );
    await addToBasket(victim, product.id, variant.id, 1);
    const placed = await reviewAndCheckout(victim);
    expect(placed.status).toBe(201);

    const address = await withCookies(app, attacker.jar).get(
      `/me/addresses/${victim.addressId}`,
    );
    expect(address.status).toBe(404);

    const order = await withCookies(app, attacker.jar).get(
      `/me/orders/${placed.body.data.id}`,
    );
    expect(order.status).toBe(404);

    const mine = await withCookies(app, attacker.jar).get('/me/orders');
    expect(mine.status).toBe(200);
    expect(mine.body.data.total).toBe(0);
  });

  it('lets the owner read their own order, including the frozen address', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 1);
    const placed = await reviewAndCheckout(shopper);

    // Editing the saved address must NOT rewrite the placed order.
    await withCookies(app, shopper.jar)
      .patch(`/me/addresses/${shopper.addressId}`)
      .send({ city: 'Karaj' });

    const read = await withCookies(app, shopper.jar).get(
      `/me/orders/${placed.body.data.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.data.addressSnapshot.city).toBe('Tehran');
  });
});
