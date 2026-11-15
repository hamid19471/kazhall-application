import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../permissions/permission.decorator';
import {
  AuthMessages,
  AuthErrorCodes,
} from 'src/common/constants/auth.messages';

/**
 * Enforces `@RequirePermissions(...)`.
 *
 * THE PERMISSIONS IT READS ARE NOT THE CLIENT'S. `request.user.permissions` is
 * written by `JwtStrategy.validate`, which expands the roles it read from the
 * DATABASE on this request. Nothing in the request — no header, no body field,
 * no token claim — contributes to it. That is the whole reason the expansion
 * happens server-side on every call rather than being baked into the JWT: a
 * capability removed thirty seconds ago must be gone now, not at the next
 * rotation.
 *
 * ORDER. Registered AFTER `JwtAuthGuard` (which authenticates and enforces the
 * audience) and after `RolesGuard`, so by the time this runs the principal is
 * known, the surface is known to be one this route serves, and any legacy
 * `@Roles` declaration has already been satisfied. A correct permission
 * presented on the wrong surface is therefore refused by the audience check
 * before it ever reaches this guard — the two enforcements are independent and
 * neither is a substitute for the other.
 *
 * A route with no declaration is not implicitly open: it is simply not
 * governed by permissions, and the guards before this one still apply.
 * `rbac-coverage.int-spec.ts` asserts that every admin-audience mutation
 * carries one.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler first, then class — the narrowest declaration wins, matching
    // `RolesGuard` and `JwtAuthGuard` in this same directory.
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { permissions?: string[] };
    }>();
    const held = new Set(request.user?.permissions ?? []);

    // EVERY listed permission is required. See the decorator for why this is
    // AND rather than OR.
    const missing = required.filter((permission) => !held.has(permission));
    if (missing.length > 0) {
      throw new ForbiddenException({
        error: AuthErrorCodes.PERMISSION_DENIED,
        message: AuthMessages.PERMISSION_DENIED,
        requiredPermissions: required,
        missingPermissions: missing,
      });
    }
    return true;
  }
}
