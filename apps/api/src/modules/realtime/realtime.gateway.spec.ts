import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { Server } from 'socket.io';

import UserRoleEnum from '../user/enums/user-role.enum';
import {
  AVAILABILITY_EVENT,
  AuthenticatedSocket,
  POS_AVAILABILITY_EVENT,
  ROOM_PUBLIC_AVAILABILITY,
  ROOM_STAFF_AVAILABILITY,
  ROOM_SUPER_ADMIN,
  RealtimeGateway,
  STOCK_EVENT,
  branchRoom,
  safeErrorText,
  userRoom,
} from './realtime.gateway';
import { PermissionService } from '../auth/permissions/permission.service';
import { CatalogCacheService } from 'src/database/cache.service';
import { systemRolePermissions } from '../auth/permissions/system-roles';

/**
 * ============================================================================
 * REALTIME SCOPING -- "who is actually on the other end of this emit?"
 * ============================================================================
 *
 * WHAT WAS WRONG
 * --------------
 * Three call sites published with `Server.emit(...)`, which reaches EVERY
 * connected socket:
 *
 *   realtime.gateway.ts   emitStockEvent  -> server.emit('stock:updated', ...)
 *   payment.service.ts    publish()       -> server.emit('stock:updated', ...)
 *   payment.service.ts    publish()       -> server.emit('order.status.updated', ...)
 *
 * so every signed-in retail customer with a page open received (a) the exact
 * physical stock of every variant -- a figure every HTTP route serving it gates
 * behind `sale`/`super_admin` -- and (b) the id and status of every other
 * customer's order. No bug was needed to trigger either; that was the normal
 * successful path.
 *
 * HOW THIS SUITE TESTS IT
 * -----------------------
 * The double below reproduces the REAL socket.io room API, not a convenience
 * shape: `to()` returns a chainable operator, chained `to()` calls UNION their
 * rooms, and `emit()` records the room set it was called on. An emission with
 * an EMPTY room set is therefore a global broadcast, and the assertions can
 * name it as such instead of having to trust a comment.
 *
 * The one global broadcast that survives (`availability:updated`) is asserted
 * on its payload KEYS, so nobody can widen it into a quantity channel later
 * without this suite failing.
 *
 * The last test greps `src` and fails if a bare global broadcast is
 * reintroduced anywhere, because a scoping rule that only holds in the files
 * somebody remembered to test is not a rule.
 * ============================================================================
 */

/** One recorded emission. `rooms: []` means it went to EVERY socket. */
interface Emission {
  rooms: string[];
  event: string;
  payload: unknown;
}

/**
 * Test double with the shape of `socket.io`'s `Server` that this gateway
 * actually uses: `emit`, `to`, and `to().to()` unioning.
 */
class RecordingServer {
  readonly emissions: Emission[] = [];

  emit(event: string, payload: unknown): boolean {
    this.emissions.push({ rooms: [], event, payload });
    return true;
  }

  to(room: string) {
    return this.operator([room]);
  }

  private operator(rooms: string[]) {
    return {
      to: (room: string) => this.operator([...rooms, room]),
      emit: (event: string, payload: unknown) => {
        this.emissions.push({ rooms: [...rooms], event, payload });
        return true;
      },
    };
  }

  /** Everything that would land on a socket sitting in `room`. */
  reaching(room: string): Emission[] {
    return this.reachingAny([room]);
  }

  /**
   * Everything that would land on a socket sitting in ANY of `rooms`.
   *
   * A socket is in several rooms at once — a customer is in their own
   * `user:<id>` AND the public availability room — so asking about one room
   * under-reports what the socket can actually receive. For a leak assertion
   * that is the wrong direction to be wrong in.
   */
  reachingAny(rooms: readonly string[]): Emission[] {
    return this.emissions.filter(
      (e) =>
        e.rooms.length === 0 || e.rooms.some((room) => rooms.includes(room)),
    );
  }

