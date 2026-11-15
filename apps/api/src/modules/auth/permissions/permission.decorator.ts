import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from './permission.catalog';

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Declares the capabilities a route requires.
 *
 * SEMANTICS: EVERY listed permission is required (AND, not OR). A route that
 * genuinely needs "either of these" lists the narrower one and lets the
 * broader role reach it through holding both — an OR would make the
 * requirement unreadable at the call site, which is the one place it has to be
 * obvious.
 *
 * Handler-level declarations OVERRIDE class-level ones, matching `@Roles` and
 * `@Public`: `getAllAndOverride` is given `[handler, class]`, so the narrowest
 * declaration wins. A controller can therefore carry the read permission at
 * class level and name the write permission on the two handlers that mutate.
 *
 * THIS IS NOT A SUBSTITUTE FOR `@Audiences(...)`. The two are orthogonal and
 * both are enforced: a principal holding `orders.void` who presents a POS
 * cookie to an admin-audience route is refused by the audience check before
 * the permission is ever consulted. "Right permission, wrong surface" must
 * still be a rejection — see `audience.ts`.
 */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Metadata key for {@link ConsultsPermissions}. */
export const CONSULTED_PERMISSIONS_KEY = 'consulted_permissions';

/**
 * ===========================================================================
 * DECLARES A CAPABILITY THIS ROUTE DECIDES ON *INSIDE* THE HANDLER
 * ===========================================================================
 *
 * WHAT IT IS FOR. A handful of routes cannot state their requirement as a
 * decorator, because the requirement depends on the request body or on the
 * caller's own set:
 *
 *   PATCH /admin/users/:id/active   needs `users.activate` OR `users.deactivate`
 *                                   depending on `isActive`
 *   PATCH /products/:id             additionally needs `products.activate` /
 *                                   `products.deactivate` only when a variant's
 *                                   state is actually CHANGING — knowable only
 *                                   after the row is read inside the transaction
 *   POST  /products/uploadImage     needs `products.create` OR `products.update`
 *   GET   /admin/users/assignable-roles  needs `users.create` OR `users.update`
 *   GET   /orders/:id               serves two different contracts to
 *                                   `orders.read` and `pos.receipt.read_own`
 *
 * Those checks are real and are tested, but they are INVISIBLE to anything that
 * introspects the container — so the capability-coverage spec used to find them
 * by REGEX-SCANNING `src/**` for `assertPermission(...)` calls and pulling
 * string literals out of the match. That scan could not tell a live call from a
 * commented-out one, would have been defeated by a code held in a constant, and
 * silently went stale whenever a helper was renamed.
 *
 * THIS DECORATOR REPLACES THE SCAN. It records the same fact as metadata, on
 * the handler, so coverage is read from the running application exactly the way
 * `@RequirePermissions` is.
 *
 * IT ENFORCES NOTHING, DELIBERATELY. `PermissionsGuard` never reads this key.
 * It is a DECLARATION that the handler decides the listed codes itself, and it
 * is a lie unless the handler really does — which is why every route carrying
 * it also has a behavioural test asserting the refusal (see
 * `permission-enforcement-gaps.int-spec.ts` and `assignable-roles.int-spec.ts`).
 * Coverage answers "is this capability wired to anything at all"; those specs
 * answer "does it actually refuse".
 */
export const ConsultsPermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(CONSULTED_PERMISSIONS_KEY, permissions);
