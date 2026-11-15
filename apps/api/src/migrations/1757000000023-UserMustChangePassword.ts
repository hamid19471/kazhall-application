import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0023 — `users.mustChangePassword`.
 *
 * THE WORKFLOW THIS MAKES SAFE. An administrator has to be able to give a
 * cashier who has forgotten their password a way back in. Every option has a
 * failure mode, and this is the one that has the smallest:
 *
 *   - "show me the existing password" is impossible and must stay impossible:
 *     the column holds a bcrypt hash and nothing can recover the input;
 *   - "generate one and display it once" puts a live credential in a browser
 *     tab, in a screenshot, and in whatever the administrator pastes it into;
 *   - ADMINISTRATOR-ENTERED TEMPORARY PASSWORD + FORCED CHANGE, which is what
 *     this column implements: the administrator types a value they hand over
 *     out of band, the account is flagged, and the very first thing the user
 *     can do with the resulting session is replace it. The administrator's
 *     value is live for one sign-in and is then gone.
 *
 * The flag is not advisory. `JwtAuthGuard` refuses every request from a
 * flagged principal with 403 `PASSWORD_CHANGE_REQUIRED`, EXCEPT on routes
 * marked `@AllowPasswordChangePending()` — introspection, rotation, sign-out
 * and the change-password endpoint itself. A flag the frontend is merely asked
 * to respect is not a control; a flag that leaves no way to clear it is a
 * lockout.
 *
 * Setting it always accompanies stamping `users.passwordChangedAt`, so the
 * reset also cuts every session the user already had, in every audience.
 *
 * DEFAULT FALSE: no existing account is challenged by this migration.
 */
export class UserMustChangePassword1757000000023 implements MigrationInterface {
  name = 'UserMustChangePassword1757000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "mustChangePassword" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "mustChangePassword"`,
    );
  }
}
