import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AUDIENCES_KEY } from '../decorators/audience.decorator';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';
import { ALLOW_PASSWORD_CHANGE_PENDING_KEY } from '../decorators/password-change.decorator';
import { SessionAudience, SESSION_AUDIENCES } from '../audience';
import {
  AUDIENCE_REQUEST_KEY,
  AudienceAwareRequest,
} from '../audience-request';

export interface JwtUser {
  sub: number;
  identifier: string;
  roles: UserRoleEnum[];
  branch: number | null;
  audience: SessionAudience;
  permissions: string[];
  mustChangePassword: boolean;
}

interface PassportInfo {
  name?: string;
  message?: string;
}

/**
 * A route that declares no audience accepts any of them, resolved in this
 * fixed order. The order is what makes the choice deterministic rather than
 * "whichever cookie the parser yielded first"; it is not a privilege ranking.
 *
 * Every route that is not `@Public()` should still declare `@Audiences(...)` —
 * `audience-coverage.int-spec.ts` fails the build when one does not, so this
 * default is a safety net for a route in flight, never the intended design.
 */
const DEFAULT_AUDIENCE_ORDER: readonly SessionAudience[] = SESSION_AUDIENCES;

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // Resolved here rather than in the strategy because only the guard can see
    // the route. The strategy is a singleton; the cookie it must read is not.
    const declared = this.reflector.getAllAndOverride<SessionAudience[]>(
      AUDIENCES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<AudienceAwareRequest>();
    request[AUDIENCE_REQUEST_KEY] =
      declared && declared.length > 0 ? declared : DEFAULT_AUDIENCE_ORDER;

    return super.canActivate(context);
  }

  /**
   * `context` is the FOURTH argument Nest's `AuthGuard` passes here, and it is
   * the only correct place to read route metadata for a post-authentication
   * check: this guard is bound through `APP_GUARD` with the default (singleton)
   * scope, so anything stashed on `this` between `canActivate` and here would
   * leak across concurrent requests.
   */
  handleRequest<TUser = JwtUser>(
    err: unknown,
    user: TUser,
    info: PassportInfo,
    context?: ExecutionContext,
  ): TUser {
    if (info?.name === 'TokenExpiredError') {
      throw new UnauthorizedException(AuthMessages.TOKEN_EXPIRED);
    }

    if (err) {
      throw err instanceof Error
        ? err
        : new UnauthorizedException(AuthMessages.INVALID_ACCESS_TOKEN);
    }
    if (!user) {
      throw new UnauthorizedException(AuthMessages.INVALID_ACCESS_TOKEN);
    }

    // FORCED PASSWORD CHANGE. An administrator issued a temporary password;
    // the only things this session may do are introspect itself, rotate, sign
    // out, and replace the password. Enforced here rather than in the frontend
    // because a flag the client is merely asked to respect is not a control —
    // and scoped by `@AllowPasswordChangePending()` rather than applied to
    // every route, because a rule with no route that can clear it is a lockout.
    const principal = user as unknown as JwtUser | undefined;
    const allowsPending = context
      ? this.reflector.getAllAndOverride<boolean>(
          ALLOW_PASSWORD_CHANGE_PENDING_KEY,
          [context.getHandler(), context.getClass()],
        )
      : false;
    if (principal?.mustChangePassword && !allowsPending) {
      throw new ForbiddenException({
        error: AuthErrorCodes.PASSWORD_CHANGE_REQUIRED,
        message: AuthMessages.PASSWORD_CHANGE_REQUIRED,
      });
    }

    return user;
  }
}
