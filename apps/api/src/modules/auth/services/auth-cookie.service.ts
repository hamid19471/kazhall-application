import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Response } from 'express';
import * as ms from 'ms';
import { StringValue } from 'ms';
import { ENV_DEFAULTS } from 'src/configs/env.validation';
import {
  AUDIENCE_COOKIES,
  LEGACY_COOKIE_NAMES,
  SessionAudience,
} from '../audience';

/**
 * Cookie attributes, shared by every audience.
 *
 * `secure` and `sameSite: 'strict'` are kept as they were. There is deliberately
 * NO `domain`: a host-only cookie is the narrowest the browser offers. It does
 * not separate ports — that is the whole reason the audience exists — but
 * widening it to a domain would additionally share the session with every
 * subdomain, which is strictly worse.
 *
 * `path` stays `/`. Scoping the admin cookie to `/admin` would be tempting, but
 * the path that matters is the API's, not the frontend's: every surface calls
 * the same API origin, so a path scope would either break every call or be
 * meaningless. Separation is carried by the NAME and the signed claim.
 */
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
};

@Injectable()
export class AuthCookieService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Cookie lifetimes are derived from the SAME config values the tokens are
   * signed with. A cookie that outlives its token turns a recoverable 401 into
   * a confusing one; a cookie that dies first logs the user out early.
   */
  setSession(
    res: Response,
    audience: SessionAudience,
    accessToken: string,
    refreshToken: string,
  ): void {
    const names = AUDIENCE_COOKIES[audience];

    res.cookie(names.access, accessToken, {
      ...cookieOptions,
      maxAge: ms(this.accessExpiration()),
    });
    res.cookie(names.refresh, refreshToken, {
      ...cookieOptions,
      maxAge: ms(this.refreshExpiration()),
    });
  }

  /**
   * Clears ONE audience's pair. Signing out of the till leaves the storefront
   * and the admin console signed in, which is the behaviour the shared cookie
   * made impossible.
   */
  clearSession(res: Response, audience: SessionAudience): void {
    const names = AUDIENCE_COOKIES[audience];
    res.clearCookie(names.access, cookieOptions);
    res.clearCookie(names.refresh, cookieOptions);
  }

  /**
   * Removes the pre-audience cookies.
   *
   * They are no longer read by anything, but a browser that authenticated
   * before this change still holds them and would keep sending them on every
   * request until they expire. Clearing them on any session write keeps the jar
   * honest about what the user is actually signed into.
   */
  clearLegacySession(res: Response): void {
    for (const name of LEGACY_COOKIE_NAMES) {
      res.clearCookie(name, cookieOptions);
    }
  }

  readRefreshCookie(
    cookies: Record<string, string | undefined> | undefined,
    audience: SessionAudience,
  ): string | undefined {
    return cookies?.[AUDIENCE_COOKIES[audience].refresh];
  }

  private accessExpiration(): StringValue {
    return (this.configService.get<string>('JWT_ACCESS_EXPIRATION') ??
      ENV_DEFAULTS.JWT_ACCESS_EXPIRATION) as StringValue;
  }

  private refreshExpiration(): StringValue {
    return (this.configService.get<string>('JWT_REFRESH_EXPIRATION') ??
      ENV_DEFAULTS.JWT_REFRESH_EXPIRATION) as StringValue;
  }
}
