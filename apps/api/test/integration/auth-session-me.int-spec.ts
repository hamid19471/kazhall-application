import * as request from 'supertest';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createBranch, createUser } from './setup/seed-helpers';

/**
 * ===========================================================================
 * GET /auth/me — session introspection
 * ===========================================================================
 *
 * THE GAP THIS CLOSES. The `access_token` cookie is httpOnly, so a frontend
 * cannot read it. Before this route there was no GET route on the auth
 * controller at all and `GET /users` is `super_admin` — so no storefront, admin
 * or POS client could determine whether anyone was signed in, what they were
 * allowed to do, or which branch they belonged to.
 *
 * The response is exactly what `JwtStrategy.validate()` already attaches to
 * every authenticated request. No new state and no new policy.
 */
// There is no shared `/auth/me` any more: each application answers for its own
// session, which is precisely what stops one surface reporting another's user.
// Each case therefore names the surface it is asking about.
const SHOP = '/auth/storefront';
const TILL = '/auth/pos';

describe('GET /auth/<audience>/me', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });
  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
  });

  it('answers 401 when nobody is signed in', async () => {
    const response = await request(app.server).get(`${SHOP}/me`);
    // A signed-out visitor is the normal case on a storefront's first paint,
    // not an error condition the client should surface.
    expect(response.status).toBe(401);
  });

  it('describes a customer session', async () => {
    const { user, username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(app, username, password, 'storefront');

    const response = await withCookies(app, jar).get(`${SHOP}/me`);

    expect(response.status).toBe(200);
    /*
     * EXACT SHAPE, deliberately — `toEqual` rather than `toMatchObject`, so a
     * field added to this response has to be added here too. That is the point
     * of the assertion: `/me` is the one place the frontend learns who it is
     * talking to, and a field appearing there unannounced is a contract change.
     *
     * `permissions` and `mustChangePassword` arrived with permission-based
     * authorisation (migration 0020 / 0023). A customer holds exactly one
     * capability — the shop's own door — which is what makes them a customer.
     */
    expect(response.body.data).toEqual({
      userId: user.id,
      identifier: expect.any(String),
      roles: [UserRoleEnum.site],
      branchId: null,
      audience: 'storefront',
      permissions: ['storefront.access'],
      mustChangePassword: false,
    });

    // And the till does not know this person at all.
    expect((await withCookies(app, jar).get(`${TILL}/me`)).status).toBe(401);
  });

  it('describes a cashier session, including the branch a POS sale is attributed to', async () => {
    const branch = await createBranch(app.dataSource);
    const { user, username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const jar = await authenticate(app, username, password, 'pos');

    const response = await withCookies(app, jar).get(`${TILL}/me`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      userId: user.id,
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
      audience: 'pos',
    });

    // The shop is signed out even though the same browser holds a till session.
    expect((await withCookies(app, jar).get(`${SHOP}/me`)).status).toBe(401);
  });

  it('reflects a role change on the NEXT request, without a token rotation', async () => {
    const { user, username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(app, username, password);
    expect(
      (await withCookies(app, jar).get(`${SHOP}/me`)).body.data.roles,
    ).toEqual([UserRoleEnum.site]);

    // Grant `sale` directly in the database — the cookie is untouched.
    const [saleRole] = await app.dataSource.query<{ id: number }[]>(
      `SELECT id FROM roles WHERE name = $1`,
      [UserRoleEnum.sale],
    );
    await app.dataSource.query(
      `INSERT INTO user_roles ("usersId", "rolesId") VALUES ($1, $2)`,
      [user.id, saleRole.id],
    );

    /**
     * THE POINT. `validate()` re-reads roles from the DATABASE on every
     * request, so this endpoint is authoritative in a way a client-side JWT
     * decode could never be: the same unchanged cookie now reports the new
     * role. An admin UI rendering navigation from a decoded token would show
     * stale permissions until the access token expired.
     */
    const after = await withCookies(app, jar).get(`${SHOP}/me`);
    expect(after.status).toBe(200);
    expect([...(after.body.data.roles as string[])].sort()).toEqual(
      [UserRoleEnum.sale, UserRoleEnum.site].sort(),
    );
  });

  it('stops answering once the account is deactivated', async () => {
    const { user, username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(app, username, password);
    expect((await withCookies(app, jar).get(`${SHOP}/me`)).status).toBe(200);

    await app.dataSource.query(
      `UPDATE users SET "deactivatedAt" = now() WHERE id = $1`,
      [user.id],
    );

    // A successful /auth/me is therefore also a liveness check on the session.
    expect((await withCookies(app, jar).get(`${SHOP}/me`)).status).toBe(401);
  });
});
