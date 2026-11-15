import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  RoleErrorCodes,
  RoleMessages,
} from 'src/common/constants/role.messages';

/**
 * ===========================================================================
 * ROLE SAFETY — the server-side half of "you cannot lock yourself out"
 * ===========================================================================
 *
 * Two lockouts are possible in this schema and both are silent:
 *
 *  1. `user_roles."rolesId"` is `ON DELETE CASCADE`. Deleting a row from
 *     `roles` therefore strips that role from EVERY user without any error and
 *     without any trace. `DELETE /roles/{super_admin id}` used to be a single
 *     request that demoted every administrator at once.
 *
 *  2. Removing `super_admin` from the last user who holds it (via
 *     `DELETE /roles/remove`, via `PATCH /users/{id}`'s `role` field which
 *     REPLACES the whole set, or via deleting/deactivating that user) leaves a
 *     system nobody can administer. Every route that could restore the role is
 *     itself `@Roles(super_admin)`, so the state is unrecoverable through the
 *     API.
 *
 * Every check below is server-side and runs inside the caller's transaction,
 * holding a row-level lock, because a check that is not serialised is not a
 * check: two requests that each read "count == 2" and then each remove one
 * assignment both commit and leave zero.
 *
 * ---------------------------------------------------------------------------
 * LOCK ORDER (violate this and you get deadlocks, not bugs)
 * ---------------------------------------------------------------------------
 * The `roles` row named `super_admin` is the mutex for "who can administer
 * this system". Any operation that needs more than one `roles` row lock MUST
 * take the `super_admin` row FIRST and every other row after it. Operations
 * that need exactly one `roles` row lock (role deletion, single role
 * assignment/unassignment) cannot participate in a lock cycle at all, so they
 * just lock their own target.
 */

export interface RoleRow {
  id: number;
  name: string;
}

/**
 * The roles the application's own guards are written against. `UserRoleEnum`
 * IS the definition — matching on names rather than ids is deliberate, because
 * `roles.id` differs per environment and per seed run, so an id-based
 * allow-list protects the wrong row on the next database.
 */
export const BUILT_IN_ROLE_NAMES: readonly string[] = Object.freeze(
  Object.values(UserRoleEnum) as string[],
);

export function isBuiltInRoleName(name: string): boolean {
  return BUILT_IN_ROLE_NAMES.includes(name);
}

/** `roles.name` comes back from raw SQL as a plain string, not the enum. */
export function isSuperAdminRoleName(name: string): boolean {
  return name === String(UserRoleEnum.superAdmin);
}

function toRoleRow(row: RoleRow): RoleRow {
  return { id: Number(row.id), name: row.name };
}

/**
 * Locks one `roles` row FOR UPDATE and returns it, or null when there is no
 * such row — including the case where a concurrent transaction deleted it
 * while this one waited for the lock (Postgres re-evaluates the row after the
 * lock is granted, so the waiter gets zero rows rather than a stale one; that
 * is exactly what makes two concurrent deletes of the same role produce one
 * success and one 404 instead of two successes).
 */
export async function lockRoleById(
  manager: EntityManager,
  id: number,
): Promise<RoleRow | null> {
  const rows = await manager.query<RoleRow[]>(
    `SELECT id, name FROM roles WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows.length > 0 ? toRoleRow(rows[0]) : null;
}

/**
 * SHARE lock, for a path that only wants to be sure the role still exists when
 * it inserts the assignment. Shared locks do not block each other, so two
 * assignments proceed in parallel, but they DO block the FOR UPDATE that role
 * deletion takes — so a delete can no longer slip between "role exists" and
 * `INSERT INTO user_roles`.
 */
export async function shareLockRoleById(
  manager: EntityManager,
  id: number,
): Promise<RoleRow | null> {
  const rows = await manager.query<RoleRow[]>(
    `SELECT id, name FROM roles WHERE id = $1 FOR SHARE`,
    [id],
  );
  return rows.length > 0 ? toRoleRow(rows[0]) : null;
}

/**
 * Takes the `super_admin` mutex. Returns null only when the role is absent
 * from the catalogue entirely (a database that was never seeded), in which
 * case there is no administrator invariant to protect.
 */
export async function lockSuperAdminRole(
  manager: EntityManager,
): Promise<RoleRow | null> {
  const rows = await manager.query<RoleRow[]>(
    `SELECT id, name FROM roles WHERE name = $1 FOR UPDATE`,
    [UserRoleEnum.superAdmin],
  );
  return rows.length > 0 ? toRoleRow(rows[0]) : null;
}

/** How many users currently hold this role. Read the role's lock first. */
export async function countRoleAssignments(
  manager: EntityManager,
  roleId: number,
): Promise<number> {
  const rows = await manager.query<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS count FROM user_roles WHERE "rolesId" = $1`,
    [roleId],
  );
  return Number(rows[0]?.count ?? 0);
}

