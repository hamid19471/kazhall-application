/**
 * ===========================================================================
 * `GET /admin/users/assignable-roles` — creating a user without `rbac.read`
 * ===========================================================================
 *
 * THE DEFECT. A delegated user manager holding `users.create` could open the
 * create-user form and never complete it. The form needs a role — the API
 * refuses a staff account with none — and the only list of roles was
 * `GET /admin/access/roles`, gated on `rbac.read`. So the form disabled its own
 * submit button and told the operator to ask for `rbac.read`, which hands over
 * the entire access-control catalogue, every custom role, and every user's
 * effective permissions: the whole permission model, acquired as an accidental
 * dependency of being allowed to hire a cashier.
 *
 * WHAT THIS FILE PROVES, in four groups:
 *
 *  1. THE DECOUPLING IS REAL. A manager with `users.create` and NO `rbac.read`
 *     reads the list, completes a creation end to end, and is still refused by
 *     every `rbac.read` route. The second half matters as much as the first: an
 *     endpoint that quietly granted catalogue access would have "fixed" the
 *     form by doing the exact thing the fix exists to avoid.
 *
 *  2. IT LEAKS NOTHING. No permission codes, no risk metadata, no inactive
 *     roles, and no role the caller could not actually confer — so it cannot
 *     be used to enumerate the shape of the authority model, nor even to
 *     discover that a higher-privileged role exists.
 *
 *  3. IT IS NOT AN AUTHORISATION. The list is a projection of what the
 *     MUTATIONS accept, and both mutations re-apply the identical rule. Asking
 *     first is a convenience; naming a role that was withheld is still a 403.
 *
 *  4. THE USER-MANAGEMENT MATRIX IS SEPARATE, CAPABILITY BY CAPABILITY.
 *     `users.create` implies none of read, update, reset, deactivate or
 *     session-revocation — asserted one route at a time, because "it should be
 *     separate" is a design statement and this is the evidence.
 */
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { createUser, uniqueSuffix } from './setup/seed-helpers';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

/** A random-but-valid staff username. `roles.name` and `users.username` differ. */
function username(): string {
  return `mgr_${uniqueSuffix().replace(/[^a-z0-9_]/g, '')}`;
}

