import * as request from 'supertest';
import type { Response } from 'supertest';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { AuthMessages } from 'src/common/constants/auth.messages';
import { OtpSender } from 'src/modules/auth/services/otp-sender';
import {
  OTP_ERROR_COOLDOWN,
  OTP_ERROR_INVALID,
  OTP_ERROR_RATE_LIMITED,
} from 'src/modules/auth/services/otp.service';
import {
  OTP_MAX_SENDS_PER_IP,
  OTP_MAX_SENDS_PER_MOBILE,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SEND_WINDOW_SECONDS,
} from 'src/modules/auth/otp.policy';

import { CookieJar, createTestApp, TestApp } from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createUser, seedRoles } from './setup/seed-helpers';

/**
 * ===========================================================================
 * OTP HARDENING — every control, asserted against the real app and a real DB
 * ===========================================================================
 *
 * WHAT THIS REPLACES. The previous OTP flow was:
 *
 *   sendOtp:    create a PERMANENT `site` user if the number is new, put an
 *               HMAC in Redis with a 120s TTL. No cooldown, no rate limit.
 *   verifyOtp:  404 "User not found." for an unknown number (a free
 *               registration oracle), otherwise GET the key, compare, DEL it.
 *               Unlimited wrong guesses; `GET`+`DEL` is not atomic.
 *
 * So: anyone could mass-create real accounts for numbers they do not control,
 * SMS-bomb a stranger's phone for free, enumerate which numbers are customers
 * without ever holding a code, brute-force a 6-digit code with no lockout, and
 * race a correct code into two sessions.
 *
 * HOW THESE TESTS AVOID PRETENDING
 * --------------------------------
 *  - NO SLEEPING. Time is advanced by backdating a column
 *    (`"expiresAt"`, `"resendAvailableAt"`) in SQL. Those are real database
 *    facts that the production statements read with the database's own `now()`,
 *    not a faked clock the code under test cannot see.
 *  - NO TEST BACK DOOR IN PRODUCTION CODE. A test cannot know a correct code,
 *    so the SMS DELIVERY PORT (`OtpSender`, the production seam that replaced a
 *    commented-out `smsService.sendSms` call) is overridden with a capturing
 *    implementation. Production keeps its own binding; nothing is weakened, no
 *    endpoint returns a code, and the hash is unchanged.
 *  - EVERY CONTROL IS ASSERTED AT THE DATABASE, not only through the HTTP
 *    status: `attempts`, `sendCount`, `consumedAt` and the row count are the
 *    facts that would still be true if a status code were accidentally right.
 *  - COVERAGE IS STATED HONESTLY. The per-IP limit is the ONE control that
 *    lives in Redis, which this harness replaces with an in-memory Map. It is
 *    genuinely exercised below — `InMemoryRedisService.incrWithExpiry` mirrors
 *    the real semantics including first-write TTL and expiry-resets-the-window
 *    — but what is proven is the LIMIT LOGIC, not node-redis's `INCR`/`EXPIRE`.
 *    Said plainly rather than implied.
 */

/** Capturing `OtpSender`. See the header: this is the production port, overridden. */
class CapturingOtpSender extends OtpSender {
  readonly sent: Array<{ mobile: string; code: string }> = [];

  send(mobile: string, code: string): Promise<void> {
    this.sent.push({ mobile, code });
    return Promise.resolve();
  }

