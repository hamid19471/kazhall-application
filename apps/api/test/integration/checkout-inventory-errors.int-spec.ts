import { randomUUID } from 'node:crypto';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { OrderMessages } from 'src/common/constants/order.messages';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { InventoryConflictCode } from 'src/modules/orders/orders.service';

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
  createProductWithVariant,
  createUser,
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * INVENTORY DOMAIN ERRORS ARE 409s WITH A CODE, NEVER BARE 500s
 * ===========================================================================
 *
 * `InventoryService` throws DOMAIN errors, not `HttpException`s, because it is
 * also driven by the reservation sweeper and the fulfilment worker, for which
 * an HTTP status is meaningless. Translating them is therefore the caller's
 * job — and the ecommerce checkout path did not do it.
 *
 * `OrdersService.checkout` calls `convertBasketToOrderAllocation` (the
 * checkout boundary of docs/ARCHITECTURE.md §2) with no try/catch, so an
 * `InsufficientStockError` raised there left the transaction correctly rolled
 * back but answered the customer with a generic **500** and the message "A
 * critical error has occurred. Please contact support." The POS path
 * (`translateInventoryError`) had had the right answer all along; only two of
 * its three call sites used it.
 *
 * REACHABILITY, which is the part that is easy to get wrong. It is tempting to
 * argue this cannot happen: the quote gate prices the basket under the variant
 * locks, so surely anything that passes the gate can be allocated. But the gate
 * prices RESERVATIONS — `min(cart_items.quantity, active reserved quantity)` —
 * and an admin stock adjustment with `allowBelowReserved: true` (a legitimate
 * operation after discovering shrinkage) changes neither the reservation nor
 * the price. The basket fingerprint therefore still matches the accepted quote,
 * checkout proceeds, and `convertBasketToOrderAllocation` is the first thing
 * that looks at physical stock. Every case below drives that sequence through
 * the real HTTP routes, in the order a real shop would produce it.
 *
 * ON `ConcurrentModificationError` — the inventory module's third domain error
 * class — see the comment at the bottom of this file. It is mapped, and it is
 * deliberately NOT tested, because it is unreachable through HTTP by
 * construction rather than by luck.
 */
