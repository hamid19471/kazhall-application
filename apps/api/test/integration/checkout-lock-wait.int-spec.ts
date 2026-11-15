import { randomUUID } from 'node:crypto';
import { QueryRunner } from 'typeorm';

import { CheckoutConflictCode } from 'src/common/constants/checkout.messages';
import {
  CheckoutQuoteLine,
  CheckoutQuoteService,
} from 'src/modules/orders/checkout-quote.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createProductWithVariant, createUser } from './setup/seed-helpers';

/**
 * ===========================================================================
 * EXPIRY IS DECIDED AFTER THE LOCK WAIT, NOT BEFORE IT
 * ===========================================================================
 *
 * THE DEFECT THESE TESTS EXIST FOR.
 *
 * `InventoryService.lockVariants` issues a plain `SELECT ... FOR UPDATE`, so it
 * BLOCKS: a concurrent POS sale, or another customer's checkout touching the
 * same SKU, holds that row until its transaction ends. Checkout used to decide
 * two expiry questions against a clock read BEFORE it asked for that lock:
 *
 *   - the quote's validity window (`CheckoutQuoteService.verify`, called at
 *     step 0, before any lock);
 *   - which basket reservations are still alive (`expireDueReservations` and
 *     `describeBasketLine`, both handed the caller's pre-lock `now`).
 *
 * So anything that lapsed WHILE the request was queued was still treated as
 * live. A customer could be charged against an expired quote, or sold units
 * whose four-hour hold had already been released to somebody else.
 *
 * HOW THESE TESTS ARE DETERMINISTIC. Nothing here waits a fixed number of
 * milliseconds and hopes. A helper transaction takes the variant lock, and the
 * test then:
 *
 *   1. starts the checkout request and POLLS `pg_stat_activity` until the
 *      backend is genuinely `wait_event_type = 'Lock'`. Being blocked there is
 *      also proof the request already PASSED the pre-lock quote check — which
 *      is exactly the window under test;
 *   2. makes the world change (busy-waits past the quote's expiry, or backdates
 *      the reservation) while the request cannot observe it;
 *   3. only THEN commits the holder.
 *
 * The ordering is enforced, not raced.
 */
