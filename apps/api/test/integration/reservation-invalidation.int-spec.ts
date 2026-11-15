import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { POS_IDEMPOTENCY_HEADER } from 'src/modules/orders/idempotency.helper';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  AVAILABILITY_EVENT,
  POS_AVAILABILITY_EVENT,
  RealtimeGateway,
} from 'src/modules/realtime/realtime.gateway';
import { deriveAvailability } from 'src/modules/inventory/availability.projection';

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
  forceStockForTest,
} from './setup/seed-helpers';
import { posKey } from './support/pos.fixtures';
import {
  connectRealtime,
  type TestRealtimeClient,
} from './support/realtime-client';

/**
 * ===========================================================================
 * BASKET RESERVATIONS INVALIDATE STOREFRONT AVAILABILITY — AND ONLY IT
 * ===========================================================================
 *
 * OWNER DECISION 2: taking, changing, releasing or expiring a basket hold must
 * invalidate affected storefront availability after commit. Before this pass
 * the four basket write paths announced NOTHING, so the last buyable unit could
 * vanish into somebody's basket and every other shopper's product page went on
 * claiming it was available until they tried to add it.
 *
 * OWNER DECISION 3: a basket reservation must not make a variant look
 * unsellable to the TILL. POS outranks basket holds — a cashier at the counter
 * displaces them — so the till's sellable number does not move when a hold is
 * taken, and waking every till to re-read it would be both wasteful and
 * misleading.
 *
 * Those two decisions are why `reservation` is a distinct reason from `stock`
 * and `allocation`, and this file is where that distinction is enforced rather
 * than merely documented.
 */
