import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Role } from '../entities/role.entity';
import { PERMISSION_CATALOG, PermissionSpec } from './permission.catalog';
import { systemRolePermissions } from './system-roles';

interface CodeRow {
  code: string;
}

interface PermissionRow {
  id: number;
  code: string;
  groupKey: string;
  labelFa: string;
  descriptionFa: string;
  risk: string;
}

/**
 * ===========================================================================
 * EFFECTIVE PERMISSIONS — the one place "what may this principal do" is
 * answered
 * ===========================================================================
 *
 * THIS SERVICE NEVER WRITES. It expands a user's ROLES into a set of
 * capability CODES and resolves codes to ids; it does not create, update or
 * delete a catalogue row under any circumstance. Catalogue rows are owned by
 * migrations, and `PermissionCatalogIntegrityService` refuses to start the
 * process if the table and the code disagree — so by the time any method here
 * runs, the two are known to match.
 *
 * That is a change from the earlier design, which upserted the catalogue at
 * boot and "self-healed" on a missed lookup. The reasoning for removing it is
 * in the header of `permission-catalog.integrity.ts`; the short version is
 * that a lookup miss means a migration did not run, and quietly inserting the
 * row converts a fault an operator must know about into a log line.
 *
 * WHERE THE ANSWER COMES FROM. Roles are read from the database on every
 * request (`JwtStrategy` already does this, so a role change takes effect on
 * the next request rather than the next token rotation) and expanded here. The
 * token's own claims are NEVER consulted: a JWT is a bearer credential the
 * holder could not have altered, but it is also a SNAPSHOT, and a snapshot of
 * authority is exactly what must not outlive a revocation.
 *
 * COST. A user holding only built-in roles costs ZERO queries — their sets
 * come from `SYSTEM_ROLE_PERMISSIONS`, in memory. Only a user holding at least
 * one CUSTOM role pays one indexed query against the composite primary key of
 * `role_permissions`. There is deliberately no cache: "permission changes must
 * affect active sessions promptly" is the requirement, and a TTL cache is a
 * window in which a revoked capability still works.
 *
 * RETIRED CODES GRANT NOTHING. Every query below filters on
 * `p."retiredAt" IS NULL`. A retired permission keeps its `role_permissions`
 * rows — that is what makes retirement reversible and auditable — but it stops
 * contributing to anybody's effective set the moment the migration lands.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The authoritative expansion.
   *
   * Inactive roles contribute nothing — that is what makes deactivating a
   * custom role a reversible way to suspend the access it grants, instead of
   * deleting it and losing every assignment.
   */
  async resolveEffective(
    roles: readonly Role[],
    manager?: EntityManager,
  ): Promise<string[]> {
    const codes = new Set<string>();
    const customRoleIds: number[] = [];

    for (const role of roles) {
      if (role.isActive === false) continue;

      // Matched on NAME, from code — not on the `isSystem` COLUMN. A row that
      // somehow claimed `super_admin` was not a system role must not thereby
      // become editable, so the code-side answer wins.
      const builtIn = systemRolePermissions(role.name);
      if (builtIn) {
        for (const code of builtIn) codes.add(code);
        continue;
      }
      customRoleIds.push(role.id);
    }

    if (customRoleIds.length > 0) {
      const scope = manager ?? this.dataSource.manager;
      const rows = await scope.query<CodeRow[]>(
        `SELECT DISTINCT p."code"
           FROM "role_permissions" rp
           JOIN "permissions" p ON p."id" = rp."permissionId"
          WHERE rp."roleId" = ANY($1::int[])
            AND p."retiredAt" IS NULL`,
        [customRoleIds],
      );
      for (const row of rows) codes.add(row.code);
    }

    return [...codes];
  }

  /**
   * BATCH expansion, for a LIST of users.
   *
   * The per-user path would be one query per row with a custom role, which is
   * the N+1 the admin screens must not have. Callers collect every custom role
   * id on the page, call this once, and union in memory.
   *
   * System roles are absent from the result by design — their sets come from
   * `SYSTEM_ROLE_PERMISSIONS` and never touch the database.
   */
  async permissionsByRoleIds(
    roleIds: readonly number[],
    manager?: EntityManager,
  ): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    if (roleIds.length === 0) return result;

    const scope = manager ?? this.dataSource.manager;
    const rows = await scope.query<Array<{ roleId: number; code: string }>>(
      `SELECT rp."roleId", p."code"
         FROM "role_permissions" rp
         JOIN "permissions" p ON p."id" = rp."permissionId"
        WHERE rp."roleId" = ANY($1::int[])
          AND p."retiredAt" IS NULL`,
      [[...roleIds]],
    );

    for (const row of rows) {
      const id = Number(row.roleId);
      const codes = result.get(id);
      if (codes) codes.push(row.code);
      else result.set(id, [row.code]);
    }
    return result;
  }

  /** Same expansion for ONE role, used by the access-control screen. */
  async permissionsForRole(
    role: Role,
    manager?: EntityManager,
  ): Promise<string[]> {
    return this.resolveEffective([role], manager);
  }

  /**
   * The catalogue as stored, for the access-control screen's checklist.
   *
   * Retired rows are excluded: a code no guard checks must not be offered as
   * a tick box, or an administrator grants authority that exists in the UI and
   * nowhere else.
   */
  async listCatalog(manager?: EntityManager): Promise<PermissionRow[]> {
    const scope = manager ?? this.dataSource.manager;
    return scope.query<PermissionRow[]>(
      `SELECT "id", "code", "groupKey", "labelFa", "descriptionFa", "risk"
         FROM "permissions"
        WHERE "retiredAt" IS NULL
        ORDER BY "id" ASC`,
    );
  }

  /**
   * Resolves codes to ids, refusing any code the catalogue does not define.
   *
   * A miss is returned as a miss and the caller produces its 400. It is NOT
   * repaired here. The previous implementation re-synced the table and
   * retried whenever the miss was a code the source file defines, which meant
   * the one symptom that reliably indicates "this database is behind the
   * migrations" silently healed itself instead of surfacing.
   *
   * That symptom cannot occur any more: the integrity check at boot refuses to
   * start a process whose catalogue does not match, so a miss now means
   * exactly what it says — an unknown code.
   */
  async idsForCodes(
    codes: readonly string[],
    manager?: EntityManager,
  ): Promise<Map<string, number>> {
    if (codes.length === 0) return new Map();

    const scope = manager ?? this.dataSource.manager;
    const rows = await scope.query<Array<{ id: number; code: string }>>(
      `SELECT "id", "code" FROM "permissions"
        WHERE "code" = ANY($1::text[]) AND "retiredAt" IS NULL`,
      [[...codes]],
    );
    const found = new Map(rows.map((row) => [row.code, Number(row.id)]));

    // A code the SOURCE defines but the table does not is not a caller error —
    // it means the running process should never have started. Logged loudly,
    // then reported as a miss so the caller still refuses the grant.
    const shouldExist = codes.filter(
      (code) =>
        !found.has(code) &&
        PERMISSION_CATALOG.some((spec) => spec.code === code),
    );
    if (shouldExist.length > 0) {
      this.logger.error(
        `permissions table is missing ${shouldExist.length} row(s) the code catalogue declares ` +
          `(${shouldExist.join(', ')}). The database is behind the migrations; ` +
          `the boot-time integrity check should have prevented this process from starting.`,
      );
    }

    return found;
  }

  /** The in-memory catalogue, for callers that need labels without a query. */
  catalog(): readonly PermissionSpec[] {
    return PERMISSION_CATALOG;
  }
}
