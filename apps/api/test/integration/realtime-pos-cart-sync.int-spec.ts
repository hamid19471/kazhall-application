import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { POS_IDEMPOTENCY_HEADER } from 'src/modules/orders/idempotency.helper';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  AVAILABILITY_EVENT,
  ROOM_PUBLIC_AVAILABILITY,
  ROOM_SUPER_ADMIN,
  RealtimeGateway,
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
import { posKey } from './support/pos.fixtures';
import {
  connectRealtime,
  attemptRealtime,
  type TestRealtimeClient,
} from './support/realtime-client';

/**
 * ===========================================================================
 * REAL-TIME WEB/POS INVENTORY AND BASKET SYNCHRONISATION
 * ===========================================================================
 *
 * THE REQUIREMENT, restated as something falsifiable: a customer with a cart
 * open and a tab they are not touching must see their basket change when a
 * cashier sells the units out from under them — without a reload, without a
 * focus event, without a polling tick.
 *
 * This file proves the SERVER half of that end to end, over a real socket,
 * with the real `socket.io-client` the browser runs. The browser half (the
 * coalescing, the ordering, the fallback state machine) is pinned by
 * `apps/web/lib/*.test.ts`, because those are pure client concerns and testing
 * them through a network would only make them flaky.
 *
 * ## What "no polling tick" means mechanically here
 *
 * Nothing in this file calls `GET /cart` on a timer, and nothing waits out an
 * interval hoping something happened. Each case connects a socket, performs an
 * HTTP action as somebody else, and AWAITS THE FRAME. The `GET /cart` that
 * follows is the reaction to the frame, which is exactly the sequence the
 * browser performs. If the gateway stopped emitting, these cases would fail on
 * a bounded deadline rather than pass more slowly.
 *
 * ## Why there is not one `sleep` in this file
 *
 * A sleep asserts "enough time passed", which is not the property under test
 * and is the property most likely to differ on CI. Every wait is either on an
 * observable frame with a deadline, or — for the cases that assert ABSENCE — a
 * bounded quiet period after which the receive buffer must still be empty.
 * `expectSilence` is the only wait with a duration in it, and it is the one
 * place a duration is the correct instrument.
 */

/** Bounded quiet period for "this must NOT arrive" assertions. */
const SILENCE_MS = 750;

interface CartLineBody {
  id: number;
  quantity: number;
  reservedQuantity: number;
  status: string;
  variant: { id: number } | null;
  change: { reason: string; quantityDelta: number | null } | null;
  tranches: Array<{ quantity: number; expiresAt: string | null }>;
  expiresAt: string | null;
}

/**
 * `notices` holds whole LINES whose `change` is non-null — the same
 * `CartLineView` shape as `data`, filtered differently
 * (`CartService.findAll`). A fully displaced line leaves `data` and appears
 * ONLY here, so `notices[].change.reason` is the single carrier of
 * `sold_in_store` in that case.
 */
interface CartBody {
  data: CartLineBody[];
  notices: CartLineBody[];
}