  get globals(): Emission[] {
    return this.emissions.filter((e) => e.rooms.length === 0);
  }
}

/** Records the rooms the gateway makes a connecting socket join. */
class FakeSocket {
  readonly joined: string[] = [];
  disconnected = false;
  data: Record<string, unknown> = {};

  constructor(
    readonly handshake: {
      headers: Record<string, string>;
      query?: Record<string, string>;
    },
  ) {}

  /** socket.io exposes current rooms as a Set; the room sweep reads it. */
  get rooms(): Set<string> {
    return new Set(this.joined);
  }

  join(room: string): Promise<void> {
    this.joined.push(room);
    return Promise.resolve();
  }

  leave(room: string): Promise<void> {
    const index = this.joined.indexOf(room);
    if (index >= 0) this.joined.splice(index, 1);
    return Promise.resolve();
  }

  disconnect(): this {
    this.disconnected = true;
    return this;
  }
}

interface FakeUserRow {
  id: number;
  roles: Array<{ name: string }>;
  branchId: number | null;
  deactivatedAt: Date | null;
  /**
   * The session epoch (migration 0027). It replaced `passwordChangedAt` as the
   * thing the handshake and the sweep compare: the token's `pv` claim must
   * still equal this value.
   */
  passwordVersion: number;
}

