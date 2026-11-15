import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0027 — `users."passwordVersion"`: a monotonic counter that ends a session
 * WITHOUT asking what time it is.
 *
 * ---------------------------------------------------------------------------
 * THE AMBIGUITY THIS REMOVES
 *
 * Session invalidation used to compare a JWT's `iat` against
 * `users."passwordChangedAt"`. A JWT `iat` is in WHOLE SECONDS; the column is
 * `timestamptz` with microsecond precision. When a token is minted in the same
 * second as a password change, the two values cannot be ordered — the
 * information needed to order them was thrown away when `iat` was rounded down
 * to a second.
 *
 * Either resolution of that tie is wrong:
 *
 *   - Resolve it in the token's favour (`iat >= floor(changedAt/1000)` passes)
 *     and every session minted during the change's own second survives — the
 *     precise second in which a compromised session is supposed to die.
 *   - Resolve it in the attacker's disfavour, which is what the code did
 *     (`iat * 1000 < changedAt.getTime()` → reject), and a LEGITIMATE login in
 *     that same second is rejected once and succeeds on retry. The user sees a
 *     password change that appears to have failed, then works.
 *
 * The second is the safe choice and was the right one to have made, but it is
 * still a wrong answer some of the time, and no amount of care in the
 * comparison can fix it: the ambiguity is in the DATA, not in the comparison.
 *
 * ---------------------------------------------------------------------------
 * THE REPLACEMENT: AN INTEGER, COMPARED FOR EQUALITY
 *
 * Every token now carries `pv`, the value of `users."passwordVersion"` at the
 * moment it was minted, and a verifier accepts the token only when `pv` still
 * EQUALS the column. Changing a password increments the column; every token
 * carrying the old value stops being accepted at the very next request, and a
 * token minted afterwards carries the new value and is accepted immediately.
 *
 * There is no clock in that sentence. Two events in the same microsecond are
 * still strictly ordered, because the increment happens inside the database
 * under the row's own lock, and the token is minted from the value the
 * increment returned. Nothing rounds, so nothing is ambiguous.
 *
 * ---------------------------------------------------------------------------
 * WHY `NOT NULL DEFAULT 1` AND NOT `DEFAULT 0`
 *
 * Nothing distinguishes "never changed" from "changed once" in this design and
 * nothing needs to: the value is an opaque epoch counter, compared only with
 * itself. Starting at 1 rather than 0 means a falsy `pv` claim is always
 * wrong, so `!payload.pv` is a safe (if not load-bearing) rejection and no
 * reader can confuse "version zero" with "claim absent". The CHECK constraint
 * states the non-negativity the contract promises where it cannot be bypassed.
 *
 * EXISTING ROWS all take the default, which is exactly right: their current
 * password IS their version-1 password.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LIVE REFRESH TOKEN IS REVOKED HERE
 *
 * Tokens minted before this migration carry no `pv` claim at all, and the
 * verifier rejects a token it cannot place in the version sequence — it fails
 * CLOSED, because "this token predates the mechanism" is not a reason to trust
 * it. Those sessions are therefore already dead the moment the new code runs.
 *
 * Revoking the ROWS as well makes that explicit rather than implied, and stops
 * `activeSessionCount` on the admin user screen reporting sessions that cannot
 * be used. It is the same decision migration 0019 made when it introduced the
 * `audience` column, and for the same reason: a one-off mass re-login is the
 * honest cost of changing what a session IS.
 */
export class UserPasswordVersion1757000000027 implements MigrationInterface {
  name = 'UserPasswordVersion1757000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "passwordVersion" integer NOT NULL DEFAULT 1`,
    );

    // The contract says non-negative. Stated in the database, where a future
    // code path that writes it directly cannot bypass it.
    await queryRunner.query(
      `ALTER TABLE "users"
         ADD CONSTRAINT "chk_users_password_version_non_negative"
         CHECK ("passwordVersion" >= 0)`,
    );

    // Every token minted before this migration lacks the `pv` claim and is
    // already refused by the verifier. Revoking the rows makes the kill
    // explicit and keeps the session counters truthful.
    await queryRunner.query(
      `UPDATE "refresh_tokens" SET "revoked" = true WHERE "revoked" = false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The constraint is attached to the column, so dropping the column would
    // take it with it; dropping it explicitly first means a partially applied
    // `up()` still reverses cleanly.
    await queryRunner.query(
      `ALTER TABLE "users"
         DROP CONSTRAINT IF EXISTS "chk_users_password_version_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "passwordVersion"`,
    );

    // Symmetrical to `up()`: after a revert, every session minted by the
    // version-aware code carries a claim the reverted verifier does not
    // understand and would ignore, which would silently RESURRECT sessions a
    // password change was supposed to have ended. Revoking them keeps the
    // revert as safe as the apply.
    await queryRunner.query(
      `UPDATE "refresh_tokens" SET "revoked" = true WHERE "revoked" = false`,
    );
  }
}