export function builtInRoleProtected(roleName: string): ConflictException {
  return new ConflictException({
    error: RoleErrorCodes.ROLE_BUILTIN_PROTECTED,
    message: RoleMessages.ROLE_BUILTIN_PROTECTED,
    roleName,
  });
}

export function roleInUse(
  roleName: string,
  assignedUserCount: number,
): ConflictException {
  return new ConflictException({
    error: RoleErrorCodes.ROLE_IN_USE,
    message: RoleMessages.ROLE_IN_USE,
    roleName,
    assignedUserCount,
  });
}

export function lastSuperAdmin(userId: number): ConflictException {
  return new ConflictException({
    error: RoleErrorCodes.LAST_SUPER_ADMIN,
    message: RoleMessages.LAST_SUPER_ADMIN,
    roleName: UserRoleEnum.superAdmin,
    userId,
  });
}

/**
 * What the caller is about to do to `targetUserId`:
 *
 *  - `role-removed`   the `super_admin` assignment itself disappears
 *                     (`DELETE /roles/remove`, a `PATCH /users/{id}` whose
 *                     `role` array omits it, or a hard user delete whose
 *                     CASCADE takes the `user_roles` row with it);
 *  - `access-revoked` the assignment survives but the holder can no longer
 *                     log in (deactivation) — an administrator who cannot
 *                     authenticate is not an administrator.
 */
export type SuperAdminChange = 'role-removed' | 'access-revoked';

interface SuperAdminCensus {
  /** Holders other than the target. */
  others: number;
  /** Holders other than the target who can still log in. */
  other_active: number;
  /** 1 when the target holds the role at all. */
  target_holds: number;
  /** 1 when the target holds it AND can still log in. */
  target_active: number;
}

/**
 * Refuses, with 409 `LAST_SUPER_ADMIN`, any change that would leave the system
 * with no usable administrator.
 *
 * MUST be called inside a transaction. It takes the `super_admin` row FOR
 * UPDATE before counting, which is what makes it correct under concurrency:
 * two requests that each try to strip `super_admin` from one of the last two
 * administrators are serialised on that row, so the second one counts AFTER
 * the first has committed, sees one holder left, and is refused. Without the
 * lock both would read "2 holders", both would pass a naive `count > 1` test,
 * and both would commit.
 *
 * Safe to call unconditionally: if the target does not hold `super_admin` the
 * change cannot affect the invariant and the function returns.
 */
export async function assertSuperAdminSurvives(
  manager: EntityManager,
  targetUserId: number,
  change: SuperAdminChange,
): Promise<void> {
  const superAdminRole = await lockSuperAdminRole(manager);
  if (!superAdminRole) return;

  const rows = await manager.query<SuperAdminCensus[]>(
    `SELECT
       COUNT(*) FILTER (WHERE ur."usersId" <> $2)::int AS others,
       COUNT(*) FILTER (WHERE ur."usersId" <> $2
                          AND u."deactivatedAt" IS NULL)::int AS other_active,
       COUNT(*) FILTER (WHERE ur."usersId" = $2)::int AS target_holds,
       COUNT(*) FILTER (WHERE ur."usersId" = $2
                          AND u."deactivatedAt" IS NULL)::int AS target_active
       FROM user_roles ur
       JOIN users u ON u.id = ur."usersId"
      WHERE ur."rolesId" = $1`,
    [superAdminRole.id, targetUserId],
  );

  const census = rows[0];
  if (!census) return;

  const others = Number(census.others);
  const otherActive = Number(census.other_active);
  const targetHolds = Number(census.target_holds);
  const targetActive = Number(census.target_active);

  // The target is not an administrator, so nothing this change does can
  // reduce the administrator population.
  if (targetHolds === 0) return;

  // Invariant 1: at least one user must still HOLD super_admin afterwards.
  if (change === 'role-removed' && others === 0) {
    throw lastSuperAdmin(targetUserId);
  }

  // Invariant 2: at least one administrator must still be able to LOG IN
  // afterwards. Only enforced when the target is currently that
  // administrator — stripping an already-deactivated admin changes nothing.
  if (targetActive > 0 && otherActive === 0) {
    throw lastSuperAdmin(targetUserId);
  }
}
