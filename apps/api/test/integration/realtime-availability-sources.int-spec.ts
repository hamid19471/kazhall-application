import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { StockAdjustModeDto } from 'src/modules/products/dto/adjust-stock.dto';
import { ReservationSweeperService } from 'src/modules/inventory/reservation-sweeper.service';
import {
  AVAILABILITY_EVENT,
  POS_AVAILABILITY_EVENT,
  STOCK_EVENT,
} from 'src/modules/realtime/realtime.gateway';

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
import {
  connectRealtime,
  type TestRealtimeClient,
} from './support/realtime-client';

/**
 * ===========================================================================
 * EVERY SOURCE OF AN AVAILABILITY CHANGE MUST ANNOUNCE ITSELF
 * ===========================================================================
 *
 * A POS sale already did. Three other things that change what the shop can
 * sell did NOT, and each gap had the same shape: physical stock or sellability
 * moved, the transaction committed, and no socket heard anything until its next
 * poll or page load.
 *
 *  1. An ADMIN STOCK ADJUSTMENT. The owner's journey is explicit about this
 *     one: an administrator corrects a count and a till must see it.
 *  2. A RESERVATION EXPIRY. Holds lapse, `availableForBasket` rises, and a
 *     variant that showed "sold out" to another shopper is buyable again.
 *  3. A VARIANT RETIREMENT. A SKU leaves sale while a storefront has it open
 *     and addable.
 *
 * ## The room problem this file also pins
 *
 * `stock:updated` is scoped to `admins` ∪ `branch:<id>`. None of the three
 * above belongs to a till, so all three carry `branchId: null` — which, per
 * `emitStockEvent`, means a SMALLER audience (`admins` only), never a fallback
 * to everyone. A POS socket sits in `branch:<id>` and NOT in `admins`, so it
 * cannot receive them.
 *
 * That is why the till subscribes to `availability:updated` as well, and why
 * these cases assert the till hears the global frame and NOT the exact count.
 * Getting this wrong in the obvious direction — widening `stock:updated` to
 * reach tills — would hand an exact quantity to every storefront customer too.
 */
