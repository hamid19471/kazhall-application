import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/role.decorator';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // HANDLER FIRST, then class. `getAllAndOverride` returns the FIRST DEFINED
    // value in array order, so the order IS the precedence rule.
    //
    // This used to read `[context.getClass(), context.getHandler()]`, which
    // made the class win: a handler-level `@Roles(...)` on a controller that
    // already carries a class-level `@Roles(...)` was silently ignored, and
    // the route enforced the class's roles while its own decorator — and its
    // Swagger docs — claimed otherwise. Nothing errors in that situation, so
    // it would only ever have been found as a production authorisation bug.
    //
    // Handler-first is also NestJS convention and matches `JwtAuthGuard`,
    // which resolves `@Public()` the same way in this same directory. No
    // route currently declares `@Roles` in both places, so this is
    // behaviour-neutral today; it exists to keep the narrowest declaration
    // authoritative from now on.
    const requiredRoles = this.reflector.getAllAndOverride<UserRoleEnum[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { roles?: UserRoleEnum[] };
    }>();
    const userRoles: UserRoleEnum[] = request.user?.roles ?? [];
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));
    if (!hasRole) {
      /*
       * A STRUCTURED REFUSAL, not a bare sentence.
       *
       * The capability guard next door answers `PERMISSION_DENIED` with
       * `details.missingPermissions`, and the console reads that to say "ask
       * your administrator for X". A role refusal must NOT be answered the
       * same way: for the routes that carry `@Roles(super_admin)` — sales
       * reporting and the financial dashboard — there is no capability to ask
       * for, by design, because the owner's rule is that they are not
       * delegable. Sending the operator away to request a permission that
       * cannot exist is the failure mode this code prevents.
       *
       * The route also stays SILENT about what it would have returned: the
       * envelope names the rule, never the data.
       *
       * `requiredRoles` is a FLAT key, not nested under `details`:
       * `GlobalExceptionFilter` gathers every key beyond
       * `message`/`error`/`statusCode` into `details` itself, so nesting it
       * here would publish `details.details.requiredRoles`. This matches how
       * `PermissionsGuard` next door publishes `missingPermissions`.
       */
      throw new ForbiddenException({
        error: AuthErrorCodes.ROLE_REQUIRED,
        message: AuthMessages.ACCESS_DENIED,
        requiredRoles,
      });
    }
    return true;
  }
}