describe('realtime POS → cart synchronisation', () => {
  let app: TestApp;
  let gateway: RealtimeGateway;

  /** Every socket opened by the running case, closed in `afterEach`. */
  let open: TestRealtimeClient[] = [];

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
    await awaitServerRegistration(client);
    return client;
  }

  /**
   * WAIT FOR THE SERVER TO HAVE FINISHED THE HANDSHAKE, not just the client.
   *
   * `connect` fires on the client as soon as the transport is up. The gateway's
   * `handleConnection` is still running at that instant: it verifies the JWT,
   * LOADS THE USER FROM THE DATABASE, stamps `socket.data`, and only then
   * joins the rooms. So for a short window a socket is connected and carries
   * an identity while belonging to no room but its own.
   *
   * That window is real in production too, and it is the reason the client
   * fires a `resync` on every connect: a room-scoped frame emitted inside it
   * is genuinely missed, and only an authoritative refetch recovers it. Here it
   * would simply make tests lie — a room-scoped assertion (`stock:updated` to
   * `branch:<id>`) or a room-scoped action (`disconnectUser`, which looks the
   * socket up by `user:<id>`) that ran inside the window would fail for a
   * reason unrelated to what it is testing.
   *
   * `socket.data` is written BEFORE the joins, so its presence is not enough.
   * This waits for the ROOMS the socket's own audience and principal imply,
   * derived from that data rather than from what the caller asked for — the
   * same rule the gateway used to grant them.
   *
   * Bounded deadline, observable state, no sleep: the same discipline as the
   * rest of this file.
   */
  async function awaitServerRegistration(
    client: TestRealtimeClient,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    let seen = 'nothing';

    while (Date.now() < deadline) {
      const sockets = await gateway.server.fetchSockets();
      const mine = sockets.find((socket) => socket.id === client.socket.id);
      const data = mine?.data as
        | {
            userId?: number;
            branchId?: number | null;
            audience?: string;
            roles?: string[];
          }
        | undefined;

      /*
       * An ANONYMOUS socket has no principal, so `data.userId` never arrives.
       * Its fully-registered state is the public room, which is the only room
       * it ever joins.
       */
      if (mine && (data as { kind?: string })?.kind === 'anonymous') {
        if (mine.rooms.has(ROOM_PUBLIC_AVAILABILITY)) return;
        seen = `anonymous, rooms=${JSON.stringify([...mine.rooms])}`;
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }

      if (mine && data?.userId !== undefined) {
        const required = [`user:${data.userId}`];
        if (data.audience === 'storefront') {
          required.push(ROOM_PUBLIC_AVAILABILITY);
        }
        if (data.audience === 'pos') {
          required.push('staff:availability');
        }
        if (data.audience === 'pos' && data.branchId != null) {
          required.push(`branch:${data.branchId}`);
        }
        if (
          data.audience === 'admin' &&
          (data.roles ?? []).includes(UserRoleEnum.superAdmin)
        ) {
          required.push(ROOM_SUPER_ADMIN);
          if (data.branchId != null) required.push(`branch:${data.branchId}`);
        }

        if (required.every((room) => mine.rooms.has(room))) return;
        seen = `rooms=${JSON.stringify([...mine.rooms])} required=${JSON.stringify(required)}`;
      }

      await new Promise((resolve) => setImmediate(resolve));
    }

    throw new Error(
      `socket ${client.socket.id ?? '?'} was never fully registered by the gateway (${seen})`,
    );
  }

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
    // EVERY socket, every time. A socket left open outlives the spec that made
    // it, keeps a connection against a DataSource the next `resetDb` is about
    // to TRUNCATE under, and shows up as an open handle at the end of the run.
    await Promise.all(open.map((client) => client.close()));
    open = [];
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  interface Scene {
    customerJar: CookieJar;
    customerId: number;
    cashierJar: CookieJar;
    cashierId: number;
    branchId: number;
    productId: number;
    variantId: number;
  }

  /**
   * A shopper holding `reserve` units of a variant with `stock` physical units,
   * and a cashier at a branch who can sell the same variant.
   */
  async function scene({
    stock = 10,
    reserve = 4,
  }: { stock?: number; reserve?: number } = {}): Promise<Scene> {
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

    const site = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const customerJar = await authenticate(
      app,
      site.username,
      site.password,
      'storefront',
    );

    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      { title: 'Reserved Kettle' },
      { stock, price: 500_000 },
    );

    if (reserve > 0) {
      const added = await withCookies(app, customerJar).post('/cart').send({
        productId: product.id,
        variantId: variant.id,
        quantity: reserve,
      });
      expect([200, 201]).toContain(added.status);
    }

    return {
      customerJar,
      customerId: site.user.id,
      cashierJar,
      cashierId: sale.user.id,
      branchId: branch.id,
      productId: product.id,
      variantId: variant.id,
    };
  }

  function sell(jar: CookieJar, variantId: number, quantity: number) {
    return withCookies(app, jar)
      .post('/orders/pos')
      .set(POS_IDEMPOTENCY_HEADER, posKey('rt'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variantId, quantity }],
      });
  }

  const readCart = async (jar: CookieJar): Promise<CartBody> => {
    const response = await withCookies(app, jar).get('/cart');
    expect(response.status).toBe(200);
    return response.body as CartBody;
  };

  const physicalStock = async (variantId: number): Promise<number> => {
    const rows: Array<{ stock: string }> = await app.dataSource.query(
      'SELECT stock FROM product_variants WHERE id = $1',
      [variantId],
    );
    return Number(rows[0]?.stock ?? NaN);
  };

  // =========================================================================
  // 1. THE HEADLINE JOURNEY
  // =========================================================================

  describe('a cart open on a socket, and a till sale', () => {
    it('reaches the customer as a frame, and the frame leads to sold_in_store — with no reload, no focus and no poll', async () => {
      // stock 10, this customer holds 4, so 6 units are free.
      const s = await scene({ stock: 10, reserve: 4 });
      const customer = await socketFor(s.customerJar, 'storefront');

      const before = await readCart(s.customerJar);
      expect(before.data).toHaveLength(1);
      expect(before.data[0].quantity).toBe(4);
      expect(before.data[0].change).toBeNull();

      // Selling 8 takes the 6 free units and must displace 2 of this
      // customer's 4.
      const sold = await sell(s.cashierJar, s.variantId, 8);
      expect(sold.status).toBe(201);

      // THE ONLY THING AWAITED. No timer, no visibility change, no refetch loop.
      const frame = await customer.next<{
        variantId: number;
        inStock: boolean;
      }>(AVAILABILITY_EVENT);
      expect(frame.variantId).toBe(s.variantId);

      // The frame is advisory. The truth comes from the authoritative read the
      // frame provokes — which is precisely what the browser does next.
      const after = await readCart(s.customerJar);
      const line = after.data.find((l) => l.variant?.id === s.variantId);
      expect(line).toBeDefined();
      expect(line!.quantity).toBe(2);
      expect(line!.reservedQuantity).toBe(2);
      expect(line!.change).toMatchObject({ reason: 'sold_in_store' });
      expect(line!.change!.quantityDelta).toBe(-2);
      expect(await physicalStock(s.variantId)).toBe(2);
    });

    it('carries NOTHING that identifies the cashier, the branch, the till or another basket', async () => {
      const s = await scene({ stock: 6, reserve: 3 });
      const customer = await socketFor(s.customerJar, 'storefront');

      expect((await sell(s.cashierJar, s.variantId, 5)).status).toBe(201);
      const frame =
        await customer.next<Record<string, unknown>>(AVAILABILITY_EVENT);

      // The WHOLE payload, exhaustively. `toMatchObject` would let a smuggled
      // `branchId` or `cashierUserId` through; `toEqual` on the key set cannot.
      expect(Object.keys(frame).sort()).toEqual([
        'productId',
        'reason',
        'variantId',
      ]);
      // Two catalogue identifiers and a coarse category. No boolean, and
      // therefore nothing the client could mistake for a business answer.
      expect(typeof frame.reason).toBe('string');

      const serialised = JSON.stringify(
        customer.allReceived(AVAILABILITY_EVENT),
      );
      for (const forbidden of [
        'branch',
        'cashier',
        'userId',
        'cartItem',
        'reservation',
        'orderId',
        'quantity',
      ]) {
        expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it('applies FULL displacement: the line is gone and the basket says why', async () => {
      const s = await scene({ stock: 10, reserve: 4 });
      const customer = await socketFor(s.customerJar, 'storefront');

      // Everything: 6 free plus all 4 of this customer's held units.
      expect((await sell(s.cashierJar, s.variantId, 10)).status).toBe(201);
      await customer.next(AVAILABILITY_EVENT);

      const after = await readCart(s.customerJar);
      const active = after.data.filter((l) => l.variant?.id === s.variantId);

      // The line is either absent or tombstoned — both are the documented
      // contract — but the REASON must survive either way, because a basket
      // that silently loses a line teaches a customer not to trust it.
      // The line has left `data`, so `notices` is the only thing that can
      // still say what happened to it — which is exactly why the storefront
      // has to read `notice.change`, not `notice`.
      expect(active).toHaveLength(0);
      const notice = after.notices.find((n) => n.variant?.id === s.variantId);
      expect(notice).toBeDefined();
      expect(notice!.status).toBe('removed');
      expect(notice!.quantity).toBe(0);
      expect(notice!.reservedQuantity).toBe(0);
      expect(notice!.change).toMatchObject({ reason: 'sold_in_store' });
      expect(notice!.change!.quantityDelta).toBe(-4);
      // No countdown may survive a line that no longer holds anything.
      expect(notice!.tranches).toEqual([]);
      expect(notice!.expiresAt).toBeNull();
      expect(await physicalStock(s.variantId)).toBe(0);
    });

    it('leaves the countdown structure consistent with the surviving quantity', async () => {
      const s = await scene({ stock: 10, reserve: 4 });
      const customer = await socketFor(s.customerJar, 'storefront');

      const before = await readCart(s.customerJar);
      const beforeTranches = before.data[0].tranches;
      expect(beforeTranches.reduce((sum, t) => sum + t.quantity, 0)).toBe(4);

      expect((await sell(s.cashierJar, s.variantId, 8)).status).toBe(201);
      await customer.next(AVAILABILITY_EVENT);

      const after = await readCart(s.customerJar);
      const line = after.data.find((l) => l.variant?.id === s.variantId)!;

      // Whatever the tranches now are, they must ADD UP to what is still held —
      // a countdown for units the customer no longer has is a deadline the UI
      // would keep ticking towards for nothing.
      expect(line.tranches.reduce((sum, t) => sum + t.quantity, 0)).toBe(
        line.reservedQuantity,
      );
      // And the line deadline must still be one of the surviving tranches.
      if (line.expiresAt !== null) {
        expect(line.tranches.map((t) => t.expiresAt)).toContain(line.expiresAt);
      }
    });
  });

  // =========================================================================
  // 2. ISOLATION — the frame must not move the wrong basket
  // =========================================================================

  describe('isolation', () => {
    it('does not touch a cart holding a DIFFERENT variant', async () => {
      const s = await scene({ stock: 10, reserve: 4 });

      // A second shopper, holding a different SKU entirely.
      const other = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const otherJar = await authenticate(
        app,
        other.username,
        other.password,
        'storefront',
      );
      const spare = await createProductWithVariant(
        app.dataSource,
        { title: 'Untouched Toaster' },
        { stock: 5, price: 200_000 },
      );
      const added = await withCookies(app, otherJar).post('/cart').send({
        productId: spare.product.id,
        variantId: spare.variant.id,
        quantity: 2,
      });
      expect([200, 201]).toContain(added.status);

      const otherBefore = await readCart(otherJar);
      expect((await sell(s.cashierJar, s.variantId, 10)).status).toBe(201);

      const otherAfter = await readCart(otherJar);
      expect(otherAfter.data).toHaveLength(1);
      expect(otherAfter.data[0].quantity).toBe(2);
      expect(otherAfter.data[0].change).toBeNull();
      expect(otherAfter.notices).toEqual([]);
      expect(otherAfter.data[0].reservedQuantity).toBe(
        otherBefore.data[0].reservedQuantity,
      );
      expect(await physicalStock(spare.variant.id)).toBe(5);
    });

    it('gives a STOREFRONT socket availability but never the exact stock count', async () => {
      const s = await scene({ stock: 6, reserve: 2 });
      const customer = await socketFor(s.customerJar, 'storefront');

      expect((await sell(s.cashierJar, s.variantId, 5)).status).toBe(201);
      await customer.next(AVAILABILITY_EVENT);

      // `stock:updated` carries `newStock`, an exact figure that every HTTP
      // route serving it gates behind `sale`/`super_admin`. A retail customer's
      // socket must not be the one place it leaks.
      await customer.expectSilence(STOCK_EVENT, SILENCE_MS);
      await customer.expectSilence('order.created', SILENCE_MS);
      await customer.expectSilence('order.status.updated', SILENCE_MS);
    });

    it('gives the selling branch’s POS socket the exact stock count', async () => {
      const s = await scene({ stock: 6, reserve: 2 });
      const till = await socketFor(s.cashierJar, 'pos');

      expect((await sell(s.cashierJar, s.variantId, 5)).status).toBe(201);

      const frame = await till.next<{ variantId: number; newStock: number }>(
        STOCK_EVENT,
      );
      expect(frame).toMatchObject({ variantId: s.variantId, newStock: 1 });
    });

    it('refuses a socket that names an audience it holds no cookie for', async () => {
      const s = await scene({ stock: 3, reserve: 0 });

      // The customer's browser holds ONLY the storefront cookie pair. Naming
      // `pos` selects a cookie that is not there, so there is no session at all
      // — the query parameter grants nothing.
      const attempt = await attemptRealtime({
        server: app.server,
        cookie: s.customerJar.header(),
        audience: 'pos',
      });
      expect(attempt.connected).toBe(false);
      await attempt.close();
    });

    it('keeps a storefront socket out of the branch room even when its owner is the cashier', async () => {
      // One person, two sessions, one browser: the rooms follow the SURFACE,
      // not the human.
      const branch = await createBranch(app.dataSource);
      const staff = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale, UserRoleEnum.site],
        branchId: branch.id,
      });
      const posJar = await authenticate(
        app,
        staff.username,
        staff.password,
        'pos',
      );
      const shopJar = await authenticate(
        app,
        staff.username,
        staff.password,
        'storefront',
      );

      const { variant } = await createProductWithVariant(
        app.dataSource,
        { title: 'Dual Session Widget' },
        { stock: 4, price: 100_000 },
      );

      const shopSocket = await socketFor(shopJar, 'storefront');
      const tillSocket = await socketFor(posJar, 'pos');

      expect((await sell(posJar, variant.id, 2)).status).toBe(201);

      await tillSocket.next(STOCK_EVENT);
      await shopSocket.next(AVAILABILITY_EVENT);
      await shopSocket.expectSilence(STOCK_EVENT, SILENCE_MS);
    });
  });

  // =========================================================================
  // 3. TRANSACTION BOUNDARIES — a rollback announces nothing
  // =========================================================================

  describe('transaction boundaries', () => {
    it('emits NO stock or availability frame when the sale is refused', async () => {
      const s = await scene({ stock: 4, reserve: 4 });
      const customer = await socketFor(s.customerJar, 'storefront');
      const till = await socketFor(s.cashierJar, 'pos');

      const stockBefore = await physicalStock(s.variantId);
      const cartBefore = await readCart(s.customerJar);

      // More than exists anywhere, held or free. The transaction rolls back.
      const refused = await sell(s.cashierJar, s.variantId, 99);
      expect(refused.status).toBeGreaterThanOrEqual(400);

      // Nothing committed, so nothing may be announced. A frame here would be
      // the exact defect the audit exists to rule out: a listener told to
      // re-read, re-reading, and caching a value that never existed.
      await customer.expectSilence(AVAILABILITY_EVENT, SILENCE_MS);
      await till.expectSilence(STOCK_EVENT, SILENCE_MS);
      await till.expectSilence('order.created', SILENCE_MS);

      expect(await physicalStock(s.variantId)).toBe(stockBefore);
      const cartAfter = await readCart(s.customerJar);
      expect(cartAfter.data[0].quantity).toBe(cartBefore.data[0].quantity);
      expect(cartAfter.data[0].change).toBeNull();
    });

    it('has already COMMITTED by the time the frame is observable', async () => {
      // The ordering rule, as an assertion rather than a comment: a listener
      // that reads the database the instant the frame lands must see the new
      // value, never the pre-commit one.
      const s = await scene({ stock: 9, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');

      expect((await sell(s.cashierJar, s.variantId, 4)).status).toBe(201);
      await customer.next(AVAILABILITY_EVENT);

      expect(await physicalStock(s.variantId)).toBe(5);
    });

    it('cannot drive stock negative when two tills sell the last units at once', async () => {
      const s = await scene({ stock: 5, reserve: 0 });
      const till = await socketFor(s.cashierJar, 'pos');

      const [a, b] = await Promise.all([
        sell(s.cashierJar, s.variantId, 4),
        sell(s.cashierJar, s.variantId, 4),
      ]);

      const statuses = [a.status, b.status].sort();
      // One wins, one is refused. Never two 201s against five units.
      expect(statuses.filter((code) => code === 201)).toHaveLength(1);
      expect(statuses.some((code) => code >= 400)).toBe(true);

      const remaining = await physicalStock(s.variantId);
      expect(remaining).toBe(1);
      expect(remaining).toBeGreaterThanOrEqual(0);

      // And exactly ONE committed announcement, matching the one commit.
      const frame = await till.next<{ newStock: number }>(STOCK_EVENT);
      expect(frame.newStock).toBe(1);
      await till.expectSilence(STOCK_EVENT, SILENCE_MS);
    });
  });

  // =========================================================================
  // 4. DUPLICATE AND REPEATED FRAMES
  // =========================================================================

  describe('duplicate frames', () => {
    it('are harmless: the authoritative read is idempotent', async () => {
      const s = await scene({ stock: 10, reserve: 4 });
      const customer = await socketFor(s.customerJar, 'storefront');

      expect((await sell(s.cashierJar, s.variantId, 8)).status).toBe(201);
      await customer.next(AVAILABILITY_EVENT);
      const first = await readCart(s.customerJar);

      // Re-announce the SAME committed fact, twice more — a redelivery, or the
      // socket and the polling fallback both noticing. The client's only
      // reaction is another `GET /cart`.
      gateway.emitAvailabilityEvent({
        variantId: s.variantId,
        productId: s.productId,
        reason: 'stock',
      });
      gateway.emitAvailabilityEvent({
        variantId: s.variantId,
        productId: s.productId,
        reason: 'stock',
      });
      await customer.next(AVAILABILITY_EVENT);
      await customer.next(AVAILABILITY_EVENT);

      const second = await readCart(s.customerJar);
      const third = await readCart(s.customerJar);

      // The change notice is CONSUMED by the first read (that is the documented
      // acknowledgement contract), so compare the state that must not drift.
      expect(second.data.map((l) => [l.variant?.id, l.quantity])).toEqual(
        third.data.map((l) => [l.variant?.id, l.quantity]),
      );
      const firstLine = first.data.find((l) => l.variant?.id === s.variantId)!;
      const thirdLine = third.data.find((l) => l.variant?.id === s.variantId)!;
      expect(thirdLine.quantity).toBe(firstLine.quantity);
      expect(thirdLine.reservedQuantity).toBe(firstLine.reservedQuantity);
    });

    it('cannot reintroduce stale cart state when an OUT-OF-ORDER frame claims the opposite', async () => {
      const s = await scene({ stock: 10, reserve: 4 });
      const customer = await socketFor(s.customerJar, 'storefront');

      expect((await sell(s.cashierJar, s.variantId, 10)).status).toBe(201);
      await customer.next(AVAILABILITY_EVENT);
      await readCart(s.customerJar);

      /*
       * A late, duplicate frame for a variant that is now at zero.
       *
       * Under the old contract this case could state a CONTRADICTION
       * (`inStock: true` against zero stock) and the test's point was that a
       * client believing it would be wrong. The invalidation contract removes
       * the possibility: the frame carries no state to contradict, so the only
       * thing a late frame can do is cause one more authoritative read. That
       * is a strictly stronger guarantee, and it is what this now pins.
       */
      gateway.emitAvailabilityEvent({
        variantId: s.variantId,
        productId: s.productId,
        reason: 'stock',
      });
      await customer.next(AVAILABILITY_EVENT);

      const after = await readCart(s.customerJar);
      expect(
        after.data.some((l) => l.variant?.id === s.variantId && l.quantity > 0),
      ).toBe(false);
      expect(await physicalStock(s.variantId)).toBe(0);
    });
  });

  // =========================================================================
  // 5. SESSION LIFECYCLE — a socket must not outlive its session
  // =========================================================================

  describe('session lifecycle', () => {
    it('drops the socket when the password epoch ends', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');
      expect(customer.connected).toBe(true);

      await app.dataSource.query(
        'UPDATE users SET "passwordVersion" = COALESCE("passwordVersion", 1) + 1 WHERE id = $1',
        [s.customerId],
      );
      // The sweep TIMER is disarmed under test on purpose; driving the sweep
      // directly is deterministic and exercises the same code path.
      await gateway.revalidateAll();

      const reason = await customer.waitForDisconnect();
      expect(typeof reason).toBe('string');
      expect(customer.connected).toBe(false);
    });

    it('drops the socket when the user is deactivated', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');

      await app.dataSource.query(
        'UPDATE users SET "deactivatedAt" = NOW() WHERE id = $1',
        [s.customerId],
      );
      await gateway.revalidateAll();

      await customer.waitForDisconnect();
      expect(customer.connected).toBe(false);
    });

    /*
     * =======================================================================
     * REVOKING SESSIONS MUST REACH THE SOCKET — the gap the sweep cannot see
     * =======================================================================
     *
     * The three cases above all work because the sweep re-reads the database
     * and finds something wrong: an expired token, a deactivated user, a moved
     * password epoch. A REVOCATION is none of those. It flips
     * `refresh_tokens.revoked` and leaves `users` untouched, so every
     * credential check the sweep performs still passes and the socket survives.
     *
     * Before `RealtimeGateway.disconnectUser`, "sign out everywhere" therefore
     * closed the refresh path and left the websocket delivering staff order and
     * stock frames for the whole remaining lifetime of an access token — up to
     * fifteen minutes after an administrator believed they had cut a
     * compromised account off. Running `revalidateAll()` in these cases is
     * deliberate: it proves the sweep is NOT what closes them.
     */
    it('drops a LIVE socket when the user signs out everywhere', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');
      expect(customer.connected).toBe(true);

      const out = await withCookies(app, s.customerJar).post(
        '/auth/storefront/logout-all',
      );
      expect([200, 201, 204]).toContain(out.status);

      await customer.waitForDisconnect();
      expect(customer.connected).toBe(false);
    });

    it('drops a LIVE socket when an administrator revokes the account’s sessions', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const cashier = await socketFor(s.cashierJar, 'pos');
      expect(cashier.connected).toBe(true);

      const admin = await createUser(app.dataSource, {
        roles: [UserRoleEnum.superAdmin],
      });
      const adminJar = await authenticate(
        app,
        admin.username,
        admin.password,
        'admin',
      );

      const revoked = await withCookies(app, adminJar).post(
        `/admin/users/${s.cashierId}/revoke-sessions`,
      );
      expect([200, 201, 204]).toContain(revoked.status);

      await cashier.waitForDisconnect();
      expect(cashier.connected).toBe(false);
    });

    it('is NOT the re-validation sweep that closes a revoked session', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');

      // Revoke the refresh rows directly, WITHOUT going through the service
      // that pushes the disconnect. This is the pre-fix state of the world.
      await app.dataSource.query(
        'UPDATE refresh_tokens SET revoked = true WHERE "userId" = $1',
        [s.customerId],
      );
      await gateway.revalidateAll();

      // The sweep has run and found nothing to object to: the account is
      // active, the token is unexpired, the epoch has not moved. The socket
      // therefore survives — which is precisely why the push exists.
      expect(customer.connected).toBe(true);

      // And the push does close it.
      const dropped = await gateway.disconnectUser(
        s.customerId,
        'test: explicit revocation',
      );
      expect(dropped).toBeGreaterThan(0);
      await customer.waitForDisconnect();
      expect(customer.connected).toBe(false);
    });

    it('drops only the named user’s sockets, never a bystander’s', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');
      const cashier = await socketFor(s.cashierJar, 'pos');

      await gateway.disconnectUser(s.customerId, 'test: isolation');

      await customer.waitForDisconnect();
      expect(customer.connected).toBe(false);
      // The cashier shares nothing with the customer but a server.
      expect(cashier.connected).toBe(true);
    });

    it('disconnecting a user with no socket is a no-op, not an error', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      await expect(
        gateway.disconnectUser(s.customerId, 'test: nobody connected'),
      ).resolves.toBe(0);
    });

    it('leaves a logged-out storefront with an ANONYMOUS socket, never a privileged one', async () => {
      /*
       * THE OUTCOME CHANGED WITH ANONYMOUS MODE, and the new one is what the
       * shop actually wants.
       *
       * Logging out CLEARS the storefront cookie, so the next handshake
       * supplies no credential — which is now a legitimate public visitor
       * rather than a refusal. The customer keeps seeing the catalogue go stale
       * in real time, exactly as they did before signing in.
       *
       * What must NOT survive is any PRIVILEGE. So this asserts the socket is
       * anonymous in the only way that matters: the public room and nothing
       * else, and specifically not the user room whose notices belong to the
       * person who just left.
       */
      const s = await scene({ stock: 3, reserve: 0 });

      const out = await withCookies(app, s.customerJar).post(
        '/auth/storefront/logout',
      );
      expect([200, 201, 204]).toContain(out.status);
      s.customerJar.absorb(out);

      const after = await socketFor(s.customerJar, 'storefront');
      expect(after.connected).toBe(true);

      const sockets = await gateway.server.fetchSockets();
      const mine = sockets.find((socket) => socket.id === after.socket.id);
      const rooms = [...(mine?.rooms ?? [])].filter(
        (room) => room !== after.socket.id,
      );

      expect(rooms).toEqual([ROOM_PUBLIC_AVAILABILITY]);
      expect(rooms).not.toContain(`user:${s.customerId}`);
      expect(mine?.data).toEqual({ kind: 'anonymous', audience: 'storefront' });
    });
  });

  // =========================================================================
  // 6. CLEANUP
  // =========================================================================

  describe('cleanup', () => {
    it('leaves no listeners and no live connection behind after close()', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');

      expect(
        customer.socket.listeners(AVAILABILITY_EVENT).length,
      ).toBeGreaterThan(0);
      await customer.close();

      expect(customer.socket.listeners(AVAILABILITY_EVENT)).toEqual([]);
      expect(customer.socket.connected).toBe(false);
      // The engine object may still be referenced for a tick while the
      // WebSocket completes its close handshake; what must be true is that it
      // is no longer OPEN, i.e. nothing is left that could deliver a frame or
      // hold the event loop.
      expect(customer.socket.io.engine?.readyState).not.toBe('open');

      // Closing twice must be safe — `afterEach` will do it again.
      await customer.close();
    });

    it('does not leave the SERVER holding a socket for a closed client', async () => {
      const s = await scene({ stock: 3, reserve: 0 });
      const customer = await socketFor(s.customerJar, 'storefront');
      const before = (await gateway.server.fetchSockets()).length;
      expect(before).toBeGreaterThan(0);

      await customer.close();

      // Poll the server's own registry rather than sleeping: the close is
      // observable, so wait for the observation with a bounded deadline.
      const deadline = Date.now() + 3_000;
      let remaining = before;
      while (Date.now() < deadline) {
        remaining = (await gateway.server.fetchSockets()).length;
        if (remaining < before) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(remaining).toBeLessThan(before);
    });
  });
});