describe('inventory failures on the ecommerce checkout routes', () => {
  let app: TestApp;

  interface Shopper {
    userId: number;
    jar: CookieJar;
    addressId: number;
  }

  const KEY = () => `cie-${randomUUID()}`;

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

    return { userId: user.id, jar, addressId: Number(created.body.data.id) };
  }

  async function makeSuperAdmin(): Promise<CookieJar> {
    const { username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return authenticate(app, username, password);
  }

  /**
   * Drops the variant's PHYSICAL stock below what baskets are holding, through
   * the real admin route and its documented escape hatch. Nothing about the
   * customer's reservation changes, which is precisely why the quote gate
   * cannot see it coming.
   */
  async function adjustStockBelowReserved(
    admin: CookieJar,
    variantId: number,
    to: number,
  ): Promise<void> {
    const response = await withCookies(app, admin)
      .post(`/products/variants/${variantId}/stock/adjust`)
      .send({ mode: 'set', value: to, allowBelowReserved: true });
    expect(response.status).toBe(201);
    expect(response.body.data.balanceAfter).toBe(to);
    expect(response.body.data.belowReserved).toBe(true);
  }

  /** Nothing in a customer-facing error body may be internal machinery. */
  function assertSafeDetails(body: unknown): void {
    const text = JSON.stringify(body);
    // No SQL, no driver text, no stack frames.
    expect(text).not.toMatch(/SELECT |UPDATE |INSERT INTO|FOR UPDATE/i);
    expect(text).not.toMatch(/stock_reservations|product_variants|cart_items/);
    expect(text).not.toMatch(/at Object\.|\.ts:\d+|node_modules/);
    // No other party's identity.
    expect(text).not.toMatch(/cashier/i);
    expect(text).not.toMatch(/branch/i);
    expect(text).not.toMatch(/reservationId|cartItemId|affected=/);
  }

  // =========================================================================
  // InsufficientStockError through POST /orders
  // =========================================================================

  it('answers 409 INSUFFICIENT_STOCK, not 500, when the basket hold has no physical stock behind it', async () => {
    const shopper = await makeShopper();
    const admin = await makeSuperAdmin();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 3, price: 250_000, sku: 'OVERSOLD-1' },
    );

    // 1. The customer takes the last three units and reviews them.
    const added = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 3 });
    expect([200, 201]).toContain(added.status);

    const quote = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(quote.status).toBe(200);
    expect(quote.body.data.basket.total).toBe(750_000);

    // 2. A stock count finds the shelf empty. The admin records that, forcing
    //    physical stock below the customer's still-live 3-unit hold.
    await adjustStockBelowReserved(admin, variant.id, 0);

    // 3. The customer presses "place order" on the quote they accepted.
    const placed = await withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({
        address: shopper.addressId,
        quoteToken: quote.body.data.quote.token,
      });

    expect(placed.status).toBe(409);
    expect(placed.body.success).toBe(false);
    expect(placed.body.statusCode).toBe(409);
    // `error` is promoted to the TOP level by GlobalExceptionFilter; `code`
    // repeats it inside `details` for clients that read only `details`.
    expect(placed.body.error).toBe(InventoryConflictCode.INSUFFICIENT_STOCK);
    expect(placed.body.details.code).toBe(
      InventoryConflictCode.INSUFFICIENT_STOCK,
    );
    expect(placed.body.message).toBe(OrderMessages.NOT_ENOUGH_STOCK);

    // Safe, actionable detail: the caller's own variant, and the shortfall.
    expect(placed.body.details.variantId).toBe(variant.id);
    expect(placed.body.details.sku).toBe('OVERSOLD-1');
    expect(placed.body.details.requested).toBe(3);
    expect(placed.body.details.available).toBe(0);
    expect(placed.body.details.retryable).toBe(true);
    assertSafeDetails(placed.body);

    /**
     * THE TRANSACTION ROLLED BACK CLEANLY, which is the half of this that a
     * status-code assertion alone would not prove. `checkout` had already
     * INSERTed the order and its line items, and
     * `convertBasketToOrderAllocation` had already RELEASED the customer's
     * basket reservations and rewritten their cart line, before it discovered
     * the shortfall. All of it must be gone.
     */
    const [{ count: orderCount }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM orders`,
    );
    expect(orderCount).toBe(0);
    const [{ count: itemCount }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM order_items`,
    );
    expect(itemCount).toBe(0);

    // The hold and the basket line survive untouched: the customer still has
    // their basket, and nothing was allocated to a non-existent order.
    const reservations = await app.dataSource.query(
      `SELECT kind, status, quantity FROM stock_reservations WHERE "variantId" = $1`,
      [variant.id],
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0].kind).toBe('basket');
    expect(reservations[0].status).toBe('active');
    expect(Number(reservations[0].quantity)).toBe(3);

    const cart = await app.dataSource.query(
      `SELECT status, quantity FROM cart_items WHERE "variantId" = $1`,
      [variant.id],
    );
    expect(cart).toHaveLength(1);
    expect(cart[0].status).toBe('active');
    expect(Number(cart[0].quantity)).toBe(3);
  });

  it('reports the real shortfall when only part of the hold is unbacked, and lets the retry succeed', async () => {
    const shopper = await makeShopper();
    const admin = await makeSuperAdmin();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000, sku: 'PARTIAL-1' },
    );

    const added = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 5 });
    expect([200, 201]).toContain(added.status);

    const quote = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(quote.status).toBe(200);

    // Two of the five units turn out not to exist.
    await adjustStockBelowReserved(admin, variant.id, 3);

    const placed = await withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({
        address: shopper.addressId,
        quoteToken: quote.body.data.quote.token,
      });

    expect(placed.status).toBe(409);
    expect(placed.body.error).toBe(InventoryConflictCode.INSUFFICIENT_STOCK);
    expect(placed.body.details.requested).toBe(5);
    expect(placed.body.details.available).toBe(3);
    assertSafeDetails(placed.body);

    /**
     * THE REFUSAL IS RECOVERABLE, and that is the whole reason it must be a 409
     * rather than a 500. The customer reduces the line to what exists, re-quotes
     * and buys it — and because the failed attempt rolled its idempotency claim
     * back with everything else, they may even reuse the key.
     */
    const reduced = await withCookies(app, shopper.jar)
      .patch(`/cart/${Number(added.body.data.id)}`)
      .send({ quantity: 3 });
    expect([200, 201]).toContain(reduced.status);

    const requote = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(requote.status).toBe(200);
    expect(requote.body.data.basket.total).toBe(300_000);

    const retried = await withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({
        address: shopper.addressId,
        quoteToken: requote.body.data.quote.token,
      });
    expect(retried.status).toBe(201);
    expect(retried.body.data.items[0].quantity).toBe(3);
    expect(retried.body.data.totalPrice).toBe(300_000);
  });

  // =========================================================================
  // The SAME mapping, reached from the POS route
  // =========================================================================

  it('POS insufficient stock uses the same code and shape, from the one shared mapping', async () => {
    const branch = await createBranch(app.dataSource);
    const { username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const cashier = await authenticate(app, username, password);
    const { variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 1, price: 500_000, sku: 'TILL-1' },
    );

    const sale = await withCookies(app, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', KEY())
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 4 }],
      });

    expect(sale.status).toBe(409);
    /**
     * THE POINT OF THIS CASE is that the POS route and the checkout route now
     * produce the SAME machine-readable code from the SAME
     * `translateInventoryError`, rather than two hand-rolled mappings that
     * drift. It also records a contract change: this body previously carried
     * NEITHER `error` (Nest's generic "Conflict" reason phrase appeared
     * instead) NOR `details.code`, so a till could only recognise "out of
     * stock" by matching an English sentence.
     */
    expect(sale.body.error).toBe(InventoryConflictCode.INSUFFICIENT_STOCK);
    expect(sale.body.details.code).toBe(
      InventoryConflictCode.INSUFFICIENT_STOCK,
    );
    expect(sale.body.message).toBe(OrderMessages.NOT_ENOUGH_STOCK);
    expect(sale.body.details.variantId).toBe(variant.id);
    expect(sale.body.details.sku).toBe('TILL-1');
    expect(sale.body.details.requested).toBe(4);
    expect(sale.body.details.available).toBe(1);

    const [{ count }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM orders`,
    );
    expect(count).toBe(0);
  });

  // =========================================================================
  // Nothing that is NOT a domain error becomes a 409
  // =========================================================================

  it('an unknown variant is still a 404 and an empty basket still a 400 — only stock conflicts are 409', async () => {
    const shopper = await makeShopper();

    /**
     * The translation is an allow-list over TWO error classes and returns
     * everything else UNCHANGED, so the other refusals on this route keep their
     * own statuses. If the catch had been written as "any error from the
     * inventory layer is a 409", this is what would have broken.
     */
    const empty = await withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({ address: shopper.addressId, quoteToken: 'kq1.x.y' });
    expect(empty.status).toBe(400);

    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 2, price: 100_000 },
    );
    const added = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId: product.id, variantId: variant.id, quantity: 1 });
    expect([200, 201]).toContain(added.status);

    const quote = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(quote.status).toBe(200);

    // A foreign address is still 404 (and still indistinguishable from a
    // missing one), not 409.
    const other = await makeShopper();
    const foreignAddress = await withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({
        address: other.addressId,
        quoteToken: quote.body.data.quote.token,
      });
    expect(foreignAddress.status).toBe(404);
  });

  /**
   * =========================================================================
   * `ConcurrentModificationError` IS UNREACHABLE THROUGH HTTP — NO TEST
   * =========================================================================
   *
   * The inventory module has exactly three domain error classes:
   * `InsufficientStockError` and `InsufficientStockForFulfilmentError`
   * (inventory.types.ts) and `ConcurrentModificationError`
   * (inventory.errors.ts). The first is covered above. The other two are not
   * tested here, and faking either one would be worse than not testing it,
   * because the test would then be asserting a mapping against a state the
   * system cannot enter.
   *
   * `ConcurrentModificationError` is raised when a guarded conditional UPDATE
   * (R2 / R3) affects a row count other than 1. Every throw site is preceded,
   * IN THE SAME TRANSACTION, by a `SELECT ... FOR UPDATE` on the very row it
   * then updates, and the UPDATE's guard re-states the condition that SELECT
   * already checked:
   *
   *   inventory.service.ts:367  leaveActive   — the reservation was selected
   *                             `FOR UPDATE ... status='active'` by
   *                             `takeFromReservations`' own query
   *   inventory.service.ts:395  shrinkActive  — same row, same lock
   *   inventory.service.ts:1009 syncAffectedCartLines — the cart line was
   *                             selected `FOR UPDATE` and its status compared
   *                             to 'active' three statements earlier
   *   inventory.service.ts:457  incrementStock / :1625 adjustStock — the
   *                             variant row is held by `lockVariants` (R1)
   *
   * A row that is locked cannot be transitioned by anyone else until the
   * transaction ends, so `affected` is 1 unless an invariant has ALREADY been
   * violated — which is exactly what the class's own doc comment says ("never
   * expected in a correct run ... the guard can only fail if an invariant has
   * already been violated"). There is no request sequence that produces it; it
   * needs out-of-band corruption of the tables.
   *
   * It is nevertheless MAPPED in `translateInventoryError`, because the cost of
   * the mapping is one branch and the alternative is that the day an invariant
   * does break, the customer gets a 500 with no code.
   *
   * `InsufficientStockForFulfilmentError` is unreachable from these routes for
   * a different and stronger reason: it is thrown only by
   * `consumeForOnlineFulfilment`, and the only caller of that method in the
   * whole codebase is `payment/fulfilment.service.ts:268`, which catches it at
   * line 288 and records `AWAITING_STOCK`. None of checkout, POS sale, void or
   * return calls it. Mapping it to a 409 would misrepresent a recoverable
   * post-payment condition as a client-side conflict, so it is deliberately
   * left to pass through.
   */
});
