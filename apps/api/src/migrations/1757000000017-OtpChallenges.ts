import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0017 — `otp_challenges`: the durable, concurrency-safe home for OTP state.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * The OTP flow kept one Redis key (`otp:<mobile>`, TTL 120s) holding an HMAC of
 * the code, and nothing else. Everything a production OTP flow needs was
 * therefore absent:
 *
 *   - no cooldown: `POST /auth/send-otp` could be called in a loop, which is a
 *     free SMS-bombing and SMS-billing primitive aimed at a third party's
 *     phone;
 *   - no rate limit, per number or per caller;
 *   - no bound on wrong guesses: a 6-digit code with unlimited attempts is a
 *     password with 10^6 possibilities and no lockout;
 *   - `GET` then `DEL` is not atomic, so two simultaneous replays of one
 *     correct code could both mint a session;
 *   - and the worst one: `sendOtp` created a PERMANENT `site` user row BEFORE
 *     any verification, so anyone could mass-create accounts for numbers they
 *     do not control, purely by hammering the endpoint.
 *
 * Redis could not fix these. `RedisService` offers `set/get/del/incr` and no
 * compare-and-set, `incr` sets no TTL at all (so a naive attempt counter never
 * expires), there was no durable place to hold the pending mobile number, and
 * the integration harness substitutes an in-memory Map for Redis — so any
 * control built on it is asserted against the substitute, not the primitive.
 *
 * WHAT THIS MIGRATION ADDS
 * ------------------------
 * ONE table, `otp_challenges`, with ONE ROW PER NORMALIZED MOBILE NUMBER
 * (`mobile` is UNIQUE). The row is simultaneously the current challenge and the
 * number's rate-limit bucket, which is what lets a single statement
 *
 *     INSERT ... ON CONFLICT ("mobile") DO UPDATE SET ...
 *       WHERE "resendAvailableAt" <= now() AND <window still has budget>
 *     RETURNING ...
 *
 * evaluate the cooldown, the hourly per-mobile cap and the re-issue atomically,
 * with concurrent senders serialised by the row lock. `RETURNING` no rows means
 * "refused", and it is impossible for two concurrent sends to both issue.
 *
 * Verification is the mirror image — one statement that both counts the attempt
 * and consumes the code:
 *
 *     UPDATE otp_challenges
 *        SET attempts = attempts + 1,
 *            "consumedAt" = CASE WHEN "codeHash" = $2 AND "expiresAt" > now()
 *                                THEN now() ELSE NULL END
 *      WHERE mobile = $1 AND "consumedAt" IS NULL AND attempts < "maxAttempts"
 *     RETURNING "consumedAt"
 *
 * so parallel guesses cannot exceed the bound (they serialise on the row and
 * re-evaluate `attempts < "maxAttempts"`), and two parallel replays of a
 * correct code cannot both see `"consumedAt" IS NULL`.
 *
 * TWO STRUCTURAL GUARANTEES, not just code conventions:
 *
 *   `uq_otp_challenges_mobile`     one live challenge per number, and the
 *                                  conflict target the upsert needs.
 *   `ck_otp_challenges_attempts`   0 <= attempts <= "maxAttempts". The bound is
 *                                  enforced by the database, so a future code
 *                                  path that forgets the `WHERE attempts <
 *                                  "maxAttempts"` guard fails loudly instead of
 *                                  silently granting unlimited guesses.
 *
 * NO PLAINTEXT CODE IS STORED. `codeHash` is
 * HMAC-SHA256(OTP_HMAC_SECRET, `<mobile>:<code>`) in hex; the mobile is bound
 * into the HMAC input so a hash captured for one number cannot be replayed
 * against another. Nothing here is logged.
 *
 * PARTIAL INDEX. `idx_otp_challenges_live` covers only unconsumed rows, which
 * is the only set an expiry sweep or an operational "who is mid-login" query
 * cares about. It never grows with historical rows.
 *
 * TABLE COUNT. This is the FIRST migration since 0002 to add a table:
 * the application table count goes from 24 to 25, and
 * `test/integration/smoke.int-spec.ts` is updated in the same change.
 *
 * ------------------------------------------------------------------------
 * PRE-EXISTING UNVERIFIED `site` USERS — OWNER DECISION, NO DATA TOUCHED HERE
 * ------------------------------------------------------------------------
 * The old `sendOtp` created a `site` user on first sight of a mobile number,
 * before verification. A deployed database therefore contains rows for numbers
 * nobody ever proved they controlled. THIS MIGRATION DELETES AND MODIFIES
 * NOTHING: those rows may be the only record of a real customer's cart, order
 * or address, and a migration must not guess.
 *
 * They are also NOT a live security hole. The new flow does find-or-create on
 * the normalized mobile at the moment of a SUCCESSFUL verification, so an
 * existing row is simply adopted by whoever proves control of the number —
 * exactly the same person who could have used it before. The residual harm is
 * accounting, not access: inflated customer counts in reports and dead rows in
 * `users`.
 *
 * Deactivating them would be actively WRONG: `users.deactivatedAt` makes login
 * fail, so stamping it would lock the legitimate owner out of a number they do
 * control.
 *
 * The safe path, for the owner to run and review by hand — an AUDIT query
 * first, never a delete:
 *
 *   -- NOTE the join-table column names: TypeORM generated `user_roles` with
 *   -- "usersId"/"rolesId" and `bookmark_products` with user_id/product_id
 *   -- (migration 0001), NOT the "userId" convention the other tables use.
 *   SELECT u.id, u.mobile, u."createdAt"
 *     FROM users u
 *     JOIN user_roles ur ON ur."usersId" = u.id
 *     JOIN roles r       ON r.id = ur."rolesId"
 *    WHERE r.name = 'site'
 *      AND u.username IS NULL
 *      AND u.password IS NULL
 *      AND u."deactivatedAt" IS NULL
 *      AND NOT EXISTS (SELECT 1 FROM orders o         WHERE o."userId"  = u.id)
 *      AND NOT EXISTS (SELECT 1 FROM cart_items c     WHERE c."userId"  = u.id)
 *      AND NOT EXISTS (SELECT 1 FROM addresses a      WHERE a."userId"  = u.id)
 *      AND NOT EXISTS (SELECT 1 FROM refresh_tokens t WHERE t."userId"  = u.id)
 *      AND NOT EXISTS (SELECT 1 FROM bookmark_products b WHERE b.user_id = u.id)
 *      AND u."createdAt" < now() - interval '90 days'
 *    ORDER BY u."createdAt";
 *
 * Every row it returns is provably empty AND has never held a session. Removing
 * them is a data-retention decision with a real (if small) blast radius —
 * `orders.cashierUserId` is ON DELETE RESTRICT and other tables reference
 * `users` — so it stays a deliberate, reviewed operator action rather than
 * something a schema migration does on deploy.
 */
