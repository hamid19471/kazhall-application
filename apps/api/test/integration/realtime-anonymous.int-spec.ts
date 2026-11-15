import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { POS_IDEMPOTENCY_HEADER } from 'src/modules/orders/idempotency.helper';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  AVAILABILITY_EVENT,
  POS_AVAILABILITY_EVENT,
  ROOM_PUBLIC_AVAILABILITY,
  ROOM_STAFF_AVAILABILITY,
  ROOM_SUPER_ADMIN,
  RealtimeGateway,
  STOCK_EVENT,
  branchRoom,
  userRoom,
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
import { posKey } from './support/pos.fixtures';
import {
  attemptRealtime,
  connectRealtime,
  type TestRealtimeClient,
} from './support/realtime-client';

/**
 * ===========================================================================
 * THE ANONYMOUS PUBLIC STOREFRONT SOCKET
 * ===========================================================================
 *
 * THE REQUIREMENT: a shop's catalogue and product pages are public, so a
 * visitor who has not signed in must still see a variant sell out. Before this
 * they could not — the gateway refused every unauthenticated handshake, and the
 * anonymous session probe additionally signed the client out, which stopped the
 * polling fallback too. Guests got nothing at all.
 *
 * THE DANGER, and what this file is really for: "accept unauthenticated
 * sockets" is one bad decision away from "leak staff data to the internet". So
 * every boundary is asserted here rather than reasoned about:
 *
 *  - an anonymous socket is allowed on the STOREFRONT only;
 *  - it joins exactly ONE room and never a user, branch, admin or staff room;
 *  - it receives the public invalidation and NOTHING else — no exact stock, no
 *    order lifecycle, no other customer's notices;
 *  - a BAD credential is never silently downgraded into an anonymous socket,
 *    which is the failure mode that would turn every authentication error into
 *    a quiet success.
 */
