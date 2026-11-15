import { randomUUID } from 'node:crypto';

import { CheckoutConflictCode } from 'src/common/constants/checkout.messages';
import { CheckoutQuoteService } from 'src/modules/orders/checkout-quote.service';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

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
 * CHECKOUT CONFIRMATION IS BOUND TO AN EXACT BASKET SNAPSHOT
 * ===========================================================================
 *
 * THE DEFECT THIS SUITE EXISTS FOR.
 *
 * The confirmation gate used to be:
 *
 *     if (changes.length > 0 && dto.confirmChanges !== true) { ...409... }
 *
 * so `confirmChanges: true` suppressed the changes the server had detected in
 * the SAME request — including a mismatch against the `expectedTotal` the
 * client had just sent. Omitting `expectedTotal` reached the same place by
 * declaring no expectation at all. Either way the customer was charged
 * whatever the server computed at that instant.
 *
 * The root cause was that "confirm" was a BOOLEAN, and a boolean cannot name
 * WHICH basket the customer agreed to buy — so it authorised every future
 * basket equally well.
 *
 * Confirmation is now a server-signed QUOTE bound to the authenticated
 * customer, the exact sellable SKUs, their quantities, their unit prices, the
 * totals, and a bounded validity window. Every case below asserts the
 * DATABASE, not just the status code: a rejected confirmation must leave no
 * order and no order allocation behind.
 */