  /** The code most recently delivered for `mobile`. Throws if none. */
  codeFor(mobile: string): string {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i].mobile === mobile) return this.sent[i].code;
    }
    throw new Error(`No OTP was delivered for ${mobile}`);
  }

  countFor(mobile: string): number {
    return this.sent.filter((entry) => entry.mobile === mobile).length;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

interface ChallengeRow {
  id: number;
  mobile: string;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  sendCount: number;
  consumedAt: Date | null;
}

/** The error envelope minus the two fields that legitimately differ per call. */
function comparableError(response: Response): Record<string, unknown> {
  const body = response.body as Record<string, unknown>;
  const { timestamp, ...rest } = body;
  void timestamp;
  return { status: response.status, ...rest };
}

/** The success envelope minus its timestamp. */
function comparableSuccess(response: Response): Record<string, unknown> {
  const body = response.body as Record<string, unknown>;
  const { timeStamp, ...rest } = body;
  void timeStamp;
  return { status: response.status, ...rest };
}

describe('OTP hardening', () => {
  let testApp: TestApp;
  const sender = new CapturingOtpSender();

  /** Unique per case, so no test inherits another's cooldown or send window. */
  let counter = 0;
  const freshMobile = (): string => {
    counter += 1;
    return `0912${String(counter).padStart(7, '0')}`;
  };

  beforeAll(async () => {
    testApp = await createTestApp({
      customise: (builder) =>
        builder.overrideProvider(OtpSender).useValue(sender),
    });
  });

  afterAll(async () => {
    await testApp.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(testApp.dataSource);
    // The per-IP counter lives in Redis. Every request in this suite arrives
    // from the same loopback peer, so without this flush one test's sends
    // would eat the next test's IP budget.
    testApp.redis.flush();
    sender.clear();
    await seedRoles(testApp.dataSource);
  });

  // ==========================================================================
  // helpers
  // ==========================================================================

  const sendOtp = (mobile: string) =>
    request(testApp.server).post('/auth/storefront/send-otp').send({ mobile });

  const verifyOtp = (mobile: string, code: string) =>
    request(testApp.server)
      .post('/auth/storefront/verify-otp')
      .send({ mobile, code });

  const challenge = async (mobile: string): Promise<ChallengeRow | null> => {
    const [row] = await testApp.dataSource.query<ChallengeRow[]>(
      `SELECT id, mobile, "codeHash", attempts, "maxAttempts", "sendCount",
              "consumedAt"
         FROM otp_challenges WHERE mobile = $1`,
      [mobile],
    );
    return row ?? null;
  };

  const requireChallenge = async (mobile: string): Promise<ChallengeRow> => {
    const row = await challenge(mobile);
    if (!row) throw new Error(`No challenge row for ${mobile}`);
    return row;
  };

  const userCount = async (): Promise<number> => {
    const [row] = await testApp.dataSource.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM users`,
    );
    return row.n;
  };

  const userByMobile = async (mobile: string) => {
    const [row] = await testApp.dataSource.query<
      Array<{ id: number; mobile: string; password: string | null }>
    >(`SELECT id, mobile, password FROM users WHERE mobile = $1`, [mobile]);
    return row ?? null;
  };

  const roleNamesOf = async (userId: number): Promise<string[]> => {
    const rows = await testApp.dataSource.query<Array<{ name: string }>>(
      // TypeORM named the join table's columns `usersId`/`rolesId`
      // (migration 0001), not `userId`/`roleId`.
      `SELECT r.name FROM roles r
         JOIN user_roles ur ON ur."rolesId" = r.id
        WHERE ur."usersId" = $1`,
      [userId],
    );
    return rows.map((row) => row.name);
  };

  /**
   * Pretends the cooldown has elapsed WITHOUT touching `windowStartedAt` or
   * `sendCount`, so the hourly per-mobile budget keeps accumulating. This is
   * the only way to reach the hourly cap without sleeping for five minutes.
   */
  const clearCooldown = (mobile: string) =>
    testApp.dataSource.query(
      `UPDATE otp_challenges
          SET "resendAvailableAt" = now() - interval '1 second'
        WHERE mobile = $1`,
      [mobile],
    );

  /** Expires the live code, exactly as the passage of time would. */
  const expireCode = (mobile: string) =>
    testApp.dataSource.query(
      `UPDATE otp_challenges
          SET "expiresAt" = now() - interval '1 second'
        WHERE mobile = $1`,
      [mobile],
    );

  /** A code guaranteed to differ from `correct`, same length and shape. */
  const wrongCode = (correct: string): string => {
    const firstDigit = Number(correct[0]);
    return `${(firstDigit + 1) % 10}${correct.slice(1)}`;
  };

  // ==========================================================================
  // 1. No user enumeration on send-otp
  // ==========================================================================

  describe('no user enumeration', () => {
    it('answers IDENTICALLY for a registered and an unregistered mobile', async () => {
      const registeredMobile = freshMobile();
      const unknownMobile = freshMobile();

      const { user } = await createUser(testApp.dataSource, {
        mobile: registeredMobile,
        roles: [UserRoleEnum.site],
      });
      expect(user.mobile).toBe(registeredMobile);

      const registered = await sendOtp(registeredMobile);
      const unknown = await sendOtp(unknownMobile);

      // Byte-for-byte identical bar the envelope timestamp. This is THE
      // assertion: `sendOtp` no longer looks a user up at all, so the two
      // branches it used to have cannot drift apart.
      expect(comparableSuccess(registered)).toEqual(comparableSuccess(unknown));
      expect(registered.status).toBe(201);
      expect(registered.body.message).toBe(AuthMessages.OTP_SENT);

      // And no cookie is set on either — this route never authenticates.
      expect(registered.headers['set-cookie']).toBeUndefined();
      expect(unknown.headers['set-cookie']).toBeUndefined();
    });

    it('creates NO user row when a code is requested', async () => {
      const mobile = freshMobile();
      const before = await userCount();

      await sendOtp(mobile).expect(201);

      // The single worst defect of the old flow: `sendOtp` inserted a
      // permanent `site` user before anybody proved control of the number, so
      // a loop over this endpoint was free unbounded account creation.
      expect(await userCount()).toBe(before);
      expect(await userByMobile(mobile)).toBeNull();

      // The pending number lives in the challenge instead.
      const row = await requireChallenge(mobile);
      expect(row.mobile).toBe(mobile);
      expect(row.consumedAt).toBeNull();
    });

    it('answers IDENTICALLY on verify for no-challenge, wrong code and expired code', async () => {
      // (a) NO CHALLENGE AT ALL — the number was never sent a code. Under the
      //     old code an unregistered number got 404 USER_NOT_FOUND here, which
      //     is the registration oracle.
      const neverSent = await verifyOtp(freshMobile(), '123456');

      // (b) A REAL CHALLENGE, WRONG CODE.
      const wrongMobile = freshMobile();
      await sendOtp(wrongMobile).expect(201);
      const wrong = await verifyOtp(
        wrongMobile,
        wrongCode(sender.codeFor(wrongMobile)),
      );

      // (c) A REAL CHALLENGE, CORRECT CODE, EXPIRED.
      const expiredMobile = freshMobile();
      await sendOtp(expiredMobile).expect(201);
      const correctButExpired = sender.codeFor(expiredMobile);
      await expireCode(expiredMobile);
      const expired = await verifyOtp(expiredMobile, correctButExpired);

      // (d) ATTEMPT BOUND EXHAUSTED — a fourth mode, folded into the same
      //     response on purpose. Telling the client "too many attempts" would
      //     reveal to a third party hammering a number that somebody is
      //     mid-login on it.
      const burnedMobile = freshMobile();
      await sendOtp(burnedMobile).expect(201);
      const burnedCorrect = sender.codeFor(burnedMobile);
      for (let i = 0; i < OTP_MAX_VERIFY_ATTEMPTS; i += 1) {
        await verifyOtp(burnedMobile, wrongCode(burnedCorrect));
      }
      const exhausted = await verifyOtp(burnedMobile, burnedCorrect);

      for (const response of [neverSent, wrong, expired, exhausted]) {
        expect(response.status).toBe(401);
        expect(response.body.error).toBe(OTP_ERROR_INVALID);
        expect(response.body.message).toBe(AuthMessages.INVALID_OTP);
        // No `details`: an `attemptsRemaining` field would immediately
        // re-open the distinction this test exists to close.
        expect(response.body.details).toBeUndefined();
      }

      // `path` differs only by the mobile-independent URL, which is the same
      // for all four, so the envelopes compare equal outright.
      expect(comparableError(wrong)).toEqual(comparableError(neverSent));
      expect(comparableError(expired)).toEqual(comparableError(neverSent));
      expect(comparableError(exhausted)).toEqual(comparableError(neverSent));
    });
  });

  // ==========================================================================
  // 2. The happy path, and where the account comes from
  // ==========================================================================

  describe('successful verification', () => {
    it('creates the site customer on FIRST successful verification and sets both cookies', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      expect(await userByMobile(mobile)).toBeNull();

      const verified = await verifyOtp(mobile, sender.codeFor(mobile));
      expect(verified.status).toBe(201);
      expect(verified.body.message).toBe(AuthMessages.LOGIN_SUCCESS);

      // The account exists NOW, and not before.
      const created = await userByMobile(mobile);
      expect(created).not.toBeNull();
      expect(await roleNamesOf(created.id)).toEqual([UserRoleEnum.site]);
      // No password: this account is OTP-only until the customer sets one.
      expect(created.password).toBeNull();

      // A real session: both httpOnly cookies, and the access token works.
      const jar = new CookieJar().absorb(verified);
      expect(jar.get('kz_storefront_access')).toBeDefined();
      expect(jar.get('kz_storefront_refresh')).toBeDefined();
      const probe = await request(testApp.server)
        .get('/auth/storefront/me')
        .set('Cookie', jar.header());
      expect(probe.status).toBe(200);
      expect(probe.body.data.userId).toBe(created.id);

      // The challenge is consumed, and the successful attempt is counted.
      const row = await requireChallenge(mobile);
      expect(row.consumedAt).not.toBeNull();
      expect(row.attempts).toBe(1);
    });

    it('adopts an EXISTING user rather than creating a second one', async () => {
      const mobile = freshMobile();
      const { user } = await createUser(testApp.dataSource, {
        mobile,
        roles: [UserRoleEnum.site],
      });
      const before = await userCount();

      await sendOtp(mobile).expect(201);
      const verified = await verifyOtp(mobile, sender.codeFor(mobile));
      expect(verified.status).toBe(201);

      expect(await userCount()).toBe(before);
      const jar = new CookieJar().absorb(verified);
      const probe = await request(testApp.server)
        .get('/auth/storefront/me')
        .set('Cookie', jar.header());
      expect(probe.body.data.userId).toBe(user.id);
    });

    it('stores no plaintext code — only a 64-hex HMAC', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const code = sender.codeFor(mobile);
      const row = await requireChallenge(mobile);

      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.codeHash).not.toContain(code);
      expect(row.maxAttempts).toBe(OTP_MAX_VERIFY_ATTEMPTS);
    });
  });

  // ==========================================================================
  // 3. Cooldown
  // ==========================================================================

  describe('resend cooldown (per normalized mobile)', () => {
    it('refuses a second send inside the cooldown window, with retryAfterSeconds', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);

      const second = await sendOtp(mobile);
      expect(second.status).toBe(429);
      expect(second.body.error).toBe(OTP_ERROR_COOLDOWN);
      expect(second.body.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.body.details.retryAfterSeconds).toBeLessThanOrEqual(
        OTP_RESEND_COOLDOWN_SECONDS,
      );

      // NOTHING WAS ISSUED behind the refusal: no second SMS (so no free
      // SMS-bombing), and the stored challenge is untouched.
      expect(sender.countFor(mobile)).toBe(1);
      const row = await requireChallenge(mobile);
      expect(row.sendCount).toBe(1);

      // The FIRST code still works — a refused resend must not invalidate the
      // code the user is already holding.
      const verified = await verifyOtp(mobile, sender.codeFor(mobile));
      expect(verified.status).toBe(201);
    });

    it('allows a resend once the cooldown has elapsed, and the new code replaces the old', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const firstCode = sender.codeFor(mobile);

      await clearCooldown(mobile);
      await sendOtp(mobile).expect(201);
      const secondCode = sender.codeFor(mobile);
      expect(secondCode).not.toBe(firstCode);

      const row = await requireChallenge(mobile);
      expect(row.sendCount).toBe(2);
      // Re-issuing resets the attempt budget, which is the point of resending.
      expect(row.attempts).toBe(0);

      // The SUPERSEDED code is dead — otherwise every resend would widen the
      // set of codes an attacker may guess.
      const stale = await verifyOtp(mobile, firstCode);
      expect(stale.status).toBe(401);
      expect(stale.body.error).toBe(OTP_ERROR_INVALID);

      // Note it consumed one of the five attempts on the NEW challenge.
      expect((await requireChallenge(mobile)).attempts).toBe(1);
      expect((await verifyOtp(mobile, secondCode)).status).toBe(201);
    });
  });

  // ==========================================================================
  // 4. Rate limits
  // ==========================================================================

  describe('send rate limit (per normalized mobile)', () => {
    it(`refuses send number ${OTP_MAX_SENDS_PER_MOBILE + 1} in the window even with the cooldown elapsed`, async () => {
      const mobile = freshMobile();

      for (let i = 0; i < OTP_MAX_SENDS_PER_MOBILE; i += 1) {
        const response = await sendOtp(mobile);
        expect(response.status).toBe(201);
        await clearCooldown(mobile);
      }

      const row = await requireChallenge(mobile);
      expect(row.sendCount).toBe(OTP_MAX_SENDS_PER_MOBILE);

      const refused = await sendOtp(mobile);
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe(OTP_ERROR_RATE_LIMITED);
      // Points at the end of the hourly window, not at the 60s cooldown.
      expect(refused.body.details.retryAfterSeconds).toBeGreaterThan(
        OTP_RESEND_COOLDOWN_SECONDS,
      );
      expect(refused.body.details.retryAfterSeconds).toBeLessThanOrEqual(
        OTP_SEND_WINDOW_SECONDS,
      );

      // No SMS and no re-issue behind the refusal.
      expect(sender.countFor(mobile)).toBe(OTP_MAX_SENDS_PER_MOBILE);
      expect((await requireChallenge(mobile)).sendCount).toBe(
        OTP_MAX_SENDS_PER_MOBILE,
      );
    });

    it('rolls the window over once it has elapsed', async () => {
      const mobile = freshMobile();
      for (let i = 0; i < OTP_MAX_SENDS_PER_MOBILE; i += 1) {
        await sendOtp(mobile).expect(201);
        await clearCooldown(mobile);
      }
      expect((await sendOtp(mobile)).status).toBe(429);

      // Backdate the window start past its length — the same thing the passage
      // of an hour does.
      await testApp.dataSource.query(
        `UPDATE otp_challenges
            SET "windowStartedAt" = now() - interval '1 second' * $2::int,
                "resendAvailableAt" = now() - interval '1 second'
          WHERE mobile = $1`,
        [mobile, OTP_SEND_WINDOW_SECONDS + 1],
      );

      await sendOtp(mobile).expect(201);
      // Counter restarted at 1 rather than continuing from 5.
      expect((await requireChallenge(mobile)).sendCount).toBe(1);
    });
  });

  describe('send rate limit (per client IP)', () => {
    /**
     * WHAT IS AND IS NOT PROVEN HERE, stated plainly.
     *
     * PROVEN: the limit logic, the 429 shape, and that the counter is keyed by
     * the CALLER rather than by the number — the mobile numbers below are all
     * distinct, so the per-mobile cap and the cooldown cannot fire and the
     * refusal can only come from the IP bucket.
     *
     * NOT PROVEN: node-redis's `INCR`/`EXPIRE` themselves. `createTestApp`
     * substitutes `InMemoryRedisService` for `RedisService`, so the counter
     * exercised is the harness's mirror of `incrWithExpiry` (same first-write
     * TTL, same "an expired key restarts the window at 1"). That is the only
     * OTP control living in Redis; everything else in this file is asserted
     * against a real PostgreSQL.
     *
     * ALSO NOT PROVEN, AND NOT PROVABLE HERE: the behaviour behind a reverse
     * proxy. Every request in this suite arrives from the loopback socket peer,
     * which is exactly what `req.ip` yields with no `trust proxy` configured —
     * see `StorefrontOtpController#clientIp` for the deployment prerequisite.
     */
    it(`refuses send number ${OTP_MAX_SENDS_PER_IP + 1} from the same caller, across DIFFERENT mobiles`, async () => {
      const mobiles = Array.from({ length: OTP_MAX_SENDS_PER_IP }, () =>
        freshMobile(),
      );

      for (const mobile of mobiles) {
        const response = await sendOtp(mobile);
        expect(response.status).toBe(201);
      }

      // A brand new number: no challenge row, so neither the cooldown nor the
      // per-mobile cap can be what refuses this.
      const oneMore = freshMobile();
      expect(await challenge(oneMore)).toBeNull();

      const refused = await sendOtp(oneMore);
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe(OTP_ERROR_RATE_LIMITED);
      expect(refused.body.details.retryAfterSeconds).toBeGreaterThan(0);

      // The IP check runs BEFORE the challenge is written, so the refused
      // number has no row and no SMS.
      expect(await challenge(oneMore)).toBeNull();
      expect(sender.countFor(oneMore)).toBe(0);
    });
  });

  // ==========================================================================
  // 5. Expiry, bounded attempts, replay
  // ==========================================================================

  describe('expiry', () => {
    it('rejects an expired code exactly like a wrong one, and does not authenticate', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const code = sender.codeFor(mobile);

      await expireCode(mobile);

      const response = await verifyOtp(mobile, code);
      expect(response.status).toBe(401);
      expect(response.body.error).toBe(OTP_ERROR_INVALID);
      expect(response.headers['set-cookie']).toBeUndefined();

      // The account is still not created — expiry must not be a way in.
      expect(await userByMobile(mobile)).toBeNull();
      // The attempt was still counted, so an expired challenge cannot be used
      // as an unlimited oracle either.
      const row = await requireChallenge(mobile);
      expect(row.attempts).toBe(1);
      expect(row.consumedAt).toBeNull();
    });
  });

  describe('bounded verification attempts', () => {
    it(`kills the challenge after ${OTP_MAX_VERIFY_ATTEMPTS} wrong codes, even for the CORRECT code afterwards`, async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const correct = sender.codeFor(mobile);
      const wrong = wrongCode(correct);

      for (let i = 1; i <= OTP_MAX_VERIFY_ATTEMPTS; i += 1) {
        const response = await verifyOtp(mobile, wrong);
        expect(response.status).toBe(401);
        expect((await requireChallenge(mobile)).attempts).toBe(i);
      }

      // THE POINT: the right code no longer works. The challenge is dead and
      // must be re-requested — which is what bounds a brute force at 5 guesses
      // per challenge instead of 10^6 per number.
      const afterBound = await verifyOtp(mobile, correct);
      expect(afterBound.status).toBe(401);
      expect(afterBound.body.error).toBe(OTP_ERROR_INVALID);
      expect(await userByMobile(mobile)).toBeNull();

      // Attempts stopped at the bound; the extra call did not even increment.
      const row = await requireChallenge(mobile);
      expect(row.attempts).toBe(OTP_MAX_VERIFY_ATTEMPTS);
      expect(row.consumedAt).toBeNull();
    });

    it('is enforced by a CHECK constraint, not only by the WHERE clause', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);

      // If a future code path forgets `WHERE attempts < "maxAttempts"`, the
      // database refuses rather than silently granting unlimited guesses.
      await expect(
        testApp.dataSource.query(
          `UPDATE otp_challenges SET attempts = "maxAttempts" + 1 WHERE mobile = $1`,
          [mobile],
        ),
      ).rejects.toThrow(/ck_otp_challenges_attempts/);
    });
  });

  describe('one-time consumption', () => {
    it('refuses a replay of a code that already bought a session', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const code = sender.codeFor(mobile);

      const first = await verifyOtp(mobile, code);
      expect(first.status).toBe(201);
      const consumedAt = (await requireChallenge(mobile)).consumedAt;
      expect(consumedAt).not.toBeNull();

      const replay = await verifyOtp(mobile, code);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toBe(OTP_ERROR_INVALID);
      expect(replay.headers['set-cookie']).toBeUndefined();

      // The consumption stamp and the attempt count are untouched by the
      // replay: the guarded UPDATE matched no row at all.
      const row = await requireChallenge(mobile);
      expect(row.consumedAt).toEqual(consumedAt);
      expect(row.attempts).toBe(1);

      // And exactly one session exists, not two.
      const [tokens] = await testApp.dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM refresh_tokens`,
      );
      expect(tokens.n).toBe(1);
    });
  });

  // ==========================================================================
  // 6. Concurrency — the assertions that need a real database
  // ==========================================================================

  describe('concurrency', () => {
    it('lets exactly ONE of five simultaneous sends for the same mobile through', async () => {
      const mobile = freshMobile();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => sendOtp(mobile)),
      );

      const issued = responses.filter((r) => r.status === 201);
      const refused = responses.filter((r) => r.status === 429);
      expect(issued).toHaveLength(1);
      expect(refused).toHaveLength(4);

      // THE DATABASE FACT. `INSERT ... ON CONFLICT ("mobile") DO UPDATE ...
      // WHERE "resendAvailableAt" <= now()` serialises the racers on one row:
      // the loser re-evaluates the WHERE against the just-inserted row, sees a
      // future `resendAvailableAt`, and writes nothing. So one row, one send
      // counted, one SMS — not five.
      const [rows] = await testApp.dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM otp_challenges WHERE mobile = $1`,
        [mobile],
      );
      expect(rows.n).toBe(1);
      expect((await requireChallenge(mobile)).sendCount).toBe(1);
      expect(sender.countFor(mobile)).toBe(1);

      // The one code that was issued is the one that works.
      expect((await verifyOtp(mobile, sender.codeFor(mobile))).status).toBe(
        201,
      );
    });

    it('lets exactly ONE of five simultaneous verifications of a correct code win', async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const code = sender.codeFor(mobile);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => verifyOtp(mobile, code)),
      );

      const winners = responses.filter((r) => r.status === 201);
      const losers = responses.filter((r) => r.status === 401);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);
      for (const loser of losers) {
        expect(loser.body.error).toBe(OTP_ERROR_INVALID);
      }

      // DATABASE FACTS: one consumption, one counted attempt (the four losers
      // matched no row, so they did not even increment), one user, one session.
      const row = await requireChallenge(mobile);
      expect(row.consumedAt).not.toBeNull();
      expect(row.attempts).toBe(1);

      const [users] = await testApp.dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM users WHERE mobile = $1`,
        [mobile],
      );
      expect(users.n).toBe(1);

      const [tokens] = await testApp.dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM refresh_tokens`,
      );
      expect(tokens.n).toBe(1);
    });

    it(`never exceeds ${OTP_MAX_VERIFY_ATTEMPTS} attempts under ${OTP_MAX_VERIFY_ATTEMPTS * 3} parallel wrong guesses`, async () => {
      const mobile = freshMobile();
      await sendOtp(mobile).expect(201);
      const wrong = wrongCode(sender.codeFor(mobile));

      const responses = await Promise.all(
        Array.from({ length: OTP_MAX_VERIFY_ATTEMPTS * 3 }, () =>
          verifyOtp(mobile, wrong),
        ),
      );
      expect(responses.every((r) => r.status === 401)).toBe(true);

      // THE ASSERTION THAT NEEDS A REAL DATABASE. A bound checked in
      // application code (read attempts, compare, write attempts + 1) would let
      // all fifteen racers read the same value and pass. Counting inside the
      // statement — `SET attempts = attempts + 1 WHERE attempts <
      // "maxAttempts"` — serialises them on the row lock, so exactly
      // `maxAttempts` increments land no matter how many arrive at once.
      const row = await requireChallenge(mobile);
      expect(row.attempts).toBe(OTP_MAX_VERIFY_ATTEMPTS);
      expect(row.consumedAt).toBeNull();
    });
  });

  // ==========================================================================
  // 7. Normalization — the control that makes every other control real
  // ==========================================================================

  describe('mobile normalization', () => {
    const canonical = '09121110000';
    const spellings = [
      '09121110000',
      '9121110000',
      '+989121110000',
      '00989121110000',
      '989121110000',
      '0912 111 0000',
      '0912-111-0000',
      '۰۹۱۲۱۱۱۰۰۰۰', // Persian digits
    ];

    it('treats every accepted spelling as ONE bucket for the cooldown', async () => {
      // The first spelling issues a code...
      await sendOtp(spellings[0]).expect(201);

      // ...and every OTHER spelling is refused by the SAME cooldown. Before
      // normalization these were separate Redis keys, so alternating spellings
      // bypassed the cooldown, both rate limits and the challenge lookup
      // outright.
      for (const spelling of spellings.slice(1)) {
        const response = await sendOtp(spelling);
        expect(response.status).toBe(429);
        expect(response.body.error).toBe(OTP_ERROR_COOLDOWN);
      }

      // One row, one send, one SMS — for all eight spellings.
      const [rows] = await testApp.dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM otp_challenges`,
      );
      expect(rows.n).toBe(1);
      expect((await requireChallenge(canonical)).sendCount).toBe(1);
      expect(sender.sent).toHaveLength(1);
      // The sender is handed the CANONICAL form, so the SMS gateway and the
      // account agree on one string.
      expect(sender.sent[0].mobile).toBe(canonical);
    });

    it('verifies a code requested under one spelling against another', async () => {
      await sendOtp('+989121110000').expect(201);
      const code = sender.codeFor(canonical);

      const verified = await verifyOtp('0912-111-0000', code);
      expect(verified.status).toBe(201);

      // The account is created under the canonical form — never under the
      // spelling the client happened to use, which would create a second user
      // for the same human.
      const created = await userByMobile(canonical);
      expect(created).not.toBeNull();
      const [users] = await testApp.dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM users`,
      );
      expect(users.n).toBe(1);
    });

    it('still rejects junk with a 400 rather than stripping it into a valid number', async () => {
      for (const junk of [
        '0912111000',
        '091211100000',
        '0812111000',
        '09121110000x',
        '<script>0912</script>',
        '',
      ]) {
        const response = await sendOtp(junk);
        expect(response.status).toBe(400);
      }
    });
  });

  // ==========================================================================
  // 8. Deactivated customer
  // ==========================================================================

  it('refuses a deactivated customer even with a correct code', async () => {
    const mobile = freshMobile();
    const { user } = await createUser(testApp.dataSource, {
      mobile,
      roles: [UserRoleEnum.site],
    });
    await testApp.dataSource.query(
      `UPDATE users SET "deactivatedAt" = now() WHERE id = $1`,
      [user.id],
    );

    await sendOtp(mobile).expect(201);
    const response = await verifyOtp(mobile, sender.codeFor(mobile));

    expect(response.status).toBe(401);
    expect(response.body.message).toBe(AuthMessages.ACCOUNT_DEACTIVATED);
    expect(response.headers['set-cookie']).toBeUndefined();

    // This response DOES differ from the generic OTP failure, and that is
    // deliberate: it is only reachable by somebody who has already proven
    // control of the phone, so it is not an enumeration channel — and a
    // deactivated customer being told "invalid code" for ever would be an
    // unanswerable support call. The code was still consumed, so it cannot be
    // replayed once the account is reactivated.
    expect((await requireChallenge(mobile)).consumedAt).not.toBeNull();
  });
});
