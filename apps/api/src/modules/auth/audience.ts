/**
 * SESSION AUDIENCE — which application a session belongs to.
 *
 * Browser cookies are scoped by host and path, never by PORT. The storefront
 * (:8001), the admin console (:8001) and the till (:8002) are all `localhost`,
 * so a single `access_token` cookie was sent to, and accepted by, every one of
 * them: signing into the till made the storefront header show the cashier, and
 * signing out of the storefront destroyed the till's session. Port, Origin,
 * Referer and User-Agent are all either shared or attacker-controlled, so none
 * of them can carry this distinction.
 *
 * The audience is therefore a SIGNED claim in the token and a COLUMN on the
 * refresh-token row, and each audience gets its own cookie names. A token minted
 * for one audience is rejected by a route belonging to another.
 */
export const SESSION_AUDIENCES = ['storefront', 'admin', 'pos'] as const;

export type SessionAudience = (typeof SESSION_AUDIENCES)[number];

export function isSessionAudience(value: unknown): value is SessionAudience {
  return (
    typeof value === 'string' &&
    (SESSION_AUDIENCES as readonly string[]).includes(value)
  );
}

/**
 * Cookie names, one pair per audience.
 *
 * The `kz_` prefix is what keeps these from colliding with anything else on
 * `localhost` during development, where every service shares the host. The
 * browser may hold all six at once; a route reads only the pair for the
 * audience it declares.
 */
export const AUDIENCE_COOKIES: Record<
  SessionAudience,
  { readonly access: string; readonly refresh: string }
> = {
  storefront: {
    access: 'kz_storefront_access',
    refresh: 'kz_storefront_refresh',
  },
  admin: { access: 'kz_admin_access', refresh: 'kz_admin_refresh' },
  pos: { access: 'kz_pos_access', refresh: 'kz_pos_refresh' },
};

export const LEGACY_COOKIE_NAMES = ['access_token', 'refresh_token'] as const;

/**
 * WHO MAY OPEN A SESSION ON EACH SURFACE.
 *
 * Decided by a PERMISSION, not by a role name. That is the change that makes
 * delegation possible at all: under the old role-name table the only way to
 * let an employee into the admin console was to make them a `super_admin`,
 * which is the same as giving them every capability the system has. A custom
 * role carrying `admin.access` plus, say, `orders.read` now opens the door and
 * nothing else behind it.
 *
 * Enforced at LOGIN, BEFORE ANY TOKEN IS MINTED, and re-decided on every
 * rotation — never by the frontend afterwards, and never by a route guard
 * alone: issuing a valid admin cookie to somebody who may not administer and
 * then refusing each request one at a time still puts a working admin session
 * in their browser.
 *
 * The built-in roles land exactly where they did before (see
 * `permissions/system-roles.ts`), so this is behaviour-preserving for them:
 *
 *   | role          | storefront | admin | pos  |
 *   | `site`        | yes        | no    | no   |
 *   | `sale`        | no         | no    | yes  |
 *   | `super_admin` | no         | yes   | yes* |
 *   | deactivated   | no         | no    | no   |
 *
 * * The administrator reads till reports from the POS surface. That is not a
 *   licence to sell: `POST /orders/pos` separately requires a branch, so a
 *   branchless administrator keeps report access and is refused the sale.
 *
 * `super_admin` is deliberately NOT eligible for the storefront: that surface
 * is the customer's, its production door is an OTP against `users.mobile`, and
 * `storefront.access` is a customer capability rather than a delegated
 * authority. See the exclusion note in `system-roles.ts`.
 *
 * A refusal issues NO COOKIES AT ALL.
 */
export const AUDIENCE_ACCESS_PERMISSION: Record<SessionAudience, string> = {
  storefront: 'storefront.access',
  admin: 'admin.access',
  pos: 'pos.access',
};

export function isEligibleForAudience(
  permissions: readonly string[],
  audience: SessionAudience,
): boolean {
  return permissions.includes(AUDIENCE_ACCESS_PERMISSION[audience]);
}