describe('realtime availability sources', () => {
  let app: TestApp;
  let sweeper: ReservationSweeperService;
  let open: TestRealtimeClient[] = [];

  let adminJar: CookieJar;
  let cashierJar: CookieJar;
  let customerJar: CookieJar;
  let customerId: number;

  async function socketFor(
    jar: CookieJar,
    audience: 'storefront' | 'admin' | 'pos',
  ): Promise<TestRealtimeClient> {
    const client = await connectRealtime({
      server: app.server,
      cookie: jar.header(),
      audience,
    });
    open.push(client);
    return client;
  }

  beforeAll(async () => {
    app = await createTestApp();
    sweeper = app.app.get(ReservationSweeperService);
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
    const admin = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    adminJar = await authenticate(app, admin.username, admin.password, 'admin');

    const cashier = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    cashierJar = await authenticate(
      app,
      cashier.username,
      cashier.password,
      'pos',
    );

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
  });

  afterEach(async () => {
    await Promise.all(open.map((client) => client.close()));
    open = [];
  });

  const physicalStock = async (variantId: number): Promise<number> => {
    const rows: Array<{ stock: string }> = await app.dataSource.query(
      'SELECT stock FROM product_variants WHERE id = $1',
      [variantId],
    );
    return Number(rows[0]?.stock ?? NaN);
  };

  // =========================================================================
  // 1. Admin stock adjustment
  // =========================================================================

  describe('an admin stock adjustment', () => {
    it('reaches a TILL on the STAFF availability room, no global frame involved', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Counted Kettle' },
        { stock: 10, price: 100_000 },
      );

      const till = await socketFor(cashierJar, 'pos');
      const console_ = await socketFor(adminJar, 'admin');

      const response = await withCookies(app, adminJar)
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .send({
          mode: StockAdjustModeDto.DELTA,
          value: -6,
          reason: 'stock count correction',
        });
      expect(response.status).toBe(201);

      // The till hears the customer-safe frame...
      /*
       * THE WORKAROUND THIS REPLACES.
       *
       * An administrator's correction carries no branch, so `stock:updated`
       * reaches the super-admin room only and never the branch room a cashier
       * sits in. The till therefore used to subscribe to the CUSTOMER-facing
       * global broadcast to learn about it.
       *
       * It now has a staff room of its own that is not branch-scoped — because
       * physical stock is one number for the whole business — so the till
       * learns from a staff frame, and the global broadcast is gone entirely.
       */
      const frame = await till.next<Record<string, unknown>>(
        POS_AVAILABILITY_EVENT,
      );
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'stock',
      });

      // ...and NOT the exact count, because it is not in `admins` and this
      // adjustment belongs to no branch.
      await till.expectSilence(STOCK_EVENT, 750);

      // The admin console, which IS in `admins`, gets the committed figure.
      const staffFrame = await console_.next<{
        variantId: number;
        newStock: number;
        branchId: number | null;
      }>(STOCK_EVENT);
      expect(staffFrame).toEqual({
        variantId: variant.id,
        newStock: 4,
        branchId: null,
      });
      expect(await physicalStock(variant.id)).toBe(4);
    });

    it('announces the variant when a correction empties it', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Emptied Kettle' },
        { stock: 3, price: 100_000 },
      );
      const shopper = await socketFor(customerJar, 'storefront');

      const response = await withCookies(app, adminJar)
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .send({ mode: StockAdjustModeDto.SET, value: 0, reason: 'shrinkage' });
      expect(response.status).toBe(201);

      // The frame no longer states a result in either direction: it names what
      // went stale and the client asks. See `AvailabilityInvalidatedPayload`.
      // it must be derived from the committed balance — not from the request.
      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'stock',
      });
      expect(await physicalStock(variant.id)).toBe(0);
    });

    it('announces NOTHING when the adjustment is refused', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Held Kettle' },
        { stock: 5, price: 100_000 },
      );
      // The customer holds 5 of the 5 units.
      const added = await withCookies(app, customerJar)
        .post('/cart')
        .send({ productId: product.id, variantId: variant.id, quantity: 5 });
      expect([200, 201]).toContain(added.status);

      const shopper = await socketFor(customerJar, 'storefront');
      const console_ = await socketFor(adminJar, 'admin');

      // Below what is reserved, without the override: 409, transaction rolled
      // back, nothing committed and therefore nothing to announce.
      const refused = await withCookies(app, adminJar)
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .send({ mode: StockAdjustModeDto.SET, value: 1, reason: 'typo' });
      expect(refused.status).toBe(409);

      // An increase is refused too (it needs a costed receipt): same outcome.
      const increase = await withCookies(app, adminJar)
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .send({ mode: StockAdjustModeDto.DELTA, value: 2, reason: 'found' });
      expect(increase.status).toBe(409);
      expect(increase.body.error).toBe('STOCK_INCREASE_REQUIRES_RECEIPT');

      await shopper.expectSilence(AVAILABILITY_EVENT, 750);
      await console_.expectSilence(STOCK_EVENT, 750);
      expect(await physicalStock(variant.id)).toBe(5);
    });
  });

  // =========================================================================
  // 2. Reservation expiry
  // =========================================================================

  describe('a lapsed reservation', () => {
    it('announces that the variant is buyable again, after the sweep commits', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Lapsing Kettle' },
        { stock: 2, price: 100_000 },
      );
      const added = await withCookies(app, customerJar)
        .post('/cart')
        .send({ productId: product.id, variantId: variant.id, quantity: 2 });
      expect([200, 201]).toContain(added.status);

      // Age the hold past its deadline. The sweeper's TIMER is disarmed under
      // test on purpose; `runOnce()` is the deterministic equivalent and is the
      // same code path.
      await app.dataSource.query(
        `UPDATE stock_reservations
            SET "expiresAt" = NOW() - INTERVAL '1 hour'
          WHERE "variantId" = $1 AND status = 'active'`,
        [variant.id],
      );

      const shopper = await socketFor(customerJar, 'storefront');
      const result = await sweeper.runOnce();
      expect(result.releasedReservations).toBeGreaterThan(0);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      // Physical stock never moved — an expiry releases a HOLD — so the reason
      // is `reservation`, which is deliberately NOT published to staff: POS
      // outranks basket holds, so the till's sellable number did not change.
      // is still true. The frame's job is to say "re-read me", and the
      // authoritative read is what reports the freed units.
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'reservation',
      });

      const cart = await withCookies(app, customerJar).get('/cart');
      expect(cart.status).toBe(200);
      const everything = [...cart.body.data, ...cart.body.notices] as Array<{
        variant: { id: number } | null;
        change: { reason: string } | null;
      }>;
      const touched = everything.find((l) => l.variant?.id === variant.id);
      expect(touched?.change).toMatchObject({ reason: 'reservation_expired' });
    });

    it('announces one frame per VARIANT, not one per displaced line', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Shared Kettle' },
        { stock: 6, price: 100_000 },
      );

      // Two shoppers, both holding the same SKU.
      const second = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const secondJar = await authenticate(
        app,
        second.username,
        second.password,
        'storefront',
      );
      for (const jar of [customerJar, secondJar]) {
        const added = await withCookies(app, jar)
          .post('/cart')
          .send({ productId: product.id, variantId: variant.id, quantity: 2 });
        expect([200, 201]).toContain(added.status);
      }

      await app.dataSource.query(
        `UPDATE stock_reservations
            SET "expiresAt" = NOW() - INTERVAL '1 hour'
          WHERE "variantId" = $1 AND status = 'active'`,
        [variant.id],
      );

      const shopper = await socketFor(customerJar, 'storefront');
      await sweeper.runOnce();

      await shopper.next(AVAILABILITY_EVENT);
      // Ten shoppers losing holds on one SKU is ONE fact about that SKU.
      // Broadcasting it per line would put a multiple of the sweep batch onto
      // every connected socket in the shop.
      await shopper.expectSilence(AVAILABILITY_EVENT, 750);
    });

    it('announces nothing when the sweep finds nothing due', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Fresh Kettle' },
        { stock: 4, price: 100_000 },
      );
      const added = await withCookies(app, customerJar)
        .post('/cart')
        .send({ productId: product.id, variantId: variant.id, quantity: 2 });
      expect([200, 201]).toContain(added.status);

      const shopper = await socketFor(customerJar, 'storefront');
      const result = await sweeper.runOnce();
      expect(result.releasedReservations).toBe(0);

      await shopper.expectSilence(AVAILABILITY_EVENT, 750);
    });
  });

  // =========================================================================
  // 3. Variant retirement
  // =========================================================================

  describe('retiring a variant', () => {
    it('announces a retirement even though the units are still on the shelf', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Retired Kettle' },
        { stock: 12, price: 100_000 },
      );
      const shopper = await socketFor(customerJar, 'storefront');

      const response = await withCookies(app, adminJar)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: false }] });
      expect(response.status).toBe(200);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      // Twelve units exist and NONE of them can be sold. A frame derived from
      // the number alone would say `true` — true about the stockroom and false
      // about the shop, and this event is about the shop.
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'catalogue',
      });
      expect(await physicalStock(variant.id)).toBe(12);
    });

    it('announces again when the variant comes back', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Returning Kettle' },
        { stock: 12, price: 100_000 },
      );
      await withCookies(app, adminJar)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: false }] })
        .expect(200);

      const shopper = await socketFor(customerJar, 'storefront');
      const response = await withCookies(app, adminJar)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: true }] });
      expect(response.status).toBe(200);

      const frame =
        await shopper.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'catalogue',
      });
    });

    it('carries no more than two catalogue ids and a reason, on any of these paths', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Audited Kettle' },
        { stock: 3, price: 100_000 },
      );
      const shopper = await socketFor(customerJar, 'storefront');

      await withCookies(app, adminJar)
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .send({ mode: StockAdjustModeDto.DELTA, value: -1, reason: 'recount' })
        .expect(201);
      await withCookies(app, adminJar)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: false }] })
        .expect(200);

      await shopper.next(AVAILABILITY_EVENT);
      await shopper.next(AVAILABILITY_EVENT);

      for (const frame of shopper.allReceived(AVAILABILITY_EVENT)) {
        expect(Object.keys(frame as object).sort()).toEqual([
          'productId',
          'reason',
          'variantId',
        ]);
      }
      // The actor is an administrator; nothing about them may travel on a
      // channel every retail customer is listening to.
      const serialised = JSON.stringify(
        shopper.allReceived(AVAILABILITY_EVENT),
      );
      expect(serialised).not.toContain('recount');
      expect(serialised).not.toContain(String(customerId));
    });
  });
});