describe('anonymous storefront realtime', () => {
  let app: TestApp;
  let gateway: RealtimeGateway;
  let open: TestRealtimeClient[] = [];

  /** An anonymous socket: storefront audience, NO cookie header at all. */
  async function anonymous(): Promise<TestRealtimeClient> {
    const client = await connectRealtime({
      server: app.server,
      audience: 'storefront',
    });
    open.push(client);
    await awaitRegistration(client);
    return client;
  }

  async function authenticated(
    jar: CookieJar,
    audience: 'storefront' | 'admin' | 'pos',
  ): Promise<TestRealtimeClient> {
    const client = await connectRealtime({
      server: app.server,
      cookie: jar.header(),
      audience,
    });
    open.push(client);
    await awaitRegistration(client);
    return client;
  }

  /**
   * Wait until the SERVER has finished the handshake, not just the client.
   *
   * `connect` fires as soon as the transport is up while `handleConnection` is
   * still joining rooms, so a room-scoped assertion made too early fails for a
   * reason unrelated to what it is testing. Bounded deadline, observable
   * state, no sleep.
   */
  async function awaitRegistration(client: TestRealtimeClient): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const sockets = await gateway.server.fetchSockets();
      const mine = sockets.find((socket) => socket.id === client.socket.id);
      // Every socket this gateway accepts lands in at least one room besides
      // its own id, so room membership is the observable "fully registered".
      if (mine && [...mine.rooms].length > 1) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `socket ${client.socket.id ?? '?'} was never registered by the gateway`,
    );
  }

  const roomsOf = async (client: TestRealtimeClient): Promise<string[]> => {
    const sockets = await gateway.server.fetchSockets();
    const mine = sockets.find((socket) => socket.id === client.socket.id);
    return [...(mine?.rooms ?? [])].filter((room) => room !== client.socket.id);
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
  });

  afterEach(async () => {
    await Promise.all(open.map((client) => client.close()));
    open = [];
  });

  // =========================================================================
  // 1. ACCEPTANCE — and only where it is allowed
  // =========================================================================

  describe('acceptance', () => {
    it('accepts a storefront handshake with no credential at all', async () => {
      const guest = await anonymous();
      expect(guest.connected).toBe(true);
    });

    it('puts it in the public availability room and NOTHING else', async () => {
      const guest = await anonymous();
      expect(await roomsOf(guest)).toEqual([ROOM_PUBLIC_AVAILABILITY]);
    });

    it('records no principal on the socket: no user, no roles, no branch, no token', async () => {
      const guest = await anonymous();
      const sockets = await gateway.server.fetchSockets();
      const mine = sockets.find(
        (socket) => socket.id === guest.socket.id,
      ) as unknown as { data: Record<string, unknown> };

      expect(mine.data).toEqual({ kind: 'anonymous', audience: 'storefront' });
      // Stated separately so a future field cannot slip in unnoticed.
      for (const key of [
        'userId',
        'roles',
        'permissions',
        'branchId',
        'token',
      ]) {
        expect(mine.data).not.toHaveProperty(key);
      }
    });

    it('refuses an anonymous POS handshake', async () => {
      const attempt = await attemptRealtime({
        server: app.server,
        audience: 'pos',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });

    it('refuses an anonymous ADMIN handshake', async () => {
      const attempt = await attemptRealtime({
        server: app.server,
        audience: 'admin',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });

    it('refuses an anonymous handshake naming an audience that does not exist', async () => {
      const attempt = await attemptRealtime({
        server: app.server,
        audience: 'not-a-surface',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });
  });

  // =========================================================================
  // 2. NO SILENT DOWNGRADE — the boundary that matters most
  // =========================================================================

  describe('a bad credential is never downgraded to anonymous', () => {
    /*
     * Each case supplies a storefront cookie that is PRESENT and WRONG. The
     * required outcome is a refusal, never a public socket: if any of these
     * became anonymous, every authentication failure in the system would turn
     * into a quiet success, and the difference between "signed out" and
     * "rejected" would stop existing.
     */
    it('refuses a malformed storefront token', async () => {
      const attempt = await attemptRealtime({
        server: app.server,
        cookie: 'kz_storefront_access=not-a-jwt',
        audience: 'storefront',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });

    it('refuses a storefront cookie signed with the wrong secret', async () => {
      const attempt = await attemptRealtime({
        server: app.server,
        cookie:
          'kz_storefront_access=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEsInR5cCI6ImFjY2VzcyIsImF1ZCI6InN0b3JlZnJvbnQiLCJwdiI6MX0.wrong-signature',
        audience: 'storefront',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });

    it('refuses a storefront session whose account has been deactivated', async () => {
      const site = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const jar = await authenticate(
        app,
        site.username,
        site.password,
        'storefront',
      );
      await app.dataSource.query(
        'UPDATE users SET "deactivatedAt" = now() WHERE id = $1',
        [site.user.id],
      );

      const attempt = await attemptRealtime({
        server: app.server,
        cookie: jar.header(),
        audience: 'storefront',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });

    it('refuses a POS cookie presented on the storefront audience', async () => {
      const branch = await createBranch(app.dataSource);
      const sale = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const posJar = await authenticate(
        app,
        sale.username,
        sale.password,
        'pos',
      );

      /*
       * The POS cookie is named `kz_pos_access`, so a storefront handshake
       * reads `kz_storefront_access`, finds nothing, and legitimately becomes
       * ANONYMOUS. That is correct — the visitor supplied no storefront
       * credential — and the point of this case is what the anonymous socket
       * then gets: the public room only, never the cashier's branch room,
       * even though the browser is holding a live till session.
       */
      const client = await connectRealtime({
        server: app.server,
        cookie: posJar.header(),
        audience: 'storefront',
      });
      open.push(client);
      await awaitRegistration(client);

      expect(await roomsOf(client)).toEqual([ROOM_PUBLIC_AVAILABILITY]);
      expect(await roomsOf(client)).not.toContain(branchRoom(branch.id));
      expect(await roomsOf(client)).not.toContain(userRoom(sale.user.id));
    });
  });

  // =========================================================================
  // 3. WHAT AN ANONYMOUS SOCKET CAN AND CANNOT RECEIVE
  // =========================================================================

  describe('event isolation', () => {
    it('receives the public availability invalidation, with no quantity and no identity', async () => {
      const guest = await anonymous();
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Public Kettle' },
        { stock: 4, price: 100_000 },
      );

      await gateway.publishAvailabilityInvalidation([variant.id], 'stock');

      const frame =
        await guest.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(Object.keys(frame).sort()).toEqual([
        'productId',
        'reason',
        'variantId',
      ]);
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'stock',
      });
    });

    it('never receives the STAFF availability frame', async () => {
      const guest = await anonymous();
      const { variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Staff Only' },
        { stock: 4, price: 100_000 },
      );

      await gateway.publishAvailabilityInvalidation([variant.id], 'stock');

      // The public twin arrives, proving the publish happened at all...
      await guest.next(AVAILABILITY_EVENT);
      // ...and its staff counterpart does not.
      await guest.expectSilence(POS_AVAILABILITY_EVENT, 400);
    });

    it('never receives an exact stock count', async () => {
      const guest = await anonymous();
      gateway.emitStockEvent({ variantId: 1, newStock: 77, branchId: null });
      gateway.emitStockEvent({ variantId: 1, newStock: 77, branchId: 5 });
      await guest.expectSilence(STOCK_EVENT, 400);
    });

    it('never receives an order lifecycle event', async () => {
      const guest = await anonymous();
      gateway.emitOrderEvent('order.created', {
        orderId: 1,
        branchId: null,
        totalPrice: 500,
        cashierUserId: 9,
      });
      gateway.emitOrderEvent('order.status.updated', {
        orderId: 1,
        status: 'PAID',
        branchId: 5,
      });
      gateway.emitOrderEvent('order.awaiting_stock', { orderId: 1 });
      for (const event of [
        'order.created',
        'order.status.updated',
        'order.awaiting_stock',
      ]) {
        await guest.expectSilence(event, 200);
      }
    });

    it("never receives another customer's own-room notice", async () => {
      const guest = await anonymous();
      const site = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });

      gateway.emitToUser(site.user.id, 'order.status.updated', {
        orderId: 3,
        status: 'PAID',
      });

      await guest.expectSilence('order.status.updated', 400);
    });

    it('is not in any room a staff frame is addressed to', async () => {
      const guest = await anonymous();
      const rooms = await roomsOf(guest);
      for (const staffRoom of [
        ROOM_SUPER_ADMIN,
        ROOM_STAFF_AVAILABILITY,
        branchRoom(1),
        userRoom(1),
      ]) {
        expect(rooms).not.toContain(staffRoom);
      }
    });
  });

  // =========================================================================
  // 4. THE END-TO-END POINT OF THE WHOLE FEATURE
  // =========================================================================

  describe('a till sale reaches an anonymous visitor', () => {
    it('announces the exact variant, with no reload and no poll', async () => {
      const guest = await anonymous();

      const branch = await createBranch(app.dataSource);
      const sale = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const cashierJar = await authenticate(
        app,
        sale.username,
        sale.password,
        'pos',
      );
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Anonymous Witness' },
        { stock: 3, price: 250_000 },
      );

      const sold = await withCookies(app, cashierJar)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, posKey('anon'))
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 3 }],
        });
      expect(sold.status).toBe(201);

      const frame =
        await guest.next<Record<string, unknown>>(AVAILABILITY_EVENT);
      expect(frame).toEqual({
        variantId: variant.id,
        productId: product.id,
        reason: 'stock',
      });
    });

    it('does not announce a variant the sale did not touch', async () => {
      const guest = await anonymous();
      const branch = await createBranch(app.dataSource);
      const sale = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const cashierJar = await authenticate(
        app,
        sale.username,
        sale.password,
        'pos',
      );
      const sold = await createProductWithVariant(
        app.dataSource,
        { title: 'Sold' },
        { stock: 2, price: 100_000 },
      );
      const untouched = await createProductWithVariant(
        app.dataSource,
        { title: 'Untouched' },
        { stock: 2, price: 100_000 },
      );

      const response = await withCookies(app, cashierJar)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, posKey('anon-iso'))
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: sold.variant.id, quantity: 1 }],
        });
      expect(response.status).toBe(201);

      await guest.next(AVAILABILITY_EVENT);
      const seen = guest
        .allReceived(AVAILABILITY_EVENT)
        .map((frame) => (frame as { variantId: number }).variantId);
      expect(seen).toContain(sold.variant.id);
      expect(seen).not.toContain(untouched.variant.id);
    });
  });

  // =========================================================================
  // 5. UPGRADE AND DOWNGRADE
  // =========================================================================

  describe('signing in is an upgrade, not a different world', () => {
    it('gives a signed-in customer the SAME public room, plus their own', async () => {
      const site = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const jar = await authenticate(
        app,
        site.username,
        site.password,
        'storefront',
      );

      const signedIn = await authenticated(jar, 'storefront');

      expect((await roomsOf(signedIn)).sort()).toEqual(
        [ROOM_PUBLIC_AVAILABILITY, userRoom(site.user.id)].sort(),
      );
    });

    it('so one publish reaches an anonymous visitor and a customer alike', async () => {
      const guest = await anonymous();
      const site = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const jar = await authenticate(
        app,
        site.username,
        site.password,
        'storefront',
      );
      const signedIn = await authenticated(jar, 'storefront');

      const { variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Both' },
        { stock: 5, price: 100_000 },
      );
      await gateway.publishAvailabilityInvalidation(
        [variant.id],
        'reservation',
      );

      const forGuest = await guest.next<{ variantId: number }>(
        AVAILABILITY_EVENT,
      );
      const forCustomer = await signedIn.next<{ variantId: number }>(
        AVAILABILITY_EVENT,
      );
      expect(forGuest.variantId).toBe(variant.id);
      expect(forCustomer.variantId).toBe(variant.id);
    });
  });
});
