import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  Type,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthMessages } from 'src/common/constants/auth.messages';
import { AuthService } from '../services/auth.service';
import { AuthCookieService } from '../services/auth-cookie.service';
import { LoginDto } from '../dto/login.dto';
import { Public } from '../decorators/public.decorator';
import { AllowPasswordChangePending } from '../decorators/password-change.decorator';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { Audiences } from '../decorators/audience.decorator';
import { AUDIENCE_COOKIES, SessionAudience } from '../audience';
import { AuthenticatedUser } from '../auth.types';
import { isReviewLoginEnabled } from '../review-login.policy';

interface UserRequest extends Request {
  user: AuthenticatedUser;
}

export interface SurfaceAuthOptions {
  /** Path segment for the password door: `login`, or `review-login`. */
  loginPath: string;
  /**
   * When true the password door only opens where review logins are enabled.
   * The storefront's production door is OTP; its password form exists so a
   * reviewer can sign in without an SMS provider, and must not be a second
   * production entrance.
   */
  reviewOnlyLogin: boolean;
}

/**
 * ONE implementation, mounted three times.
 *
 * The surfaces used to share `/auth/login`, `/auth/me`, `/auth/refresh-token`
 * and one cookie pair, which is what let a till session authenticate the
 * storefront. Splitting them by hand would have produced three copies free to
 * drift apart; generating them from a single class means a change to the cookie
 * rules, the rotation rules or the error envelope cannot land on two surfaces
 * and miss the third.
 *
 * `audience` is closed over at module-definition time. It is NEVER read from
 * the request — not from the path, not from a header, not from the body — so a
 * caller cannot select their own audience.
 */