describe('checkout revalidates expiry after a contended lock wait', () => {
  let app: TestApp;
  let holder: QueryRunner | null = null;

  interface Shopper {
    userId: number;
    jar: CookieJar;
    addressId: number;
  }

  const KEY = () => `chk-${randomUUID()}`;

  /**
   * The ONE Idempotency-Key the hardened new-SKU regression uses for its whole
   * retry sequence. Module-scoped so `dbState()` can report on that exact key
   * without every caller having to thread it through.
   */
  let sharedKey = '';

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    /*
     * Never leave a lock (or a pooled connection) behind, however the test
     * ended — INCLUDING when the rollback itself throws.
     *
     * `release()` used to sit after `rollbackTransaction()` in the same block,
     * so a failing rollback skipped it and stranded a pooled connection still
     * holding `FOR UPDATE` on `product_variants` for the life of the process.
     * Every later `resetDb` in this file would then queue behind a lock nobody
     * owned. The release now runs in `finally`, which is the only placement
     * that survives a rollback failure.
     */
    const runner = holder;
    holder = null;
    if (!runner) return;
    try {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
  });

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

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

  async function addToBasket(
    shopper: Shopper,
    productId: number,
    variantId: number,
    quantity: number,
  ): Promise<void> {
    const response = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId, variantId, quantity });
    expect([200, 201]).toContain(response.status);
  }

  interface QuoteView {
    token: string;
    basketVersion: string;
    subtotal: number;
    total: number;
  }

  async function quoteOf(shopper: Shopper): Promise<{
    quote: QuoteView;
    lines: Array<{ variantId: number; quantity: number; unitPrice: number }>;
    total: number;
  }> {
    const response = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(response.status).toBe(200);
    const data = response.body.data as {
      quote: QuoteView;
      basket: {
        total: number;
        lines: Array<{
          cartItemId: number;
          variantId: number;
          quantity: number;
          unitPrice: number;
        }>;
      };
    };
    return {
      quote: data.quote,
      lines: data.basket.lines,
      total: data.basket.total,
    };
  }

  function checkout(shopper: Shopper, quoteToken: string, key = KEY()) {
    return withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ address: shopper.addressId, quoteToken });
  }

  /** Takes and HOLDS the variant row lock in its own transaction. */
  async function holdVariantLock(variantId: number): Promise<void> {
    holder = app.dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(
      `SELECT id FROM product_variants WHERE id = $1 FOR UPDATE`,
      [variantId],
    );
  }

  async function releaseVariantLock(): Promise<void> {
    const runner = holder;
    if (!runner) throw new Error('no lock held');
    // Same rule as `afterEach`: the release must survive a failing commit,
    // which is exactly when a stranded connection would be most confusing.
    holder = null;
    try {
      await runner.commitTransaction();
    } finally {
      await runner.release();
    }
  }

  /**
   * Blocks until a backend is actually waiting on a lock.
   *
   * This is the synchronisation point that makes the tests deterministic, and
   * it doubles as an assertion: a request parked on `wait_event_type = 'Lock'`
   * inside `lockVariants` has already cleared the pre-lock quote check, which
   * is precisely the interval these tests probe.
   */
  async function waitUntilBlockedOnLock(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [row] = await app.dataSource.query(
        `SELECT count(*)::int AS waiting
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND state = 'active'`,
      );
      if (Number(row.waiting) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'checkout never blocked on the variant lock; the premise of this test does not hold',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Busy-waits until `instant` has definitely passed. No fixed sleep. */
  async function waitUntilPast(instant: number): Promise<void> {
    while (Date.now() <= instant) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Everything a rejected checkout must NOT have created, plus the
   * bookkeeping that proves a retry did not duplicate work.
   *
   * Separate from `footprint()` rather than an extension of it: the other tests
   * in this file assert `footprint()` with `toEqual`, and widening its shape
   * would have forced edits to tests that are not in scope here.
   *
   * `movements` counts `stock_movements` for BOTH variants. Online checkout
   * writes none — it converts basket reservations into order allocations and
   * leaves physical stock alone until fulfilment — so this is a guard that the
   * checkout path has not started moving stock, not a fulfilment assertion.
   */
  async function dbState(variantIds: number[]): Promise<{
    orders: number;
    orderItems: number;
    allocationRows: number;
    allocatedQuantity: number;
    movements: number;
    idempotencyRows: number;
    completedIdempotencyRows: number;
  }> {
    const [row] = await app.dataSource.query<
      {
        orders: number;
        orderItems: number;
        allocationRows: number;
        allocatedQuantity: number;
        movements: number;
        idempotencyRows: number;
        completedIdempotencyRows: number;
      }[]
    >(
      `SELECT
         (SELECT COUNT(*)::int FROM orders WHERE channel = 'online')          AS "orders",
         (SELECT COUNT(*)::int FROM order_items oi
            JOIN orders o ON o.id = oi."orderId" AND o.channel = 'online')    AS "orderItems",
         (SELECT COUNT(*)::int FROM stock_reservations
           WHERE kind = 'order' AND status = 'active'
             AND "variantId" = ANY($1::int[]))                                AS "allocationRows",
         (SELECT COALESCE(SUM(quantity), 0)::int FROM stock_reservations
           WHERE kind = 'order' AND status = 'active'
             AND "variantId" = ANY($1::int[]))                                AS "allocatedQuantity",
         (SELECT COUNT(*)::int FROM stock_movements
           WHERE "variantId" = ANY($1::int[]))                                AS "movements",
         (SELECT COUNT(*)::int FROM idempotency_keys
           WHERE scope = 'online_order' AND key = $2)                         AS "idempotencyRows",
         (SELECT COUNT(*)::int FROM idempotency_keys
           WHERE scope = 'online_order' AND key = $2
             AND status = 'completed')                                        AS "completedIdempotencyRows"`,
      [variantIds, sharedKey],
    );
    return {
      orders: Number(row.orders),
      orderItems: Number(row.orderItems),
      allocationRows: Number(row.allocationRows),
      allocatedQuantity: Number(row.allocatedQuantity),
      movements: Number(row.movements),
      idempotencyRows: Number(row.idempotencyRows),
      completedIdempotencyRows: Number(row.completedIdempotencyRows),
    };
  }

  async function footprint(): Promise<{ orders: number; allocations: number }> {
    const [row] = await app.dataSource.query(
      `SELECT (SELECT COUNT(*)::int FROM orders WHERE channel = 'online') AS orders,
              (SELECT COUNT(*)::int FROM stock_reservations
                WHERE kind = 'order' AND status = 'active')            AS allocations`,
    );
    return { orders: Number(row.orders), allocations: Number(row.allocations) };
  }

  // =========================================================================
  // 1. The QUOTE expires while checkout waits for the lock
  // =========================================================================

  it('refuses a quote that expired WHILE checkout was queued for the variant lock', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 2);

    // A genuine, server-signed quote for the real basket, whose window closes a
    // few seconds from now. Minted through the real service by shifting its
    // `now` back — the signature and the fingerprint are authentic, only the
    // window is short.
    const { lines } = await quoteOf(shopper);
    const quotes = app.app.get(CheckoutQuoteService);
    const quoteLines: CheckoutQuoteLine[] = lines.map((line) => ({
      variantId: line.variantId,
      cartItemId: null,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      totalPrice: line.unitPrice * line.quantity,
    }));
    const subtotal = quoteLines.reduce((sum, l) => sum + l.totalPrice, 0);
    const shortLived = quotes.issue({
      userId: shopper.userId,
      lines: quoteLines,
      subtotal,
      total: subtotal,
      now: new Date(Date.now() - quotes.ttlMs + 5_000),
    });
    expect(shortLived.payload.expiresAt).toBeGreaterThan(Date.now());

    await holdVariantLock(variant.id);

    const pending = checkout(shopper, shortLived.token).then((r) => r);

    // Blocked on the lock => it already passed the PRE-LOCK quote check.
    await waitUntilBlockedOnLock();

    // Let the window close while the request cannot see it, then release.
    await waitUntilPast(shortLived.payload.expiresAt);
    await releaseVariantLock();

    const response = await pending;

    // The pre-lock check said "valid"; the post-lock check says "expired".
    // Before the fix this was a 201 and the customer was charged against a
    // quote that had already lapsed.
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
    // Consistent and recoverable: a fresh quote for the current basket.
    expect(response.body.details.quote.token).toBeTruthy();
    expect(response.body.details.basket.total).toBe(200_000);

    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    const [{ movements }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS movements FROM stock_movements WHERE "variantId" = $1`,
      [variant.id],
    );
    expect(movements).toBe(0);

    // And the freshly issued quote completes the checkout normally.
    const placed = await checkout(
      shopper,
      response.body.details.quote.token as string,
    );
    expect(placed.status).toBe(201);
  });

  // =========================================================================
  // 2. A BASKET RESERVATION expires while checkout waits for the lock
  // =========================================================================

  it('drops a basket reservation that expired WHILE checkout was queued, and sells only what is still held', async () => {
    const shopper = await makeShopper();
    const keep = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    const lapse = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 700_000 },
    );
    await addToBasket(shopper, keep.product.id, keep.variant.id, 1);
    await addToBasket(shopper, lapse.product.id, lapse.variant.id, 2);

    const { quote, total } = await quoteOf(shopper);
    expect(total).toBe(1_500_000);

    // Hold the lock on the SURVIVING SKU: checkout locks the whole set in
    // ascending id order, so blocking on any one of them blocks the request
    // before it reads any reservation.
    await holdVariantLock(Math.min(keep.variant.id, lapse.variant.id));

    const pending = checkout(shopper, quote.token).then((r) => r);
    await waitUntilBlockedOnLock();

    /*
     * The hold on the second line is set to lapse at an instant that falls
     * STRICTLY BETWEEN the two clocks:
     *
     *   pre-lock clock  <  lapsesAt  <  post-lock clock
     *
     * That is what makes this test DISCRIMINATING. An earlier draft backdated
     * `expiresAt` by a whole minute, which the PRE-lock clock also reads as
     * expired -- so it passed against the defect and proved nothing. The
     * request is already parked on the lock at this point, which means its
     * pre-lock clock has already been read, so any future instant is after it
     * by construction. No four-hour wait and no timing race.
     */
    const lapsesAt = new Date(Date.now() + 1_500);
    const updated = await app.dataSource.query(
      `UPDATE stock_reservations
          SET "expiresAt" = $2
        WHERE "variantId" = $1 AND kind = 'basket' AND status = 'active'
        RETURNING id`,
      [lapse.variant.id, lapsesAt],
    );
    expect(updated.length).toBeGreaterThan(0);

    await waitUntilPast(lapsesAt.getTime());
    await releaseVariantLock();
    const response = await pending;

    /**
     * The lapsed line must not be sold. Before the fix, `expireDueReservations`
     * and `describeBasketLine` were both handed the PRE-LOCK clock, so the
     * released hold still counted as live and its two units were sold out of
     * stock nobody was holding.
     */
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(response.body.details.basket.total).toBe(100_000);
    expect(response.body.details.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: lapse.variant.id,
          currentQuantity: 0,
        }),
      ]),
    );
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });

    /**
     * The refusal rolled its whole transaction back, and that INCLUDES the lazy
     * expiry it performed -- so the lapsed reservation row is still `active` on
     * disk right now. That is the pre-existing lazy-expiry design, not a leak:
     * the row is past `expiresAt`, so no read counts it, and the next
     * COMMITTING read (a quote, a `GET /cart`, or the sweeper) releases it for
     * good.
     *
     * Asserted this way rather than as `active = 0` -- which is what the first
     * draft of this test expected, and what failed -- because the durable
     * guarantee is "the lapsed units are never sold", not "the row is tidied up
     * inside a transaction that rolled back".
     */
    const [{ stillActive }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS "stillActive" FROM stock_reservations
        WHERE "variantId" = $1 AND kind = 'basket' AND status = 'active'`,
      [lapse.variant.id],
    );
    expect(stillActive).toBe(1);

    // A committing read applies the same decision and makes it stick, which is
    // the real proof that the expiry is applied consistently and was not a
    // one-off of the refused request.
    const after = await quoteOf(shopper);
    expect(after.total).toBe(100_000);
    expect(after.lines.map((line) => line.variantId)).toEqual([
      keep.variant.id,
    ]);

    const [{ active }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS active FROM stock_reservations
        WHERE "variantId" = $1 AND kind = 'basket' AND status = 'active'`,
      [lapse.variant.id],
    );
    expect(active).toBe(0);
  });

  // =========================================================================
  // 3. Both still valid after the wait
  // =========================================================================

  it('places the order when quote and reservations both survive the wait, stamped with the POST-LOCK instant', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 250_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 2);

    const { quote } = await quoteOf(shopper);

    await holdVariantLock(variant.id);
    const pending = checkout(shopper, quote.token).then((r) => r);
    await waitUntilBlockedOnLock();

    // Hold it long enough that a pre-lock timestamp and a post-lock timestamp
    // are unmistakably different.
    await waitUntilPast(Date.now() + 1_200);
    const releasedAt = Date.now();
    await releaseVariantLock();

    const response = await pending;
    expect(response.status).toBe(201);
    expect(response.body.data.totalPrice).toBe(500_000);
    expect(await footprint()).toEqual({ orders: 1, allocations: 1 });

    /**
     * DIRECT EVIDENCE THAT THE POST-LOCK CLOCK IS THE ONE IN USE.
     *
     * `orders."soldAt"` is stamped from the authoritative instant. The request
     * arrived, and its pre-lock clock was read, more than a second BEFORE the
     * holder released the lock — so a `soldAt` at or after `releasedAt` can
     * only have come from a clock read after the wait. With the old code this
     * assertion fails: `soldAt` predates the release.
     */
    const [row] = await app.dataSource.query<{ soldAt: string }[]>(
      `SELECT "soldAt" FROM orders WHERE id = $1`,
      [Number(response.body.data.id)],
    );
    expect(new Date(row.soldAt).getTime()).toBeGreaterThanOrEqual(
      releasedAt - 50,
    );

    // The allocation's own window is measured from that same instant.
    const [allocation] = await app.dataSource.query<{ expiresAt: string }[]>(
      `SELECT "expiresAt" FROM stock_reservations
        WHERE "variantId" = $1 AND kind = 'order' AND status = 'active'`,
      [variant.id],
    );
    expect(new Date(allocation.expiresAt).getTime()).toBeGreaterThan(
      releasedAt,
    );
  });

  // =========================================================================
  // 4. A SKU that appears during the wait is a transient race, not a change
  // =========================================================================

  it('a new SKU appearing during the wait cannot enter an order without renewed confirmation, under ONE Idempotency-Key', async () => {
    const shopper = await makeShopper();
    const first = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    const late = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 300_000 },
    );
    const variantIds = [first.variant.id, late.variant.id];
    await addToBasket(shopper, first.product.id, first.variant.id, 1);

    const { quote } = await quoteOf(shopper);

    /**
     * ONE KEY FOR THE WHOLE ATTEMPT.
     *
     * The documented flow requires a client to hold BOTH invariants across a
     * retry: the same customer-accepted `quoteToken` AND the same
     * `Idempotency-Key`. An earlier version of this test reused the token but
     * let the `checkout()` helper mint a fresh key per call, so it proved only
     * half of the contract — and the interesting half is the other one. If a
     * rejected attempt left its idempotency claim behind, the customer would be
     * locked out of their own checkout by a 409 they never caused; if a
     * successful one did not, a retry would place a second order.
     *
     * Every request below sends this exact key.
     */
    sharedKey = KEY();

    await holdVariantLock(first.variant.id);
    const pending = checkout(shopper, quote.token, sharedKey).then((r) => r);
    await waitUntilBlockedOnLock();

    /**
     * The lock set was chosen from the discovery read (and the quote), both of
     * which happened BEFORE the block — so this SKU is in neither. When the
     * locked re-read finds it, its price cannot be stated authoritatively,
     * because we do not hold its row.
     */
    await addToBasket(shopper, late.product.id, late.variant.id, 1);
    await releaseVariantLock();

    const response = await pending;

    /**
     * Its own code, because the recovery differs from every other 409: there is
     * no diff to show a customer and no quote in the body (a basket we could
     * not price cannot be priced into a quote). It previously borrowed
     * `checkout_contents_changed` and returned an empty `changes` and an empty
     * `basket` — telling a client to "show the customer the changes" while
     * handing it nothing to show.
     */
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(CheckoutConflictCode.RETRY_REQUIRED);
    expect(response.body.details.retryable).toBe(true);
    expect(response.body.details.confirmationRequired).toBe(false);
    expect(response.body.details.quote).toBeUndefined();
    expect(response.body.details.changes).toBeUndefined();

    // Nothing created, AND the key is free again: the 409 was thrown inside the
    // checkout transaction, so the idempotency claim rolled back with it.
    expect(await dbState(variantIds)).toEqual({
      orders: 0,
      orderItems: 0,
      allocationRows: 0,
      allocatedQuantity: 0,
      movements: 0,
      idempotencyRows: 0,
      completedIdempotencyRows: 0,
    });

    /**
     * THE SAFE RECOVERY, AND WHY THE OBVIOUS ONE IS WRONG.
     *
     * `retryable: true` invites a client to re-quote and resubmit
     * automatically, and the contract document used to say exactly that. It is
     * unsafe precisely BECAUSE of this scenario: the transient race can be
     * caused by a NEW SKU appearing in the basket, so a fresh quote prices
     * something the customer never agreed to buy. Auto-submitting it rebuilds
     * the `confirmChanges: true` defect in the client.
     *
     * The safe first step is to retry with the SAME accepted token and the SAME
     * key. The SKU is in the lock set this time, so the server can price it —
     * and it answers QUOTE_STALE, because the basket no longer matches what the
     * customer accepted.
     */
    const sameToken = await checkout(shopper, quote.token, sharedKey);
    expect(sameToken.status).toBe(409);
    expect(sameToken.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(sameToken.body.details.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'line_added',
          variantId: late.variant.id,
          previousQuantity: 0,
          currentQuantity: 1,
        }),
      ]),
    );
    expect(sameToken.body.details.basket.total).toBe(400_000);
    const freshToken = sameToken.body.details.quote.token as string;

    // Still nothing created, and the key is still free.
    expect(await dbState(variantIds)).toEqual({
      orders: 0,
      orderItems: 0,
      allocationRows: 0,
      allocatedQuantity: 0,
      movements: 0,
      idempotencyRows: 0,
      completedIdempotencyRows: 0,
    });

    /**
     * THE PROOF. The accepted token can never place an order containing the
     * late SKU, however many times it is retried on the same key — the
     * fingerprint that authorised 1 x 100,000 cannot authorise
     * 1 x 100,000 + 1 x 300,000.
     */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await checkout(shopper, quote.token, sharedKey);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
      // Asserted INSIDE the loop: a leak on the second retry must not be
      // masked by a check that only runs after the third.
      expect(await dbState(variantIds)).toEqual({
        orders: 0,
        orderItems: 0,
        allocationRows: 0,
        allocatedQuantity: 0,
        movements: 0,
        idempotencyRows: 0,
        completedIdempotencyRows: 0,
      });
    }
    const [{ lateLines }] = await app.dataSource.query<{ lateLines: number }[]>(
      `SELECT COUNT(*)::int AS "lateLines" FROM order_items WHERE "variantId" = $1`,
      [late.variant.id],
    );
    expect(lateLines).toBe(0);

    /**
     * Only after the customer is shown the diff and explicitly accepts it —
     * which is what adopting the fresh token represents — does the late SKU
     * enter an order. Same key, still.
     */
    const confirmed = await checkout(shopper, freshToken, sharedKey);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.totalPrice).toBe(400_000);
    const variantsOnOrder = (
      confirmed.body.data.items as Array<{ variantId: number }>
    ).map((item) => item.variantId);
    expect(variantsOnOrder).toContain(late.variant.id);
    expect(variantsOnOrder).toContain(first.variant.id);

    /**
     * ONE order, ONE order line per SKU, ONE allocation row per SKU holding
     * exactly the accepted quantity, and the key now COMPLETED.
     *
     * Two allocation rows, not one: `convertBasketToOrderAllocation` writes one
     * reservation per variant and this basket has two. The duplicate-work guard
     * is `allocatedQuantity`, which is 2 (one unit of each) and would be 4 if a
     * retry had re-run the conversion.
     */
    const afterConfirm = await dbState(variantIds);
    expect(afterConfirm).toEqual({
      orders: 1,
      orderItems: 2,
      allocationRows: 2,
      allocatedQuantity: 2,
      movements: 0,
      idempotencyRows: 1,
      completedIdempotencyRows: 1,
    });

    /**
     * REPLAY. The customer's client times out on the 201 it never saw and
     * resends the same request: same key, same adopted token. It must get the
     * SAME order back and must not allocate a second time.
     */
    const replay = await checkout(shopper, freshToken, sharedKey);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(confirmed.body.data.id);
    expect(replay.body.data.orderNumber).toBe(confirmed.body.data.orderNumber);
    expect(replay.body.data.acceptedQuote.basketVersion).toBe(
      confirmed.body.data.acceptedQuote.basketVersion,
    );

    // Byte-for-byte the same database state as before the replay.
    expect(await dbState(variantIds)).toEqual(afterConfirm);

    // And exactly one online order exists overall, with the two expected lines.
    const [{ orders }] = await app.dataSource.query<{ orders: number }[]>(
      `SELECT COUNT(*)::int AS orders FROM orders WHERE channel = 'online'`,
    );
    expect(orders).toBe(1);
  });

  // =========================================================================
  // 4. Idempotency survives a rejection that happened after a lock wait
  // =========================================================================

  it('lets the SAME Idempotency-Key be reused after a post-lock-wait rejection', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 2);

    const { lines } = await quoteOf(shopper);
    const quotes = app.app.get(CheckoutQuoteService);
    const quoteLines: CheckoutQuoteLine[] = lines.map((line) => ({
      variantId: line.variantId,
      cartItemId: null,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      totalPrice: line.unitPrice * line.quantity,
    }));
    const subtotal = quoteLines.reduce((sum, l) => sum + l.totalPrice, 0);
    const shortLived = quotes.issue({
      userId: shopper.userId,
      lines: quoteLines,
      subtotal,
      total: subtotal,
      now: new Date(Date.now() - quotes.ttlMs + 5_000),
    });

    await holdVariantLock(variant.id);
    const key = KEY();
    const pending = checkout(shopper, shortLived.token, key).then((r) => r);
    await waitUntilBlockedOnLock();
    await waitUntilPast(shortLived.payload.expiresAt);
    await releaseVariantLock();

    const refused = await pending;
    expect(refused.status).toBe(409);

    // The rejection rolled its transaction back, taking the idempotency claim
    // with it — so the customer is not locked out of their own checkout by a
    // lock wait they never saw.
    const placed = await checkout(
      shopper,
      refused.body.details.quote.token as string,
      key,
    );
    expect(placed.status).toBe(201);
    expect(await footprint()).toEqual({ orders: 1, allocations: 1 });
  });
});
