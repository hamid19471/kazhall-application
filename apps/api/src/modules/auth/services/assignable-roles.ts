import { BadRequestException } from '@nestjs/common';
import { Role } from '../entities/role.entity';
import { isSystemRoleName } from '../permissions/system-roles';
import {
  RoleErrorCodes,
  RoleMessages,
} from 'src/common/constants/role.messages';

/**
 * ===========================================================================
 * WHICH ROLES MAY THIS PRINCIPAL HAND TO SOMEBODY ELSE?
 * ===========================================================================
 *
 * ONE ANSWER, TWO CALLERS. `POST /admin/users` (creating a staff account with
 * `roleIds`) and `PUT /admin/access/users/:id/roles` (changing an existing
 * user's roles) both confer capabilities on another person, so both must obey
 * the same rules. `GET /admin/users/assignable-roles` exists so that a form
 * can ASK the question in advance instead of discovering the answer as a 403
 * after the operator has filled the form in.
 *
 * All three read this module, so the list a form offers and the set the
 * mutation accepts cannot drift apart. A role the endpoint offers is a role
 * the mutation will take; a role it withholds is a role the mutation refuses.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES
 *
 * 1. NO ESCALATION. A role is assignable only when everything it confers is
 *    already held by the actor. Without it, anyone able to create a user could
 *    create one carrying `super_admin` and then sign in as them — the
 *    permission model's most obvious back door, and the reason role assignment
 *    was deliberately kept off `POST /admin/users`' own permission
 *    (`users.create` does not imply `rbac.manage`).
 *
 *    THE COMPARISON IS OVER EFFECTIVE PERMISSIONS, not over role identity. It
 *    does not matter whether the role is built-in or custom, or what it is
 *    called; what matters is the set of codes it hands over.
 *
 * 2. NO DEACTIVATED ROLES. `PermissionService.resolveEffective` SKIPS a role
 *    whose `isActive` is false, so assigning one is not a smaller grant — it
 *    is a grant of nothing at all, on an account the operator believes they
 *    have just configured. It also passes the escalation check trivially (the
 *    empty set is a subset of everything), which is exactly the kind of
 *    silent-success that makes a permission model untrustworthy. Refused
 *    explicitly, with its own error code.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 *
 * SYSTEM-ROLE SAFETY IS NOT WEAKENED AND NOT DUPLICATED. A built-in role still
 * cannot be renamed, deactivated or re-permissioned — that is
 * `RbacService`'s business and it is unchanged. Assigning a built-in role to a
 * user has always been allowed and still is, subject to rule 1.
 *
 * THE LAST-ADMINISTRATOR INVARIANT IS NOT HERE EITHER. "Can this role be
 * given?" and "would giving it leave the system with no administrator?" are
 * different questions with different answers; the second is
 * `assertSuperAdminSurvives` and stays at the call site that performs the
 * write, inside its transaction and its lock.
 */

/**
 * The reduced role shape a user form needs, and NOTHING ELSE.
 *
 * WHAT IS WITHHELD, AND WHY THAT IS THE POINT. This endpoint is reachable by a
 * user manager who holds no `rbac.read` at all, so it must not become a side
 * door onto the permission model:
 *
 *   - NO `permissions` ARRAY. The codes a role grants are the internals of the
 *     access-control catalogue; a principal who may staff the shop does not
 *     thereby get to enumerate how the system's authority is decomposed.
 *     `permissionCount` is a size, which is what a form needs to say "this
 *     role is a big one" — it names nothing.
 *   - NO `risk` METADATA, no catalogue grouping, no descriptions of individual
 *     capabilities. Those live on `GET /admin/access/permissions`, which keeps
 *     its `rbac.read` gate.
 *   - NO INACTIVE ROLES AT ALL, so the response cannot be used to enumerate
 *     roles that exist but are switched off.
 *
 * `isSystem` and `titleFa`/`description` ARE included: they are what makes the
 * checklist readable in Persian, and neither says anything about capabilities.
 */
export interface AssignableRoleView {
  id: number;
  name: string;
  titleFa: string | null;
  description: string | null;
  /** A built-in role, whose capability set is owned by code. */
  isSystem: boolean;
  /**
   * Always `true`. Present so the shape matches `RoleSummary` and a form can
   * render the same component for both, not because it can ever vary here.
   */
  isActive: true;
  /** HOW MANY capabilities, never WHICH ones. See the note above. */
  permissionCount: number;
}

/**
 * Is every capability this role confers already held by the actor?
 *
 * A `super_admin` holds every catalogue code EXCEPT the customer-only
 * `storefront.access`, so it can assign every STAFF role and cannot assign the
 * customer `site` role. That is not a gap: `POST /admin/users` creates staff
 * accounts and has always refused `site` for exactly this reason, so an
 * endpoint that offered it would be offering something the mutation rejects.
 */
export function isAssignable(
  conferred: readonly string[],
  actorPermissions: ReadonlySet<string>,
): boolean {
  return conferred.every((code) => actorPermissions.has(code));
}

/**
 * Refuses a deactivated role, by name, before any write happens.
 *
 * Called by BOTH mutation paths. The error is a 400 rather than a 403: the
 * actor is not forbidden from assigning roles, they have named one that cannot
 * be assigned by anybody.
 */
export function assertRolesActive(roles: readonly Role[]): void {
  const inactive = roles.filter((role) => role.isActive === false);
  if (inactive.length === 0) return;

  throw new BadRequestException({
    error: RoleErrorCodes.ROLE_INACTIVE,
    message: RoleMessages.ROLE_INACTIVE,
    inactiveRoles: inactive.map((role) => role.name),
  });
}

/** Projects a role plus its conferred-code count into the reduced view. */
export function toAssignableRoleView(
  role: Role,
  permissionCount: number,
): AssignableRoleView {
  return {
    id: role.id,
    name: role.name,
    titleFa: role.titleFa ?? null,
    description: role.description ?? null,
    // READ FROM THE NAME, NOT FROM THE COLUMN. `roles.isSystem` exists but is
    // not what the rest of the application consults: `RbacService` and
    // `PermissionService` both decide "is this built-in?" with
    // `isSystemRoleName(role.name)`, so that a row whose flag was set by hand
    // cannot claim to be built-in. Matching them here keeps one answer.
    isSystem: isSystemRoleName(role.name),
    isActive: true,
    permissionCount,
  };
}
