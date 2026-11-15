/**
 * ONE BROWSER, THREE APPLICATIONS.
 *
 * Cookies are scoped by host and path, never by port. The storefront (:8001),
 * the admin console (:8001) and the till (:8002) are all `localhost`, so while
 * they shared one `access_token`/`refresh_token` pair every one of them
 * authenticated as whoever had signed in last: signing into the till made the
 * shop header show the cashier, and signing out of the shop destroyed the
 * till's session.
 *
 * The fix has two halves and BOTH are asserted here, because either alone is
 * bypassable:
 *
 *   1. a signed `aud` claim, plus an `audience` column on the refresh-token row
 *   2. a separate cookie pair per surface, chosen by the ROUTE, not by the
 *      client and not by whichever cookie the parser happened to yield first
 *
 * Every case below sends ALL THREE cookie pairs at once — the real situation in
 * a browser with all three applications open — because a rule that only holds
 * when one session exists is not the rule that was needed.
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { AUDIENCE_COOKIES } from 'src/modules/auth/audience';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { createUser } from './setup/seed-helpers';

const ALL_SURFACES = ['storefront', 'admin', 'pos'] as const;

describe('session audiences (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  const loginPath = (surface: (typeof ALL_SURFACES)[number]) =>
    surface === 'storefront'
      ? '/auth/storefront/review-login'
      : `/auth/${surface}/login`;

  /** Signs in through the real HTTP door and returns the cookie header. */
  async function signIn(
    surface: (typeof ALL_SURFACES)[number],
    username: string,
    password: string,
  ): Promise<{ status: number; cookie: string; setCookies: string[] }> {
    const res = await ctx
      .request()
      .post(loginPath(surface))
      .send({ username, password });
    const raw = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const issued = raw.filter((c) => !/^[^=]+=;/.test(c));
    return {
      status: res.status,
      cookie: issued.map((c) => c.split(';')[0]).join('; '),
      setCookies: raw.map((c) => c.split('=')[0]),
    };
  }

  async function makeUser(
    roles: UserRoleEnum[],
    opts: { branchId?: number | null } = {},
  ) {
    const created = await createUser(ctx.dataSource, {
      roles,
      ...(opts.branchId === undefined ? {} : { branchId: opts.branchId }),
    });
    return {
      id: created.user.id,
      username: created.username,
      password: created.password,
    };
  }

  // =========================================================================
  // 1. Cookie names and claims
  // =========================================================================

  describe('cookie names and token claims', () => {
    it('gives each surface its own cookie pair, and no shared fallback', async () => {
      const cashier = await makeUser([UserRoleEnum.sale], { branchId: null });
      const admin = await makeUser([UserRoleEnum.superAdmin]);
      const shopper = await makeUser([UserRoleEnum.site]);

      const pos = await signIn('pos', cashier.username, cashier.password);
      const adm = await signIn('admin', admin.username, admin.password);
      const shop = await signIn(
        'storefront',
        shopper.username,
        shopper.password,
      );

      expect(pos.cookie).toContain(AUDIENCE_COOKIES.pos.access);
      expect(pos.cookie).toContain(AUDIENCE_COOKIES.pos.refresh);
      expect(adm.cookie).toContain(AUDIENCE_COOKIES.admin.access);
      expect(shop.cookie).toContain(AUDIENCE_COOKIES.storefront.access);

      // No surface issues another's cookie, and none issues the old shared pair.
      expect(pos.cookie).not.toContain('kz_admin');
      expect(pos.cookie).not.toContain('kz_storefront');
      expect(adm.cookie).not.toContain('kz_pos');
      for (const issued of [pos.cookie, adm.cookie, shop.cookie]) {
        expect(issued).not.toMatch(/(^|[ ;])access_token=/);
        expect(issued).not.toMatch(/(^|[ ;])refresh_token=/);
      }
    });

    it('marks every session cookie httpOnly, Secure, SameSite=Strict and Path=/', async () => {
      const admin = await makeUser([UserRoleEnum.superAdmin]);
      const res = await ctx
        .request()
        .post('/auth/admin/login')
        .send({ username: admin.username, password: admin.password });
      const setCookies = (
        res.headers['set-cookie'] as unknown as string[]
      ).filter((c) => c.startsWith('kz_admin'));

      expect(setCookies).toHaveLength(2);
      for (const cookie of setCookies) {
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/Secure/i);
        expect(cookie).toMatch(/SameSite=Strict/i);
        expect(cookie).toMatch(/Path=\//i);
        expect(cookie).toMatch(/Max-Age=\d+/i);
      }
    });
  });

  // =========================================================================
  // 2. Login eligibility — decided BEFORE a token exists
  // =========================================================================

  describe('login eligibility', () => {
    it('lets each role in at its own door and nowhere else', async () => {
      const cases: Array<{
        roles: UserRoleEnum[];
        allowed: Array<(typeof ALL_SURFACES)[number]>;
      }> = [
        { roles: [UserRoleEnum.sale], allowed: ['pos'] },
        { roles: [UserRoleEnum.superAdmin], allowed: ['admin', 'pos'] },
        { roles: [UserRoleEnum.site], allowed: ['storefront'] },
      ];

      for (const { roles, allowed } of cases) {
        const user = await makeUser(roles);
        for (const surface of ALL_SURFACES) {
          const res = await signIn(surface, user.username, user.password);
          if (allowed.includes(surface)) {
            expect([200, 201]).toContain(res.status);
          } else {
            expect(res.status).toBe(401);
            // THE POINT: a refusal issues NOTHING. Handing out a valid cookie
            // and leaving the frontend to refuse the role afterwards would put
            // a working session for the wrong application in the browser.
            expect(res.cookie).toBe('');
          }
        }
      }
    });

    it('refuses a deactivated account at every door', async () => {
      const user = await makeUser([UserRoleEnum.superAdmin]);
      await ctx.dataSource.query(
        `UPDATE users SET "deactivatedAt" = now() WHERE id = $1`,
        [user.id],
      );
      for (const surface of ALL_SURFACES) {
        const res = await signIn(surface, user.username, user.password);
        expect(res.status).toBe(401);
        expect(res.cookie).toBe('');
      }
    });

    it('says nothing about whether an unknown username exists', async () => {
      const real = await makeUser([UserRoleEnum.superAdmin]);
      // Both well-formed, so validation cannot be what differs between them.
      const unknown = await signIn(
        'admin',
        'no_such_person_here',
        'Passw0rd!x',
      );
      const wrongPassword = await signIn('admin', real.username, 'Passw0rd!x');

      expect(unknown.status).toBe(401);
      expect(wrongPassword.status).toBe(401);
      // Byte-identical: an unknown name and a wrong password are one answer.
      expect(unknown.cookie).toBe('');
      expect(wrongPassword.cookie).toBe('');
    });
  });

  // =========================================================================
  // 3. Wrong-audience rejection, with every cookie present at once
  // =========================================================================

  describe('a session is only accepted by its own application', () => {
    async function allThreeSignedIn() {
      const cashier = await makeUser([UserRoleEnum.sale]);
      const admin = await makeUser([UserRoleEnum.superAdmin]);
      const shopper = await makeUser([UserRoleEnum.site]);
      const pos = await signIn('pos', cashier.username, cashier.password);
      const adm = await signIn('admin', admin.username, admin.password);
      const shop = await signIn(
        'storefront',
        shopper.username,
        shopper.password,
      );
      return {
        ids: { cashier: cashier.id, admin: admin.id, shopper: shopper.id },
        pos: pos.cookie,
        admin: adm.cookie,
        shop: shop.cookie,
        everything: [pos.cookie, adm.cookie, shop.cookie].join('; '),
      };
    }

    it('answers each /me for its own surface even when all three cookies are sent', async () => {
      const s = await allThreeSignedIn();

      for (const [surface, expectedId] of [
        ['pos', s.ids.cashier],
        ['admin', s.ids.admin],
        ['storefront', s.ids.shopper],
      ] as const) {
        const res = await ctx
          .request()
          .get(`/auth/${surface}/me`)
          .set('Cookie', s.everything)
          .expect(200);
        // Deterministic selection: the route reads ITS cookie, not the first
        // one in the header. This is the assertion the original defect failed.
        expect(res.body.data.userId).toBe(expectedId);
        expect(res.body.data.audience).toBe(surface);
      }
    });

    it('refuses a foreign session on a surface-specific route', async () => {
      const s = await allThreeSignedIn();

      // Till cookie at the shop's door and the admin console's door.
      await ctx
        .request()
        .get('/auth/storefront/me')
        .set('Cookie', s.pos)
        .expect(401);
      await ctx
        .request()
        .get('/auth/admin/me')
        .set('Cookie', s.pos)
        .expect(401);
      // Shop cookie at the till.
      await ctx.request().get('/auth/pos/me').set('Cookie', s.shop).expect(401);
      // Admin cookie at the till.
      await ctx
        .request()
        .get('/auth/pos/me')
        .set('Cookie', s.admin)
        .expect(401);
    });

    it('refuses a POS session on admin-only APIs and a storefront session on both', async () => {
      const s = await allThreeSignedIn();

      for (const route of ['/orders', '/users', '/branch']) {
        await ctx.request().get(route).set('Cookie', s.pos).expect(401);
        await ctx.request().get(route).set('Cookie', s.shop).expect(401);
        await ctx.request().get(route).set('Cookie', s.admin).expect(200);
      }
    });

    it('refuses an admin or POS session on customer-private APIs', async () => {
      const s = await allThreeSignedIn();

      for (const route of ['/cart', '/me/orders', '/me/addresses']) {
        await ctx.request().get(route).set('Cookie', s.admin).expect(401);
        await ctx.request().get(route).set('Cookie', s.pos).expect(401);
        await ctx.request().get(route).set('Cookie', s.shop).expect(200);
      }
    });

    it('refuses an admin session at the POS sale endpoint', async () => {
      const s = await allThreeSignedIn();
      // Explicitly required: an Admin cookie must not sell, unless a separate
      // POS session exists — and then it is that session doing the selling.
      await ctx
        .request()
        .post('/orders/pos')
        .set('Cookie', s.admin)
        .set('Idempotency-Key', 'aud-cross-1')
        .send({ paymentMethod: 'cash', items: [] })
        .expect(401);
    });

    it('will not let a renamed cookie smuggle a token into another surface', async () => {
      const cashier = await makeUser([UserRoleEnum.sale]);
      const pos = await signIn('pos', cashier.username, cashier.password);
      const token = /kz_pos_access=([^;]+)/.exec(pos.cookie)?.[1];
      expect(token).toBeDefined();

      // The cookie NAME says admin; the signed `aud` claim inside still says
      // pos, and the claim is what decides. Without this check the cookie name
      // — which any client can choose — would be the whole control.
      await ctx
        .request()
        .get('/auth/admin/me')
        .set('Cookie', `kz_admin_access=${token ?? ''}`)
        .expect(401);
    });
  });

  // =========================================================================
  // 4. Refresh and logout are per-surface; logout-all is not
  // =========================================================================

  describe('rotation and sign-out', () => {
    async function twoSessions() {
      const admin = await makeUser([UserRoleEnum.superAdmin]);
      const adm = await signIn('admin', admin.username, admin.password);
      const pos = await signIn('pos', admin.username, admin.password);
      return { user: admin, admin: adm.cookie, pos: pos.cookie };
    }

    it('rotates only the surface asked, leaving the other session alone', async () => {
      const s = await twoSessions();

      const rotated = await ctx
        .request()
        .post('/auth/admin/refresh')
        .set('Cookie', [s.admin, s.pos].join('; '))
        .expect(201);
      const names = (rotated.headers['set-cookie'] as unknown as string[]).map(
        (c) => c.split('=')[0],
      );
      expect(names.sort()).toEqual(['kz_admin_access', 'kz_admin_refresh']);

      // The till's refresh token was untouched and still rotates.
      await ctx
        .request()
        .post('/auth/pos/refresh')
        .set('Cookie', s.pos)
        .expect(201);
    });

    it('refuses to rotate a refresh token belonging to another surface', async () => {
      const s = await twoSessions();
      await ctx
        .request()
        .post('/auth/admin/refresh')
        .set('Cookie', s.pos)
        .expect(401);
      await ctx
        .request()
        .post('/auth/pos/refresh')
        .set('Cookie', s.admin)
        .expect(401);
    });

    it('signs out of one application only', async () => {
      const s = await twoSessions();

      const out = await ctx
        .request()
        .post('/auth/pos/logout')
        .set('Cookie', [s.admin, s.pos].join('; '))
        .expect(200);
      const cleared = (out.headers['set-cookie'] as unknown as string[]).map(
        (c) => c.split('=')[0],
      );
      expect(cleared).toEqual(
        expect.arrayContaining(['kz_pos_access', 'kz_pos_refresh']),
      );
      expect(cleared).not.toContain('kz_admin_access');

      // The till is dead, the admin console is not. This is the behaviour the
      // shared cookie made impossible: one logout used to end all of them.
      await ctx
        .request()
        .post('/auth/pos/refresh')
        .set('Cookie', s.pos)
        .expect(401);
      await ctx
        .request()
        .post('/auth/admin/refresh')
        .set('Cookie', s.admin)
        .expect(201);
    });

    it('ends every session in every audience on logout-all', async () => {
      const s = await twoSessions();

      await ctx
        .request()
        .post('/auth/admin/logout-all')
        .set('Cookie', s.admin)
        .expect(200);

      // The explicit security lever, as distinct from the sign-out button.
      await ctx
        .request()
        .post('/auth/admin/refresh')
        .set('Cookie', s.admin)
        .expect(401);
      await ctx
        .request()
        .post('/auth/pos/refresh')
        .set('Cookie', s.pos)
        .expect(401);
    });
  });

  // =========================================================================
  // 5. Account lifecycle reaches every audience at once
  // =========================================================================

  describe('password change and deactivation cross every surface', () => {
    it('invalidates the admin AND the POS session when the password changes', async () => {
      const user = await makeUser([UserRoleEnum.superAdmin]);
      const adm = await signIn('admin', user.username, user.password);
      const pos = await signIn('pos', user.username, user.password);

      await ctx
        .request()
        .get('/auth/admin/me')
        .set('Cookie', adm.cookie)
        .expect(200);
      await ctx
        .request()
        .get('/auth/pos/me')
        .set('Cookie', pos.cookie)
        .expect(200);

      /*
       * ENDS THE PASSWORD EPOCH. No clock, and no `+ interval '1 second'`.
       *
       * That interval was here because the old rule compared a whole-second
       * `iat` against a microsecond `passwordChangedAt`: pushing the column a
       * second into the future was the only way to be sure a token minted
       * moments earlier landed on the losing side of it. It also meant the
       * test asserted something the application never does — no code path
       * stamps a password change in the future.
       */
      await ctx.dataSource.query(
        `UPDATE users SET "passwordVersion" = "passwordVersion" + 1 WHERE id = $1`,
        [user.id],
      );

      // "Kill every session NOW" must not stop at the surface it was pressed on.
      await ctx
        .request()
        .get('/auth/admin/me')
        .set('Cookie', adm.cookie)
        .expect(401);
      await ctx
        .request()
        .get('/auth/pos/me')
        .set('Cookie', pos.cookie)
        .expect(401);
      await ctx
        .request()
        .post('/auth/pos/refresh')
        .set('Cookie', pos.cookie)
        .expect(401);
    });

    it('invalidates every audience when the account is deactivated', async () => {
      const user = await makeUser([UserRoleEnum.superAdmin]);
      const adm = await signIn('admin', user.username, user.password);
      const pos = await signIn('pos', user.username, user.password);

      await ctx.dataSource.query(
        `UPDATE users SET "deactivatedAt" = now() WHERE id = $1`,
        [user.id],
      );

      await ctx
        .request()
        .get('/auth/admin/me')
        .set('Cookie', adm.cookie)
        .expect(401);
      await ctx
        .request()
        .get('/auth/pos/me')
        .set('Cookie', pos.cookie)
        .expect(401);
      await ctx
        .request()
        .post('/auth/admin/refresh')
        .set('Cookie', adm.cookie)
        .expect(401);
    });

    it('drops a surface as soon as the user stops being eligible for it', async () => {
      const user = await makeUser([UserRoleEnum.superAdmin]);
      const pos = await signIn('pos', user.username, user.password);
      await ctx
        .request()
        .post('/auth/pos/refresh')
        .set('Cookie', pos.cookie)
        .expect(201);

      // Demote: no longer eligible for the till at all.
      await ctx.dataSource.query(
        `DELETE FROM user_roles WHERE "usersId" = $1`,
        [user.id],
      );

      // Eligibility is re-decided on every rotation, not only at login, so the
      // till is lost at the next rotation rather than at the refresh token's
      // 48-hour expiry.
      const second = await signIn('pos', user.username, user.password);
      expect(second.status).toBe(401);
    });
  });

  // =========================================================================
  // 6. The refresh-token row carries the audience, not just the claim
  // =========================================================================

  it('records the audience on the refresh-token row', async () => {
    const user = await makeUser([UserRoleEnum.superAdmin]);
    await signIn('admin', user.username, user.password);
    await signIn('pos', user.username, user.password);

    const rows = await ctx.dataSource.query<Array<{ audience: string }>>(
      `SELECT audience FROM refresh_tokens WHERE "userId" = $1 AND revoked = false ORDER BY audience`,
      [user.id],
    );
    // Two live sessions for one person, distinguishable in the database. The
    // claim could be forged only by forging the signature; the row could be
    // wrong only by a bug. Both are checked, so neither alone is load-bearing.
    expect(rows.map((r) => r.audience)).toEqual(['admin', 'pos']);
  });

  it('refuses a storefront password login when review logins are switched off', async () => {
    const shopper = await makeUser([UserRoleEnum.site]);
    const previous = process.env.KAZHAL_ENABLE_REVIEW_LOGIN;
    process.env.KAZHAL_ENABLE_REVIEW_LOGIN = 'false';
    try {
      // Production customer sign-in is OTP. The password form is a review aid
      // and must not become a second production entrance.
      const res = await signIn(
        'storefront',
        shopper.username,
        shopper.password,
      );
      expect(res.status).toBe(403);
      expect(res.cookie).toBe('');
    } finally {
      if (previous === undefined) delete process.env.KAZHAL_ENABLE_REVIEW_LOGIN;
      else process.env.KAZHAL_ENABLE_REVIEW_LOGIN = previous;
    }
  });
});
