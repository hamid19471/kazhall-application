import * as request from 'supertest';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PERMISSION_CATALOG } from 'src/modules/auth/permissions/permission.catalog';
import { systemRolePermissions } from 'src/modules/auth/permissions/system-roles';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createBranch, createUser, uniqueSuffix } from './setup/seed-helpers';

/**
 * ===========================================================================
 * PERMISSION-BASED AUTHORISATION — the properties the whole model rests on
 * ===========================================================================
 *
 * The previous model was three role NAMES, which gave the owner exactly two
 * settings for an employee: "everything an administrator can do" or "cannot
 * enter the console at all". Delegation is the point of replacing it, so every
 * case below is written from the owner's question rather than from the code:
 *
 *   1. Can I let somebody read orders WITHOUT letting them void a sale?
 *   2. Does adding a capability work without them signing in again?
 *   3. Does removing one take effect just as fast?
 *   4. Can a delegate quietly give themselves more than they have?
 *   5. Can somebody use an admin capability from the till?
 *   6. Can the administrator role be weakened into a lockout?
 *
 * Every assertion is over HTTP against the real application module, because a
 * unit test of the guard would prove the guard works and not that the ROUTES
 * are wired to it — which is the half that actually fails.
 */
describe('permission-based authorisation', () => {
  let app: TestApp;
  let admin: CookieJar;
  let adminUserId: number;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    const created = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    adminUserId = created.user.id;
    admin = await authenticate(
      app,
      created.username,
      created.password,
      'admin',
    );
  });

  /** Creates a custom role through the API and returns its id. */
  async function createRole(permissions: string[]): Promise<number> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const response = await withCookies(app, admin)
      .post('/admin/access/roles')
      .send({
        name: `role_${suffix}`,
        titleFa: 'نقش آزمایشی',
        permissions,
      });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  /** A staff account holding exactly `roleIds`, signed in to the console. */
  async function staffWithRoles(roleIds: number[]): Promise<{
    jar: CookieJar;
    userId: number;
  }> {
    const created = await createUser(app.dataSource, { roles: [] });
    const assign = await withCookies(app, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds });
    expect(assign.status).toBe(200);

    const jar = await authenticate(
      app,
      created.username,
      created.password,
      'admin',
    );
    return { jar, userId: created.user.id };
  }

  // =========================================================================
  // 0. The catalogue is a closed set
  // =========================================================================

  describe('the permission catalogue', () => {
    it('is served with a Persian label and consequence for every code', async () => {
      const response = await withCookies(app, admin).get(
        '/admin/access/permissions',
      );
      expect(response.status).toBe(200);

      const served = (
        response.body.groups as Array<{
          permissions: Array<{
            code: string;
            labelFa: string;
            descriptionFa: string;
            risk: string;
          }>;
        }>
      ).flatMap((group) => group.permissions);

      // Every code in the source catalogue is offered, and every one carries
      // the two strings an administrator actually reads. A code with no label
      // would render as `orders.status.update` in the role editor, which is
      // exactly what this model exists to stop.
      expect(served).toHaveLength(PERMISSION_CATALOG.length);
      for (const permission of served) {
        expect(permission.labelFa.trim().length).toBeGreaterThan(0);
        expect(permission.descriptionFa.trim().length).toBeGreaterThan(0);
        expect(['normal', 'sensitive', 'critical']).toContain(permission.risk);
      }
    });

    it('refuses a code that does not exist, naming it', async () => {
      const response = await withCookies(app, admin)
        .post('/admin/access/roles')
        .send({
          name: `role_${uniqueSuffix().replace(/[^a-z0-9_]/g, '')}`,
          titleFa: 'نقش نامعتبر',
          permissions: ['orders.read', 'orders.delete_everything'],
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('UNKNOWN_PERMISSION');
      expect(response.body.details.unknownPermissions).toEqual([
        'orders.delete_everything',
      ]);
    });
  });

  // =========================================================================
  // 1. Delegation: read orders WITHOUT being able to change anything
  // =========================================================================

  describe('a delegated order reader', () => {
    it('enters the console and reads orders, and can do nothing else', async () => {
      const roleId = await createRole(['admin.access', 'orders.read']);
      const { jar } = await staffWithRoles([roleId]);

      // The door opened at all — which under the old model required making
      // them a super_admin.
      const me = await withCookies(app, jar).get('/auth/admin/me');
      expect(me.status).toBe(200);
      expect(me.body.data.permissions).toEqual(
        expect.arrayContaining(['admin.access', 'orders.read']),
      );
      // They hold NOTHING beyond what was granted.
      expect(me.body.data.permissions).toHaveLength(2);

      expect((await withCookies(app, jar).get('/orders')).status).toBe(200);

      // ...and every neighbouring capability is refused, each with the same
      // machine-readable code so one client branch handles them all.
      const refusals = await Promise.all([
        withCookies(app, jar).get('/admin/users'),
        withCookies(app, jar).get('/admin/inventory'),
        withCookies(app, jar).get('/admin/access/roles'),
        withCookies(app, jar).get('/admin/audit'),
        withCookies(app, jar).get('/payment/admin/reconciliation'),
      ]);
      for (const refusal of refusals) {
        expect(refusal.status).toBe(403);
        expect(refusal.body.error).toBe('PERMISSION_DENIED');
      }

      /*
       * SALES REPORTING IS REFUSED DIFFERENTLY, ON PURPOSE.
       *
       * It used to be in the list above, refused as a missing CAPABILITY. It
       * is now refused as a missing ROLE — there is no reports capability in
       * the catalogue at all, because the owner's rule is that reporting
       * belongs to the built-in `super_admin` role and is not delegable.
       *
       * The distinct code matters to the console: `PERMISSION_DENIED` tells an
       * operator to ask for a capability, and here there is none to ask for.
       * `details.requiredRoles` names the rule instead, and the response
       * carries no figure of any kind.
       */
      const reporting = await withCookies(app, jar).get(
        '/reports/sales/summary',
      );
      expect(reporting.status).toBe(403);
      expect(reporting.body.error).toBe('ROLE_REQUIRED');
      expect(reporting.body.details.requiredRoles).toEqual(['super_admin']);
      expect(reporting.body).not.toHaveProperty('totals');
      expect(JSON.stringify(reporting.body)).not.toMatch(/grossSales|netSales/);

      // The financial dashboard answers with the same rule, which is the whole
      // point of gating the two on the same thing.
      const financial = await withCookies(app, jar).get(
        '/admin/dashboard/financial',
      );
      expect(financial.status).toBe(403);
      expect(financial.body.error).toBe('ROLE_REQUIRED');
    });

    it('is refused the order MUTATIONS that reading does not imply', async () => {
      const roleId = await createRole(['admin.access', 'orders.read']);
      const { jar } = await staffWithRoles([roleId]);
      const orderId = await seedOrder(app);

      const status = await withCookies(app, jar)
        .patch(`/orders/status/${orderId}`)
        .send({ status: 'processing' });
      expect(status.status).toBe(403);
      expect(status.body.details.missingPermissions).toEqual([
        'orders.status.update',
      ]);

      const voided = await withCookies(app, jar)
        .post(`/orders/${orderId}/void`)
        .send({});
      expect(voided.status).toBe(403);
      expect(voided.body.details.missingPermissions).toEqual(['orders.void']);

      const returned = await withCookies(app, jar)
        .post(`/orders/${orderId}/return`)
        .send({});
      expect(returned.status).toBe(403);
      expect(returned.body.details.missingPermissions).toEqual([
        'orders.return',
      ]);
    });
  });

  // =========================================================================
  // 2 & 3. A permission change reaches a LIVE session
  // =========================================================================

  describe('a permission change on a signed-in user', () => {
    it('takes effect on the very next request, without a new sign-in', async () => {
      const roleId = await createRole(['admin.access', 'orders.read']);
      const { jar } = await staffWithRoles([roleId]);
      const orderId = await seedOrder(app);

      const before = await withCookies(app, jar)
        .patch(`/orders/status/${orderId}`)
        .send({ status: 'processing' });
      expect(before.status).toBe(403);

      const grant = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({
          permissions: ['admin.access', 'orders.read', 'orders.status.update'],
        });
      expect(grant.status).toBe(200);

      // SAME COOKIE. No refresh, no re-login. The capability is expanded from
      // the database on every request, so a grant cannot be held up by a
      // token's remaining lifetime.
      const after = await withCookies(app, jar)
        .patch(`/orders/status/${orderId}`)
        .send({ status: 'processing' });
      expect(after.status).toBe(200);
    });

    it('takes a capability AWAY just as fast', async () => {
      const roleId = await createRole([
        'admin.access',
        'orders.read',
        'orders.status.update',
      ]);
      const { jar } = await staffWithRoles([roleId]);
      const orderId = await seedOrder(app);

      expect(
        (
          await withCookies(app, jar)
            .patch(`/orders/status/${orderId}`)
            .send({ status: 'processing' })
        ).status,
      ).toBe(200);

      await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: ['admin.access', 'orders.read'] });

      const after = await withCookies(app, jar)
        .patch(`/orders/status/${orderId}`)
        .send({ status: 'shipped' });
      expect(after.status).toBe(403);
    });

    it('deactivating the ROLE suspends everything it grants, reversibly', async () => {
      const roleId = await createRole(['admin.access', 'orders.read']);
      const { jar } = await staffWithRoles([roleId]);

      expect((await withCookies(app, jar).get('/orders')).status).toBe(200);

      await withCookies(app, admin)
        .patch(`/admin/access/roles/${roleId}/active`)
        .send({ isActive: false });

      // An inactive role contributes nothing — including `admin.access`, so
      // even introspection now reports an empty capability set.
      const me = await withCookies(app, jar).get('/auth/admin/me');
      expect(me.status).toBe(200);
      expect(me.body.data.permissions).toEqual([]);
      expect((await withCookies(app, jar).get('/orders')).status).toBe(403);

      await withCookies(app, admin)
        .patch(`/admin/access/roles/${roleId}/active`)
        .send({ isActive: true });

      // The assignment was never removed, so reactivating restores exactly the
      // access it had. This is why deactivation exists rather than deletion.
      expect((await withCookies(app, jar).get('/orders')).status).toBe(200);
    });
  });

  // =========================================================================
  // 4. No escalation
  // =========================================================================

  describe('a delegate with rbac.manage', () => {
    it('cannot grant a capability it does not hold itself', async () => {
      const delegateRole = await createRole([
        'admin.access',
        'rbac.read',
        'rbac.manage',
        'orders.read',
      ]);
      const { jar } = await staffWithRoles([delegateRole]);

      const attempt = await withCookies(app, jar)
        .post('/admin/access/roles')
        .send({
          name: `role_${uniqueSuffix().replace(/[^a-z0-9_]/g, '')}`,
          titleFa: 'نقش پرقدرت',
          // They hold neither of these.
          permissions: ['admin.access', 'orders.void', 'users.password.reset'],
        });

      expect(attempt.status).toBe(403);
      expect(attempt.body.error).toBe('PERMISSION_ESCALATION');
      expect(attempt.body.details.beyondActorAuthority.sort()).toEqual([
        'orders.void',
        'users.password.reset',
      ]);
    });

    it('cannot hand somebody a ROLE that confers more than it holds', async () => {
      // Made by the administrator, who does hold everything.
      const powerful = await createRole(['admin.access', 'orders.void']);

      const delegateRole = await createRole([
        'admin.access',
        'rbac.read',
        'rbac.manage',
      ]);
      const { jar } = await staffWithRoles([delegateRole]);
      const victim = await createUser(app.dataSource, { roles: [] });

      // Granting is guarded; so is ASSIGNING, because assigning confers
      // exactly the same authority by a different route.
      const attempt = await withCookies(app, jar)
        .put(`/admin/access/users/${victim.user.id}/roles`)
        .send({ roleIds: [powerful] });

      expect(attempt.status).toBe(403);
      expect(attempt.body.error).toBe('PERMISSION_ESCALATION');
      expect(attempt.body.details.beyondActorAuthority).toContain(
        'orders.void',
      );
    });
  });

  // =========================================================================
  // 5. Audience and permission are INDEPENDENT
  // =========================================================================

  describe('surface enforcement', () => {
    it('refuses a correct permission presented on the wrong surface', async () => {
      const branch = await createBranch(app.dataSource);
      // A super_admin holds every management capability AND may open a till
      // session — which makes them the only principal who can prove the two
      // checks are independent rather than one standing in for the other.
      const created = await createUser(app.dataSource, {
        roles: [UserRoleEnum.superAdmin],
        branchId: branch.id,
      });
      const posJar = await authenticate(
        app,
        created.username,
        created.password,
        'pos',
      );

      // Holds `orders.read`. Presents a POS cookie to an admin-audience route.
      const refused = await withCookies(app, posJar).get('/admin/users');
      expect(refused.status).toBe(401);

      // The same principal, on the surface the route serves, is admitted —
      // so the refusal above was the AUDIENCE, not the capability.
      const adminJar = await authenticate(
        app,
        created.username,
        created.password,
        'admin',
      );
      expect(
        (await withCookies(app, adminJar).get('/admin/users')).status,
      ).toBe(200);
    });

    it('refuses an admin session to somebody without admin.access', async () => {
      const roleId = await createRole(['orders.read']); // no admin.access
      const created = await createUser(app.dataSource, { roles: [] });
      await withCookies(app, admin)
        .put(`/admin/access/users/${created.user.id}/roles`)
        .send({ roleIds: [roleId] });

      const login = await request(app.server)
        .post('/auth/admin/login')
        .send({ username: created.username, password: created.password });

      // Refused BEFORE any token is minted, so no admin cookie is ever set.
      expect(login.status).toBe(401);
      expect(login.body.error).toBe('AUDIENCE_NOT_PERMITTED');
      expect(login.headers['set-cookie']).toBeUndefined();
    });
  });

  // =========================================================================
  // 6. The administrator cannot be weakened into a lockout
  // =========================================================================

  describe('system roles', () => {
    it('hold exactly what the code says, and super_admin holds everything but the shop door', async () => {
      const response = await withCookies(app, admin).get('/auth/admin/me');
      const held = new Set<string>(
        (response.body.data as { permissions: string[] }).permissions,
      );

      for (const permission of PERMISSION_CATALOG) {
        if (permission.code === 'storefront.access') {
          // The customer's door is not a delegated authority, and granting it
          // would let an administrator open a shopper session — the exact
          // cross-surface identity the audience model exists to prevent.
          expect(held.has(permission.code)).toBe(false);
        } else {
          expect(held.has(permission.code)).toBe(true);
        }
      }
      expect([...held].sort()).toEqual(
        [...(systemRolePermissions(UserRoleEnum.superAdmin) ?? [])].sort(),
      );
    });

    it('cannot be renamed, deactivated, or re-permissioned', async () => {
      const roles = await withCookies(app, admin).get('/admin/access/roles');
      const superAdmin = (
        roles.body.data as Array<{ id: number; name: string }>
      ).find((role) => role.name === String(UserRoleEnum.superAdmin))!;

      for (const attempt of [
        withCookies(app, admin)
          .patch(`/admin/access/roles/${superAdmin.id}`)
          .send({ titleFa: 'دیگر' }),
        withCookies(app, admin)
          .patch(`/admin/access/roles/${superAdmin.id}/active`)
          .send({ isActive: false }),
        withCookies(app, admin)
          .put(`/admin/access/roles/${superAdmin.id}/permissions`)
          .send({ permissions: ['admin.access'] }),
      ]) {
        const response = await attempt;
        expect(response.status).toBe(409);
        expect(response.body.error).toBe('SYSTEM_ROLE_IMMUTABLE');
      }

      // And the capability set is unchanged afterwards.
      const me = await withCookies(app, admin).get('/auth/admin/me');
      expect(me.body.data.permissions).toContain('rbac.manage');
    });

    it('refuses to strip super_admin from the last administrator', async () => {
      const roles = await withCookies(app, admin).get('/admin/access/roles');
      const saleRole = (
        roles.body.data as Array<{ id: number; name: string }>
      ).find((role) => role.name === String(UserRoleEnum.sale))!;

      const response = await withCookies(app, admin)
        .put(`/admin/access/users/${adminUserId}/roles`)
        .send({ roleIds: [saleRole.id] });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('LAST_SUPER_ADMIN');

      // Still an administrator, and the refusal was not merely cosmetic.
      const me = await withCookies(app, admin).get('/auth/admin/me');
      expect(me.body.data.roles).toContain(UserRoleEnum.superAdmin);
    });
  });

  // =========================================================================
  // 7. Every change is recorded, and the record cannot be edited
  // =========================================================================

  describe('the administrative audit trail', () => {
    it('records who changed a role’s capabilities, with before and after', async () => {
      const roleId = await createRole(['admin.access', 'orders.read']);
      await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: ['admin.access', 'orders.read', 'orders.void'] });

      const audit = await withCookies(app, admin).get(
        '/admin/audit?action=role.permissions.changed',
      );
      expect(audit.status).toBe(200);

      const row = (audit.body.data as Array<Record<string, unknown>>)[0];
      expect(row.actorUserId).toBe(adminUserId);
      expect(row.targetType).toBe('role');
      expect(row.targetId).toBe(String(roleId));
      const summary = row.summary as {
        granted: string[];
        revoked: string[];
      };
      expect(summary.granted).toEqual(['orders.void']);
      expect(summary.revoked).toEqual([]);
    });

    it('is append-only at the DATABASE, not merely by convention', async () => {
      await createRole(['admin.access']);

      // The API exposes no write route at all, so this reaches past it to the
      // table itself — which is the only way to prove the guarantee is real
      // rather than a property of the current controller surface.
      await expect(
        app.dataSource.query(
          `UPDATE admin_audit_log SET action = 'tampered' WHERE id = (SELECT MIN(id) FROM admin_audit_log)`,
        ),
      ).rejects.toThrow(/append-only/);

      await expect(
        app.dataSource.query(`DELETE FROM admin_audit_log`),
      ).rejects.toThrow(/append-only/);
    });

    it('never records a password, even when one is supplied', async () => {
      const target = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });
      const reset = await withCookies(app, admin)
        .post(`/admin/users/${target.user.id}/password`)
        .send({ temporaryPassword: 'Temp!Passw0rd' });
      expect(reset.status).toBe(200);

      const audit = await withCookies(app, admin).get(
        '/admin/audit?action=user.password.reset',
      );
      const row = (audit.body.data as Array<Record<string, unknown>>)[0];
      expect(JSON.stringify(row)).not.toContain('Temp!Passw0rd');
      // Nor a hash of it, nor anything shaped like one.
      expect(JSON.stringify(row)).not.toMatch(/\$2[aby]\$/);
    });
  });
});

/** A minimal POS-shaped order, written straight to the table. */
async function seedOrder(app: TestApp): Promise<number> {
  const [row] = await app.dataSource.query<Array<{ id: number }>>(
    `INSERT INTO orders (channel, status, "fulfillmentState", total_price,
                         subtotal, "soldAt", "paidAt")
     VALUES ('pos', 'paid', 'fulfilled', 1000, 1000, now(), now())
     RETURNING id`,
  );
  return Number(row.id);
}
