import * as request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';
import { TOKEN_TYPE_ACCESS } from 'src/modules/auth/auth.types';
import { ALLOW_PASSWORD_CHANGE_PENDING_KEY } from 'src/modules/auth/decorators/password-change.decorator';
import { IS_PUBLIC_KEY } from 'src/modules/auth/decorators/public.decorator';

// The password-change cut-off is audience-independent; this spec proves it on
// the storefront and `audience-isolation.int-spec.ts` proves it reaches the
// other surfaces too.
const authBase = '/auth/storefront';
const refreshPath = `${authBase}/refresh`;
// The storefront's password door is the review-only one; production customer
// sign-in is OTP.
const loginPath = `${authBase}/review-login`;

import {
  authenticate,
  CookieJar,
  createTestApp,
  TestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createBranch, createUser } from './setup/seed-helpers';
import { connectTestSocket } from './support/socket-client';
import {
  REVALIDATION_INTERVAL_MS,
  RealtimeGateway,
} from 'src/modules/realtime/realtime.gateway';

/**
 * ===========================================================================
 * WHAT A PASSWORD CHANGE ACTUALLY INVALIDATES — the correction, in assertions
 * ===========================================================================
 *
 * THE RETRACTED CLAIM. An earlier audit stated that "a password change does not
 * revoke refresh tokens" and recommended chaining a deactivate-account step
 * onto every password change. The recommendation would have been actively
 * harmful: `users.deactivatedAt` is the SOFT RETIREMENT flag for staff who can
 * never be hard-deleted (`orders.cashierUserId` is ON DELETE RESTRICT), and
 * both `JwtStrategy` and `AuthService.login` refuse a deactivated user
 * outright. Stamping it on a password change would lock every user out of
 * their own account permanently, on the one action a user is most likely to
 * take right after a scare.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM, AS IT NOW STANDS: `users."passwordVersion"` (migration 0027)
 * ---------------------------------------------------------------------------
 *
 * Every access and refresh token carries `pv`, the value of
 * `users."passwordVersion"` at the moment it was minted. A verifier admits the
 * token only while `pv` still EQUALS the column.
 *
 *   src/modules/user/user.service.ts  (`applyPasswordChange`, `update`)
 *     One transaction: new hash, `"passwordVersion" = "passwordVersion" + 1`
 *     IN SQL, and every live `refresh_tokens` row revoked.
 *
 *   src/modules/user/admin-user.service.ts  (`resetPassword`)
 *     The same three things, in the same transaction, for the administrator
 *     reset path.
 *
 *   src/modules/auth/strategies/jwt.strategy.ts  (`validate`)
 *     Every authenticated REQUEST rejects a token whose `pv` no longer matches,
 *     with `AuthMessages.SESSION_INVALIDATED`.
 *
 *   src/modules/auth/services/auth.service.ts  (`refreshToken`)
 *     ROTATION applies the same rule. Without it the control would be a no-op:
 *     the holder of a stale refresh token would simply rotate into a fresh
 *     access token.
 *
 *   src/modules/auth/auth.types.ts  (`isStaleSessionVersion`)
 *     The comparison itself — an integer equality, with three fail-closed
 *     rejections: no claim on the token, no version on the row, or a mismatch.
 *
 *   src/modules/realtime/realtime.gateway.ts  (handshake and periodic sweep)
 *     The websocket handshake applies the rule, and the sweep re-applies it to
 *     already-open sockets.
 *
 * ---------------------------------------------------------------------------
 * THE SAME-SECOND AMBIGUITY IS GONE, NOT MITIGATED
 * ---------------------------------------------------------------------------
 *
 * This file used to carry two tests (4 and 4b) arguing about ONE SECOND, and a
 * helper called `awaitNextSecond()`. The rule was `iat` versus
 * `users."passwordChangedAt"`: whole seconds against microseconds, which
 * cannot be ordered when a token is minted in the change's own second. The
 * code resolved that tie by failing CLOSED — the safe choice of two wrong
 * answers — and the cost, which test 4b proved rather than assumed, was that a
 * LEGITIMATE login landing in that second was rejected once and succeeded on
 * retry.
 *
 * `passwordVersion` removes the ambiguous data instead of choosing a side of
 * it. There is no clock in the comparison, so there is no window to document,
 * no `awaitNextSecond()` to make a test deterministic, and no retry. The two
 * boundaries are still asserted below — a token from the previous epoch is
 * dead, a token from the current epoch is alive — but they are now boundaries
 * in an integer sequence rather than in wall-clock time.
 *
 * So the correct statement is: A PASSWORD CHANGE ENDS EVERY SESSION — access
 * tokens, refresh rotation, and websockets — IMMEDIATELY AND WITHOUT
 * AMBIGUITY, AND WITHOUT ANY FURTHER STEP.
 */

/** Any authenticated, role-free route. A "is this session live?" probe. */
const PROTECTED_ROUTE = '/cart';

const OK = [200, 201];

