import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { Role } from 'src/modules/auth/entities/role.entity';
import {
  RoleErrorCodes,
  RoleMessages,
} from 'src/common/constants/role.messages';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createUser, seedRoles, uniqueSuffix } from './setup/seed-helpers';

/**
 * ===========================================================================
 * ROLE DELETION SAFETY — the two silent lockouts
 * ===========================================================================
 *
 * `user_roles."rolesId"` is declared `ON DELETE CASCADE`. That single line is
 * why `DELETE /roles/{id}` was a lockout button rather than a catalogue edit:
 * `RoleService.removeRole` used to be `getRoleById(id)` followed by
 * `delete(id)`, so deleting the `super_admin` row demoted EVERY administrator,
 * returned 200, and left no trace anywhere — and every route that could put
 * the role back is itself `@Roles(super_admin)`.
 *
 * The second lockout needs no role deletion at all: strip `super_admin` from
 * the last user holding it, by any of the four paths this file exercises, and
 * the same unrecoverable state follows.
 *
 * Every assertion below therefore checks the DATABASE, not just the HTTP
 * status. A 409 that still cascaded, or a "refusal" that had already committed
 * the delete, would pass a status-only test.
 *
 * NOTE ON CUSTOM ROLES. They are inserted through the repository, because
 * **`POST /roles` NO LONGER EXISTS.** It could not succeed:
 * `CreateRoleDto.name` carried `@IsEnum(UserRoleEnum)`, so the only names it
 * accepted were the three built-ins, all of which the seeder creates on
 * bootstrap — every possible request answered 400 `This role already exists`.
 * It also contradicted `DELETE /roles/:id`, which refuses those same three
 * names with 409. Section 0 below pins the resulting public contract. Custom
 * rows in `roles` therefore only arrive out-of-band (seeder, migration, DBA),
 * which is exactly how they are created here — and the refusals that protect
 * them are unchanged.
 */
