import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ===========================================================================
 * otp_challenges — one durable row per normalized mobile number
 * ===========================================================================
 *
 * WHY POSTGRESQL AND NOT REDIS.
 *
 * The previous implementation kept the OTP hash in Redis under `otp:<mobile>`
 * with a 120s TTL, and that choice is what made every control below
 * impossible to write correctly:
 *
 *  1. NO DURABLE PLACE FOR THE PENDING MOBILE. Because Redis held only a hash,
 *     `sendOtp` had nowhere to remember "somebody claims this number" — so it
 *     created a PERMANENT `site` user row before any verification. Anyone could
 *     mass-create accounts by hammering `POST /auth/send-otp`. The pending
 *     number now lives in THIS row and the user is created only on the first
 *     successful verification.
 *
 *  2. NO ATOMIC BOUNDED ATTEMPTS. Counting wrong guesses needs
 *     read-modify-write. `RedisService` exposes `incr` (which does not even set
 *     a TTL, so the counter would outlive the challenge for ever) and no
 *     compare-and-set, so N parallel guesses could all pass a bound check made
 *     in application code. `UPDATE ... SET attempts = attempts + 1
 *     WHERE attempts < "maxAttempts" RETURNING ...` bounds them under a row
 *     lock, and `ck_otp_challenges_attempts` makes the bound structural.
 *
 *  3. NO ATOMIC ONE-TIME CONSUMPTION. `GET` then `DEL` is two round trips: two
 *     simultaneous replays of one correct code both read it and both
 *     authenticated. Consumption is now the same single UPDATE, guarded by
 *     `"consumedAt" IS NULL`.
 *
 *  4. NOT TESTABLE. The integration harness substitutes an in-memory Map for
 *     `RedisService`, so anything built on Redis is asserted against the
 *     substitute rather than against the real primitive. These rows are
 *     asserted against a real PostgreSQL.
 *
 * ONE ROW PER MOBILE, FOR EVER. `mobile` is UNIQUE and the row is never
 * deleted: it is the mobile number's rate-limit bucket as well as its current
 * challenge. That is what lets a single `INSERT ... ON CONFLICT (mobile)
 * DO UPDATE ... WHERE <cooldown and window still allow it> RETURNING *`
 * evaluate the cooldown, the hourly cap and the re-issue in one statement, with
 * concurrent senders serialised by the row lock. Table growth is bounded by the
 * number of distinct mobile numbers ever seen, and no plaintext code and no
 * personal data beyond the number itself is stored.
 *
 * WRITTEN THROUGH RAW SQL ONLY. Every mutation in `OtpService` is a single
 * conditional statement; there is deliberately no `save()` path, because a
 * read-modify-write through the repository is exactly the race this table
 * exists to eliminate. This class is the typed row shape and the schema
 * documentation.
 *
 * ===========================================================================
 * THREE COLUMN DEFAULTS EXIST IN THE DATABASE AND ARE NOT RESTATED HERE
 * ===========================================================================
 * Migration 0017 (`OtpChallenges1757000000017`) created this table with
 *
 *   "maxAttempts"       integer NOT NULL DEFAULT 5
 *   "windowStartedAt"   timestamptz NOT NULL DEFAULT now()
 *   "resendAvailableAt" timestamptz NOT NULL DEFAULT now()
 *
 * and the `@Column`s below deliberately omit all three, so `typeorm
 * schema:log` permanently proposes three `DROP DEFAULT` statements. THAT DIFF
 * IS EXPECTED AND MUST NOT BE "FIXED" — in either direction. Reasons, one per
 * column:
 *
 *  - `maxAttempts` is SNAPSHOTTED per row from `OTP_MAX_VERIFY_ATTEMPTS` (see
 *    the property comment). Mirroring `default: 5` here would publish a second,
 *    silently divergent copy of a policy number whose whole point is that it
 *    lives in one place and is frozen at issue time. The database default is a
 *    last-resort floor for a row inserted by something other than `OtpService`
 *    — a manual `INSERT` during an incident — where 5 is safer than a failed
 *    statement or an unbounded guess budget.
 *
 *  - `windowStartedAt` / `resendAvailableAt` are the rate-limit window origin
 *    and the cooldown gate. Every real write sets both explicitly, computed
 *    from the SAME `now()` as the rest of the upsert so the window, the
 *    cooldown and the expiry cannot disagree by a round trip. `DEFAULT now()`
 *    exists only so that an `INSERT` which omits them is closed (a fresh
 *    window, cooldown already elapsed) rather than rejected by NOT NULL — the
 *    fail-safe, since the alternative to a default here is no row at all and
 *    therefore no bucket to rate-limit against.
 *
 * Dropping the defaults to match the entity would remove that floor; adding
 * them to the entity would imply the application relies on them, which it must
 * not. The entity states the row SHAPE; the migration states the STORAGE
 * fallback. They are allowed to differ here precisely because nothing in
 * `OtpService` ever leaves these columns to the database.
 */
@Entity('otp_challenges')
export class OtpChallenge {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * The NORMALIZED mobile number (`09XXXXXXXXX`, see
   * `otp.policy.ts#normalizeMobile`). UNIQUE — this is the conflict target of
   * the upsert and the bucket key for the cooldown and the per-mobile cap.
   *
   * Normalization is not cosmetic here: two spellings of one number would be
   * two rows, and every control keyed by this column would be bypassable by
   * alternating spellings.
   */
  @Column({ type: 'varchar', length: 20, unique: true })
  mobile: string;

  /**
   * HMAC-SHA256(OTP_HMAC_SECRET, `<normalized mobile>:<code>`), hex.
   *
   * The code itself is never stored and never logged. Binding the mobile into
   * the HMAC input means a hash captured for one number cannot be replayed
   * against another.
   */
  @Column({ type: 'varchar', length: 64 })
  codeHash: string;

  /** Verification attempts made against the CURRENT code. Reset on re-issue. */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /**
   * The attempt bound, SNAPSHOTTED at issue time from
   * `OTP_MAX_VERIFY_ATTEMPTS`.
   *
   * Stored per row rather than read from the constant inside the SQL so that
   * tightening the policy cannot retroactively resurrect a challenge that was
   * already dead, nor kill one mid-flight for a user who is holding a valid
   * code.
   */
  @Column({ type: 'int' })
  maxAttempts: number;

  /** Sends counted inside the current per-mobile window. */
  @Column({ type: 'int', default: 0 })
  sendCount: number;

  /** Start of the current per-mobile send window. */
  @Column({ type: 'timestamptz' })
  windowStartedAt: Date;

  /** Cooldown gate: a send before this instant is refused. */
  @Column({ type: 'timestamptz' })
  resendAvailableAt: Date;

  /** Expiry of the current code. An expired code is rejected like a wrong one. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /**
   * Set by the consuming UPDATE. Non-null means this code has already bought a
   * session and must never buy another — the replay guard.
   */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
