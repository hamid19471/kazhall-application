import * as request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StringValue } from 'ms';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { AuthMessages } from 'src/common/constants/auth.messages';
import {
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
} from 'src/modules/auth/auth.types';
import { User } from 'src/modules/user/entities/user.entity';

import {
  authenticate,
  CookieJar,
  createTestApp,
  TestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createUser } from './setup/seed-helpers';

/**
 * SESSION AND TOKEN LIFECYCLE — verification against the real application.
 *
 * Everything here goes through the REAL AppModule, the REAL global
 * JwtAuthGuard/JwtStrategy and a REAL PostgreSQL. Nothing is stubbed, so a
 * green test means the deployed app behaves this way.
 *
 * Time is never faked by sleeping. Where a test needs a token that was issued
 * at a particular instant it MINTS one with the application's own signing
 * secret (read from the running app's ConfigService) and an explicit `iat` —
 * the token is then verified by the real guard exactly like any other. Each
 * such case is paired with a control assertion proving the same minting path
 * produces an ACCEPTED token, so a 401 can never be an artefact of the mint.
 */

/** Any authenticated, role-free route. Used purely as a "is this session live?" probe. */
const PROTECTED_ROUTE = '/cart';

// This spec exercises session MECHANICS — rotation, logout, the password-change
// cut-off — on one surface. `/cart` is a storefront route and every actor below
// is a `site` customer, so the storefront is the surface under test; the
// cross-surface rules have their own spec.
const AUDIENCE = 'storefront' as const;
const authBase = `/auth/${AUDIENCE}`;
const refreshPath = `${authBase}/refresh`;
const ACCESS_COOKIE = 'kz_storefront_access';
const REFRESH_COOKIE = 'kz_storefront_refresh';

const OK = [200, 201];

interface MintOptions {
  typ?: string;
  /** Seconds since epoch. Defaults to jsonwebtoken's "now". */
  iat?: number;
  /** Anything `expiresIn` accepts; negative values mint an already-expired token. */
  expiresIn?: StringValue | number;
  jti?: string;
  /**
   * The session epoch (`users."passwordVersion"`). Defaults to the fixture's
   * current value, which is what a real login would stamp.
   */
  pv?: number;
}

