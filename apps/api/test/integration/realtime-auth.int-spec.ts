import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StringValue } from 'ms';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
} from 'src/modules/auth/auth.types';
import {
  AuthenticatedSocket,
  ROOM_STAFF_AVAILABILITY,
  ROOM_SUPER_ADMIN,
  RealtimeGateway,
  parseCookieHeader,
} from 'src/modules/realtime/realtime.gateway';
import { User } from 'src/modules/user/entities/user.entity';

import { createTestApp, TestApp } from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createBranch, createUser } from './setup/seed-helpers';

/**
 * WEBSOCKET HANDSHAKE AUTHENTICATION.
 *
 * The gateway is taken from the REAL running application (same JwtService,
 * same ConfigService, same DataSource, same PostgreSQL), and its real
 * `handleConnection` is invoked with a socket whose handshake the test controls
 * — which is the point: a websocket handshake is entirely client-supplied, so
 * the only honest way to test "what can a client talk its way into" is to let
 * the test BE the hostile client.
 *
 * What is deliberately NOT simulated is the socket.io wire protocol; that is
 * socket.io's code, not this project's, and reproducing it in a test would add
 * timing flakiness without testing anything of ours. That the gateway is
 * actually mounted on the application is asserted separately.
 */

/** Records everything the gateway does to a connecting socket. */
class FakeSocket {
  readonly joined: string[] = [];
  disconnected = false;
  forcedClose = false;
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
    if (!this.joined.includes(room)) this.joined.push(room);
    return Promise.resolve();
  }

  leave(room: string): Promise<void> {
    const index = this.joined.indexOf(room);
    if (index >= 0) this.joined.splice(index, 1);
    return Promise.resolve();
  }

  disconnect(close: boolean): this {
    this.disconnected = true;
    this.forcedClose = close;
    return this;
  }
}

