/**
 * ============================================================================
 * ADAPTER onto workstream A's integration harness.
 *
 * A owns `test/integration/setup/test-app.ts` and `test-db.ts`. This file adds
 * the two affordances the catalog suites need on top of what A exposes, so
 * that reconciling with any future change to A's signatures is a ONE-FILE
 * change rather than a five-file change:
 *
 *   ctx.request()   supertest agent bound to the booted server
 *                   (A exposes the raw `server` handle instead)
 *   ctx.loginAs()   creates a user with the given roles and returns a
 *                   ready-to-send `Cookie` header value
 *
 * WHY loginAs MINTS A TOKEN RATHER THAN POSTING /auth/login. A provides
 * `authenticate(app, username, password)`, which is the right helper for
 * testing auth itself. These suites are testing the CATALOG: going through the
 * real login flow would make every catalog assertion depend on bcrypt cost,
 * on the login DTO's current shape, and on OTP/refresh-token bookkeeping.
 * Minting an access token with the app's own `JwtService` exercises exactly
 * the same verification path (`JwtStrategy.validate` still loads the user,
 * re-derives roles FROM THE DATABASE, and enforces the `typ` claim and the
 * deactivation/password-change checks) while depending on none of that.
 *
 * NB: `JwtStrategy` reads the token from the `access_token` COOKIE, not from
 * an Authorization header, which is why `loginAs` returns a cookie string.
 * ============================================================================
 */
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';

import {
  createTestApp as createBaseTestApp,
  TestApp as BaseTestApp,
} from '../setup/test-app';
import { resetDb } from '../setup/test-db';

import { Role } from 'src/modules/auth/entities/role.entity';
import { User } from 'src/modules/user/entities/user.entity';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { TOKEN_TYPE_ACCESS } from 'src/modules/auth/auth.types';
import { AUDIENCE_COOKIES, SessionAudience } from 'src/modules/auth/audience';

type Agent = ReturnType<typeof request>;

export interface LoginResult {
  userId: number;
  /** Which application this session belongs to. */
  audience: SessionAudience;
  /** Value for a `Cookie:` request header. */
  cookie: string;
}

export interface TestApp extends BaseTestApp {
  request(): Agent;
  loginAs(
    roles: UserRoleEnum[],
    identifier?: string,
    opts?: { branchId?: number | null; audience?: SessionAudience },
  ): Promise<LoginResult>;
}

let identifierCounter = 0;

export async function createTestApp(): Promise<TestApp> {
  const base = await createBaseTestApp();
  const jwtService = base.app.get(JwtService, { strict: false });
  // The secret is passed EXPLICITLY: `RealtimeModule` also registers a
  // JwtModule, with `register({})` and therefore no secret, and `app.get()`
  // may hand back that instance. Relying on the resolved instance's ambient
  // configuration silently produced "secretOrPrivateKey must have a value".
  const jwtSecret =
    base.app
      .get(ConfigService, { strict: false })
      .get<string>('JWT_SECRET_KEY') ?? process.env.JWT_SECRET_KEY;
  if (!jwtSecret) throw new Error('JWT_SECRET_KEY is not configured for tests');

  async function loginAs(
    roles: UserRoleEnum[],
    identifier?: string,
    opts?: { branchId?: number | null; audience?: SessionAudience },
  ): Promise<LoginResult> {
    // Defaulted from the roles so existing cases keep meaning what they meant:
    // a `sale` fixture is a till session, a `site` fixture is a shopper, and a
    // super_admin fixture is the admin console unless a case says otherwise.
    const audience: SessionAudience =
      opts?.audience ??
      (roles.includes(UserRoleEnum.sale)
        ? 'pos'
        : roles.includes(UserRoleEnum.superAdmin)
          ? 'admin'
          : 'storefront');
    const roleRepo = base.dataSource.getRepository(Role);
    const userRepo = base.dataSource.getRepository(User);

    const roleRows: Role[] = [];
    for (const name of roles) {
      const existing = await roleRepo.findOne({ where: { name } });
      roleRows.push(
        existing ?? (await roleRepo.save(roleRepo.create({ name }))),
      );
    }

    const username = identifier ?? `catalog-test-user-${++identifierCounter}`;
    const user = await userRepo.save(
      userRepo.create({
        username,
        password: 'not-used-by-these-tests',
        roles: roleRows,
        branchId: opts?.branchId ?? null,
      } as Partial<User>),
    );

    /*
     * `pv` IS A MANDATORY CLAIM (migration 0027).
     *
     * `JwtStrategy` admits a token only while its `pv` still equals
     * `users."passwordVersion"`, and fails CLOSED on a token that carries no
     * claim at all — which is every token signed before the mechanism existed.
     * A hand-minted fixture token must therefore state the epoch of the row it
     * was minted for, exactly as `AuthService.issueTokens` does.
     *
     * Read back from the SAVED row rather than hard-coded to 1: the column's
     * default is a schema fact, and a fixture that assumed it would break
     * silently (as a 401 on an unrelated assertion) if it ever changed.
     */
    const token = await jwtService.signAsync(
      {
        sub: user.id,
        identifier: username,
        roles,
        branch: opts?.branchId ?? null,
        aud: audience,
        pv: user.passwordVersion,
        typ: TOKEN_TYPE_ACCESS,
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );

    return {
      userId: user.id,
      audience,
      cookie: `${AUDIENCE_COOKIES[audience].access}=${token}`,
    };
  }

  return {
    ...base,
    request: () => request(base.server as never),
    loginAs,
  };
}

/** A names it `resetDb`; the catalog suites read better as `resetDatabase`. */
export const resetDatabase = resetDb;
