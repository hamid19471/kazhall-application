import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Binds every refresh token to the application that issued it.
 *
 * Browser cookies are scoped by host, not by port, so the storefront, the admin
 * console and the till all shared one `access_token`/`refresh_token` pair on
 * `localhost`. Signing into the till made the storefront show the cashier, and
 * signing out of the storefront destroyed the till's session. The token now
 * carries a signed `aud` claim and the row carries the matching column, so a
 * refresh token presented to the wrong surface is refused by the database row
 * as well as by the claim.
 *
 * EXISTING ROWS ARE REVOKED RATHER THAN LABELLED. There is no evidence in the
 * row saying which application a pre-existing session came from, and guessing
 * would reintroduce exactly the confusion this removes. Revoking costs every
 * signed-in user one re-login; mislabelling would leave a cross-surface session
 * alive and indistinguishable from a correct one.
 */
export class SessionAudiences1757000000019 implements MigrationInterface {
  name = 'SessionAudiences1757000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "refresh_tokens" SET "revoked" = true WHERE "revoked" = false`,
    );

    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD "audience" character varying(16)`,
    );
    await queryRunner.query(
      `UPDATE "refresh_tokens" SET "audience" = 'storefront' WHERE "audience" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "audience" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_audience" ` +
        `CHECK ("audience" IN ('storefront', 'admin', 'pos'))`,
    );

    // Revocation sweeps and logout-all read by user; the audience narrows the
    // per-surface logout to one row set without a second index.
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_active_user_audience" ` +
        `ON "refresh_tokens" ("userId", "audience") WHERE "revoked" = false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_refresh_tokens_active_user_audience"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "ck_refresh_tokens_audience"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "audience"`,
    );
  }
}