describe('realtime gateway authentication', () => {
  let testApp: TestApp;
  let gateway: RealtimeGateway;
  let signer: JwtService;

  beforeAll(async () => {
    testApp = await createTestApp();
    gateway = testApp.app.get(RealtimeGateway);
    signer = new JwtService({
      secret: testApp.app
        .get(ConfigService)
        .getOrThrow<string>('JWT_SECRET_KEY'),
    });
  });

  afterAll(async () => {
    await testApp.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(testApp.dataSource);
  });

  // ==========================================================================
  // helpers
  // ==========================================================================

  /**
   * `pv` IS PART OF EVERY TOKEN THE APPLICATION MINTS, so a hand-built one
   * must carry it too or the handshake refuses it for the wrong reason.
   *
   * It defaults to the user's CURRENT `passwordVersion` (1 for a fresh
   * fixture), which is what a real login would have stamped. A case that wants
   * a stale session overrides it, or moves the column — either way the
   * assertion is about the epoch and not about a clock.
   */
  const accessTokenFor = (
    user: User,
    overrides: Record<string, unknown> = {},
    expiresIn: StringValue | number = '15m',
  ): string =>
    signer.sign(
      {
        sub: user.id,
        identifier: user.username ?? user.mobile,
        roles: [],
        branch: user.branchId ?? null,
        aud: 'pos',
        pv: user.passwordVersion ?? 1,
        typ: TOKEN_TYPE_ACCESS,
        ...overrides,
      },
      { expiresIn },
    );

  /** Runs the REAL handshake against a socket carrying `cookieHeader`. */
  const connect = async (
    cookieHeader: string | undefined,
    extraHeaders: Record<string, string> = {},
    audience = 'pos',
  ): Promise<FakeSocket> => {
    const socket = new FakeSocket({
      headers: {
        ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
        ...extraHeaders,
      },
      // The browser sends every audience's cookie, so the handshake must say
      // which session is connecting. Naming one you hold no cookie for yields
      // nothing — it selects, it does not grant.
      query: { audience },
    });
    await gateway.handleConnection(socket as unknown as AuthenticatedSocket);
    return socket;
  };

  // ==========================================================================
  // The gateway is genuinely part of the application
  // ==========================================================================

  it('is mounted on the running application with a socket.io server attached', () => {
    // If Nest had not bound the gateway, `server` would be undefined and every
    // emitter in the app would be a silent no-op.
    expect(gateway).toBeInstanceOf(RealtimeGateway);
    expect(gateway.server).toBeDefined();
  });

  // ==========================================================================
  // Rejection paths
  // ==========================================================================

  describe('rejects a connection that is not authenticated', () => {
    it('with no cookie header at all', async () => {
      const socket = await connect(undefined);
      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });

    it('with cookies but no session cookie for the named audience', async () => {
      const socket = await connect('session=abc; theme=dark');
      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });

    it('with a token signed by the wrong secret', async () => {
      const { user } = await createUser(testApp.dataSource);
      const forged = new JwtService({
        secret: 'not-the-application-secret',
      }).sign({ sub: user.id, typ: TOKEN_TYPE_ACCESS }, { expiresIn: '15m' });

      const socket = await connect(`kz_pos_access=${forged}`);
      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });

    it('with an expired access token', async () => {
      const { user } = await createUser(testApp.dataSource);
      const socket = await connect(
        `kz_pos_access=${accessTokenFor(user, {}, '-60s')}`,
      );
      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });

    it('with a REFRESH token used as an access token', async () => {
      // Access and refresh tokens share a signing secret; only `typ` separates
      // them, so a long-lived refresh token must not open a live socket.
      const { user } = await createUser(testApp.dataSource);
      const refresh = signer.sign(
        {
          sub: user.id,
          identifier: user.username,
          roles: [],
          branch: null,
          typ: TOKEN_TYPE_REFRESH,
          jti: 'some-token-id',
        },
        { expiresIn: '2d' },
      );

      const socket = await connect(`kz_pos_access=${refresh}`);
      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });

    it('for a soft-deactivated user holding a still-valid token', async () => {
      /*
       * A `sale` user, because the surface being connected to is the till.
       * This used to be the default `site` role with a POS cookie, which now
       * fails the handshake's audience-eligibility check before deactivation
       * is ever reached — see 'refuses an audience the principal is not
       * permitted' below. Using an eligible principal keeps this case about
       * DEACTIVATION, which is what it is for.
       */
      const branch = await createBranch(testApp.dataSource);
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const token = accessTokenFor(user);

      // Sanity: the very same token connects while the account is live.
      const before = await connect(`kz_pos_access=${token}`);
      expect(before.disconnected).toBe(false);

      await testApp.dataSource.query(
        `UPDATE users SET "deactivatedAt" = now() WHERE id = $1`,
        [user.id],
      );

      const after = await connect(`kz_pos_access=${token}`);
      expect(after.disconnected).toBe(true);
      expect(after.joined).toEqual([]);
    });

    it('for a token from an ENDED password epoch', async () => {
      // The gateway must honour the same "kill every session NOW" lever as the
      // HTTP guard; a socket can otherwise stay open for hours on a credential
      // that was revoked seconds after it was issued.
      //
      // NO CLOCK IS INVOLVED. This used to move `passwordChangedAt` to a
      // timestamp 900ms after the token's `iat` second, which only worked
      // because the comparison was made in milliseconds against the start of
      // that second. Incrementing the epoch is exact: the token carries 1, the
      // row now says 2, and no arithmetic on either value can make them equal.
      // `sale`, for the same reason as the deactivation case above.
      const epochBranch = await createBranch(testApp.dataSource);
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: epochBranch.id,
      });
      const token = accessTokenFor(user);

      const before = await connect(`kz_pos_access=${token}`);
      expect(before.disconnected).toBe(false);

      await testApp.dataSource.query(
        `UPDATE users SET "passwordVersion" = "passwordVersion" + 1 WHERE id = $1`,
        [user.id],
      );

      const after = await connect(`kz_pos_access=${token}`);
      expect(after.disconnected).toBe(true);
      expect(after.joined).toEqual([]);
    });

    it('for a token that carries no password-epoch claim at all', async () => {
      // Every token signed before migration 0027 is in this shape. It cannot
      // be placed in the version sequence, and "predates the mechanism" is not
      // a reason to trust it — the verifier fails CLOSED.
      const { user } = await createUser(testApp.dataSource);
      const legacy = signer.sign(
        {
          sub: user.id,
          identifier: user.username ?? user.mobile,
          roles: [],
          branch: user.branchId ?? null,
          aud: 'pos',
          typ: TOKEN_TYPE_ACCESS,
        },
        { expiresIn: '15m' },
      );

      const socket = await connect(`kz_pos_access=${legacy}`);
      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });
  });

  // ==========================================================================
  // Acceptance and room membership
  // ==========================================================================

  describe('accepts an authenticated connection', () => {
    it('joins the user room, and the branch room when the user has a branch', async () => {
      const branch = await createBranch(testApp.dataSource);
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });

      const socket = await connect(`kz_pos_access=${accessTokenFor(user)}`);

      expect(socket.disconnected).toBe(false);
      // A till joins the staff availability room (not branch-scoped: physical
      // stock is one number for the whole business) and its own branch room.
      expect(socket.joined.sort()).toEqual(
        [
          `user:${user.id}`,
          ROOM_STAFF_AVAILABILITY,
          `branch:${branch.id}`,
        ].sort(),
      );
      expect(socket.data).toMatchObject({
        userId: user.id,
        branchId: branch.id,
        roles: [UserRoleEnum.sale],
      });
    });

    it('joins the super-admin room only for a super_admin ON THE ADMIN SURFACE', async () => {
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.superAdmin],
      });

      const adminSocket = await connect(
        `kz_admin_access=${accessTokenFor(user, { aud: 'admin' })}`,
        {},
        'admin',
      );
      expect(adminSocket.disconnected).toBe(false);
      expect(adminSocket.joined).toContain(ROOM_SUPER_ADMIN);

      // The SAME person on the till does not get the operator console's room.
      // An administrator ringing up a sale is a cashier for that moment, and
      // the rooms follow the surface rather than the role.
      const tillSocket = await connect(`kz_pos_access=${accessTokenFor(user)}`);
      expect(tillSocket.disconnected).toBe(false);
      expect(tillSocket.joined).not.toContain(ROOM_SUPER_ADMIN);
    });
  });

  // ==========================================================================
  // The client cannot grant itself privileges
  // ==========================================================================

  describe('room membership is not client-grantable', () => {
    it('ignores roles, branch and room hints supplied by the client', async () => {
      const ownBranch = await createBranch(testApp.dataSource);
      const otherBranch = await createBranch(testApp.dataSource);
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: ownBranch.id,
      });

      // A token the client legitimately holds, but stuffed with claims it would
      // love to be believed: super_admin, someone else's branch. The claims are
      // correctly signed — this is not a forgery, it is the exact attack a
      // stolen-and-replayed handshake makes if roles are read from the token.
      const token = accessTokenFor(user, {
        roles: [UserRoleEnum.superAdmin],
        branch: otherBranch.id,
      });

      const socket = await connect(`kz_pos_access=${token}`, {
        // Nothing a client puts in the handshake may influence membership.
        'x-rooms': ROOM_SUPER_ADMIN,
      });

      expect(socket.disconnected).toBe(false);
      // Their REAL rooms, from the database: own user room, the staff
      // availability room their `pos.access` earns, and their OWN branch.
      expect(socket.joined.sort()).toEqual(
        [
          `user:${user.id}`,
          ROOM_STAFF_AVAILABILITY,
          `branch:${ownBranch.id}`,
        ].sort(),
      );
      // Not the room the claim asked for, and not the other shop's counter.
      expect(socket.joined).not.toContain(ROOM_SUPER_ADMIN);
      expect(socket.joined).not.toContain(`branch:${otherBranch.id}`);
      expect(socket.data).toMatchObject({
        roles: [UserRoleEnum.sale],
        branchId: ownBranch.id,
      });
    });

    it('refuses an audience the principal is not permitted, rather than degrading it', async () => {
      /*
       * THE STRONGER OUTCOME this pass introduced.
       *
       * A `site` customer holding a POS cookie used to authenticate
       * successfully and simply join no staff room. Authentication answered
       * "who is this?" and nobody asked "may they be here?", so the socket
       * existed at all — and every room decision after it was the only thing
       * standing between a customer and till traffic.
       *
       * `pos.access` is now required to open a POS socket, exactly as it is
       * required to open a POS HTTP session, so the answer is no socket.
       */
      const branch = await createBranch(testApp.dataSource);
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.site],
        branchId: branch.id,
      });

      const socket = await connect(
        `kz_pos_access=${accessTokenFor(user, { aud: 'pos' })}`,
      );

      expect(socket.disconnected).toBe(true);
      expect(socket.joined).toEqual([]);
    });

    it('grants admin membership from the DATABASE even when the token says otherwise', async () => {
      // The mirror image: roles come from the database, so a real admin whose
      // token predates the promotion is still admitted to `admins`.
      const { user } = await createUser(testApp.dataSource, {
        roles: [UserRoleEnum.superAdmin],
      });
      const token = accessTokenFor(user, {
        roles: [UserRoleEnum.site],
        aud: 'admin',
      });

      const socket = await connect(`kz_admin_access=${token}`, {}, 'admin');
      expect(socket.joined).toContain(ROOM_SUPER_ADMIN);
    });
  });

  // ==========================================================================
  // Cookie parsing — the handshake's first step
  // ==========================================================================

  describe('parseCookieHeader', () => {
    it('reads a normal header, quoted and encoded values, and duplicates', () => {
      expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
      expect(parseCookieHeader('a="quoted"')).toEqual({ a: 'quoted' });
      expect(parseCookieHeader('a=a%20b')).toEqual({ a: 'a b' });
      // First occurrence wins, matching the `cookie` package.
      expect(parseCookieHeader('a=1; a=2')).toEqual({ a: '1' });
      expect(parseCookieHeader(undefined)).toEqual({});
      // A JWT contains dots and dashes and must survive untouched.
      expect(parseCookieHeader('access_token=aa.bb-cc_dd')).toEqual({
        access_token: 'aa.bb-cc_dd',
      });
    });
  });
});
