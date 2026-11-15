import { ForbiddenException } from '@nestjs/common';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';
import { PermissionCode } from './permission.catalog';

/**
 * The `PermissionsGuard` refusal, raised from inside a handler.
 *
 * FOR THE RARE ROUTE WHOSE REQUIRED CAPABILITY DEPENDS ON THE REQUEST — a
 * single `PATCH .../active` that needs `x.activate` or `x.deactivate`
 * depending on the body, or a route that serves two different principals with
 * two different response shapes. A decorator cannot express that, and
 * splitting such a route in two would change the URL contract for the sake of
 * the implementation.
 *
 * It throws the SAME shape the guard throws — same `error` code, same
 * `requiredPermissions` / `missingPermissions` keys — so a client branches on
 * one code rather than discovering that in-handler checks answer differently.
 *
 * This is NOT an alternative to `@RequirePermissions(...)`. Any route whose
 * requirement is static must declare it on the route, where it is visible to
 * a reader and to `permission-coverage.int-spec.ts`.
 */
export function assertPermission(
  req: UserRequest,
  ...permissions: PermissionCode[]
): void {
  assertPermissionsHeld(req.user?.permissions ?? [], ...permissions);
}

/**
 * The same refusal, expressed against a bare SET of codes.
 *
 * For a check that has to happen below the controller layer, where there is no
 * request object. `ProductsService.update` is the case that forced this: a
 * variant's activation state is only known to be CHANGING once the existing
 * row has been loaded inside the transaction, so the decision cannot be made
 * on the request alone and must not be made on the body alone — the body may
 * restate `isActive` without altering it, and refusing that would break saves
 * for a role that was never trying to deactivate anything.
 *
 * Throwing from inside the transaction is deliberate: the rollback is what
 * makes the refusal atomic with the rest of the update.
 */
export function assertPermissionsHeld(
  held: Iterable<string>,
  ...permissions: PermissionCode[]
): void {
  const set = new Set(held);
  const missing = permissions.filter((permission) => !set.has(permission));
  if (missing.length > 0) {
    throw new ForbiddenException({
      error: AuthErrorCodes.PERMISSION_DENIED,
      message: AuthMessages.PERMISSION_DENIED,
      requiredPermissions: permissions,
      missingPermissions: missing,
    });
  }
}

/**
 * Non-throwing variant, for shaping a response rather than authorising it.
 *
 * A route that uses this to BRANCH must still refuse somewhere — reading a
 * capability is not enforcing it. Every such route carries
 * `@ConsultsPermissions(...)` so the coverage spec can see the codes, and a
 * behavioural spec that proves the refusal.
 */
export function hasPermission(
  req: UserRequest,
  ...permissions: PermissionCode[]
): boolean {
  const held = new Set(req.user?.permissions ?? []);
  return permissions.every((permission) => held.has(permission));
}