describe('assignable roles (int)', () => {
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

  /** Creates a custom role carrying exactly `permissions`, returns its id. */
  async function roleWith(
    permissions: string[],
    overrides: { name?: string; titleFa?: string } = {},
  ): Promise<number> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const response = await withCookies(app, admin)
      .post('/admin/access/roles')
      .send({
        name: overrides.name ?? `role_${suffix}`,
        titleFa: overrides.titleFa ?? 'نقش آزمایشی',
        permissions,
      });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  /** A signed-in admin-surface principal holding exactly `permissions`. */
  async function staffHolding(
    permissions: string[],
  ): Promise<{ jar: CookieJar; userId: number; roleId: number }> {
    const roleId = await roleWith(permissions);
    const created = await createUser(app.dataSource, { roles: [] });
    const assign = await withCookies(app, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [roleId] });
    expect(assign.status).toBe(200);
    return {
      jar: await authenticate(app, created.username, created.password, 'admin'),
      userId: created.user.id,
      roleId,
    };
  }

  const MANAGER = ['admin.access', 'users.create', 'users.read'];

  // =======================================================================
  // 1. The decoupling
  // =======================================================================

  describe('a user manager who holds no rbac.read', () => {
    it('reads the assignable-role list', async () => {
      const manager = await staffHolding(MANAGER);

      const response = await withCookies(app, manager.jar).get(
        '/admin/users/assignable-roles',
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('is STILL refused by every rbac.read route', async () => {
      // The half that makes the fix a fix. If this endpoint had been built by
      // relaxing `rbac.read`, these would all be 200 and the catalogue would
      // have leaked through the back door the form opened.
      const manager = await staffHolding(MANAGER);

      for (const path of [
        '/admin/access/roles',
        '/admin/access/permissions',
        `/admin/access/users/${adminUserId}/effective`,
        '/roles',
      ]) {
        const response = await withCookies(app, manager.jar).get(path);
        expect([path, response.status]).toEqual([path, 403]);
        expect(response.body.error).toBe('PERMISSION_DENIED');
      }
    });

    it('completes a creation end to end, using a role from the list', async () => {
      // The whole user journey the defect blocked, in one case.
      const manager = await staffHolding([
        ...MANAGER,
        // To be able to confer `pos.*`, the manager must hold them.
        'pos.access',
        'pos.sell',
        'pos.receipt.read_own',
      ]);

      const list = await withCookies(app, manager.jar)
        .get('/admin/users/assignable-roles')
        .expect(200);

      const sale = (list.body.data as Array<{ id: number; name: string }>).find(
        (role) => role.name === 'sale',
      );
      expect(sale).toBeDefined();

      const name = username();
      const created = await withCookies(app, manager.jar)
        .post('/admin/users')
        .send({
          username: name,
          password: 'Cashi3r!Temp',
          roleIds: [sale!.id],
        });

      expect(created.status).toBe(201);
      expect(created.body.data.username).toBe(name);

      // And the account really can open a till session.
      const jar = await authenticate(app, name, 'Cashi3r!Temp', 'pos');
      expect(jar.has('kz_pos_access')).toBe(true);
    });

    it('is served to a principal who may UPDATE users but not create them', async () => {
      // The OR the route decorator cannot express. Both halves must work, or
      // the "change this user's roles" screen breaks instead of the create one.
      const updater = await staffHolding([
        'admin.access',
        'users.read',
        'users.update',
      ]);

      await withCookies(app, updater.jar)
        .get('/admin/users/assignable-roles')
        .expect(200);
    });

    it('refuses a principal who may do neither, naming both capabilities', async () => {
      const reader = await staffHolding(['admin.access', 'users.read']);

      const response = await withCookies(app, reader.jar).get(
        '/admin/users/assignable-roles',
      );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_DENIED');
      // Both codes are named so a client can say which capability is missing
      // rather than guessing at an AND it was never subject to.
      expect(response.body.details.requiredPermissions).toEqual(
        expect.arrayContaining(['users.create', 'users.update']),
      );
    });
  });

  // =======================================================================
  // 2. What the response withholds
  // =======================================================================

  describe('the response shape', () => {
    it('carries a permission COUNT and never the codes, risk or grouping', async () => {
      const manager = await staffHolding(MANAGER);

      const response = await withCookies(app, manager.jar)
        .get('/admin/users/assignable-roles')
        .expect(200);

      const serialised = JSON.stringify(response.body);
      // Not one catalogue code anywhere in the payload.
      expect(serialised).not.toContain('users.create');
      expect(serialised).not.toContain('rbac.manage');
      expect(serialised).not.toContain('risk');
      expect(serialised).not.toContain('groupKey');

      for (const role of response.body.data as Array<Record<string, unknown>>) {
        expect(Object.keys(role).sort()).toEqual([
          'description',
          'id',
          'isActive',
          'isSystem',
          'name',
          'permissionCount',
          'titleFa',
        ]);
        expect(typeof role.permissionCount).toBe('number');
        expect(role.isActive).toBe(true);
      }
    });

    it('omits a role that confers more than the caller holds', async () => {
      // `users.read` + `users.create` cannot confer a role that also grants
      // `orders.void`, so that role must not appear — not even by name, which
      // would tell the caller a more powerful role exists.
      const manager = await staffHolding(MANAGER);
      const powerful = await roleWith([
        'admin.access',
        'orders.read',
        'orders.void',
      ]);

      const response = await withCookies(app, manager.jar)
        .get('/admin/users/assignable-roles')
        .expect(200);

      const ids = (response.body.data as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(ids).not.toContain(powerful);
      // `super_admin` is the obvious one, and it is absent for the same reason.
      const names = (response.body.data as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(names).not.toContain('super_admin');
    });

    it('omits a DEACTIVATED role even when the caller could otherwise confer it', async () => {
      const manager = await staffHolding(MANAGER);
      const retired = await roleWith(['admin.access', 'users.read']);
      await withCookies(app, admin)
        .patch(`/admin/access/roles/${retired}/active`)
        .send({ isActive: false })
        .expect(200);

      const response = await withCookies(app, manager.jar)
        .get('/admin/users/assignable-roles')
        .expect(200);

      const ids = (response.body.data as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(ids).not.toContain(retired);
    });

    it('offers a super_admin every STAFF role, and never the customer role', async () => {
      // A `super_admin` holds every catalogue code EXCEPT the customer-only
      // `storefront.access`, so it can confer every staff role and cannot
      // confer `site`. That is not a gap: `POST /admin/users` creates STAFF
      // accounts and has always refused `site` for exactly this reason, so
      // offering it would be offering something the mutation rejects.
      const custom = await roleWith(['admin.access', 'audit.read']);

      const response = await withCookies(app, admin)
        .get('/admin/users/assignable-roles')
        .expect(200);

      const names = (response.body.data as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(names).toContain('super_admin');
      expect(names).toContain('sale');
      expect(names).not.toContain('site');

      const ids = (response.body.data as Array<{ id: number }>).map(
        (r) => r.id,
      );
      expect(ids).toContain(custom);

      // Built-in roles first, which is what the form renders at the top.
      const first = response.body.data[0] as { isSystem: boolean };
      expect(first.isSystem).toBe(true);
    });
  });

  // =======================================================================
  // 3. The list is a projection of the mutation, not a permission
  // =======================================================================

  describe('asking first grants nothing', () => {
    it('refuses a create that names a role the list withheld', async () => {
      const manager = await staffHolding(MANAGER);
      const powerful = await roleWith([
        'admin.access',
        'orders.read',
        'orders.void',
      ]);

      const response = await withCookies(app, manager.jar)
        .post('/admin/users')
        .send({
          username: username(),
          password: 'Sneaky!Pass1',
          roleIds: [powerful],
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_ESCALATION');
      expect(response.body.details.beyondActorAuthority).toEqual(
        expect.arrayContaining(['orders.void']),
      );
    });

    it('refuses a create that names a DEACTIVATED role, by name', async () => {
      // Without this the account would be created with a role that confers
      // nothing — a silent success, which is worse than a refusal, and one
      // that passes the escalation check trivially because the empty set is a
      // subset of everything.
      const retired = await roleWith(['admin.access', 'users.read']);
      await withCookies(app, admin)
        .patch(`/admin/access/roles/${retired}/active`)
        .send({ isActive: false })
        .expect(200);

      const response = await withCookies(app, admin)
        .post('/admin/users')
        .send({
          username: username(),
          password: 'Inact1ve!Pass',
          roleIds: [retired],
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('ROLE_INACTIVE');
      expect(response.body.details.inactiveRoles).toHaveLength(1);
    });

    it('refuses a ROLE CHANGE that names a deactivated role, with the same rule', async () => {
      // The second caller of the shared module. Creating and re-assigning must
      // agree, or the form is honest on one screen and wrong on the other.
      const target = await createUser(app.dataSource, { roles: [] });
      const retired = await roleWith(['admin.access', 'users.read']);
      await withCookies(app, admin)
        .patch(`/admin/access/roles/${retired}/active`)
        .send({ isActive: false })
        .expect(200);

      const response = await withCookies(app, admin)
        .put(`/admin/access/users/${target.user.id}/roles`)
        .send({ roleIds: [retired] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('ROLE_INACTIVE');
    });

    it('leaves system-role safety exactly as it was', async () => {
      // The new endpoint reads roles; it must not have loosened anything that
      // WRITES them.
      const [systemRole] = await app.dataSource.query<Array<{ id: number }>>(
        `SELECT id FROM roles WHERE name = 'sale'`,
      );

      const rename = await withCookies(app, admin)
        .patch(`/admin/access/roles/${systemRole.id}`)
        .send({ titleFa: 'دست‌کاری‌شده' });
      expect(rename.status).toBe(409);
      expect(rename.body.error).toBe('SYSTEM_ROLE_IMMUTABLE');

      const deactivate = await withCookies(app, admin)
        .patch(`/admin/access/roles/${systemRole.id}/active`)
        .send({ isActive: false });
      expect(deactivate.status).toBe(409);
      expect(deactivate.body.error).toBe('SYSTEM_ROLE_IMMUTABLE');
    });
  });

  // =======================================================================
  // 4. The user-management matrix, capability by capability
  // =======================================================================

  describe('users.create implies no other user-management power', () => {
    /**
     * Each case gives a principal `users.create` and NOTHING else from the
     * `users.*` family, then checks the route that needs a different code.
     * A 403 here is the assertion; a 200 would mean one capability had
     * silently absorbed another.
     */
    let creator: { jar: CookieJar; userId: number };
    let victim: number;

    beforeEach(async () => {
      creator = await staffHolding(['admin.access', 'users.create']);
      const target = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });
      victim = target.user.id;
    });

    it('cannot LIST users (users.read)', async () => {
      const response = await withCookies(app, creator.jar).get('/admin/users');
      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain('users.read');
    });

    it('cannot READ one user (users.read)', async () => {
      const response = await withCookies(app, creator.jar).get(
        `/admin/users/${victim}`,
      );
      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain('users.read');
    });

    it('cannot UPDATE a profile field or a branch (users.update)', async () => {
      const response = await withCookies(app, creator.jar)
        .patch(`/admin/users/${victim}`)
        .send({ username: username() });
      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain(
        'users.update',
      );
    });

    it('cannot RESET a password (users.password.reset)', async () => {
      const response = await withCookies(app, creator.jar)
        .post(`/admin/users/${victim}/password`)
        .send({ temporaryPassword: 'T3mp!Passw0rd' });
      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain(
        'users.password.reset',
      );
    });

    it('cannot DEACTIVATE an account (users.deactivate)', async () => {
      const response = await withCookies(app, creator.jar)
        .patch(`/admin/users/${victim}/active`)
        .send({ isActive: false });
      expect(response.status).toBe(403);
    });

    it('cannot REVOKE sessions (users.sessions.revoke)', async () => {
      const response = await withCookies(app, creator.jar).post(
        `/admin/users/${victim}/revoke-sessions`,
      );
      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain(
        'users.sessions.revoke',
      );
    });

    it('cannot ASSIGN ROLES to an existing user (rbac.manage)', async () => {
      // The one power `users.create` gets near: it may attach roles AT
      // CREATION, under the no-escalation rule. It may not re-assign them
      // afterwards, which is a different authority on a different controller.
      const response = await withCookies(app, creator.jar)
        .put(`/admin/access/users/${victim}/roles`)
        .send({ roleIds: [] });
      expect(response.status).toBe(403);
    });
  });

  describe('the reverse direction: other capabilities do not imply creation', () => {
    it('a user READER cannot create an account', async () => {
      const reader = await staffHolding(['admin.access', 'users.read']);

      const response = await withCookies(app, reader.jar)
        .post('/admin/users')
        .send({
          username: username(),
          password: 'N0tAll0wed!1',
          roleIds: [1],
        });

      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain(
        'users.create',
      );
    });

    it('a DEACTIVATE operator cannot reactivate, and vice versa', async () => {
      // Two separate capabilities chosen by the request body — the case a
      // single `users.setActive` would have collapsed.
      const target = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });
      const off = await staffHolding([
        'admin.access',
        'users.read',
        'users.deactivate',
      ]);
      const on = await staffHolding([
        'admin.access',
        'users.read',
        'users.activate',
      ]);

      // The deactivator may switch it off...
      await withCookies(app, off.jar)
        .patch(`/admin/users/${target.user.id}/active`)
        .send({ isActive: false })
        .expect(200);

      // ...but may not switch it back on.
      const restore = await withCookies(app, off.jar)
        .patch(`/admin/users/${target.user.id}/active`)
        .send({ isActive: true });
      expect(restore.status).toBe(403);

      // The activator is the mirror image.
      await withCookies(app, on.jar)
        .patch(`/admin/users/${target.user.id}/active`)
        .send({ isActive: true })
        .expect(200);
      const retire = await withCookies(app, on.jar)
        .patch(`/admin/users/${target.user.id}/active`)
        .send({ isActive: false });
      expect(retire.status).toBe(403);
    });
  });
});
