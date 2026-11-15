import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PERMISSION_CATALOG } from './permission.catalog';

/**
 * ===========================================================================
 * THE BUILT-IN ROLES' CAPABILITY SETS — defined in CODE, not in a table
 * ===========================================================================
 *
 * `role_permissions` holds grants for CUSTOM roles only. The three system
 * roles expand from the map below, and the access-control screen renders their
 * sets read-only. Three reasons, in order of importance:
 *
 *  1. A ROW THAT COULD STRIP `rbac.manage` FROM `super_admin` IS A LOCKOUT
 *     PRIMITIVE. Every route that could put the grant back requires the
 *     permission that was just removed, so the state is unrecoverable through
 *     the API — the same shape of unrecoverable state `role-safety.ts` already
 *     exists to prevent for role ASSIGNMENT. Making the set unwritable is a
 *     stronger guarantee than guarding each write against it.
 *  2. The `sale` and `site` sets are what the seeder, the audience rules and
 *     the POS sale flow assume. They are part of the application's shape, and
 *     an application's shape does not belong in editable data.
 *  3. It means a freshly-migrated (or, in the integration harness, freshly
 *     truncated) database still has a working administrator, instead of one
 *     whose account exists and authorises nothing.
 *
 * `super_admin` therefore holds EVERY permission in the catalogue, computed —
 * so a capability added to `permission.catalog.ts` tomorrow is already
 * granted, and cannot be forgotten here.
 *
 * THE ONE EXCLUSION, AND WHY IT IS NOT A CONTRADICTION. `storefront.access` is
 * not a management capability; it is the CUSTOMER's door, whose production
 * authentication is an OTP against `users.mobile`. Granting it to `super_admin`
 * would let an administrator open a shopper session on the storefront, which is
 * precisely the cross-surface identity the audience model exists to prevent
 * and which `audience-isolation.int-spec.ts` asserts cannot happen. "Every
 * permission" means every permission that delegates authority; a customer
 * login is not one.
 */
const CUSTOMER_ONLY_PERMISSIONS: readonly string[] = ['storefront.access'];

const ALL_STAFF_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOG.map((permission) => permission.code).filter(
    (code) => !CUSTOMER_ONLY_PERMISSIONS.includes(code),
  ),
);

/**
 * The till operator. `pos.access` is the door; `pos.sell` is the sale;
 * `pos.receipt.read_own` is the receipt for a sale THEY rang up — never
 * another cashier's. There is deliberately no `orders.read` here: a cashier
 * who could read the management order list could read every customer's
 * address and telephone number.
 */
const SALE_PERMISSIONS: readonly string[] = Object.freeze([
  'pos.access',
  'pos.sell',
  'pos.receipt.read_own',
]);

/** The customer. One capability: sign in to the shop. */
const SITE_PERMISSIONS: readonly string[] = Object.freeze([
  'storefront.access',
]);

/**
 * `Partial<Record<...>>` rather than `Record<...>`, deliberately: the lookup
 * key is an arbitrary role NAME read out of the database, so indexing must be
 * typed as possibly-missing. A plain `Record` would claim every string is a
 * system role and hand a custom role the `undefined` it was told could not
 * happen.
 */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<
  Partial<Record<string, readonly string[]>>
> = Object.freeze({
  [UserRoleEnum.superAdmin]: ALL_STAFF_PERMISSIONS,
  [UserRoleEnum.sale]: SALE_PERMISSIONS,
  [UserRoleEnum.site]: SITE_PERMISSIONS,
});

export function isSystemRoleName(name: string): boolean {
  return systemRolePermissions(name) !== null;
}

/**
 * The permissions a system role confers, or `null` when the name is not a
 * system role (in which case the grants live in `role_permissions`).
 */
export function systemRolePermissions(name: string): readonly string[] | null {
  return SYSTEM_ROLE_PERMISSIONS[name] ?? null;
}
