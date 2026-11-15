import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0006 — `users` lifecycle columns (docs/ARCHITECTURE.md §3, §4).
 *
 *   deactivatedAt     soft deactivation. `orders.cashierUserId` is ON DELETE
 *                     RESTRICT, so retiring a staff member with sales MUST be
 *                     done by setting this rather than by deleting the row.
 *                     Deactivated users fail login and are disconnected from
 *                     any live websocket on the next re-validation tick.
 *
 *   passwordChangedAt used by JwtStrategy: an access token whose `iat` predates
 *                     this instant is rejected, so a password change (or an
 *                     admin-forced reset) invalidates every session that was
 *                     already open.
 *
 * Both are `timestamptz` — comparison against a JWT `iat` must be absolute, not
 * server-local.
 */
export class UserLifecycleColumns1757000000006 implements MigrationInterface {
  name = 'UserLifecycleColumns1757000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "deactivatedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "passwordChangedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_active" ON "users" ("id") WHERE "deactivatedAt" IS NULL`,
    );
    // The refresh-rotation UPDATE is `WHERE tokenId = :id AND revoked = false`;
    // logout revokes by userId. Both want the live rows only.
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_active_user" ON "refresh_tokens" ("userId") WHERE revoked = false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_refresh_tokens_active_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_users_active"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "passwordChangedAt"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deactivatedAt"`);
  }
}