describe('role deletion safety', () => {
  let app: TestApp;
  /** The acting administrator; also the ONLY one unless a test adds another. */
  let admin: CookieJar;
  let adminUserId: number;
  let roleIds: Map<string, number>;

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

    const seeded = await seedRoles(app.dataSource);
    roleIds = new Map([...seeded].map(([name, role]) => [name, role.id]));

    const created = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    adminUserId = created.user.id;
    admin = await authenticate(app, created.username, created.password);
  });

  // =========================================================================
  // helpers — all of them read the database directly
  // =========================================================================

  async function createCustomRole(): Promise<Role> {
    const repo = app.dataSource.getRepository(Role);
    return repo.save(repo.create({ name: `custom_${uniqueSuffix()}` }));
  }

  async function roleExists(roleId: number): Promise<boolean> {
    const rows = await app.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM roles WHERE id = $1`,
      [roleId],
    );
    return rows.length === 1;
  }

  /** Ids of every user holding `super_admin`, straight out of the join table. */
  async function superAdminHolders(): Promise<number[]> {
    const rows = await app.dataSource.query<Array<{ usersId: number }>>(
      `SELECT ur."usersId"
         FROM user_roles ur
         JOIN roles r ON r.id = ur."rolesId"
        WHERE r.name = $1
        ORDER BY ur."usersId"`,
      [UserRoleEnum.superAdmin],
    );
    return rows.map((row) => Number(row.usersId));
  }

  async function holdsRole(userId: number, roleId: number): Promise<boolean> {
    const rows = await app.dataSource.query<Array<{ usersId: number }>>(
      `SELECT "usersId" FROM user_roles
        WHERE "usersId" = $1 AND "rolesId" = $2`,
      [userId, roleId],
    );
    return rows.length === 1;
  }

  async function assignmentCount(roleId: number): Promise<number> {
    const rows = await app.dataSource.query<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM user_roles WHERE "rolesId" = $1`,
      [roleId],
    );
    return Number(rows[0].count);
  }

  async function isDeactivated(userId: number): Promise<boolean> {
    const rows = await app.dataSource.query<
      Array<{ deactivatedAt: Date | null }>
    >(`SELECT "deactivatedAt" FROM users WHERE id = $1`, [userId]);
    return rows.length === 1 && rows[0].deactivatedAt !== null;
  }

  /** A second administrator, so the invariant is no longer at its floor. */
  async function addSecondAdmin(): Promise<number> {
    const { user } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return user.id;
  }

  // =========================================================================
  // 0. THE PUBLIC ROLE CONTRACT — a fixed, three-value vocabulary
  // =========================================================================

  describe('the role catalogue is fixed', () => {
    it('exposes no role-creation endpoint at all', async () => {
      const response = await withCookies(app, admin)
        .post('/roles')
        .send({ name: 'auditor' });

      // 404 = the route is GONE, not "your body was wrong" and not "that role
      // exists". A frontend must not render a create-role affordance.
      expect(response.status).toBe(404);

      // And nothing was inserted by the attempt.
      const rows: Array<{ name: string }> = await app.dataSource.query(
        `SELECT name FROM roles ORDER BY name`,
      );
      expect(rows.map((r) => r.name).sort()).toEqual(
        [UserRoleEnum.superAdmin, UserRoleEnum.sale, UserRoleEnum.site].sort(),
      );
    });

    it('rejects a built-in name through the retired endpoint too', async () => {
      // The old route's ONLY reachable answer was 400 `ROLE_ALREADY_EXISTS`
      // for exactly these three names. It is now 404 for all of them, so the
      // contradiction with DELETE's 409 `ROLE_BUILTIN_PROTECTED` is gone.
      for (const name of [
        UserRoleEnum.superAdmin,
        UserRoleEnum.sale,
        UserRoleEnum.site,
      ]) {
        const response = await withCookies(app, admin)
          .post('/roles')
          .send({ name });
        expect(response.status).toBe(404);
      }
    });

    it('still serves the catalogue, the assignment routes and the user lookup', async () => {
      const { user } = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });
      const saleRoleId = roleIds.get(UserRoleEnum.sale)!;
      const siteRoleId = roleIds.get(UserRoleEnum.site)!;

      const catalogue = await withCookies(app, admin).get('/roles');
      expect(catalogue.status).toBe(200);
      expect(
        (catalogue.body.data as Array<{ name: string }>)
          .map((r) => r.name)
          .sort(),
      ).toEqual(
        [UserRoleEnum.superAdmin, UserRoleEnum.sale, UserRoleEnum.site].sort(),
      );

      const assign = await withCookies(app, admin)
        .post('/roles/assign')
        .send({ userId: user.id, roleId: siteRoleId });
      expect(assign.status).toBe(201);

      const held = await withCookies(app, admin).get(`/roles/users/${user.id}`);
      expect(held.status).toBe(200);
      expect(
        (held.body.data as Array<{ name: string }>).map((r) => r.name).sort(),
      ).toEqual([UserRoleEnum.sale, UserRoleEnum.site].sort());

      const remove = await withCookies(app, admin)
        .delete('/roles/remove')
        .send({ userId: user.id, roleId: saleRoleId });
      expect(remove.status).toBe(200);
      await expect(holdsRole(user.id, saleRoleId)).resolves.toBe(false);
      await expect(holdsRole(user.id, siteRoleId)).resolves.toBe(true);
    });
  });

  // =========================================================================
  // 1. The three built-in roles are structural and never deletable
  // =========================================================================

  describe('DELETE /roles/:id — built-in roles', () => {
    it.each([UserRoleEnum.superAdmin, UserRoleEnum.sale, UserRoleEnum.site])(
      'refuses to delete the built-in "%s" role with 409 ROLE_BUILTIN_PROTECTED',
      async (name) => {
        const roleId = roleIds.get(name)!;

        const response = await withCookies(app, admin).delete(
          `/roles/${roleId}`,
        );

        expect(response.status).toBe(409);
        expect(response.body.error).toBe(RoleErrorCodes.ROLE_BUILTIN_PROTECTED);
        expect(response.body.message).toBe(RoleMessages.ROLE_BUILTIN_PROTECTED);
        // The name, not the id: the refusal has to be legible in an
        // environment whose ids differ from this one's.
        expect(response.body.details).toEqual({ roleName: name });

        // Nothing was committed before the refusal.
        await expect(roleExists(roleId)).resolves.toBe(true);
      },
    );

    it('leaves the CASCADE lockout closed: the administrator keeps the role', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;
      expect(await superAdminHolders()).toEqual([adminUserId]);

      const response = await withCookies(app, admin).delete(
        `/roles/${superAdminRoleId}`,
      );
      expect(response.status).toBe(409);

      // THE POINT OF THE WHOLE FILE. Before the fix this row was gone —
      // `ON DELETE CASCADE` took it with the role and the response was 200.
      await expect(holdsRole(adminUserId, superAdminRoleId)).resolves.toBe(
        true,
      );
      expect(await superAdminHolders()).toEqual([adminUserId]);

      // And the session is still an administrator's session.
      const stillAdmin = await withCookies(app, admin).get('/roles');
      expect(stillAdmin.status).toBe(200);
    });
  });

  // =========================================================================
  // 2. Custom roles: in use is refused, unused deletes
  // =========================================================================

  describe('DELETE /roles/:id — custom roles', () => {
    it('refuses a custom role that is still assigned, with 409 ROLE_IN_USE and the count', async () => {
      const custom = await createCustomRole();
      const first = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });
      const second = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });

      for (const created of [first, second]) {
        const assigned = await withCookies(app, admin)
          .post('/roles/assign')
          .send({ userId: created.user.id, roleId: custom.id });
        expect(assigned.status).toBe(201);
      }
      expect(await assignmentCount(custom.id)).toBe(2);

      const response = await withCookies(app, admin).delete(
        `/roles/${custom.id}`,
      );

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(RoleErrorCodes.ROLE_IN_USE);
      expect(response.body.details).toEqual({
        roleName: custom.name,
        assignedUserCount: 2,
      });

      // Neither the role nor either assignment was touched.
      await expect(roleExists(custom.id)).resolves.toBe(true);
      expect(await assignmentCount(custom.id)).toBe(2);
      await expect(holdsRole(first.user.id, custom.id)).resolves.toBe(true);
      await expect(holdsRole(second.user.id, custom.id)).resolves.toBe(true);
    });

    it('deletes an unused custom role and the row is really gone', async () => {
      const custom = await createCustomRole();
      expect(await assignmentCount(custom.id)).toBe(0);

      const response = await withCookies(app, admin).delete(
        `/roles/${custom.id}`,
      );

      // The pre-existing success contract is unchanged.
      expect(response.status).toBe(200);
      expect(response.body.message).toBe(RoleMessages.ROLE_DELETED);
      expect(response.body.success).toBe(true);

      await expect(roleExists(custom.id)).resolves.toBe(false);
    });

    it('answers 404, not 409, for a role id that does not exist', async () => {
      const response = await withCookies(app, admin).delete('/roles/987654');
      expect(response.status).toBe(404);
      expect(response.body.message).toBe(RoleMessages.ROLE_NOT_FOUND);
    });

    // -----------------------------------------------------------------------
    // Atomicity. The lock, not the check, is what these two prove.
    // -----------------------------------------------------------------------

    it('never reports success twice when the same role is deleted concurrently', async () => {
      const custom = await createCustomRole();

      const [a, b] = await Promise.all([
        withCookies(app, admin).delete(`/roles/${custom.id}`),
        withCookies(app, admin).delete(`/roles/${custom.id}`),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      // Exactly one winner. The loser blocks on the same `FOR UPDATE`, and
      // when the winner commits Postgres re-evaluates the locked row, finds it
      // deleted, and returns zero rows — hence 404 rather than a second 200.
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses).toEqual([200, 404]);

      await expect(roleExists(custom.id)).resolves.toBe(false);
    });

    it('does not let a concurrent assignment slip between the count and the delete', async () => {
      const custom = await createCustomRole();
      const { user } = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });

      const [assign, remove] = await Promise.all([
        withCookies(app, admin)
          .post('/roles/assign')
          .send({ userId: user.id, roleId: custom.id }),
        withCookies(app, admin).delete(`/roles/${custom.id}`),
      ]);

      const assignOk = assign.status === 201;
      const removeOk = remove.status === 200;

      // One or the other, never both: the assignment holds a SHARE lock on the
      // role row, so the delete either sees the assignment and refuses with
      // ROLE_IN_USE, or commits first and the assignment finds no such role.
      expect(assignOk).not.toBe(removeOk);

      // Whichever way it fell, the database agrees with the answers given.
      if (removeOk) {
        await expect(roleExists(custom.id)).resolves.toBe(false);
        expect(assign.status).toBe(404);
        expect(await assignmentCount(custom.id)).toBe(0);
      } else {
        await expect(roleExists(custom.id)).resolves.toBe(true);
        expect(remove.status).toBe(409);
        expect(remove.body.error).toBe(RoleErrorCodes.ROLE_IN_USE);
        await expect(holdsRole(user.id, custom.id)).resolves.toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. DELETE /roles/remove — the last super_admin assignment
  // =========================================================================

  describe('DELETE /roles/remove — last super_admin', () => {
    it('refuses to strip super_admin from the only user holding it', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;

      const response = await withCookies(app, admin)
        .delete('/roles/remove')
        .send({ userId: adminUserId, roleId: superAdminRoleId });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(RoleErrorCodes.LAST_SUPER_ADMIN);
      expect(response.body.message).toBe(RoleMessages.LAST_SUPER_ADMIN);
      expect(response.body.details).toEqual({
        roleName: UserRoleEnum.superAdmin,
        userId: adminUserId,
      });

      await expect(holdsRole(adminUserId, superAdminRoleId)).resolves.toBe(
        true,
      );
      expect(await superAdminHolders()).toEqual([adminUserId]);
    });

    it('allows the strip once a second administrator exists', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;
      const secondAdminId = await addSecondAdmin();

      const response = await withCookies(app, admin)
        .delete('/roles/remove')
        .send({ userId: adminUserId, roleId: superAdminRoleId });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe(RoleMessages.ROLE_REMOVED);
      expect(await superAdminHolders()).toEqual([secondAdminId]);
    });

    it('still allows a NON-super_admin role to be stripped from the last admin', async () => {
      const saleRoleId = roleIds.get(UserRoleEnum.sale)!;
      const assigned = await withCookies(app, admin)
        .post('/roles/assign')
        .send({ userId: adminUserId, roleId: saleRoleId });
      expect(assigned.status).toBe(201);

      const response = await withCookies(app, admin)
        .delete('/roles/remove')
        .send({ userId: adminUserId, roleId: saleRoleId });

      // The guard is about administrators, not about role removal in general.
      expect(response.status).toBe(200);
      await expect(holdsRole(adminUserId, saleRoleId)).resolves.toBe(false);
      expect(await superAdminHolders()).toEqual([adminUserId]);
    });

    it('cannot be raced into leaving the system with zero administrators', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;
      const secondAdminId = await addSecondAdmin();
      expect(await superAdminHolders()).toHaveLength(2);

      // Both of the last two administrators, stripped at the same instant.
      // A naive `count > 1` check passes in BOTH transactions here — that is
      // the whole point — and both would commit, leaving zero. The
      // `SELECT ... FOR UPDATE` on the super_admin role row serialises them,
      // so the second one counts after the first has committed.
      const [first, second] = await Promise.all([
        withCookies(app, admin)
          .delete('/roles/remove')
          .send({ userId: adminUserId, roleId: superAdminRoleId }),
        withCookies(app, admin)
          .delete('/roles/remove')
          .send({ userId: secondAdminId, roleId: superAdminRoleId }),
      ]);

      const statuses = [first.status, second.status];
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(1);
      const refused = [first, second].find((r) => r.status === 409)!;
      expect(refused.body.error).toBe(RoleErrorCodes.LAST_SUPER_ADMIN);

      // THE INVARIANT, asserted against the join table rather than against a
      // status code: somebody still administers this system.
      const holders = await superAdminHolders();
      expect(holders).toHaveLength(1);
      expect([adminUserId, secondAdminId]).toContain(holders[0]);
    });
  });

  // =========================================================================
  // 4. The other paths that strip a super_admin assignment
  // =========================================================================

  describe('PATCH /users/:id — the role field REPLACES the whole set', () => {
    it('refuses a replacement that drops super_admin from the last admin', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;

      const response = await withCookies(app, admin)
        .patch(`/users/${adminUserId}`)
        .send({ role: [UserRoleEnum.sale] });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(RoleErrorCodes.LAST_SUPER_ADMIN);

      // The whole PATCH rolled back — not just the role part.
      await expect(holdsRole(adminUserId, superAdminRoleId)).resolves.toBe(
        true,
      );
      expect(await superAdminHolders()).toEqual([adminUserId]);
    });

    it('rolls the username change back with it', async () => {
      const before = await app.dataSource.query<Array<{ username: string }>>(
        `SELECT username FROM users WHERE id = $1`,
        [adminUserId],
      );

      const response = await withCookies(app, admin)
        .patch(`/users/${adminUserId}`)
        .send({ username: `renamed_${uniqueSuffix()}`, role: ['sale'] });
      expect(response.status).toBe(409);

      const after = await app.dataSource.query<Array<{ username: string }>>(
        `SELECT username FROM users WHERE id = $1`,
        [adminUserId],
      );
      expect(after[0].username).toBe(before[0].username);
    });

    it('permits the replacement once another administrator exists', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;
      const secondAdminId = await addSecondAdmin();

      const response = await withCookies(app, admin)
        .patch(`/users/${adminUserId}`)
        .send({ role: [UserRoleEnum.sale] });

      expect(response.status).toBe(200);
      await expect(holdsRole(adminUserId, superAdminRoleId)).resolves.toBe(
        false,
      );
      expect(await superAdminHolders()).toEqual([secondAdminId]);
    });

    it('permits a replacement that keeps super_admin', async () => {
      const response = await withCookies(app, admin)
        .patch(`/users/${adminUserId}`)
        .send({ role: [UserRoleEnum.superAdmin, UserRoleEnum.sale] });

      expect(response.status).toBe(200);
      expect(await superAdminHolders()).toEqual([adminUserId]);
    });

    it('cannot be raced into demoting both of the last two administrators', async () => {
      const secondAdminId = await addSecondAdmin();

      const [first, second] = await Promise.all([
        withCookies(app, admin)
          .patch(`/users/${adminUserId}`)
          .send({ role: [UserRoleEnum.sale] }),
        withCookies(app, admin)
          .patch(`/users/${secondAdminId}`)
          .send({ role: [UserRoleEnum.sale] }),
      ]);

      expect(
        [first.status, second.status].filter((s) => s === 200),
      ).toHaveLength(1);
      expect(
        [first.status, second.status].filter((s) => s === 409),
      ).toHaveLength(1);
      expect(await superAdminHolders()).toHaveLength(1);
    });
  });

  describe('deleting or deactivating the last administrator', () => {
    it('refuses DELETE /users/:id when it would hard-delete the last admin', async () => {
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;

      const response = await withCookies(app, admin).delete(
        `/users/${adminUserId}`,
      );

      // `user_roles."usersId"` is ON DELETE CASCADE too, so a hard delete is
      // just as effective a way to remove the last super_admin assignment.
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(RoleErrorCodes.LAST_SUPER_ADMIN);

      const rows = await app.dataSource.query<Array<{ id: number }>>(
        `SELECT id FROM users WHERE id = $1`,
        [adminUserId],
      );
      expect(rows).toHaveLength(1);
      await expect(holdsRole(adminUserId, superAdminRoleId)).resolves.toBe(
        true,
      );
    });

    it('refuses PATCH /users/:id/deactivate for the last admin', async () => {
      const response = await withCookies(app, admin).patch(
        `/users/${adminUserId}/deactivate`,
      );

      // The assignment would survive, but an administrator who cannot log in
      // administers nothing — the lockout is identical.
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(RoleErrorCodes.LAST_SUPER_ADMIN);
      await expect(isDeactivated(adminUserId)).resolves.toBe(false);
    });

    it('permits both once a second administrator exists', async () => {
      const secondAdminId = await addSecondAdmin();

      const deactivated = await withCookies(app, admin).patch(
        `/users/${secondAdminId}/deactivate`,
      );
      expect(deactivated.status).toBe(200);
      await expect(isDeactivated(secondAdminId)).resolves.toBe(true);

      // ...and the remaining admin is now the last ACTIVE one, so stripping
      // them is refused even though a deactivated holder still exists.
      const superAdminRoleId = roleIds.get(UserRoleEnum.superAdmin)!;
      const stripped = await withCookies(app, admin)
        .delete('/roles/remove')
        .send({ userId: adminUserId, roleId: superAdminRoleId });
      expect(stripped.status).toBe(409);
      expect(stripped.body.error).toBe(RoleErrorCodes.LAST_SUPER_ADMIN);
    });

    it('still deletes a non-administrator normally', async () => {
      const { user } = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
      });

      const response = await withCookies(app, admin).delete(
        `/users/${user.id}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.softDeactivated).toBe(false);
      const rows = await app.dataSource.query<Array<{ id: number }>>(
        `SELECT id FROM users WHERE id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