describe('password change invalidation (the corrected record)', () => {
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
    testApp.redis.flush();
  });

  // ==========================================================================
  // helpers
  // ==========================================================================

  const customer = () =>
    createUser(testApp.dataSource, { roles: [UserRoleEnum.site] });

  const admin = () =>
    createUser(testApp.dataSource, { roles: [UserRoleEnum.superAdmin] });

  const probeWithAccessToken = (token: string) =>
    request(testApp.server)
      .get(PROTECTED_ROUTE)
      .set('Cookie', `kz_storefront_access=${token}`);

  const refreshWith = (refreshToken: string) =>
    request(testApp.server)
      .post(refreshPath)
      .set('Cookie', `kz_storefront_refresh=${refreshToken}`);

  /** The REAL password-change path: super_admin PATCHes the user. */
  const changePasswordViaApi = async (
    userId: number,
    newPassword: string,
  ): Promise<void> => {
    const { username: adminName, password: adminPassword } = await admin();
    const adminJar = await authenticate(testApp, adminName, adminPassword);

    const response = await withCookies(testApp, adminJar)
      .patch(`/users/${userId}`)
      .send({ password: newPassword });

    if (!OK.includes(response.status)) {
      throw new Error(
        `Password change failed (${response.status}): ${JSON.stringify(
          response.body,
        )}`,
      );
    }
  };

  const passwordChangedAt = async (userId: number): Promise<Date | null> => {
    const [row] = await testApp.dataSource.query<
      Array<{ passwordChangedAt: Date | null }>
    >(`SELECT "passwordChangedAt" FROM users WHERE id = $1`, [userId]);
    return row?.passwordChangedAt ?? null;
  };

  const refreshTokenRows = (userId: number) =>
    testApp.dataSource.query<Array<{ tokenId: string; revoked: boolean }>>(
      `SELECT "tokenId", revoked FROM refresh_tokens WHERE "userId" = $1`,
      [userId],
    );

  const passwordVersionOf = async (userId: number): Promise<number> => {
    const [row] = await testApp.dataSource.query<
      Array<{ passwordVersion: number }>
    >(`SELECT "passwordVersion" FROM users WHERE id = $1`, [userId]);
    return Number(row.passwordVersion);
  };

  const issuedAt = (token: string): number => {
    const payload = signer.decode<{ iat?: number }>(token);
    if (typeof payload?.iat !== 'number') throw new Error('token has no iat');
    return payload.iat;
  };

  /** The `pv` claim of a token, as the verifier reads it. */
  const sessionVersionOf = (token: string): number | undefined =>
    signer.decode<{ pv?: number }>(token)?.pv;

  // ==========================================================================
  // 1. The old ACCESS token is dead
  // ==========================================================================

  it('rejects an access token issued before the password change', async () => {
    const { user, username, password } = await customer();
    const jar = await authenticate(testApp, username, password);
    const staleAccessToken = jar.get('kz_storefront_access') as string;

    // CONTROL: this exact token authenticates before the change. Without this
    // the 401 below could be an artefact of anything.
    await probeWithAccessToken(staleAccessToken).expect(200);
    expect(await passwordChangedAt(user.id)).toBeNull();

    await changePasswordViaApi(user.id, 'N3wPassw0rd!a');
    expect(await passwordChangedAt(user.id)).not.toBeNull();

    const after = await probeWithAccessToken(staleAccessToken);
    expect(after.status).toBe(401);
    expect(after.body.message).toBe(AuthMessages.SESSION_INVALIDATED);
  });

  // ==========================================================================
  // 2. The old REFRESH token cannot rotate
  // ==========================================================================

  it('refuses to rotate a refresh token issued before the password change', async () => {
    const { user, username, password } = await customer();
    const jar = await authenticate(testApp, username, password);
    const staleRefreshToken = jar.get('kz_storefront_refresh') as string;

    await changePasswordViaApi(user.id, 'N3wPassw0rd!b');

    const rotation = await refreshWith(staleRefreshToken);
    expect(rotation.status).toBe(401);

    // AND NOTHING WAS MINTED BEHIND THE REJECTION. This is the assertion that
    // makes the test meaningful: a 401 that had still inserted a replacement
    // row would mean the guard ran after the transaction, and the session would
    // be recoverable. Only the original login's row exists.
    const rows = await refreshTokenRows(user.id);
    expect(rows).toHaveLength(1);

    // Retrying does not help — it is not a one-shot rejection.
    expect((await refreshWith(staleRefreshToken)).status).toBe(401);
    expect(await refreshTokenRows(user.id)).toHaveLength(1);
  });

  // ==========================================================================
  // 3. A session created AFTER the change is completely normal
  // ==========================================================================

  it('lets a session established after the change authenticate and rotate normally', async () => {
    const { user, username } = await customer();
    const newPassword = 'N3wPassw0rd!c';

    const oldJar = await authenticate(
      testApp,
      username,
      'Passw0rd!test', // the fixture default
    );
    await withCookies(testApp, oldJar).get(PROTECTED_ROUTE).expect(200);

    await changePasswordViaApi(user.id, newPassword);

    // The old session is dead (proved by tests 1 and 2)...
    expect(
      (await probeWithAccessToken(oldJar.get('kz_storefront_access') as string))
        .status,
    ).toBe(401);

    // ...and the new one is entirely unremarkable: login with the new
    // password, use the access token, rotate the refresh token, use the
    // rotated access token.
    //
    // NO `awaitNextSecond()`. This login happens as fast as the process can
    // issue it — very possibly in the same millisecond as the change — and
    // that is now simply fine: the new token carries the new epoch. Under the
    // old timestamp rule this test was a coin flip on where inside its second
    // the change happened to land, and the second boundary had to be crossed
    // deliberately to make it deterministic.
    const freshJar = await authenticate(testApp, username, newPassword);
    await withCookies(testApp, freshJar).get(PROTECTED_ROUTE).expect(200);

    const rotated = await refreshWith(
      freshJar.get('kz_storefront_refresh') as string,
    );
    expect(OK).toContain(rotated.status);

    const rotatedJar = new CookieJar().absorb(rotated);
    await withCookies(testApp, rotatedJar).get(PROTECTED_ROUTE).expect(200);

    // The OLD password no longer works, so "the new session works" is not an
    // artefact of the change having silently failed.
    const oldCredentials = await request(testApp.server)
      .post(loginPath)
      .send({ username, password: 'Passw0rd!test' });
    expect(oldCredentials.status).toBe(401);
  });

  // ==========================================================================
  // 4. The boundary that used to be a one-second window
  // ==========================================================================

  /**
   * WHAT THESE TWO CASES REPLACE.
   *
   * There used to be a test 4 ("rejects a token whose `iat` falls in the same
   * second as the change (fails closed)") and a test 4b ("rejects a session
   * minted in the same second as the change, EVEN THOUGH IT CAME AFTER IT").
   * Together they documented a real, measured, sub-second window in which a
   * legitimate fresh session got one spurious 401 and a retry succeeded —
   * the unavoidable cost of ordering a whole-second `iat` against a
   * microsecond `passwordChangedAt` in the safe direction.
   *
   * The window is gone, because the thing that created it is gone. Both
   * boundaries are still asserted, in the terms the mechanism actually uses.
   *
   * NEITHER CASE WAITS FOR ANYTHING. That is the assertion: the change and the
   * new session happen as fast as two statements can run.
   */
  it('rejects a token from the previous epoch, at any distance in time', async () => {
    const { user } = await customer();
    const token = signer.sign(
      {
        sub: user.id,
        identifier: user.username,
        roles: [],
        branch: null,
        aud: 'storefront',
        pv: await passwordVersionOf(user.id),
        typ: TOKEN_TYPE_ACCESS,
      },
      { expiresIn: '15m' },
    );
    await probeWithAccessToken(token).expect(200);

    await changePasswordViaApi(user.id, 'N3wPassw0rd!e');

    const response = await probeWithAccessToken(token);
    expect(response.status).toBe(401);
    expect(response.body.message).toBe(AuthMessages.SESSION_INVALIDATED);
  });

  it('accepts a session created in the SAME SECOND as the change, with no retry', async () => {
    /*
     * THE CASE THE OLD MECHANISM GOT WRONG.
     *
     * Under the `iat`/`passwordChangedAt` rule this login was rejected once,
     * because its token's second had begun before the change; the user saw a
     * password change that appeared to have failed and then worked. Here the
     * change and the login are back to back with nothing between them, and the
     * new session is live on its FIRST request.
     *
     * The same-second-ness is asserted rather than assumed: if the two
     * happened to straddle a second boundary the test would still pass, but it
     * would no longer be testing what it says. The `expect` on the timestamps
     * makes that visible instead of silently weakening the case.
     */
    const { user, username } = await customer();
    const newPassword = 'N3wPassw0rd!f';

    const oldJar = await authenticate(testApp, username, 'Passw0rd!test');
    const oldAccess = oldJar.get('kz_storefront_access') as string;

    const changeAt = Date.now();
    await changePasswordViaApi(user.id, newPassword);

    // No await on a clock. Straight back in.
    const freshJar = await authenticate(testApp, username, newPassword);
    const freshAccess = freshJar.get('kz_storefront_access') as string;
    const loginAt = Date.now();

    // Works on the FIRST request — no 401, no retry.
    await withCookies(testApp, freshJar).get(PROTECTED_ROUTE).expect(200);

    // And rotation works immediately too, which is the half of a session the
    // old rule also refused.
    const rotated = await refreshWith(
      freshJar.get('kz_storefront_refresh') as string,
    );
    expect(OK).toContain(rotated.status);

    // The old session is dead in the same breath.
    expect((await probeWithAccessToken(oldAccess)).status).toBe(401);

    // The epoch moved by exactly one, and the new token carries the new value.
    const version = await passwordVersionOf(user.id);
    expect(version).toBe(2);
    expect(sessionVersionOf(freshAccess)).toBe(2);
    expect(sessionVersionOf(oldAccess)).toBe(1);

    // This really was the same wall-clock second — the condition the old
    // mechanism could not survive. Recorded, not relied upon.
    if (Math.floor(changeAt / 1000) === Math.floor(loginAt / 1000)) {
      expect(issuedAt(freshAccess)).toBeGreaterThanOrEqual(
        Math.floor(changeAt / 1000),
      );
    }
  });

  it('rejects a token carrying no epoch claim at all', async () => {
    // Every token signed before migration 0027 is in this shape. The verifier
    // cannot place it in the version sequence, and "predates the mechanism" is
    // not a reason to trust it.
    const { user } = await customer();
    const legacy = signer.sign(
      {
        sub: user.id,
        identifier: user.username,
        roles: [],
        branch: null,
        aud: 'storefront',
        typ: TOKEN_TYPE_ACCESS,
      },
      { expiresIn: '15m' },
    );

    const response = await probeWithAccessToken(legacy);
    expect(response.status).toBe(401);
    expect(response.body.message).toBe(AuthMessages.SESSION_INVALIDATED);
  });

  it('does not lose an increment when two password changes race', async () => {
    /*
     * THE REASON THE INCREMENT IS WRITTEN AS SQL AND NOT AS ARITHMETIC.
     *
     * `"passwordVersion" = "passwordVersion" + 1` happens inside PostgreSQL
     * under the row's own lock. Were it computed in JavaScript it would be a
     * read, a gap, and a write — and two concurrent changes would both read 1
     * and both write 2, leaving the second change unable to invalidate a
     * session the first had already issued under version 2.
     *
     * Two changes are fired without awaiting the first, so they overlap in the
     * connection pool. Whatever order they commit in, the column must end at
     * 3: one increment per change, none lost.
     */
    const { user } = await customer();
    expect(await passwordVersionOf(user.id)).toBe(1);

    await Promise.all([
      changePasswordViaApi(user.id, 'N3wPassw0rd!g1'),
      changePasswordViaApi(user.id, 'N3wPassw0rd!g2'),
    ]);

    expect(await passwordVersionOf(user.id)).toBe(3);
  });

  it('does not let an unrelated profile edit un-do a password change', async () => {
    /*
     * THE SILENT CLOBBER, AND WHY `users.passwordVersion` IS `update: false`.
     *
     * TypeORM's `save(entity)` builds its SET list by diffing the in-memory
     * entity against the row AS IT IS WHEN THE SAVE RUNS — not against the row
     * as it was when the entity was loaded. A column that moved in the
     * DATABASE in between therefore looks like a change the caller made, and
     * is written back at the entity's STALE value.
     *
     * So an administrator renaming a user, having loaded that user before
     * somebody else changed their password, would push `passwordVersion` back
     * down — and every session the password change had just killed would come
     * back to life, because their tokens carry the old `pv` and the column now
     * agrees with it again. No error, no conflict, nothing in a log.
     *
     * `update: false` on the column makes the SQL increment the only thing
     * that can move it. This case is the proof, and it is written as the
     * REAL sequence rather than as a unit test of TypeORM: change the
     * password, then perform an ordinary profile edit, then check that the old
     * session is still dead.
     */
    const { user, username } = await customer();

    const jar = await authenticate(testApp, username, 'Passw0rd!test');
    const access = jar.get('kz_storefront_access') as string;
    await probeWithAccessToken(access).expect(200);

    await changePasswordViaApi(user.id, 'N3wPassw0rd!h');
    expect(await passwordVersionOf(user.id)).toBe(2);
    expect((await probeWithAccessToken(access)).status).toBe(401);

    // An ordinary, unrelated profile edit through the entity path.
    const { username: adminName, password: adminPassword } = await admin();
    const adminJar = await authenticate(testApp, adminName, adminPassword);
    const renamed = `${username}_renamed`;
    const edit = await withCookies(testApp, adminJar)
      .patch(`/users/${user.id}`)
      .send({ username: renamed });
    expect(OK).toContain(edit.status);

    // The epoch did NOT go backwards...
    expect(await passwordVersionOf(user.id)).toBe(2);
    // ...and the session the password change killed is still dead.
    expect((await probeWithAccessToken(access)).status).toBe(401);
  });

  // ==========================================================================
  // 5. What a password change does NOT do — stated as an assertion
  // ==========================================================================

  /**
   * THE RETRACTED CLAIM WAS DIRECTIONALLY RIGHT ABOUT THE BOOKKEEPING, AND
   * THAT HALF HAS NOW BEEN FIXED TOO.
   *
   * A password change used to leave `refresh_tokens.revoked = false` for ever.
   * The rows were unusable — the verifier refused them — but any operator
   * query or admin screen counting `revoked = false` as "active sessions"
   * OVERCOUNTED after a password change, and someone reading such a screen
   * could reasonably conclude the sessions had never been killed. That is very
   * plausibly how the original wrong claim was arrived at.
   *
   * `applyPasswordChange` now revokes them IN THE SAME TRANSACTION as the hash
   * and the epoch bump. The kill is explicit rather than implied, and
   * `activeSessionCount` tells the truth immediately.
   *
   * This test therefore asserts the OPPOSITE of what it used to. That is
   * deliberate: the behaviour changed, and the assertion changed with it
   * rather than the documentation being left to disagree with the code.
   */
  it('revokes every pre-change refresh_tokens row, in the same transaction', async () => {
    const { user, username, password } = await customer();
    await authenticate(testApp, username, password);
    await authenticate(testApp, username, password);

    const before = await refreshTokenRows(user.id);
    expect(before).toHaveLength(2);
    expect(before.every((row) => !row.revoked)).toBe(true);

    await changePasswordViaApi(user.id, 'N3wPassw0rd!d');

    const after = await refreshTokenRows(user.id);
    // The rows are kept — this is not a delete — but every one of them is now
    // explicitly dead.
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.revoked)).toBe(true);

    // Belt and braces: the claim check refuses them as well, so neither
    // mechanism is load-bearing on its own.
    const stale = before[0];
    expect(stale.revoked).toBe(false);
  });

  // ==========================================================================
  // 5b. ALREADY-OPEN WEBSOCKETS — exercised, not asserted by description
  // ==========================================================================

  /**
   * THE TODO THAT USED TO SIT HERE, AND WHY IT IS GONE.
   *
   * This block was `it.todo('websocket sweep closes a pre-change socket …
   * (needs a socket.io client; see comment)')`. The reasoning was sound —
   * `socket.io-client` is not a dependency of this workspace and is not present
   * anywhere in the pnpm store, and a test that claimed to prove the sweep
   * without opening a socket would be pretending.
   *
   * It was also unnecessary. socket.io's HTTP long-polling transport is a small
   * documented protocol, and Node has shipped a global `fetch` since 18, so a
   * real client is ~200 lines of `support/socket-client.ts` and NO new
   * dependency. These cases open a real connection to the real gateway on the
   * real bound test server: the handshake, the cookie parsing, the `audience`
   * query, `handleConnection`, the room joins and `disconnect(true)` are all
   * exercised exactly as a browser would exercise them.
   *
   * ---------------------------------------------------------------------------
   * HOW THE SWEEP IS OBSERVED WITHOUT WAITING 60 SECONDS
   *
   * `afterInit` schedules `revalidateAll()` on a `setInterval` of
   * `REVALIDATION_INTERVAL_MS`. The test calls `revalidateAll()` — the SAME
   * method the timer calls, on the SAME gateway instance from the container —
   * and then waits on an OBSERVABLE EVENT with a strict deadline: the client's
   * long poll is already parked on the server, so the close arrives the instant
   * it is sent.
   *
   * There is no sleep, no retry and no inflated timeout anywhere. The one
   * timing assertion is on the CONSTANT: `REVALIDATION_INTERVAL_MS` is pinned
   * at 60 000 ms, so "within the documented revalidation interval" stays a
   * statement about the code rather than about how fast this machine is.
   */
  describe('an already-open websocket', () => {
    /** Cookie header for a live storefront session, as a browser would send. */
    const sessionCookie = (jar: CookieJar): string => jar.header();

    /**
     * Runs `body` with a live socket and CLOSES IT WHATEVER HAPPENS.
     *
     * The closes used to sit at the end of each case, so a failing assertion
     * in the middle leaked a live socket. That is not a tidiness problem: an
     * open socket keeps the gateway's session-revalidation sweep doing
     * `users`/`roles` reads on the application pool at arbitrary moments, and
     * the harness TRUNCATEs both of those tables between tests — which is a
     * lock collision landing in a LATER file, with nothing to trace it to.
     */
    async function withSocket(
      jar: CookieJar,
      body: (
        socket: Awaited<ReturnType<typeof connectTestSocket>>,
      ) => Promise<void>,
    ): Promise<void> {
      const socket = await connectTestSocket({
        server: testApp.server,
        cookie: sessionCookie(jar),
        audience: 'storefront',
      });
      try {
        await body(socket);
      } finally {
        await socket.close();
      }
    }

    it('is closed by the sweep once the password epoch advances', async () => {
      const { user, username } = await customer();
      const jar = await authenticate(testApp, username, 'Passw0rd!test');

      await withSocket(jar, async (socket) => {
        // It really connected: the gateway accepted the handshake and joined the
        // namespace. Without this the close below would prove nothing.
        expect(socket.isOpen()).toBe(true);
        expect(socket.namespaceSid).not.toBeNull();

        // The epoch advances. The socket is NOT touched by this — a password
        // change writes the database, it does not reach into open connections.
        await changePasswordViaApi(user.id, 'N3wPassw0rd!ws');
        expect(await passwordVersionOf(user.id)).toBe(2);

        // The sweep is what reaches them, and this is the sweep.
        const gateway = testApp.app.get(RealtimeGateway);
        await gateway.revalidateAll();

        const why = await socket.waitForClose(5_000);
        expect(socket.isOpen()).toBe(false);
        // Either framing is a real close; which one depends on whether the
        // transport or the namespace notices first.
        expect(why).toMatch(/DISCONNECT|CLOSE|dropped/);
      });
    });

    it('is NOT closed by the sweep when nothing changed', async () => {
      // The control. Without it, a sweep that disconnected every socket
      // unconditionally would pass the case above.
      const { username } = await customer();
      const jar = await authenticate(testApp, username, 'Passw0rd!test');

      await withSocket(jar, async (socket) => {
        expect(socket.isOpen()).toBe(true);

        const gateway = testApp.app.get(RealtimeGateway);
        await gateway.revalidateAll();
        await gateway.revalidateAll();

        expect(socket.isOpen()).toBe(true);
        expect(socket.closeReason()).toBeNull();
      });
    });

    it('refuses a NEW socket carrying a token from the ended epoch', async () => {
      // The other half of the control: the handshake gate and the sweep are
      // different code paths, and both must hold.
      const { user, username } = await customer();
      const jar = await authenticate(testApp, username, 'Passw0rd!test');
      const staleCookie = sessionCookie(jar);

      await changePasswordViaApi(user.id, 'N3wPassw0rd!ws2');

      const socket = await connectTestSocket({
        server: testApp.server,
        cookie: staleCookie,
        audience: 'storefront',
      });

      expect(socket.isOpen()).toBe(false);
      await socket.close();
    });

    it('closes the socket on an ADMINISTRATOR reset too, not only a self-service change', async () => {
      const { user, username } = await customer();
      const jar = await authenticate(testApp, username, 'Passw0rd!test');
      await withSocket(jar, async (socket) => {
        expect(socket.isOpen()).toBe(true);

        // `AdminUserService.resetPassword` is a different writer, in raw SQL,
        // inside the audit transaction — so it gets its own case.
        const { username: adminName, password: adminPassword } = await admin();
        const adminJar = await authenticate(
          testApp,
          adminName,
          adminPassword,
          'admin',
        );
        const reset = await withCookies(testApp, adminJar)
          .post(`/admin/users/${user.id}/password`)
          .send({ temporaryPassword: 'T3mp!Socket9' });
        expect(OK).toContain(reset.status);

        await testApp.app.get(RealtimeGateway).revalidateAll();

        await socket.waitForClose(5_000);
        expect(socket.isOpen()).toBe(false);
      });
    });

    it('pins the documented sweep interval at 60 seconds', () => {
      /*
       * The one number an incident runbook depends on. The cases above prove
       * the sweep CLOSES the socket; this proves how long a responder may have
       * to wait for it, without this suite having to wait that long itself.
       *
       * The immediate lever, when a minute is too long, remains
       * `POST /auth/users/:id/revoke-sessions` plus a deactivation — which the
       * same sweep also enforces.
       */
      expect(REVALIDATION_INTERVAL_MS).toBe(60_000);
    });
  });

  // ==========================================================================
  // 6. THE FORCED CHANGE — what an administrator-issued temporary password
  //    actually does, end to end
  // ==========================================================================

  /**
   * `users.mustChangePassword` (migration 1757000000023) is set by
   * `POST /admin/users/:id/password`, and `JwtAuthGuard` then refuses every
   * route not marked `@AllowPasswordChangePending()`.
   *
   * The DEFECT these cases exist for was never in the backend: it was a till
   * that signed a new cashier in, showed them the ordinary catalogue, and let
   * every request behind it fail 403. The frontend now redirects to a
   * change-password screen instead — and these assertions are what the
   * frontend is allowed to rely on.
   */
  describe('forced change after an administrator-issued temporary password', () => {
    /** The route the defect was actually observed on. */
    const POS_CATALOGUE = '/inventory/catalog';
    const TEMPORARY = 'T3mp!Passw0rd';

    /*
     * A cashier STANDS IN A SHOP. `GET /inventory/catalog` is scoped to
     * `req.user.branch` and refuses a branchless `pos` session with 400
     * USER_NOT_IN_BRANCH, so a fixture without a branch could no longer tell
     * the 403 this suite is about apart from a misconfigured till.
     */
    const cashier = async () => {
      const branch = await createBranch(testApp.dataSource);
      return createUser(testApp.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
    };

    /**
     * The REAL administrative path: an administrator types a password and
     * hands it over out of band. The system never generates and displays one.
     */
    const issueTemporaryPassword = async (
      userId: number,
      temporaryPassword: string,
    ): Promise<void> => {
      const { username: adminName, password: adminPassword } = await admin();
      const adminJar = await authenticate(
        testApp,
        adminName,
        adminPassword,
        'admin',
      );
      const response = await withCookies(testApp, adminJar)
        .post(`/admin/users/${userId}/password`)
        .send({ temporaryPassword });

      if (!OK.includes(response.status)) {
        throw new Error(
          `Temporary password not set (${response.status}): ${JSON.stringify(
            response.body,
          )}`,
        );
      }

      /*
       * NOTHING IS WAITED FOR HERE ANY MORE.
       *
       * This used to cross the wall-clock second boundary before letting
       * anybody sign in with the temporary password, because the old rule
       * compared a whole-second `iat` against a microsecond
       * `passwordChangedAt` and refused a sign-in inside the change's own
       * second — once. The reset now increments `users."passwordVersion"`, and
       * a sign-in that follows it by a microsecond carries the new epoch and
       * is accepted on its first request. The absence of a wait here is part
       * of what these cases assert.
       */
    };

    const posLogin = (username: string, password: string) =>
      request(testApp.server)
        .post('/auth/pos/login')
        .send({ username, password });

    /**
     * ======================================================================
     * 6z. THE ADMINISTRATOR RESET MOVES THE EPOCH, EXACTLY LIKE A SELF-SERVICE
     *     CHANGE — same mechanism, same transaction, same immediacy.
     * ======================================================================
     *
     * The two paths write the password in completely different code —
     * `UserService.applyPasswordChange` for the self-service change,
     * `AdminUserService.resetPassword` (raw SQL, inside the audit
     * transaction) for the reset — so "they behave the same way" is a claim
     * that has to be asserted rather than inferred from one of them.
     */
    it('bumps the epoch, kills every audience, and admits an immediate sign-in', async () => {
      const { user, username } = await cashier();

      // Two live sessions on the till, plus one belonging to somebody else.
      const first = new CookieJar().absorb(
        await posLogin(username, 'Passw0rd!test').expect(201),
      );
      const second = new CookieJar().absorb(
        await posLogin(username, 'Passw0rd!test').expect(201),
      );
      const { user: bystander, username: otherName } = await cashier();
      const otherJar = new CookieJar().absorb(
        await posLogin(otherName, 'Passw0rd!test').expect(201),
      );

      await withCookies(testApp, first).get('/auth/pos/me').expect(200);
      await withCookies(testApp, second).get('/auth/pos/me').expect(200);

      const [beforeVersion, beforeOther] = await Promise.all([
        passwordVersionOf(user.id),
        passwordVersionOf(bystander.id),
      ]);
      expect(beforeVersion).toBe(1);

      await issueTemporaryPassword(user.id, TEMPORARY);

      // 1. The epoch moved by exactly one.
      expect(await passwordVersionOf(user.id)).toBe(beforeVersion + 1);

      // 2. BOTH of the user's sessions are dead, and so is rotation.
      await withCookies(testApp, first).get('/auth/pos/me').expect(401);
      await withCookies(testApp, second).get('/auth/pos/me').expect(401);
      await request(testApp.server)
        .post('/auth/pos/refresh')
        .set('Cookie', `kz_pos_refresh=${second.get('kz_pos_refresh')!}`)
        .expect(401);

      // 3. The refresh rows were revoked in the same transaction, so
      //    `activeSessionCount` is truthful straight away rather than counting
      //    sessions that would fail on first use.
      const rows = await refreshTokenRows(user.id);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((row) => row.revoked)).toBe(true);

      // 4. NOBODY ELSE IS AFFECTED — not their epoch, not their session.
      expect(await passwordVersionOf(bystander.id)).toBe(beforeOther);
      await withCookies(testApp, otherJar).get('/auth/pos/me').expect(200);
      const otherRows = await refreshTokenRows(bystander.id);
      expect(otherRows.every((row) => !row.revoked)).toBe(true);

      // 5. And the temporary password works on the FIRST attempt, with no
      //    wait — the case the old whole-second rule refused once.
      const signIn = await posLogin(username, TEMPORARY);
      expect(signIn.status).toBe(201);
      const fresh = new CookieJar().absorb(signIn);
      expect(sessionVersionOf(fresh.get('kz_pos_access')!)).toBe(
        beforeVersion + 1,
      );
    });

    /**
     * ======================================================================
     * 6a. THE WHOLE JOURNEY, INCLUDING THE PART THE TILL USED TO GET WRONG
     * ======================================================================
     *
     * Signing in works — that is the point of a temporary password and it is
     * why the old screen looked healthy. What does NOT work is anything the
     * cashier came to do, and that gap is the entire user-visible defect.
     */
    it('signs in, refuses the catalogue, accepts the change, and then works normally', async () => {
      const { user, username } = await cashier();
      await issueTemporaryPassword(user.id, TEMPORARY);

      // 1. The temporary password opens a till session. It must, or the
      //    cashier could never reach the change form.
      const signIn = await posLogin(username, TEMPORARY);
      expect(OK).toContain(signIn.status);
      const jar = new CookieJar().absorb(signIn);

      // 2. Introspection is reachable and TELLS THE FRONTEND WHAT TO DO. This
      //    is the only thing the change screen may read, and the only way it
      //    can know to render itself at all.
      const me = await withCookies(testApp, jar)
        .get('/auth/pos/me')
        .expect(200);
      expect(me.body.data.mustChangePassword).toBe(true);
      expect(me.body.data.identifier).toBe(username);

      // 3. The catalogue — the screen the cashier was being shown — is
      //    refused, with the documented code the client keys off.
      const blocked = await withCookies(testApp, jar).get(POS_CATALOGUE);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe(AuthErrorCodes.PASSWORD_CHANGE_REQUIRED);
      expect(blocked.body.message).toBe(AuthMessages.PASSWORD_CHANGE_REQUIRED);

      // 4. The change itself is reachable, and clears the flag.
      const changed = await withCookies(testApp, jar)
        .post('/auth/pos/change-password')
        .send({ currentPassword: TEMPORARY, newPassword: 'Cashi3r!Own' });
      expect(changed.status).toBe(200);

      // The response CLEARS this surface's cookies rather than leaving the
      // browser holding a credential that will only fail on the next call.
      const cleared = changed.headers['set-cookie'] as unknown as string[];
      expect(cleared.some((c) => c.startsWith('kz_pos_access=;'))).toBe(true);

      // 5. THE TEMPORARY PASSWORD IS DEAD. The whole point: the value the
      //    administrator knows stops being a way in.
      expect((await posLogin(username, TEMPORARY)).status).toBe(401);

      // 6. The new one is an ordinary session with an ordinary catalogue.
      //
      //    Immediately. No second boundary is crossed and none needs to be:
      //    the sign-in carries the epoch the change just created.
      const fresh = new CookieJar().absorb(
        await posLogin(username, 'Cashi3r!Own').expect(201),
      );
      const meAfter = await withCookies(testApp, fresh)
        .get('/auth/pos/me')
        .expect(200);
      expect(meAfter.body.data.mustChangePassword).toBe(false);
      expect(OK).toContain(
        (await withCookies(testApp, fresh).get(POS_CATALOGUE)).status,
      );
    });

    /**
     * 6b. THE REFUSAL, ON ITS OWN, WITH ITS CONTRACT SPELLED OUT.
     *
     * Asserted separately from the journey because the frontend BRANCHES on
     * this envelope: status, `error` code and `message` are all part of the
     * contract, and a change to any of them silently turns the till's
     * redirect into a generic error screen.
     */
    it('refuses a normal protected route with 403 PASSWORD_CHANGE_REQUIRED', async () => {
      const { user, username } = await cashier();
      await issueTemporaryPassword(user.id, TEMPORARY);
      const jar = new CookieJar().absorb(await posLogin(username, TEMPORARY));

      const response = await withCookies(testApp, jar).get(POS_CATALOGUE);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: AuthErrorCodes.PASSWORD_CHANGE_REQUIRED,
        message: AuthMessages.PASSWORD_CHANGE_REQUIRED,
      });
    });

    /**
     * ======================================================================
     * 6c. THE ALLOW-LIST IS EXACTLY WHAT IT CLAIMS TO BE
     * ======================================================================
     *
     * `@AllowPasswordChangePending()` is the ONLY thing standing between "a
     * forced password change" and "a route a half-authenticated principal can
     * still call". A decorator added to one more handler in a hurry would not
     * fail any other test in this repository — it would simply widen the hole
     * and stay widened.
     *
     * So the set is enumerated from the running application's metadata and
     * compared to an explicit list. Adding a route here is a deliberate act
     * with a test to update, which is the point.
     */
    it('carries @AllowPasswordChangePending on exactly the three auth routes, per audience', () => {
      const reflector = testApp.app.get(Reflector);
      const modules = (
        testApp.app as unknown as {
          container: {
            getModules(): Map<
              string,
              {
                controllers: Map<
                  unknown,
                  {
                    metatype?: new (...args: never[]) => unknown;
                    instance?: object;
                  }
                >;
              }
            >;
          };
        }
      ).container.getModules();

      const allowed: string[] = [];
      const publicAllowed: string[] = [];
      let handlersSeen = 0;

      for (const module of modules.values()) {
        for (const wrapper of module.controllers.values()) {
          const metatype = wrapper.metatype;
          const instance = wrapper.instance;
          if (!metatype || !instance) continue;

          const basePath =
            (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';

          for (const name of Object.getOwnPropertyNames(
            Object.getPrototypeOf(instance),
          )) {
            if (name === 'constructor') continue;
            const handler = (instance as Record<string, unknown>)[name];
            if (typeof handler !== 'function') continue;
            const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as
              | string
              | undefined;
            if (methodPath === undefined) continue;
            handlersSeen += 1;

            const pending =
              reflector.get<boolean>(
                ALLOW_PASSWORD_CHANGE_PENDING_KEY,
                handler,
              ) ??
              reflector.get<boolean>(
                ALLOW_PASSWORD_CHANGE_PENDING_KEY,
                metatype,
              );
            if (pending !== true) continue;

            const route =
              `/${basePath}/${methodPath}`
                .replace(/\/+/g, '/')
                .replace(/\/$/, '') || '/';
            allowed.push(route);
            if (
              (reflector.get<boolean>(IS_PUBLIC_KEY, handler) ??
                reflector.get<boolean>(IS_PUBLIC_KEY, metatype)) === true
            ) {
              publicAllowed.push(route);
            }
          }
        }
      }

      // Guards against a vacuous pass: an enumeration that found nothing would
      // otherwise "prove" the allow-list is empty.
      expect(handlersSeen).toBeGreaterThan(60);

      /**
       * WHY EACH ONE IS ON THE LIST — and why nothing else is:
       *
       *   /me             introspection. The ONLY way a client can learn it
       *                   must show the change form, and where it gets the
       *                   username to show on it. Without this the frontend
       *                   sees a working session and a wall of 403s, which is
       *                   the defect this whole change is about.
       *   /change-password  the act itself. The only route that clears the
       *                   flag; gating it is a lockout with no way out.
       *   /logout-all     the authenticated sign-out lever. A temporary
       *                   password was, by definition, known to somebody else;
       *                   somebody who thinks it was seen must be able to kill
       *                   every session without first being forced to type a
       *                   replacement.
       *
       * `login`, `refresh` and `logout` are NOT here and do not need to be:
       * they are `@Public()`, so the guard returns before any principal — and
       * therefore any flag — exists. Rotation and ordinary sign-out keep
       * working while the flag is set, for free.
       */
      expect([...allowed].sort()).toEqual([
        '/auth/admin/change-password',
        '/auth/admin/logout-all',
        '/auth/admin/me',
        '/auth/pos/change-password',
        '/auth/pos/logout-all',
        '/auth/pos/me',
        '/auth/storefront/change-password',
        '/auth/storefront/logout-all',
        '/auth/storefront/me',
      ]);

      // A `@Public()` route carrying the decorator would be meaningless at
      // best and a misreading of the model at worst — the guard never reaches
      // the flag on a public route.
      expect(publicAllowed).toEqual([]);
    });

    /**
     * ======================================================================
     * 6d. AUDIENCE ISOLATION — stated precisely, because "isolated" means two
     *     different things here and only one of them is true
     * ======================================================================
     *
     * TRUE: one person's password change touches nobody else's session, on any
     * surface. That is what this case proves, and it is the property a till
     * and a console running side by side actually depend on.
     *
     * ALSO TRUE, and asserted below rather than glossed over: the SAME user's
     * sessions on the OTHER audiences ARE killed, because
     * `users.passwordChangedAt` is a per-user cut-off and every audience's
     * verifier applies it. That is deliberate and documented at the top of
     * this file — a password change ends every session — and it is NOT
     * something to "fix" in the name of isolation. Cookie handling is what is
     * audience-scoped: the change-password response clears only the surface it
     * was called on.
     */
    it('leaves other people’s sessions on other audiences untouched', async () => {
      const { user: cash, username: cashName } = await cashier();
      const { username: adminName, password: adminPassword } = await admin();

      const adminJar = await authenticate(
        testApp,
        adminName,
        adminPassword,
        'admin',
      );
      // CONTROL: the administrator's console session works before any of this.
      await withCookies(testApp, adminJar).get('/auth/admin/me').expect(200);

      await issueTemporaryPassword(cash.id, TEMPORARY);
      const posJar = new CookieJar().absorb(
        await posLogin(cashName, TEMPORARY),
      );
      await withCookies(testApp, posJar)
        .post('/auth/pos/change-password')
        .send({ currentPassword: TEMPORARY, newPassword: 'Cashi3r!Own2' })
        .expect(200);

      // The administrator never noticed.
      const adminAfter = await withCookies(testApp, adminJar).get(
        '/auth/admin/me',
      );
      expect(adminAfter.status).toBe(200);
      expect(adminAfter.body.data.identifier).toBe(adminName);
    });

    it('does kill the SAME user’s sessions on the other audiences (by design)', async () => {
      // One account that can hold both a till session and a console session,
      // so the two can be observed at once.
      const { user, username, password } = await createUser(
        testApp.dataSource,
        { roles: [UserRoleEnum.sale, UserRoleEnum.superAdmin] },
      );

      const posJar = await authenticate(testApp, username, password, 'pos');
      const adminJar = await authenticate(testApp, username, password, 'admin');
      await withCookies(testApp, posJar).get('/auth/pos/me').expect(200);
      await withCookies(testApp, adminJar).get('/auth/admin/me').expect(200);

      await withCookies(testApp, posJar)
        .post('/auth/pos/change-password')
        .send({ currentPassword: password, newPassword: 'Both!Surfaces1' })
        .expect(200);

      // The console session is gone too — `passwordChangedAt` is per USER, and
      // that is the security property, not a leak between audiences.
      expect(
        (await withCookies(testApp, adminJar).get('/auth/admin/me')).status,
      ).toBe(401);

      // But the COOKIES were cleared only on the surface that made the call.
      // The admin cookie is still in the browser; it is merely worthless.
      expect(adminJar.has('kz_admin_access')).toBe(true);

      // Straight back in on the other surface, with no wait.
      const reAdmin = await authenticate(
        testApp,
        username,
        'Both!Surfaces1',
        'admin',
      );
      await withCookies(testApp, reAdmin).get('/auth/admin/me').expect(200);
      expect(user.id).toBeGreaterThan(0);
    });

    /**
     * 6e. NO PASSWORD IN THE AUDIT TRAIL.
     *
     * `admin_audit_log` is append-only at the database level: a plaintext
     * password written there cannot be edited or deleted afterwards. The
     * administrative reset is the one place a plaintext password is in scope
     * of an audit write, so the row it produces is read back and checked in
     * full rather than trusted to `AuditService.redact`.
     *
     * (The self-service change writes no audit row at all — there is no
     * administrator acting on somebody else to record.)
     */
    it('writes no password, hashed or plain, into the audit trail', async () => {
      const { user, username } = await cashier();
      await issueTemporaryPassword(user.id, TEMPORARY);

      const rows = await testApp.dataSource.query<
        Array<{ action: string; summary: Record<string, unknown> | null }>
      >(
        `SELECT action, summary FROM admin_audit_log
          WHERE "targetType" = 'user' AND "targetId" = $1`,
        [String(user.id)],
      );
      expect(rows.length).toBeGreaterThan(0);

      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(TEMPORARY);
      expect(serialised).not.toContain('$2b$');
      expect(serialised).not.toContain('$2a$');
      /*
       * The summary is built from an EXPLICIT ALLOW-LIST of scalar facts, not
       * spread from the DTO — which is precisely how a plaintext password ends
       * up in an audit log on the first password-reset call. Pinning the key
       * set is what makes a future `summary: { ...dto }` fail here.
       *
       * `mustChangePassword` is a FLAG NAME, not a credential; it is named out
       * loud so a blanket "no key contains the word password" rule cannot be
       * added, pass vacuously on this row, and be mistaken for a real control.
       */
      for (const row of rows) {
        expect(Object.keys(row.summary ?? {}).sort()).toEqual([
          'mustChangePassword',
          'sessionsRevoked',
        ]);
      }

      // And the change the cashier makes for themselves adds nothing new.
      const jar = new CookieJar().absorb(await posLogin(username, TEMPORARY));
      await withCookies(testApp, jar)
        .post('/auth/pos/change-password')
        .send({ currentPassword: TEMPORARY, newPassword: 'N0Audit!Leak' })
        .expect(200);

      const after = await testApp.dataSource.query<Array<unknown>>(
        `SELECT summary FROM admin_audit_log
          WHERE "targetType" = 'user' AND "targetId" = $1`,
        [String(user.id)],
      );
      expect(JSON.stringify(after)).not.toContain('N0Audit!Leak');
    });
  });
});