export function createSurfaceAuthController(
  audience: SessionAudience,
  options: SurfaceAuthOptions,
): Type<unknown> {
  const cookieNames = AUDIENCE_COOKIES[audience];

  @ApiTags(`auth:${audience}`)
  @Controller(`auth/${audience}`)
  @Audiences(audience)
  class SurfaceAuthController {
    constructor(
      readonly authService: AuthService,
      readonly cookies: AuthCookieService,
    ) {}

    @Public()
    @ApiOperation({
      summary: `Password sign-in for the ${audience} application`,
      description:
        `Verifies the password, then verifies that this account may open a ` +
        `${audience} session AT ALL. An ineligible account is refused here and ` +
        `receives no cookies — the frontend is never asked to enforce the role ` +
        `after the fact.`,
    })
    @ApiCreatedResponse({
      description: `Authenticated; \`${cookieNames.access}\` and \`${cookieNames.refresh}\` are set.`,
    })
    @Post(options.loginPath)
    async login(
      @Body() loginDto: LoginDto,
      @Res({ passthrough: true }) res: Response,
    ) {
      if (options.reviewOnlyLogin && !isReviewLoginEnabled()) {
        throw new ForbiddenException(AuthMessages.REVIEW_LOGIN_DISABLED);
      }
      const { accessToken, refreshToken } = await this.authService.login(
        loginDto,
        audience,
      );
      this.cookies.clearLegacySession(res);
      this.cookies.setSession(res, audience, accessToken, refreshToken);
      return { message: AuthMessages.LOGIN_SUCCESS };
    }

    @Public()
    @ApiOperation({
      summary: `Rotate the ${audience} session`,
      description:
        `Reads \`${cookieNames.refresh}\` and nothing else. A refresh cookie ` +
        `belonging to another application is refused, so one surface can never ` +
        `rotate another's session — the shared-cookie behaviour that used to ` +
        `let a storefront refresh replace the till's token.`,
    })
    @ApiCreatedResponse({ description: 'Both session cookies are replaced.' })
    @Post('refresh')
    async refresh(
      @Req() req: Request,
      @Res({ passthrough: true }) res: Response,
    ) {
      const presented = this.cookies.readRefreshCookie(
        req.cookies as Record<string, string | undefined> | undefined,
        audience,
      );
      if (!presented) {
        throw new UnauthorizedException(AuthMessages.INVALID_REFRESH_TOKEN);
      }
      const { accessToken, refreshToken } = await this.authService.refreshToken(
        presented,
        audience,
      );
      this.cookies.setSession(res, audience, accessToken, refreshToken);
      return { message: AuthMessages.TOKEN_REFRESHED };
    }

    @Public()
    @HttpCode(200)
    @ApiOperation({
      summary: `Sign out of the ${audience} application only`,
      description:
        `Revokes this surface's refresh token and clears only its cookie pair. ` +
        `Sessions on the other applications are deliberately untouched; use ` +
        `\`logout-all\` to end every session everywhere.`,
    })
    @ApiOkResponse({ description: 'This surface is signed out.' })
    @Post('logout')
    async logout(
      @Req() req: Request,
      @Res({ passthrough: true }) res: Response,
    ) {
      const presented = this.cookies.readRefreshCookie(
        req.cookies as Record<string, string | undefined> | undefined,
        audience,
      );
      const revoked = await this.authService.logout(presented, audience);
      this.cookies.clearSession(res, audience);
      this.cookies.clearLegacySession(res);
      return { message: AuthMessages.LOGOUT_SUCCESS, revoked };
    }

    @ApiCookieAuth(cookieNames.access)
    @HttpCode(200)
    @ApiOperation({
      summary: 'Sign out of EVERY application on every device',
      description:
        'The security lever, not the sign-out button: revokes every refresh ' +
        "token this user holds in every audience. Only this surface's cookies " +
        'can be cleared from here — the browser is not asked to forget the ' +
        'others, but their refresh tokens are already dead and their access ' +
        'tokens expire within JWT_ACCESS_EXPIRATION.',
    })
    @ApiOkResponse({ description: 'Every session for this user is revoked.' })
    @AllowPasswordChangePending()
    @Post('logout-all')
    async logoutAll(
      @Req() req: UserRequest,
      @Res({ passthrough: true }) res: Response,
    ) {
      const revoked = await this.authService.revokeAllSessions(req.user.sub);
      this.cookies.clearSession(res, audience);
      this.cookies.clearLegacySession(res);
      return { message: AuthMessages.SESSIONS_REVOKED, revoked };
    }

    @ApiCookieAuth(cookieNames.access)
    @ApiOperation({
      summary: `Who is signed in to the ${audience} application`,
      description:
        `Reads only \`${cookieNames.access}\`. With sessions open on several ` +
        `surfaces at once each answers for itself — this is what stops the ` +
        `storefront header showing the cashier who is signed into the till.`,
    })
    @ApiOkResponse({ description: 'The current principal for this surface.' })
    @AllowPasswordChangePending()
    @Get('me')
    me(@Req() req: UserRequest) {
      return {
        data: {
          userId: req.user.sub,
          identifier: req.user.identifier,
          roles: req.user.roles,
          branchId: req.user.branch,
          audience: req.user.audience,
          /*
           * EFFECTIVE CAPABILITIES, expanded from the database on this
           * request. Published so the console can hide affordances the caller
           * cannot use — NOT so it can decide anything: every one of these is
           * re-checked server-side by `PermissionsGuard` on the actual call,
           * and a client that forged this list would change nothing but its
           * own menu.
           */
          permissions: req.user.permissions,
          /*
           * When true the frontend must show the change-password form and
           * nothing else. It is not relying on good behaviour: every other
           * route already answers 403 PASSWORD_CHANGE_REQUIRED.
           */
          mustChangePassword: req.user.mustChangePassword,
        },
      };
    }

    @ApiCookieAuth(cookieNames.access)
    @HttpCode(200)
    @ApiOperation({
      summary: 'Change your own password',
      description:
        'Requires the CURRENT password as well as a live session: a cookie ' +
        'proves the browser signed in once, not that the owner is at the ' +
        'keyboard.\n\n' +
        'On success EVERY session of this user, in every audience and on ' +
        'every device, is invalidated — including the one that made this ' +
        'call. Sign in again with the new password; do not expect the ' +
        'current cookies to keep working.\n\n' +
        'This is also the ONLY route that clears `mustChangePassword`, and is ' +
        'therefore reachable while that flag is set.',
    })
    @ApiOkResponse({ description: 'Password changed; all sessions are dead.' })
    @AllowPasswordChangePending()
    @Post('change-password')
    async changePassword(
      @Req() req: UserRequest,
      @Body() dto: ChangePasswordDto,
      @Res({ passthrough: true }) res: Response,
    ) {
      await this.authService.changePassword(
        req.user.sub,
        dto.currentPassword,
        dto.newPassword,
      );
      // The caller's own access token now predates `passwordChangedAt` and is
      // dead. Clearing the cookies here means the browser is not left holding
      // a credential that will only fail on the next request.
      this.cookies.clearSession(res, audience);
      this.cookies.clearLegacySession(res);
      return { message: AuthMessages.PASSWORD_CHANGED };
    }
  }

  Object.defineProperty(SurfaceAuthController, 'name', {
    value: `${audience[0].toUpperCase()}${audience.slice(1)}AuthController`,
  });

  return SurfaceAuthController;
}