describe('auth session lifecycle', () => {
  let testApp: TestApp;
  /** Signs with the SAME secret the app verifies with. */
  let signer: JwtService;

  beforeAll(async () => {
    testApp = await createTestApp();
    const secret = testApp.app
      .get(ConfigService)
      .getOrThrow<string>('JWT_SECRET_KEY');
    signer = new JwtService({ secret });
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

  const staff = () =>
    createUser(testApp.dataSource, { roles: [UserRoleEnum.site] });

  const admin = () =>
    createUser(testApp.dataSource, { roles: [UserRoleEnum.superAdmin] });

  const mint = (user: User, options: MintOptions = {}): string =>
    signer.sign(
      {
        sub: user.id,
        identifier: user.username ?? user.mobile,
        roles: [],
        aud: AUDIENCE,
        branch: user.branchId ?? null,
        typ: options.typ ?? TOKEN_TYPE_ACCESS,
        // The session epoch. A hand-built token must carry it or the strategy
        // refuses it for the wrong reason — every token the application mints
        // has carried `pv` since migration 0027. A fresh fixture is at 1.
        pv: options.pv ?? user.passwordVersion ?? 1,
        ...(options.jti ? { jti: options.jti } : {}),
        ...(options.iat ? { iat: options.iat } : {}),
      },
      { expiresIn: options.expiresIn ?? '15m' },
    );

  /** Hits the probe route with one hand-built cookie header. */
  const probeWithAccessToken = (token: string) =>
    request(testApp.server)
      .get(PROTECTED_ROUTE)
      .set('Cookie', `${ACCESS_COOKIE}=${token}`);

  const refreshWith = (refreshToken: string) =>
    request(testApp.server)
      .post(refreshPath)
      .set('Cookie', `${REFRESH_COOKIE}=${refreshToken}`);

  /**
   * Ends the user's current password epoch, exactly as a real password change
   * does — atomically, in SQL, with no clock involved.
   *
   * It replaces `setPasswordChangedAt(userId, someInstant)`, which could only
   * express "the change happened at this timestamp" and therefore forced every
   * case around it to reason about whole seconds versus milliseconds.
   */
  const endPasswordEpoch = (userId: number) =>
    testApp.dataSource.query(
      `UPDATE users SET "passwordVersion" = "passwordVersion" + 1 WHERE id = $1`,
      [userId],
    );

  const passwordVersionOf = async (userId: number): Promise<number> => {
    const [row] = await testApp.dataSource.query<
      Array<{ passwordVersion: number }>
    >(`SELECT "passwordVersion" FROM users WHERE id = $1`, [userId]);
    return Number(row.passwordVersion);
  };

  const refreshTokenRows = (userId: number) =>
    testApp.dataSource.query<Array<{ tokenId: string; revoked: boolean }>>(
      `SELECT "tokenId", revoked FROM refresh_tokens WHERE "userId" = $1`,
      [userId],
    );

  // ==========================================================================
  // 1. Expired access token + valid refresh token
  // ==========================================================================

  describe('expired access token', () => {
    it('rejects an expired access token but lets the refresh flow restore access', async () => {
      const { user, username, password } = await staff();
      const jar = await authenticate(testApp, username, password);

      // Control 1: the session and the probe route work at all.
      await withCookies(testApp, jar).get(PROTECTED_ROUTE).expect(200);

      // Control 2: a token minted here, unexpired, is ACCEPTED. This is what
      // makes the rejection below attributable to expiry and nothing else.
      await probeWithAccessToken(mint(user, { expiresIn: '15m' })).expect(200);

      const expired = await probeWithAccessToken(
        mint(user, { expiresIn: '-60s' }),
      );
      expect(expired.status).toBe(401);
      expect(expired.body.message).toBe(AuthMessages.TOKEN_EXPIRED);

      // The refresh token is untouched by the failed request and still works.
      const refreshed = await refreshWith(jar.get(REFRESH_COOKIE) as string);
      expect(OK).toContain(refreshed.status);

      const rotated = new CookieJar().absorb(refreshed);
      expect(rotated.get(ACCESS_COOKIE)).toBeDefined();
      // The REFRESH token is what must change — rotation is the security
      // property. The access token is deliberately not asserted to differ: two
      // access tokens minted for the same user in the same second carry
      // identical claims and are therefore byte-identical, which is a property
      // of JWT, not a rotation failure.
      expect(rotated.get(REFRESH_COOKIE)).not.toBe(jar.get(REFRESH_COOKIE));

      // And the brand new access token authenticates.
      await withCookies(testApp, rotated).get(PROTECTED_ROUTE).expect(200);
    });

    it('rejects a request that carries no access token at all', async () => {
      const anonymous = await request(testApp.server).get(PROTECTED_ROUTE);
      expect(anonymous.status).toBe(401);
    });
  });

  // ==========================================================================
  // 2. Refresh-as-access (and access-as-refresh)
  // ==========================================================================

  describe('token purpose', () => {
    it('refuses a refresh token presented as an access token', async () => {
      const { username, password } = await staff();
      const jar = await authenticate(testApp, username, password);

      const refreshToken = jar.get(REFRESH_COOKIE) as string;
      expect(refreshToken).toBeDefined();
      // It really is a refresh token: same secret, `typ: refresh`.
      expect(signer.decode<{ typ?: string }>(refreshToken)?.typ).toBe(
        TOKEN_TYPE_REFRESH,
      );

      const response = await probeWithAccessToken(refreshToken);
      expect(response.status).toBe(401);
      expect(response.body.message).toBe(AuthMessages.WRONG_TOKEN_TYPE);

      // Rejecting it must not have consumed the token: it is still rotatable.
      const rotated = await refreshWith(refreshToken);
      expect(OK).toContain(rotated.status);
    });

    it('refuses an access token presented at the refresh endpoint', async () => {
      const { username, password } = await staff();
      const jar = await authenticate(testApp, username, password);

      const response = await refreshWith(jar.get(ACCESS_COOKIE) as string);
      expect(response.status).toBe(401);
    });

    it('refuses a token that carries no purpose claim at all', async () => {
      // Tokens minted before `typ` existed must not be a bypass.
      const { user } = await staff();
      const legacy = signer.sign(
        { sub: user.id, identifier: user.username, roles: [], branch: null },
        { expiresIn: '15m' },
      );
      const response = await probeWithAccessToken(legacy);
      expect(response.status).toBe(401);
    });
  });

  // ==========================================================================
  // 3. Concurrent refresh rotation
  // ==========================================================================

  describe('concurrent refresh rotation', () => {
    /**
     * DOCUMENTED GUARANTEE (AuthService.refreshToken): exactly one racer wins.
     * Revocation is a guarded conditional UPDATE
     * (`SET revoked = true WHERE tokenId = :id AND revoked = false`) whose
     * affected-row count must be 1, executed in the same transaction that
     * inserts the replacement. So N concurrent rotations of one token must
     * yield 1 success and N-1 rejections — never two live token families.
     */
    it('lets exactly one of five concurrent rotations win', async () => {
      const { user, username, password } = await staff();
      const jar = await authenticate(testApp, username, password);
      const refreshToken = jar.get(REFRESH_COOKIE) as string;

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => refreshWith(refreshToken)),
      );

      const winners = responses.filter((r) => OK.includes(r.status));
      const losers = responses.filter((r) => r.status === 401);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);

      // The database agrees: the old row is revoked and exactly ONE live
      // replacement exists. Two live rows here would mean a stolen refresh
      // token had been forked into two independent sessions.
      const rows = await refreshTokenRows(user.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => !row.revoked)).toHaveLength(1);

      // The winner's tokens are genuinely usable...
      const rotated = new CookieJar().absorb(winners[0]);
      await withCookies(testApp, rotated).get(PROTECTED_ROUTE).expect(200);

      // ...and the consumed token cannot be replayed.
      const replay = await refreshWith(refreshToken);
      expect(replay.status).toBe(401);
    });
  });

  // ==========================================================================
  // 4. Logout under the documented session policy
  // ==========================================================================

  describe('logout (documented policy: CURRENT SESSION ONLY)', () => {
    it('revokes only the presented session and clears both cookies', async () => {
      const { username, password } = await staff();
      const phone = await authenticate(testApp, username, password);
      const till = await authenticate(testApp, username, password);
      expect(phone.get(REFRESH_COOKIE)).not.toBe(till.get(REFRESH_COOKIE));

      // Captured before the logout response clears it from the jar, so the
      // replay below uses exactly the token that session held.
      const phoneRefresh = phone.get(REFRESH_COOKIE) as string;

      const response = await withCookies(testApp, phone).post(
        `${authBase}/logout`,
      );
      expect(response.status).toBe(200);
      expect(response.body.revoked).toBe(1);

      // Both cookies are actively cleared, not merely left to expire.
      const cleared = response.headers['set-cookie'] as unknown as string[];
      expect(cleared.some((c) => c.startsWith('access_token=;'))).toBe(true);
      expect(cleared.some((c) => c.startsWith('refresh_token=;'))).toBe(true);
      phone.absorb(response);
      expect(phone.has(ACCESS_COOKIE)).toBe(false);
      expect(phone.has(REFRESH_COOKIE)).toBe(false);

      // The logged-out session's refresh token is dead...
      const replay = await refreshWith(phoneRefresh);
      expect(replay.status).toBe(401);

      // ...while the OTHER session is completely unaffected: this is the whole
      // point of the policy (signing out of a phone must not sign the POS
      // terminal out mid-sale).
      await withCookies(testApp, till).get(PROTECTED_ROUTE).expect(200);
      const tillRefresh = await refreshWith(till.get(REFRESH_COOKIE) as string);
      expect(OK).toContain(tillRefresh.status);
    });

    it('logout-all revokes every session of the caller', async () => {
      const { user, username, password } = await staff();
      const first = await authenticate(testApp, username, password);
      const second = await authenticate(testApp, username, password);

      const response = await withCookies(testApp, first).post(
        `${authBase}/logout-all`,
      );
      expect(response.status).toBe(200);
      expect(response.body.revoked).toBe(2);

      expect(
        (await refreshWith(second.get(REFRESH_COOKIE) as string)).status,
      ).toBe(401);

      const rows = await refreshTokenRows(user.id);
      expect(rows.filter((row) => !row.revoked)).toHaveLength(0);
    });

    it('is idempotent: logging out twice, or with no cookie, still succeeds', async () => {
      const { username, password } = await staff();
      const jar = await authenticate(testApp, username, password);

      const first = await withCookies(testApp, jar).post(`${authBase}/logout`);
      expect(first.body.revoked).toBe(1);

      // Same (now revoked) cookie again — no throw, nothing more revoked.
      const second = await request(testApp.server)
        .post(`${authBase}/logout`)
        .set('Cookie', `refresh_token=${jar.get(REFRESH_COOKIE) ?? ''}`);
      expect(second.status).toBe(200);
      expect(second.body.revoked).toBe(0);

      const bare = await request(testApp.server).post(`${authBase}/logout`);
      expect(bare.status).toBe(200);
      expect(bare.body.revoked).toBe(0);
    });
  });

  // ==========================================================================
  // 5. Password-change invalidation
  // ==========================================================================

  describe('password change invalidates existing sessions', () => {
    it('rejects an access token minted before the change (real PATCH /users/:id)', async () => {
      const { user: victim } = await staff();
      const {
        user: superAdmin,
        username: adminName,
        password: adminPassword,
      } = await admin();
      const adminJar = await authenticate(testApp, adminName, adminPassword);
      expect(superAdmin.id).toBeGreaterThan(0);

      // A token demonstrably issued five seconds ago — and demonstrably valid.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = mint(victim, { iat: nowSeconds - 5, expiresIn: '15m' });
      await probeWithAccessToken(token).expect(200);

      const changed = await withCookies(testApp, adminJar)
        .patch(`/users/${victim.id}`)
        .send({ password: 'N3wPassw0rd!x' });
      expect(OK).toContain(changed.status);

      // The real service stamped the column...
      const [row] = await testApp.dataSource.query<
        Array<{ passwordChangedAt: Date | null }>
      >(`SELECT "passwordChangedAt" FROM users WHERE id = $1`, [victim.id]);
      expect(row.passwordChangedAt).not.toBeNull();

      // ...and the pre-existing session is dead.
      const after = await probeWithAccessToken(token);
      expect(after.status).toBe(401);
      expect(after.body.message).toBe(AuthMessages.SESSION_INVALIDATED);
    });

    /**
     * THE SHARP EDGE THAT NO LONGER EXISTS.
     *
     * This used to be two cases arguing about ONE SECOND. A JWT `iat` is in
     * whole seconds; `users."passwordChangedAt"` has microsecond precision. A
     * token minted in the same second as a change could not be ordered against
     * it, so the comparison was made in milliseconds against the START of the
     * token's second and deliberately failed CLOSED — safe, but it meant a
     * legitimate login landing in that second was rejected once and worked on
     * retry.
     *
     * `passwordVersion` removes the ambiguity rather than choosing a side of
     * it. The two cases below are the same two boundaries, restated in terms
     * that have no boundary: a token from the previous epoch is dead, and a
     * token from the current epoch is alive, however close together in time
     * the two events were.
     */
    it('rejects a token from the previous epoch, however recently it was minted', async () => {
      const { user } = await staff();
      const token = mint(user, { expiresIn: '15m' });
      await probeWithAccessToken(token).expect(200);

      // No timestamp anywhere. The epoch simply moves on.
      await endPasswordEpoch(user.id);

      const response = await probeWithAccessToken(token);
      expect(response.status).toBe(401);
      expect(response.body.message).toBe(AuthMessages.SESSION_INVALIDATED);
    });

    it('accepts a token minted in the SAME instant the epoch advanced, if it carries the new version', async () => {
      /*
       * THE CASE THAT USED TO BE IMPOSSIBLE TO GET RIGHT.
       *
       * Under the timestamp rule this token would have been rejected: its
       * `iat` second began before `passwordChangedAt`, and the comparison
       * failed closed. There is no wall-clock gap engineered here and no
       * `awaitNextSecond()` — the change and the new session happen as fast as
       * two statements can run, which is the point.
       */
      const { user } = await staff();
      await endPasswordEpoch(user.id);
      const newVersion = await passwordVersionOf(user.id);
      expect(newVersion).toBe(2);

      const token = mint(user, { expiresIn: '15m', pv: newVersion });
      await probeWithAccessToken(token).expect(200);
    });

    it('rejects a token that carries no epoch claim at all', async () => {
      // The shape of every token signed before migration 0027. It cannot be
      // placed in the version sequence, so it is refused rather than trusted.
      const { user } = await staff();
      const legacy = signer.sign(
        {
          sub: user.id,
          identifier: user.username ?? user.mobile,
          roles: [],
          aud: AUDIENCE,
          branch: user.branchId ?? null,
          typ: TOKEN_TYPE_ACCESS,
        },
        { expiresIn: '15m' },
      );

      const response = await probeWithAccessToken(legacy);
      expect(response.status).toBe(401);
      expect(response.body.message).toBe(AuthMessages.SESSION_INVALIDATED);
    });

    /**
     * The access token is only half of a session. Killing it while leaving the
     * REFRESH token rotatable is no invalidation at all: the holder simply
     * rotates and receives a brand new access token whose `iat` now postdates
     * the change.
     */
    it('refuses to rotate a refresh token from the previous epoch', async () => {
      const { user, username, password } = await staff();
      const jar = await authenticate(testApp, username, password);
      const refreshToken = jar.get(REFRESH_COOKIE) as string;

      await endPasswordEpoch(user.id);

      const response = await refreshWith(refreshToken);
      expect(response.status).toBe(401);

      // And nothing was minted behind the rejection.
      const rows = await refreshTokenRows(user.id);
      expect(rows).toHaveLength(1);
    });
  });
});
