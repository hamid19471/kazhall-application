import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0022 — `admin_audit_log`, the append-only record of administrative acts.
 *
 * WHY A THIRD AUDIT TABLE. There are already two, and both are deliberately
 * narrow: `order_actions` records what happened to ONE ORDER, and
 * `payment_actions` records what an operator decided about ONE RECONCILIATION
 * CASE. Neither can hold "who gave this role the ability to void sales", "who
 * reset this cashier's password" or "who closed this branch" — and those are
 * exactly the acts that need a record, because they change what other people
 * are able to do rather than changing one document.
 *
 * Every act here is written by `AdminAuditService` inside the same transaction
 * as the change it describes, so a committed change without its audit row is
 * not representable.
 *
 * APPEND-ONLY IS ENFORCED BY THE DATABASE, exactly as it is for
 * `payment_actions`: `trg_admin_audit_log_append_only` raises on any UPDATE or
 * DELETE. An audit trail that application code is merely trusted not to
 * rewrite is not an audit trail, and "no ordinary Admin API can edit it" is a
 * claim a row trigger can make and a code review cannot. (`TRUNCATE` does not
 * fire row triggers, so the integration harness's per-test reset still works,
 * and `TRUNCATE` needs table ownership, which an application credential should
 * not hold.)
 *
 * THERE IS NO FOREIGN KEY ON `actorUserId`, for the same reason
 * `payment_actions` has none: `ON DELETE SET NULL` is an UPDATE, and an UPDATE
 * is what the trigger must forbid. Deleting a staff member would therefore
 * either rewrite history or fail with a trigger error. The id is kept for
 * joining while the account exists; `actorDisplaySnapshot` is the part that
 * must outlive it, and it is NOT NULL.
 *
 * WHAT MUST NEVER LAND IN `summary`: plaintext passwords, password hashes,
 * refresh-token hashes, JWTs, cookies, OTP codes, gateway secrets, or a raw
 * request body. `AdminAuditService` builds every summary from an explicit
 * allow-list of scalar fields for exactly this reason — a "just spread the
 * DTO" convenience would put a password in the audit log on the first
 * password-reset call.
 */
export class AdminAuditLog1757000000022 implements MigrationInterface {
  name = 'AdminAuditLog1757000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "admin_audit_log" (
        "id"                   BIGSERIAL PRIMARY KEY,
        "actorUserId"          integer NULL,
        "actorDisplaySnapshot" character varying(160) NOT NULL,
        "actorAudience"        character varying(16)  NULL,
        "action"               character varying(64)  NOT NULL,
        "targetType"           character varying(32)  NOT NULL,
        "targetId"             character varying(64)  NULL,
        "targetLabel"          character varying(200) NULL,
        "summary"              jsonb NULL,
        "requestId"            character varying(64) NULL,
        "createdAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);

    // "the newest administrative acts" — the audit screen's default query.
    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_created" ON "admin_audit_log" ("createdAt" DESC, "id" DESC)`,
    );
    // "everything that happened to THIS user / role / branch".
    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_target" ON "admin_audit_log" ("targetType", "targetId", "createdAt" DESC)`,
    );
    // "everything THIS administrator did".
    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_actor" ON "admin_audit_log" ("actorUserId", "createdAt" DESC)`,
    );
    // The action filter on the audit screen.
    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_action" ON "admin_audit_log" ("action", "createdAt" DESC)`,
    );

    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."admin_audit_log_append_only"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION
           'admin_audit_log is append-only: % is not permitted', TG_OP
           USING ERRCODE = '23514';
       END;
       $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_admin_audit_log_append_only"
         BEFORE UPDATE OR DELETE ON "admin_audit_log"
         FOR EACH ROW EXECUTE FUNCTION "public"."admin_audit_log_append_only"()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_admin_audit_log_append_only" ON "admin_audit_log"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "public"."admin_audit_log_append_only"()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_audit_log"`);
  }
}
