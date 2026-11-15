import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0028 — retires `reports.read`.
 *
 * ---------------------------------------------------------------------------
 * THE OWNER'S RULE, AND WHY A CAPABILITY CODE COULD NOT EXPRESS IT
 *
 *   "Sales reports are available only to the main administrator, represented
 *    by the built-in `super_admin` role."
 *
 * A catalogue permission exists so that it CAN be delegated: the RBAC editor
 * lists it, `POST /admin/access/roles` accepts it, and any custom role may
 * hold it. Publishing `reports.read` and then relying on everyone to remember
 * never to grant it is a rule enforced by convention — and the convention had
 * already broken. A delegated "accountant" role holding `admin.access` +
 * `reports.read` was being created, documented and asserted in the test suite,
 * and the controller's own comments contradicted each other about whether
 * reporting belonged to the administrator alone or to a delegate.
 *
 * `ReportsController` is now gated on the ROLE (`@Roles(super_admin)` plus
 * `@Audiences('admin')`), with `ReportsService.assertReportViewer` re-asserting
 * it below the controller. No permission string participates in the decision
 * any more, so the code has nothing left to do.
 *
 * ---------------------------------------------------------------------------
 * RETIRE, DO NOT DELETE — three independent reasons
 *
 * 1. IT IS THE SAFER MIGRATION-COMPATIBLE DESIGN. `permissions.code` is
 *    referenced by `role_permissions.permissionId` with ON DELETE CASCADE.
 *    DELETEing the row would silently destroy every grant that ever pointed at
 *    it, on every deployed database, with no record that it had been granted.
 *    Retirement is reversible: `down()` clears the timestamp and the grants are
 *    still there.
 *
 * 2. A RETIRED CODE ALREADY GRANTS NOTHING, STRUCTURALLY. Every query in
 *    `PermissionService` filters `p."retiredAt" IS NULL`
 *    (`resolveEffective`, `permissionsByRoleIds`, `listCatalog`). So a stale
 *    `role_permissions` row naming `reports.read` — on a database upgraded
 *    from before this migration — contributes to nobody's effective set from
 *    the moment this lands. That is exactly the owner's requirement that "a
 *    custom role must never obtain effective sales-report access, even if a
 *    stale database row or request contains `reports.read`", and it holds
 *    without anything remembering to check.
 *
 * 3. IT CANNOT BE RE-GRANTED. `RbacService.assertKnownPermissions` validates
 *    against `PERMISSION_CODES`, built from the CODE catalogue, which no
 *    longer contains `reports.read`. `POST /admin/access/roles` and
 *    `PUT /admin/access/roles/:id/permissions` answer 400 `UNKNOWN_PERMISSION`.
 *    `GET /admin/access/permissions` serves the same catalogue, so the RBAC
 *    editor stops offering it with no UI change required.
 *
 * DELETING THE EXISTING GRANTS IS ALSO DELIBERATELY NOT DONE.
 * `permission-catalog-boot.int-spec.ts` pins the property that a retired
 * permission "stops granting anything, WITHOUT LOSING THE GRANT" — the grant
 * row is the audit record of who was once given what. Removing it here would
 * contradict that property and erase the only evidence that a delegation had
 * been made.
 *
 * ---------------------------------------------------------------------------
 * BOOT INTEGRITY IS PRESERVED. `PermissionCatalogIntegrityService` refuses to
 * start when the database and the code catalogue disagree. Its rules are:
 * a code the CODE declares but the database lacks is `missing`; a code the
 * database has ACTIVE that the code does not declare is `unexpected_active`;
 * and a row that is RETIRED and not declared by code is explicitly fine
 * (`diffCatalogue`, the `continue` in the trailing loop). This migration moves
 * `reports.read` into exactly that last state, so a process running the new
 * code against a database that has run this migration starts cleanly — and a
 * process running the NEW code against an UNMIGRATED database refuses to start
 * with `unexpected_active: reports.read`, which is the correct, loud failure.
 */
export class RetireReportsReadPermission1757000000028 implements MigrationInterface {
  name = 'RetireReportsReadPermission1757000000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * A FIXED INSTANT, NOT `now()`.
     *
     * `retiredAt` is the date of the DECISION, and the decision has one date.
     * `now()` gave it the date of whichever deployment happened to run the
     * migration, so two databases migrated a week apart disagreed about when
     * the capability was withdrawn — and `permission-catalog-boot.int-spec.ts`
     * caught it precisely: its up/down/up case snapshots every row and found
     * the two applications differing by 740 milliseconds. A migration that
     * produces a different database each time it is applied is not a
     * migration, it is a script.
     *
     * The value is this migration's own timestamp prefix (1757000000028 ms
     * since the epoch), so the constant is not a second fact that can drift
     * from the file it lives in.
     *
     * Still idempotent on `retiredAt IS NULL`, so re-running cannot rewrite a
     * row an operator has already reasoned about.
     */
    await queryRunner.query(
      `UPDATE "permissions"
          SET "retiredAt" = to_timestamp(1757000000028 / 1000.0)
        WHERE "code" = 'reports.read'
          AND "retiredAt" IS NULL`,
    );

    // A database that never ran migration 0020 has no such row at all; that is
    // not an error, and nothing above assumes otherwise.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Un-retires the row. The grants were never removed, so a revert restores
    // the previous behaviour exactly — which is the property that made
    // retirement the reversible choice in the first place.
    //
    // NOTE what a revert does NOT do: it cannot put `reports.read` back into
    // the CODE catalogue. Reverting this migration therefore also requires
    // reverting the application code, and running the new code against a
    // reverted database is refused at boot with `unexpected_active` rather
    // than silently re-opening the capability. That refusal is the point.
    await queryRunner.query(
      `UPDATE "permissions"
          SET "retiredAt" = NULL
        WHERE "code" = 'reports.read'`,
    );
  }
}