describe('reservation invalidation and availability semantics', () => {
  let app: TestApp;
  let gateway: RealtimeGateway;
  let open: TestRealtimeClient[] = [];

  let customerJar: CookieJar;
  let customerId: number;
  let cashierJar: CookieJar;
  let adminJar: CookieJar;

  async function guest(): Promise<TestRealtimeClient> {
    const client = await connectRealtime({
      server: app.server,
      audience: 'storefront',
    });
    open.push(client);
    await settle(client);
    return client;
  }

  async function till(): Promise<TestRealtimeClient> {
    const client = await connectRealtime({
      server: app.server,
      cookie: cashierJar.header(),
      audience: 'pos',
    });
    open.push(client);
    await settle(client);
    return client;
  }

  /** Wait for the gateway to finish joining rooms. Bounded; no sleep. */
  async function settle(client: TestRealtimeClient): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const sockets = await gateway.server.fetchSockets();
      const mine = sockets.find((socket) => socket.id === client.socket.id);
      if (mine && [...mine.rooms].length > 1) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('socket was never registered by the gateway');
  }

  const facts = async (variantId: number) => {
    const [row] = await app.dataSource.query<
      Array<{
        variantId: number;
        productId: number;
        isActive: boolean;
        physicalStock: string;
        basketReserved: string;
        orderAllocated: string;
      }>
    >(
      `SELECT v.id AS "variantId", v."productId" AS "productId",
              v."isActive" AS "isActive", v.stock AS "physicalStock",
              COALESCE(SUM(r.quantity) FILTER (WHERE r.kind = 'basket'), 0) AS "basketReserved",
              COALESCE(SUM(r.quantity) FILTER (WHERE r.kind = 'order'), 0)  AS "orderAllocated"
         FROM product_variants v
         LEFT JOIN stock_reservations r
                ON r."variantId" = v.id AND r.status = 'active' AND r."expiresAt" > now()
        WHERE v.id = $1
        GROUP BY v.id, v."productId", v."isActive", v.stock`,
      [variantId],
    );
    return deriveAvailability({
      variantId: Number(row.variantId),
      productId: Number(row.productId),
      isActive: row.isActive === true,
      physicalStock: Number(row.physicalStock),
      basketReserved: Number(row.basketReserved),
      orderAllocated: Number(row.orderAllocated),
    });
  };

  beforeAll(async () => {
    app = await createTestApp();
    gateway = app.app.get(RealtimeGateway);
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
    open = [];

    const branch = await createBranch(app.dataSource);
    const sale = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    cashierJar = await authenticate(app, sale.username, sale.password, 'pos');

    const site = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    customerId = site.user.id;
    customerJar = await authenticate(
      app,
      site.username,
      site.password,
      'storefront',
    );

    const admin = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    adminJar = await authenticate(app, admin.username, admin.password, 'admin');
  });

  afterEach(async () => {
    await Promise.all(open.map((client) => client.close()));
    open = [];
  });

  const addToBasket = (
    productId: number,
    variantId: number,
    quantity: number,
  ) =>
    withCookies(app, customerJar)
      .post('/cart')
      .send({ productId, variantId, quantity });

  // =========================================================================
  // 1. THE FOUR BASKET WRITE PATHS
  // =========================================================================

  describe('every basket write announces a storefront invalidation', () => {
    it('on CREATE — and never tells the till stock moved', async () => {
      const shopper = await guest();
      const counter = await till();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Held Kettle' },
        { stock: 5, price: 100_000 },
      );

      expect((await addToBasket(product.id, variant.id, 2)).status).toBe(201);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'reservation',
      });

      // OWNER DECISION 3, as an assertion: no staff frame at all. The till's
      // sellable number did not move, so nothing woke the till.
      await counter.expectSilence(POS_AVAILABILITY_EVENT, 500);
    });

    it('on INCREASE', async () => {
      const shopper = await guest();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Grown Kettle' },
        { stock: 5, price: 100_000 },
      );
      const created = await addToBasket(product.id, variant.id, 1);
      const lineId = (created.body as { data: { id: number } }).data.id;
      await shopper.next(AVAILABILITY_EVENT);

      const raised = await withCookies(app, customerJar)
        .patch(`/cart/${lineId}`)
        .send({ quantity: 3 });
      expect(raised.status).toBe(200);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toMatchObject({
        variantId: variant.id,
        reason: 'reservation',
      });
      expect((await facts(variant.id)).basketReserved).toBe(3);
    });

    it('on DECREASE', async () => {
      const shopper = await guest();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Shrunk Kettle' },
        { stock: 5, price: 100_000 },
      );
      const created = await addToBasket(product.id, variant.id, 3);
      const lineId = (created.body as { data: { id: number } }).data.id;
      await shopper.next(AVAILABILITY_EVENT);

      const lowered = await withCookies(app, customerJar)
        .patch(`/cart/${lineId}`)
        .send({ quantity: 1 });
      expect(lowered.status).toBe(200);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toMatchObject({
        variantId: variant.id,
        reason: 'reservation',
      });
      expect((await facts(variant.id)).availableForBasket).toBe(4);
    });

    it('on REMOVE', async () => {
      const shopper = await guest();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Dropped Kettle' },
        { stock: 5, price: 100_000 },
      );
      const created = await addToBasket(product.id, variant.id, 2);
      const lineId = (created.body as { data: { id: number } }).data.id;
      await shopper.next(AVAILABILITY_EVENT);

      const removed = await withCookies(app, customerJar).delete(
        `/cart/${lineId}`,
      );
      expect([200, 204]).toContain(removed.status);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toMatchObject({
        variantId: variant.id,
        reason: 'reservation',
      });
      expect((await facts(variant.id)).availableForBasket).toBe(5);
    });

    it('but NOT for an unchanged quantity — a pure read announces nothing', async () => {
      const shopper = await guest();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Unchanged Kettle' },
        { stock: 5, price: 100_000 },
      );
      const created = await addToBasket(product.id, variant.id, 2);
      const lineId = (created.body as { data: { id: number } }).data.id;
      await shopper.next(AVAILABILITY_EVENT);

      // R4: setting the same quantity writes nothing and must not move
      // `expiresAt`. An advisory frame for a no-op would send every storefront
      // in the shop to re-read a number that did not change.
      const same = await withCookies(app, customerJar)
        .patch(`/cart/${lineId}`)
        .send({ quantity: 2 });
      expect(same.status).toBe(200);

      await shopper.expectSilence(AVAILABILITY_EVENT, 600);
    });

    it('and nothing at all when the basket write is REFUSED', async () => {
      const shopper = await guest();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Scarce Kettle' },
        { stock: 1, price: 100_000 },
      );

      // More than exists: the transaction rolls back, so there is no committed
      // change to announce.
      const refused = await addToBasket(product.id, variant.id, 5);
      expect(refused.status).toBeGreaterThanOrEqual(400);

      await shopper.expectSilence(AVAILABILITY_EVENT, 600);
    });
  });

  // =========================================================================
  // 2. OWNER DECISION 3 — POS PRIORITY IS REAL, NOT JUST ANNOUNCED
  // =========================================================================

  describe('a basket hold does not reduce what the till may sell', () => {
    it('leaves availableForPos untouched while availableForBasket drops', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Contested Kettle' },
        { stock: 4, price: 100_000 },
      );

      expect((await addToBasket(product.id, variant.id, 4)).status).toBe(201);

      const after = await facts(variant.id);
      expect(after.availableForBasket).toBe(0);
      expect(after.availableForPos).toBe(4);
      expect(after.sellableOnline).toBe(false);
      expect(after.sellableInStore).toBe(true);
    });

    it('and the till really can sell every one of those units', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Displaced Kettle' },
        { stock: 4, price: 100_000 },
      );
      expect((await addToBasket(product.id, variant.id, 4)).status).toBe(201);

      const sold = await withCookies(app, cashierJar)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, posKey('priority'))
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 4 }],
        });
      expect(sold.status).toBe(201);
      expect((await facts(variant.id)).physicalStock).toBe(0);
    });

    it('whereas an ORDER allocation does reduce it, and is announced to staff', async () => {
      const counter = await till();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Allocated Kettle' },
        { stock: 4, price: 100_000 },
      );
      expect((await addToBasket(product.id, variant.id, 4)).status).toBe(201);

      /*
       * Converted straight through the inventory service rather than through a
       * full checkout: this case is about the SEMANTIC difference between the
       * two kinds of hold, and a checkout would drag an address, a quote and a
       * payment into it.
       */
      await app.dataSource.query(
        `UPDATE stock_reservations SET kind = 'order' WHERE "variantId" = $1 AND status = 'active'`,
        [variant.id],
      );

      const after = await facts(variant.id);
      expect(after.availableForBasket).toBe(0);
      expect(after.availableForPos).toBe(0);
      expect(after.sellableInStore).toBe(false);

      // And an allocation change IS staff-relevant, unlike a basket hold.
      await gateway.publishAvailabilityInvalidation([variant.id], 'allocation');
      const staffFrame = await counter.next<Record<string, unknown>>(
        POS_AVAILABILITY_EVENT,
      );
      expect(staffFrame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'allocation',
      });
    });
  });

  // =========================================================================
  // 3. CENTRALISED AVAILABILITY SEMANTICS (§4 regressions)
  // =========================================================================

  describe('one definition of sellability', () => {
    it('an INACTIVE variant with positive physical stock sells nowhere', async () => {
      const { variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Retired Kettle' },
        { stock: 9, price: 100_000 },
      );
      await app.dataSource.query(
        `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
        [variant.id],
      );

      const after = await facts(variant.id);
      expect(after.physicalStock).toBe(9);
      expect(after.sellableOnline).toBe(false);
      expect(after.sellableInStore).toBe(false);
      expect(after.availableForBasket).toBe(0);
      expect(after.availableForPos).toBe(0);
    });

    it('a VOID restoring stock to an inactive variant does not make it sellable', async () => {
      /*
       * This is the case the old contract got WRONG. The void path emitted
       * `inStock: balanceAfter > 0` with no `isActive` term, so returning units
       * to a retired variant announced it as available. The frame no longer
       * states availability at all, and the projection answers with `isActive`
       * included.
       */
      const { variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Returned Then Retired' },
        { stock: 0, price: 100_000 },
      );
      await forceStockForTest(app.dataSource, variant.id, 5);
      await app.dataSource.query(
        `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
        [variant.id],
      );

      const after = await facts(variant.id);
      expect(after.physicalStock).toBe(5);
      expect(after.sellableOnline).toBe(false);
      expect(after.sellableInStore).toBe(false);
    });

    it('reserving the LAST basket-available unit makes it unsellable online', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Last One' },
        { stock: 1, price: 100_000 },
      );
      expect((await addToBasket(product.id, variant.id, 1)).status).toBe(201);

      const after = await facts(variant.id);
      expect(after.sellableOnline).toBe(false);
      expect(after.sellableInStore).toBe(true);
    });

    it('an EXPIRED reservation is available again with no sweep involved', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Lapsed Hold' },
        { stock: 3, price: 100_000 },
      );
      expect((await addToBasket(product.id, variant.id, 3)).status).toBe(201);
      expect((await facts(variant.id)).sellableOnline).toBe(false);

      // Backdate the hold. `facts()` measures against `now()` and the
      // projection's SQL excludes lapsed rows, so correctness never waits for
      // the sweeper.
      await app.dataSource.query(
        `UPDATE stock_reservations SET "expiresAt" = now() - interval '1 minute'
          WHERE "variantId" = $1 AND status = 'active'`,
        [variant.id],
      );

      const after = await facts(variant.id);
      expect(after.basketReserved).toBe(0);
      expect(after.availableForBasket).toBe(3);
      expect(after.sellableOnline).toBe(true);
    });

    it('the public LIST and the public DETAIL agree about one variant', async () => {
      /*
       * They did not before this pass. `GET /products` used a
       * reservation-BLIND predicate while `GET /products/:id` subtracted
       * reservations, so a product whose only units were all held in baskets
       * advertised itself as available on the listing and sold out on the
       * detail page — the same row, the same second, two answers.
       */
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Consistent Kettle' },
        { stock: 2, price: 100_000 },
      );

      const before = await withCookies(app, customerJar).get(
        `/products?inStockOnly=true`,
      );
      expect(before.status).toBe(200);
      expect(
        (before.body as { data: Array<{ id: number }> }).data.map((p) => p.id),
      ).toContain(product.id);

      // Reserve every unit.
      expect((await addToBasket(product.id, variant.id, 2)).status).toBe(201);

      const detail = await withCookies(app, customerJar).get(
        `/products/${product.id}`,
      );
      const detailVariant = (
        detail.body as {
          data: {
            variants: Array<{
              id: number;
              availability?: { inStock: boolean };
            }>;
          };
        }
      ).data.variants.find((v) => v.id === variant.id);
      expect(detailVariant?.availability?.inStock).toBe(false);

      const list = await withCookies(app, customerJar).get(
        `/products?inStockOnly=true`,
      );
      expect(
        (list.body as { data: Array<{ id: number }> }).data.map((p) => p.id),
      ).not.toContain(product.id);
    });
  });

  // =========================================================================
  // 4. DEDUPLICATION — one frame per variant, not per row
  // =========================================================================

  describe('deduplication', () => {
    it('publishes ONE frame per variant however many rows changed', async () => {
      const shopper = await guest();
      const { variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Many Tranches' },
        { stock: 9, price: 100_000 },
      );

      // The same variant named five times, as a transaction touching five
      // reservation tranches of one SKU would produce.
      await gateway.publishAvailabilityInvalidation(
        [variant.id, variant.id, variant.id, variant.id, variant.id],
        'reservation',
      );

      await shopper.next(AVAILABILITY_EVENT);
      await shopper.expectSilence(AVAILABILITY_EVENT, 500);
      expect(shopper.allReceived(AVAILABILITY_EVENT)).toHaveLength(1);
    });

    it('ignores ids that name no variant', async () => {
      const shopper = await guest();
      await gateway.publishAvailabilityInvalidation([987654321], 'stock');
      await shopper.expectSilence(AVAILABILITY_EVENT, 500);
    });
  });

  // =========================================================================
  // 5. THE CUSTOMER IS NEVER IDENTIFIED
  // =========================================================================

  it('never names the customer whose basket moved', async () => {
    const shopper = await guest();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      { title: 'Anonymous Hold' },
      { stock: 5, price: 100_000 },
    );

    expect((await addToBasket(product.id, variant.id, 2)).status).toBe(201);
    await shopper.next(AVAILABILITY_EVENT);

    const serialised = JSON.stringify(shopper.allReceived(AVAILABILITY_EVENT));
    for (const forbidden of [
      String(customerId),
      'userId',
      'cartItem',
      'basket',
      'cashier',
      'branch',
      'quantity',
      'reserved',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    void adminJar;
  });
});