describe('checkout quote contract', () => {
  let app: TestApp;

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
  ): Promise<number> {
    const response = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId, variantId, quantity });
    expect([200, 201]).toContain(response.status);
    return Number(response.body.data.id);
  }

  interface QuoteView {
    token: string;
    basketVersion: string;
    issuedAt: string;
    expiresAt: string;
    subtotal: number;
    total: number;
  }

  async function quoteOf(
    shopper: Shopper,
  ): Promise<{ quote: QuoteView; total: number }> {
    const response = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(response.status).toBe(200);
    return {
      quote: response.body.data.quote as QuoteView,
      total: Number(response.body.data.basket.total),
    };
  }

  function checkout(shopper: Shopper, quoteToken: string, key = KEY()) {
    return withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ address: shopper.addressId, quoteToken });
  }

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

  async function setVariantPrice(variantId: number, price: number) {
    await app.dataSource.query(
      `UPDATE product_variants SET price = $2 WHERE id = $1`,
      [variantId, price],
    );
  }

  /** Orders and ORDER-kind allocations, which a rejection must never create. */
  async function footprint(): Promise<{ orders: number; allocations: number }> {
    const [row] = await app.dataSource.query(
      `SELECT (SELECT COUNT(*)::int FROM orders WHERE channel = 'online') AS orders,
              (SELECT COUNT(*)::int FROM stock_reservations
                WHERE kind = 'order' AND status = 'active')            AS allocations`,
    );
    return { orders: Number(row.orders), allocations: Number(row.allocations) };
  }

  /** Re-signs nothing: flips a digit in the PAYLOAD and keeps the signature. */
  function tamper(token: string, mutate: (payload: any) => void): string {
    const [prefix, body, signature] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    mutate(payload);
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    return `${prefix}.${forged}.${signature}`;
  }

  // =========================================================================
  // The old bypass is unreachable
  // =========================================================================

  describe('the previous bypass fields are gone', () => {
    it('rejects confirmChanges, the flag that used to suppress detected changes', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 5, price: 100_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 2);

      const response = await withCookies(app, shopper.jar)
        .post('/orders')
        .set('Idempotency-Key', KEY())
        .send({ address: shopper.addressId, confirmChanges: true });

      // 400, not a silent success: the ValidationPipe runs with
      // `forbidNonWhitelisted`, so the field that used to be the bypass is now
      // an outright request error. Failing closed matters more than being
      // polite to an old client here — the alternative is charging one.
      expect(response.status).toBe(400);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });

    it('rejects a checkout that declares an expectedTotal instead of a quote', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 5, price: 100_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 2);

      const response = await withCookies(app, shopper.jar)
        .post('/orders')
        .set('Idempotency-Key', KEY())
        .send({ address: shopper.addressId, expectedTotal: 200_000 });

      expect(response.status).toBe(400);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });
  });

  // =========================================================================
  // Initial-checkout contract
  // =========================================================================

  describe('initial checkout', () => {
    it('refuses a first attempt that presents no quote, and hands one back', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 5, price: 300_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 2);

      const response = await checkout(shopper, 'this-is-not-a-quote-token');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
      // Typed, so the token handed back below is a `string` and not an `any`
      // flowing into the next request.
      const details = response.body.details as {
        quote: QuoteView;
        basket: { total: number };
      };
      expect(details.quote.token).toBeTruthy();
      expect(details.basket.total).toBe(600_000);
      expect(details.quote.total).toBe(600_000);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });

      // And the handed-back quote works immediately.
      const placed = await checkout(shopper, details.quote.token);
      expect(placed.status).toBe(201);
      expect(placed.body.data.totalPrice).toBe(600_000);
    });

    it('places the order when the quote still prices the basket exactly', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 6, price: 250_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 3);

      const { quote } = await quoteOf(shopper);
      const placed = await checkout(shopper, quote.token);

      expect(placed.status).toBe(201);
      // The response carries the quote the order was authorised by, and its
      // fingerprint, so the accepted purchase is auditable from the receipt.
      expect(placed.body.data.acceptedQuote).toMatchObject({
        basketVersion: quote.basketVersion,
        subtotal: 750_000,
        total: 750_000,
      });
      expect(await footprint()).toEqual({ orders: 1, allocations: 1 });
    });
  });

  // =========================================================================
  // Price changed between the 409 and the confirmation
  // =========================================================================

  it('refuses a quote whose price moved, and charges the NEW price only after a fresh acceptance', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 2);

    // The customer reviews 2 x 100,000.
    const { quote: accepted } = await quoteOf(shopper);
    expect(accepted.total).toBe(200_000);

    // The price is raised before they confirm.
    await setVariantPrice(variant.id, 180_000);

    const refused = await checkout(shopper, accepted.token);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);

    // The diff names BOTH figures, per SKU, so a client can render "was / now".
    const changes = refused.body.details.changes as Array<
      Record<string, unknown>
    >;
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'price_changed',
          variantId: variant.id,
          previousUnitPrice: 100_000,
          currentUnitPrice: 180_000,
        }),
        expect.objectContaining({
          kind: 'total_changed',
          previousTotal: 200_000,
          currentTotal: 360_000,
        }),
      ]),
    );
    expect(refused.body.details.basket.total).toBe(360_000);
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });

    // Only the FRESH quote authorises the new price.
    const placed = await checkout(
      shopper,
      refused.body.details.quote.token as string,
    );
    expect(placed.status).toBe(201);
    expect(placed.body.data.totalPrice).toBe(360_000);
    expect(placed.body.data.items[0].unitPrice).toBe(180_000);
  });

  it('refuses a price DROP too — the customer is shown the basket they will actually be charged', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 200_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 1);

    const { quote } = await quoteOf(shopper);
    await setVariantPrice(variant.id, 50_000);

    // A drop is in the customer's favour, and it is STILL refused. The
    // guarantee is "you are charged the basket you accepted", not "you are
    // never charged more" — a total that silently moves in either direction
    // means the review screen was fiction.
    const refused = await checkout(shopper, quote.token);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
  });

  // =========================================================================
  // Further POS displacement before confirmation
  // =========================================================================

  it('refuses each successive quote as POS keeps taking units, and never authorises the older one', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 6, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 6);

    const { quote: first } = await quoteOf(shopper);
    expect(first.total).toBe(600_000);

    // POS takes 2. The first quote is now stale.
    await posConsume(variant.id, 2);
    const refusedOnce = await checkout(shopper, first.token);
    expect(refusedOnce.status).toBe(409);
    expect(refusedOnce.body.details.basket.total).toBe(400_000);
    const second = refusedOnce.body.details.quote.token as string;

    // POS takes 1 more BEFORE the customer confirms the second quote.
    await posConsume(variant.id, 1);
    const refusedTwice = await checkout(shopper, second);
    expect(refusedTwice.status).toBe(409);
    expect(refusedTwice.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(refusedTwice.body.details.basket.total).toBe(300_000);

    // The FIRST quote is still refused, and is not resurrected by the fact
    // that a newer one also failed.
    expect((await checkout(shopper, first.token)).status).toBe(409);
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });

    // The current quote settles it, for exactly the units still held.
    const placed = await checkout(
      shopper,
      refusedTwice.body.details.quote.token as string,
    );
    expect(placed.status).toBe(201);
    expect(placed.body.data.items[0].quantity).toBe(3);
    expect(placed.body.data.totalPrice).toBe(300_000);
  });

  // =========================================================================
  // Changed lines / quantities with an UNCHANGED total
  // =========================================================================

  it('refuses a different basket that happens to cost exactly the same (swapped SKUs)', async () => {
    const shopper = await makeShopper();
    const a = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 400_000 },
    );
    const b = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 400_000 },
    );

    const lineA = await addToBasket(shopper, a.product.id, a.variant.id, 1);
    const { quote } = await quoteOf(shopper);
    expect(quote.total).toBe(400_000);

    // Swap A for B. Same money, different purchase.
    expect(
      (await withCookies(app, shopper.jar).delete(`/cart/${lineA}`)).status,
    ).toBeLessThan(400);
    await addToBasket(shopper, b.product.id, b.variant.id, 1);

    const refused = await checkout(shopper, quote.token);

    // The whole point: an `expectedTotal` check could never see this, and the
    // `confirmChanges` boolean did not even try.
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(refused.body.details.basket.total).toBe(400_000);

    const changes = refused.body.details.changes as Array<
      Record<string, unknown>
    >;
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: a.variant.id,
          currentQuantity: 0,
        }),
        expect.objectContaining({
          kind: 'line_added',
          variantId: b.variant.id,
          currentQuantity: 1,
        }),
      ]),
    );
    // No TOTAL_CHANGED entry, because the total genuinely did not move — which
    // is exactly why the total alone is not a safe gate.
    expect(changes.some((c) => c.kind === 'total_changed')).toBe(false);
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
  });

  it('refuses a quantity reshuffle across two SKUs that leaves the total identical', async () => {
    const shopper = await makeShopper();
    const a = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 8, price: 100_000 },
    );
    const b = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 8, price: 100_000 },
    );
    const lineA = await addToBasket(shopper, a.product.id, a.variant.id, 2);
    const lineB = await addToBasket(shopper, b.product.id, b.variant.id, 2);

    const { quote } = await quoteOf(shopper);
    expect(quote.total).toBe(400_000);

    // 2+2 becomes 1+3. Same total, different purchase.
    expect(
      (
        await withCookies(app, shopper.jar)
          .patch(`/cart/${lineA}`)
          .send({ quantity: 1 })
      ).status,
    ).toBeLessThan(400);
    expect(
      (
        await withCookies(app, shopper.jar)
          .patch(`/cart/${lineB}`)
          .send({ quantity: 3 })
      ).status,
    ).toBeLessThan(400);

    const refused = await checkout(shopper, quote.token);
    expect(refused.status).toBe(409);
    expect(refused.body.details.basket.total).toBe(400_000);
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
  });

  // =========================================================================
  // Missing, expired, tampered, another customer's
  // =========================================================================

  describe('an unusable quote is refused with one indistinguishable code', () => {
    async function stockedShopper(): Promise<{
      shopper: Shopper;
      variantId: number;
    }> {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 5, price: 100_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 2);
      return { shopper, variantId: variant.id };
    }

    it('an OMITTED quoteToken is the ordinary first step: 409 with a quote to review, and nothing created', async () => {
      const { shopper } = await stockedShopper();
      const response = await withCookies(app, shopper.jar)
        .post('/orders')
        .set('Idempotency-Key', KEY())
        .send({ address: shopper.addressId });

      /**
       * 409, not 400. This used to be a bare validation error carrying no
       * quote, while an EXPIRED token got a 409 carrying everything needed to
       * continue — two recovery paths for the same situation, and the
       * documented `checkout_quote_required` code was unreachable except by
       * sending whitespace. Now every quote problem is one 409 with one
       * recovery.
       */
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(CheckoutConflictCode.QUOTE_REQUIRED);
      expect(response.body.details.quote.token).toBeTruthy();
      expect(response.body.details.basket.total).toBe(200_000);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });

      // And it completes with the quote it just handed back.
      const placed = await checkout(
        shopper,
        response.body.details.quote.token as string,
      );
      expect(placed.status).toBe(201);
    });

    it('an EMPTY-STRING quoteToken is treated the same as omitting it', async () => {
      const { shopper } = await stockedShopper();
      const response = await checkout(shopper, '');
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(CheckoutConflictCode.QUOTE_REQUIRED);
      expect(response.body.details.quote.token).toBeTruthy();
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });

    it('an EXPIRED but genuinely signed quote is refused', async () => {
      const { shopper } = await stockedShopper();
      const quotes = app.app.get(CheckoutQuoteService);

      // Signed by the real service with the real key — only the clock is
      // against it. This is not a forgery; it is a quote the customer sat on.
      const stale = quotes.issue({
        userId: shopper.userId,
        lines: [
          {
            variantId: 1,
            cartItemId: null,
            quantity: 2,
            unitPrice: 100_000,
            totalPrice: 200_000,
          },
        ],
        subtotal: 200_000,
        total: 200_000,
        now: new Date(Date.now() - quotes.ttlMs - 60_000),
      });
      expect(new Date(stale.payload.expiresAt).getTime()).toBeLessThan(
        Date.now(),
      );

      const refused = await checkout(shopper, stale.token);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
      expect(refused.body.details.quote.token).toBeTruthy();
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });

    it('a TAMPERED quote that lowers the price is refused', async () => {
      const { shopper } = await stockedShopper();
      const { quote } = await quoteOf(shopper);
      expect(quote.total).toBe(200_000);

      const forged = tamper(quote.token, (payload) => {
        payload.subtotal = 1;
        payload.total = 1;
        payload.lines[0].unitPrice = 1;
        payload.lines[0].totalPrice = 1;
      });

      const refused = await checkout(shopper, forged);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
      // Refused on the SIGNATURE, before the payload is even parsed — so the
      // forged figures never reach the pricing path.
      expect(refused.body.details.basket.total).toBe(200_000);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });

    it('a TAMPERED quote that extends its own expiry is refused', async () => {
      const { shopper } = await stockedShopper();
      const { quote } = await quoteOf(shopper);
      const forged = tamper(quote.token, (payload) => {
        payload.expiresAt = Date.now() + 10 * 365 * 24 * 3_600_000;
      });

      const refused = await checkout(shopper, forged);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });

    it("ANOTHER CUSTOMER's quote is refused even when it prices an identical basket", async () => {
      const victim = await makeShopper();
      const attacker = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 10, price: 100_000 },
      );
      // Identical baskets, so nothing but OWNERSHIP can distinguish them.
      await addToBasket(victim, product.id, variant.id, 2);
      await addToBasket(attacker, product.id, variant.id, 2);

      const { quote: victimQuote } = await quoteOf(victim);
      const refused = await checkout(attacker, victimQuote.token);

      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_INVALID);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });

      // The attacker's OWN quote works, so the refusal was about ownership and
      // not about the basket being unbuyable.
      const own = await quoteOf(attacker);
      expect((await checkout(attacker, own.quote.token)).status).toBe(201);
    });

    it('the tampered, expired and foreign refusals are indistinguishable to the client', async () => {
      const { shopper } = await stockedShopper();
      const quotes = app.app.get(CheckoutQuoteService);
      const { quote } = await quoteOf(shopper);

      const expired = quotes.issue({
        userId: shopper.userId,
        lines: [],
        subtotal: 0,
        total: 0,
        now: new Date(Date.now() - quotes.ttlMs - 60_000),
      });
      const foreign = quotes.issue({
        userId: shopper.userId + 99_999,
        lines: [],
        subtotal: 0,
        total: 0,
        now: new Date(),
      });
      const forged = tamper(quote.token, (p) => {
        p.total = 1;
      });

      const bodies: Array<{ error: unknown; message: unknown }> = [];
      for (const token of [expired.token, foreign.token, forged]) {
        const response = await checkout(shopper, token);
        expect(response.status).toBe(409);
        bodies.push({
          error: response.body.error,
          message: response.body.message,
        });
      }
      // One code, one message. Distinguishing them would tell a prober whether
      // a captured token was genuine, or whose it was.
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
    });
  });

  it('refuses a quote when the customer ADDED a line after reviewing', async () => {
    const shopper = await makeShopper();
    const a = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    const b = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 300_000 },
    );
    await addToBasket(shopper, a.product.id, a.variant.id, 1);

    const { quote } = await quoteOf(shopper);
    await addToBasket(shopper, b.product.id, b.variant.id, 1);

    const refused = await checkout(shopper, quote.token);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CheckoutConflictCode.QUOTE_STALE);
    expect(refused.body.details.basket.total).toBe(400_000);
    expect(refused.body.details.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'line_added',
          variantId: b.variant.id,
          previousQuantity: 0,
          currentQuantity: 1,
        }),
      ]),
    );
    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
  });

  // =========================================================================
  // A rejected confirmation leaves the inventory exactly as it found it
  // =========================================================================

  it('leaves the surviving basket reservations untouched when a confirmation is refused', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 6, price: 100_000 },
    );
    await addToBasket(shopper, product.id, variant.id, 6);

    const { quote } = await quoteOf(shopper);
    await posConsume(variant.id, 2); // POS priority takes 2 of the 6.

    const refused = await checkout(shopper, quote.token);
    expect(refused.status).toBe(409);

    /**
     * The 4 units the customer still holds must still be HELD after the
     * refusal. A rejected confirmation rolls its transaction back, so it may
     * not release a reservation, convert one to an order allocation, or move
     * physical stock. The 2 units POS took are gone because POS took them —
     * not because the refused checkout did anything.
     */
    const reservations = await app.dataSource.query(
      `SELECT kind, status, COALESCE(SUM(quantity), 0)::int AS qty
         FROM stock_reservations
        WHERE "variantId" = $1
        GROUP BY kind, status
        ORDER BY kind, status`,
      [variant.id],
    );
    const activeBasket = reservations.find(
      (r) => r.kind === 'basket' && r.status === 'active',
    );
    expect(activeBasket?.qty).toBe(4);
    expect(
      reservations.some((r) => r.kind === 'order' && r.status === 'active'),
    ).toBe(false);

    // Physical stock moved once, for the POS sale, and not for the refusal.
    const [{ stock }] = await app.dataSource.query(
      `SELECT stock FROM product_variants WHERE id = $1`,
      [variant.id],
    );
    expect(Number(stock)).toBe(4);
    const [{ movements }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS movements FROM stock_movements WHERE "variantId" = $1`,
      [variant.id],
    );
    expect(movements).toBe(1);

    expect(await footprint()).toEqual({ orders: 0, allocations: 0 });
  });

  // =========================================================================
  // Retry and replay
  // =========================================================================

  describe('retry and replay', () => {
    it('a REFUSED confirmation can be retried with the SAME Idempotency-Key', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 5, price: 100_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 2);

      const { quote: stale } = await quoteOf(shopper);
      await setVariantPrice(variant.id, 150_000);

      const key = KEY();
      const refused = await checkout(shopper, stale.token, key);
      expect(refused.status).toBe(409);

      // The 409 rolled its transaction back, taking the idempotency claim with
      // it, so the SAME key is free for the retry. If the claim survived, a
      // customer who hit one 409 could never complete that checkout.
      const placed = await checkout(
        shopper,
        refused.body.details.quote.token as string,
        key,
      );
      expect(placed.status).toBe(201);
      expect(placed.body.data.totalPrice).toBe(300_000);
      expect(await footprint()).toEqual({ orders: 1, allocations: 1 });
    });

    it('a SUCCESSFUL request replays without allocating twice, even with a different quote', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 9, price: 100_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 3);

      const { quote } = await quoteOf(shopper);
      const key = KEY();
      const first = await checkout(shopper, quote.token, key);
      expect(first.status).toBe(201);

      // Same key, DIFFERENT (and now stale) quote. The stored response is
      // replayed: the request is identified by its key and its order-defining
      // fields, and `quoteToken` is a control field for one attempt, so a
      // retried confirmation cannot become a second order.
      const replay = await checkout(
        shopper,
        'a-completely-different-token',
        key,
      );
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(replay.body.data.orderNumber).toBe(first.body.data.orderNumber);
      expect(replay.body.data.acceptedQuote.basketVersion).toBe(
        quote.basketVersion,
      );

      expect(await footprint()).toEqual({ orders: 1, allocations: 1 });
      const [{ allocated }] = await app.dataSource.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS allocated
           FROM stock_reservations
          WHERE "variantId" = $1 AND kind = 'order' AND status = 'active'`,
        [variant.id],
      );
      expect(allocated).toBe(3);
    });

    it('a used quote cannot place a SECOND order under a new Idempotency-Key', async () => {
      const shopper = await makeShopper();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        {},
        { stock: 9, price: 100_000 },
      );
      await addToBasket(shopper, product.id, variant.id, 3);

      const { quote } = await quoteOf(shopper);
      expect((await checkout(shopper, quote.token)).status).toBe(201);

      // The basket is empty now (its holds became the order's allocation), so
      // there is nothing left to price and no second order can be created.
      const again = await checkout(shopper, quote.token, KEY());
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(await footprint()).toEqual({ orders: 1, allocations: 1 });
    });
  });
});