function buildGateway(user: FakeUserRow | null): {
  gateway: RealtimeGateway;
  server: RecordingServer;
} {
  const jwtService = {
    verify: () => ({
      sub: user?.id ?? 0,
      typ: 'access',
      // A shopper's socket is a STOREFRONT socket. Rooms follow the surface,
      // not only the role, so this is what decides which rooms it may join.
      aud: 'storefront',
      // The epoch the fake token was minted under. A real token always carries
      // it, so a fake one that did not would be refused at the handshake for a
      // reason none of these room-scoping cases is about.
      pv: user?.passwordVersion ?? 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  } as unknown as JwtService;

  const configService = {
    getOrThrow: () => 'test-secret',
  } as unknown as ConfigService;

  const dataSource = {
    getRepository: () => ({ findOne: () => Promise.resolve(user) }),
  } as unknown as DataSource;

  /**
   * The REAL system-role expansion, not an empty stub.
   *
   * An empty permission set is not a neutral choice any more: the handshake now
   * refuses an audience the principal is not eligible for, so stubbing "no
   * permissions" disconnects every socket these cases are about. Expanding the
   * fake user's roles through `systemRolePermissions` — the same map the
   * application uses — keeps the room assertions about ROOMS.
   */
  const permissionService = {
    resolveEffective: (roles: Array<{ name: string }>) =>
      Promise.resolve([
        ...new Set(
          (roles ?? []).flatMap(
            (role) => systemRolePermissions(role.name) ?? [],
          ),
        ),
      ]),
  } as unknown as PermissionService;
  const catalogCache = {
    invalidateProducts: () => Promise.resolve(),
  } as unknown as CatalogCacheService;

  const gateway = new RealtimeGateway(
    jwtService,
    configService,
    dataSource,
    permissionService,
    catalogCache,
  );
  const server = new RecordingServer();
  gateway.server = server as unknown as Server;
  return { gateway, server };
}

/** A plain retail customer: `site` role, no branch, not an admin. */
const SITE_ONLY_USER: FakeUserRow = {
  id: 41,
  roles: [{ name: UserRoleEnum.site }],
  branchId: null,
  deactivatedAt: null,
  passwordVersion: 1,
};

describe('RealtimeGateway room scoping', () => {
  describe('emitOrderEvent -- staff rooms only', () => {
    it('never broadcasts globally, and reaches admins for a branch-less order', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitOrderEvent('order.status.updated', {
        orderId: 7,
        status: 'paid',
        branchId: null,
      });

      expect(server.globals).toEqual([]);
      expect(server.emissions).toHaveLength(1);
      expect(server.emissions[0].rooms).toEqual([ROOM_SUPER_ADMIN]);
    });

    it('unions the order’s branch room when the order has a branch', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitOrderEvent('order.created', { orderId: 9, branchId: 3 });

      expect(server.globals).toEqual([]);
      expect(server.emissions[0].rooms).toEqual([
        ROOM_SUPER_ADMIN,
        branchRoom(3),
      ]);
    });

    it('treats the operational awaiting-stock notice as staff data too', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitOrderEvent('order.awaiting_stock', {
        orderId: 11,
        branchId: null,
      });

      expect(server.globals).toEqual([]);
      expect(server.emissions[0]).toEqual({
        rooms: [ROOM_SUPER_ADMIN],
        event: 'order.awaiting_stock',
        payload: { orderId: 11, branchId: null },
      });
    });

    it('does NOT fall back to a global broadcast when branchId is absent', () => {
      const { gateway, server } = buildGateway(null);

      // No `branchId` key at all -- the shape orders.service.ts uses for a
      // stock frame. "Unknown branch" must mean a SMALLER audience, never the
      // whole world.
      gateway.emitOrderEvent('order.voided', { orderId: 12 });

      expect(server.globals).toEqual([]);
      expect(server.emissions[0].rooms).toEqual([ROOM_SUPER_ADMIN]);
    });
  });

  describe('emitStockEvent -- exact quantities are staff data', () => {
    it('never broadcasts globally', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitStockEvent({ variantId: 5, newStock: 2 });

      expect(server.globals).toEqual([]);
      expect(server.emissions[0]).toEqual({
        rooms: [ROOM_SUPER_ADMIN],
        event: STOCK_EVENT,
        payload: { variantId: 5, newStock: 2 },
      });
    });

    it('adds the branch room so till staff (role `sale`) receive it', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitStockEvent({ variantId: 5, newStock: 2, branchId: 8 });

      expect(server.emissions[0].rooms).toEqual([
        ROOM_SUPER_ADMIN,
        branchRoom(8),
      ]);
    });
  });

  describe('availability invalidation -- room-scoped, and never global', () => {
    it('sends the PUBLIC frame to the public room and nowhere else', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitAvailabilityEvent({
        variantId: 5,
        productId: 3,
        reason: 'stock',
      });

      // There is no longer ANY global broadcast in this application. This used
      // to assert `rooms: []` -- "deliberately everybody" -- which handed every
      // till and console every storefront frame.
      expect(server.globals).toEqual([]);
      expect(server.emissions).toHaveLength(1);
      const [emission] = server.emissions;
      expect(emission.rooms).toEqual([ROOM_PUBLIC_AVAILABILITY]);
      expect(emission.event).toBe(AVAILABILITY_EVENT);

      // The payload contract, asserted key by key. If a future change adds
      // `newStock`, `remaining`, `orderId`, `inStock` or anything else, this
      // fails -- which is what makes the frame safe for an ANONYMOUS visitor.
      expect(Object.keys(emission.payload as object).sort()).toEqual([
        'productId',
        'reason',
        'variantId',
      ]);
      expect(emission.payload).toEqual({
        variantId: 5,
        productId: 3,
        reason: 'stock',
      });
    });

    it('sends the STAFF frame to the staff room, with the same safe payload', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitPosAvailabilityEvent({
        variantId: 5,
        productId: 3,
        reason: 'stock',
      });

      expect(server.globals).toEqual([]);
      expect(server.emissions[0].rooms).toEqual([ROOM_STAFF_AVAILABILITY]);
      expect(server.emissions[0].event).toBe(POS_AVAILABILITY_EVENT);
      expect(Object.keys(server.emissions[0].payload as object).sort()).toEqual(
        ['productId', 'reason', 'variantId'],
      );
    });
  });

  describe('emitToUser -- exactly one customer', () => {
    it('targets only that customer’s room', () => {
      const { gateway, server } = buildGateway(null);

      gateway.emitToUser(41, 'order.status.updated', {
        orderId: 7,
        status: 'paid',
      });

      expect(server.globals).toEqual([]);
      expect(server.emissions[0].rooms).toEqual([userRoom(41)]);
    });
  });

  // ==========================================================================
  // What a real `site`-only socket can actually receive
  // ==========================================================================
  describe('a site-only customer socket', () => {
    it('joins only its own user room', async () => {
      const { gateway } = buildGateway(SITE_ONLY_USER);
      const socket = new FakeSocket({
        headers: { cookie: 'kz_storefront_access=t' },
        query: { audience: 'storefront' },
      });

      await gateway.handleConnection(socket as unknown as AuthenticatedSocket);

      expect(socket.disconnected).toBe(false);
      // The public availability room is the storefront's channel; a signed-in
      // customer joins exactly it and their own user room.
      expect(socket.joined.sort()).toEqual(
        [userRoom(SITE_ONLY_USER.id), ROOM_PUBLIC_AVAILABILITY].sort(),
      );
      expect(socket.joined).not.toContain(ROOM_SUPER_ADMIN);
      expect(socket.joined).not.toContain(ROOM_STAFF_AVAILABILITY);
    });

    it('cannot reach any channel carrying an exact stock number', async () => {
      const { gateway, server } = buildGateway(SITE_ONLY_USER);
      const socket = new FakeSocket({
        headers: { cookie: 'kz_storefront_access=t' },
        query: { audience: 'storefront' },
      });
      await gateway.handleConnection(socket as unknown as AuthenticatedSocket);

      // Exactly what PaymentService.publish() emits for one consumed variant.
      gateway.emitStockEvent({ variantId: 5, newStock: 2, branchId: 8 });
      gateway.emitAvailabilityEvent({
        variantId: 5,
        productId: 3,
        reason: 'stock',
      });
      // ...and the staff counterpart, which a customer must NOT reach either.
      gateway.emitPosAvailabilityEvent({
        variantId: 5,
        productId: 3,
        reason: 'stock',
      });

      // Asked across EVERY room this socket actually joined, not just its
      // user room — the public availability frame arrives through the other one.
      const reachable = server.reachingAny(socket.joined);

      // The customer gets the public invalidation and nothing else: not the
      // exact-stock frame, and not the staff availability frame either.
      expect(reachable.map((e) => e.event)).toEqual([AVAILABILITY_EVENT]);

      // Every name a quantity travels under in this codebase.
      const FORBIDDEN_KEYS = [
        'newStock',
        'stock',
        'physicalStock',
        'balanceAfter',
        'quantity',
        'quantityConsumed',
        'basketReserved',
        'orderAllocated',
        'availableForBasket',
        'availableForPos',
      ];

      for (const emission of reachable) {
        const payload = emission.payload as Record<string, unknown>;
        for (const key of FORBIDDEN_KEYS) {
          expect(payload).not.toHaveProperty(key);
        }
        /*
         * Stated structurally as well as by name: the only numbers a
         * customer-reachable frame may carry are CATALOGUE IDENTIFIERS. A count
         * under any name at all fails here.
         *
         * `productId` joined `variantId` with the invalidation contract. It is
         * safe for the same reason `variantId` is: it identifies a row in the
         * public catalogue — it is in the URL of every product page — and it
         * says nothing about how many of anything exists, who holds it, or
         * where. It is on the frame so a listing page can reconcile one
         * product instead of refetching its whole current page.
         */
        const PUBLIC_IDENTIFIERS = ['variantId', 'productId'];
        for (const [key, value] of Object.entries(payload)) {
          if (typeof value === 'number') {
            expect(PUBLIC_IDENTIFIERS).toContain(key);
          }
        }
      }
    });

    it('never receives another customer’s order id or status', async () => {
      const { gateway, server } = buildGateway(SITE_ONLY_USER);
      const socket = new FakeSocket({
        headers: { cookie: 'kz_storefront_access=t' },
        query: { audience: 'storefront' },
      });
      await gateway.handleConnection(socket as unknown as AuthenticatedSocket);

      const customerA = SITE_ONLY_USER.id;
      const customerB = 99;
      const orderOfA = 500;
      const orderOfB = 501;

      // Customer B's order settles: staff frames + B's own channel.
      gateway.emitOrderEvent('order.created', {
        orderId: orderOfB,
        branchId: null,
      });
      gateway.emitOrderEvent('order.status.updated', {
        orderId: orderOfB,
        status: 'paid',
        branchId: null,
      });
      gateway.emitToUser(customerB, 'order.status.updated', {
        orderId: orderOfB,
        status: 'paid',
      });
      // Then A's own order settles.
      gateway.emitToUser(customerA, 'order.status.updated', {
        orderId: orderOfA,
        status: 'paid',
      });

      const reachable = server.reaching(userRoom(customerA));
      expect(reachable).toEqual([
        {
          rooms: [userRoom(customerA)],
          event: 'order.status.updated',
          payload: { orderId: orderOfA, status: 'paid' },
        },
      ]);

      // Stated the other way round, because this is the actual leak: no order
      // id that is not A's may appear in anything A can receive.
      const serialised = JSON.stringify(reachable);
      expect(serialised).toContain(String(orderOfA));
      expect(serialised).not.toContain(String(orderOfB));
    });
  });

  // ==========================================================================
  // Regression guard over the whole source tree
  // ==========================================================================
  describe('safeErrorText -- a reconciliation failure cannot leak a credential', () => {
    /*
     * The operational signal for a failed reconciliation carries an error
     * string, and an error string is the one field in that payload whose
     * content this application does not author. If a driver, adapter or HTTP
     * library ever echoed the request back inside a message, the two shapes
     * that could ride along are a JWT and a session cookie. The claim "no
     * cookies, JWTs or secrets are logged" is therefore enforced here rather
     * than assumed of every dependency.
     */
    it('keeps the class name and message, which is what an operator needs', () => {
      expect(safeErrorText(new TypeError('socket.rooms is not iterable'))).toBe(
        'TypeError: socket.rooms is not iterable',
      );
    });

    it('redacts a JWT', () => {
      const token =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjQyfQ.c2lnbmF0dXJl';
      const text = safeErrorText(new Error(`upstream rejected ${token}`));
      expect(text).toBe('Error: upstream rejected [jwt]');
      expect(text).not.toContain('eyJ');
    });

    it('redacts this application’s session cookies, including several at once', () => {
      const text = safeErrorText(
        new Error(
          'handshake failed: kz_pos_access=abc.def.ghi; kz_pos_refresh=zzz',
        ),
      );
      expect(text).toBe('Error: handshake failed: [cookie]; [cookie]');
      expect(text).not.toContain('abc');
      expect(text).not.toContain('zzz');
    });

    it('caps the length, so a huge payload cannot be logged through it', () => {
      expect(safeErrorText(new Error('x'.repeat(5_000))).length).toBe(300);
    });

    it('survives a thrown non-Error', () => {
      expect(safeErrorText('plain string')).toBe('NonError: plain string');
      expect(safeErrorText(undefined)).toBe('NonError: undefined');
    });
  });

  describe('no global broadcast may be reintroduced anywhere in src', () => {
    const SRC_ROOT = resolve(__dirname, '..', '..');
    const GATEWAY_FILE = join('modules', 'realtime', 'realtime.gateway.ts');
    /** The single marker that whitelists one line inside the gateway. */
    const ALLOWED_MARKER = 'ALLOWED-GLOBAL-BROADCAST';

    function sourceFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          out.push(...sourceFiles(full));
        } else if (entry.endsWith('.ts')) {
          out.push(full);
        }
      }
      return out;
    }

    /**
     * A line that is only a comment is not a call site. Both the gateway and
     * orders.service.ts quote the old `server.emit(...)` in prose explaining
     * why it was removed, and a guard that flagged its own documentation would
     * be deleted within a week.
     */
    function isComment(line: string): boolean {
      const t = line.trim();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    }

    const HOW_TO_FIX =
      '\n\nA bare `server.emit(...)` reaches EVERY connected socket, including ' +
      'every retail storefront customer. Publish through RealtimeGateway ' +
      'instead:\n' +
      '  - staff order events      -> emitOrderEvent(event, { ..., branchId })\n' +
      '  - exact stock quantities  -> emitStockEvent({ variantId, newStock, branchId })\n' +
      '  - one customer            -> emitToUser(userId, event, payload)\n' +
      '  - customer-safe stock hint-> emitAvailabilityEvent({ variantId, inStock })\n' +
      'If you genuinely need a new global broadcast, it must live in ' +
      'realtime.gateway.ts, carry a payload with no quantity and no ' +
      "identifier of anybody's order, and be marked with the " +
      `\`${ALLOWED_MARKER}\` comment on the emitting line.`;

    it('has no `server.emit(` outside the gateway’s audited broadcast', () => {
      // `server.emit(`, `this.server.emit(`, `server?.emit(`, `x.server .emit(`.
      const bare = /\bserver\s*\??\s*\.\s*emit\s*\(/;
      const offenders: string[] = [];

      for (const file of sourceFiles(SRC_ROOT)) {
        const rel = relative(SRC_ROOT, file);
        if (rel.endsWith('.spec.ts')) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!bare.test(line) || isComment(line)) return;
          const isAudited =
            rel.split(sep).join(sep) === GATEWAY_FILE &&
            lines
              .slice(Math.max(0, index - 6), index)
              .some((l) => l.includes(ALLOWED_MARKER));
          if (!isAudited) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
      }

      expect(offenders.join('\n') + (offenders.length ? HOW_TO_FIX : '')).toBe(
        '',
      );
    });

    it('has NO global broadcast left anywhere, not even an audited one', () => {
      /*
       * This assertion was inverted by this pass, and the inversion is the
       * point.
       *
       * It used to permit exactly ONE global `server.emit` — the availability
       * event — on the grounds that its payload could not carry a quantity or
       * an identity. That was a sound argument about the PAYLOAD and no
       * argument at all about the AUDIENCE: every till and every admin console
       * received every storefront frame.
       *
       * Storefront sockets now have a room of their own
       * (`ROOM_PUBLIC_AVAILABILITY`), so the last global broadcast is gone and
       * the rule is simply: there are none. A re-introduced one fails here and
       * in the offender scan above.
       */
      const lines = readFileSync(join(SRC_ROOT, GATEWAY_FILE), 'utf8').split(
        '\n',
      );
      const globals = lines.filter(
        (line) =>
          /\bserver\s*\??\s*\.\s*emit\s*\(/.test(line) && !isComment(line),
      );
      expect(globals).toEqual([]);
    });

    it('lets nothing outside the gateway touch the raw socket.io server', () => {
      // Reaching `realtimeGateway.server` is how the global broadcast got into
      // payment.service.ts in the first place: the scoped API was there, and
      // the raw handle sat next to it.
      const raw = /realtimeGateway\s*\??\s*\.\s*server\b/;
      const offenders: string[] = [];

      for (const file of sourceFiles(SRC_ROOT)) {
        const rel = relative(SRC_ROOT, file);
        if (rel.endsWith('.spec.ts')) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (raw.test(line) && !isComment(line)) {
              offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
            }
          });
      }

      expect(
        offenders.join('\n') +
          (offenders.length
            ? '\n\nUse the gateway’s scoped emitters instead of its `server` ' +
              'handle.' +
              HOW_TO_FIX
            : ''),
      ).toBe('');
    });
  });
});