export class OtpChallenges1757000000017 implements MigrationInterface {
  name = 'OtpChallenges1757000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "otp_challenges" (
         "id" SERIAL NOT NULL,
         "mobile" character varying(20) NOT NULL,
         "codeHash" character varying(64) NOT NULL,
         "attempts" integer NOT NULL DEFAULT 0,
         "maxAttempts" integer NOT NULL DEFAULT 5,
         "sendCount" integer NOT NULL DEFAULT 0,
         "windowStartedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "resendAvailableAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
         "consumedAt" TIMESTAMP WITH TIME ZONE,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "ck_otp_challenges_attempts"
           CHECK ("attempts" >= 0 AND "attempts" <= "maxAttempts"),
         CONSTRAINT "ck_otp_challenges_max_attempts"
           CHECK ("maxAttempts" > 0),
         CONSTRAINT "uq_otp_challenges_mobile" UNIQUE ("mobile"),
         CONSTRAINT "PK_otp_challenges" PRIMARY KEY ("id")
       )`,
    );

    // Only unconsumed rows are ever scanned by an expiry sweep or by an
    // operational "which numbers are mid-login" query, so the index does not
    // grow with history.
    await queryRunner.query(
      `CREATE INDEX "idx_otp_challenges_live" ON "otp_challenges" ("expiresAt")
         WHERE "consumedAt" IS NULL`,
    );
  }

  /**
   * Reverses `up()` completely.
   *
   * DATA LOSS, STATED PLAINLY: every in-flight OTP challenge is destroyed, so
   * anybody holding an unverified code has to request a new one. Nothing else
   * is lost — no user, session, order or payment row is referenced by this
   * table, and no plaintext secret was ever stored in it, so there is nothing
   * worth exporting first.
   *
   * Note that rolling this back ALSO restores the defective flow the schema
   * replaced: no cooldown, no rate limit, unbounded guessing, non-atomic
   * consumption, and account creation before verification.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_otp_challenges_live"`);
    await queryRunner.query(`DROP TABLE "otp_challenges"`);
  }
}
