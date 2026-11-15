import type { Session, UserRole } from "@kazhal/api-client";

/**
 * CLIENT-SIDE PERMISSION READING — for hiding affordances, never for deciding.
 *
 * Every capability listed on the session was expanded server-side from the
 * user's role rows on the request that returned it, and every API call
 * re-checks it in `PermissionsGuard`. So:
 *
 *  - hiding a button the caller cannot use is a KINDNESS, not a control;
 *  - showing one they cannot use is a 403 they did not need to see, not a
 *    security hole;
 *  - a client that forged this list would change nothing but its own menu.
 *
 * The corollary matters more than the rule: nothing in this app may treat a
 * successful `can()` as permission to skip an error path. Every mutation still
 * handles 403.
 */
export type PermissionCode = string;

/** An absent list means "no capabilities known" — never "all of them". */
export function permissionsOf(session: Session | null | undefined): ReadonlySet<PermissionCode> {
  return new Set(session?.permissions ?? []);
}

/** True only when EVERY listed capability is held. Matches the server's AND. */
export function can(
  session: Session | null | undefined,
  ...required: PermissionCode[]
): boolean {
  if (required.length === 0) return true;
  const held = permissionsOf(session);
  return required.every((permission) => held.has(permission));
}

/** True when ANY of them is held. For "can this person see this section at all". */
export function canAny(
  session: Session | null | undefined,
  ...required: PermissionCode[]
): boolean {
  if (required.length === 0) return true;
  const held = permissionsOf(session);
  return required.some((permission) => held.has(permission));
}

/**
 * Persian names for the RISK levels the server attaches to each capability.
 * The capability's own label and consequence sentence come FROM THE SERVER
 * (`GET /admin/access/permissions`) — duplicating forty Persian strings here
 * is how the console and the API start describing the same permission
 * differently.
 */
/**
 * ===========================================================================
 * ROLE GATES — for the one rule that is deliberately NOT a capability
 * ===========================================================================
 *
 * Almost everything in this console is gated on a capability code, because
 * almost everything is meant to be delegable. Sales reporting is not:
 *
 *   "Sales reports are available only to the main administrator, represented
 *    by the built-in `super_admin` role."
 *
 * A capability code exists so that it CAN be granted to a custom role, so
 * publishing one for reporting made the rule a convention rather than a
 * control. `reports.read` was retired by API migration 0028 and the server now
 * gates `/reports/*` on `@Roles(super_admin)` plus `@Audiences('admin')`.
 * These helpers are how the console asks the same question, so the menu and
 * the server cannot disagree.
 *
 * Same caveat as `can()`: this hides affordances, it never decides anything.
 * The API re-checks the role from the database on every request.
 */
export function hasRole(
  session: Session | null | undefined,
  ...roles: UserRole[]
): boolean {
  if (roles.length === 0) return true;
  const held = session?.roles ?? [];
  return roles.some((role) => held.includes(role));
}

/** The main administrator, and nobody else. */
export function isSuperAdmin(session: Session | null | undefined): boolean {
  return hasRole(session, "super_admin");
}

/**
 * A navigation/page gate: any-of permissions AND any-of roles.
 *
 * BOTH halves must pass when both are declared, which is the same conjunction
 * the API applies (`RolesGuard` and `PermissionsGuard` both run). An empty
 * list on either side means "this half imposes no condition" — so an item with
 * only `roles` is purely role-gated, and one with only `permissions` behaves
 * exactly as every item did before role gates existed.
 */
export interface AccessGate {
  readonly permissions: readonly PermissionCode[];
  readonly roles?: readonly UserRole[];
}

export function canReach(
  session: Session | null | undefined,
  gate: AccessGate,
): boolean {
  return (
    canAny(session, ...gate.permissions) && hasRole(session, ...(gate.roles ?? []))
  );
}

export const RISK_LABEL: Record<string, string> = {
  normal: "عادی",
  sensitive: "حساس",
  critical: "پرخطر",
};

export const RISK_TONE: Record<string, "neutral" | "warning" | "danger"> = {
  normal: "neutral",
  sensitive: "warning",
  critical: "danger",
};
