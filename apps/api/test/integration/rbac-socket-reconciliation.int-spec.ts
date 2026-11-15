/**
 * ===========================================================================
 * RBAC MUTATIONS RECONCILE LIVE SOCKETS — THROUGH THE REAL CALL SITES
 * ===========================================================================
 *
 * WHAT WAS UNTESTED. `RbacService.setRolePermissions` and
 * `RbacService.setRoleActive` each call `RealtimeGateway.reconcileAll` after
 * their transaction commits. The gateway method was covered and the RBAC
 * transaction was covered, but nothing asserted that the two are WIRED — so a
 * deleted line, a reordered `await`, or a reconcile moved inside the
 * transaction would all have passed every suite while leaving a live socket
 * holding a capability the database had just withdrawn.
 *
 * HOW THESE CASES ARE WRITTEN, and why it matters:
 *
 *  - REAL SOCKETS over a bound server. Not `handleConnection` with a fake
 *    socket: the thing being tested is that a real client goes away.
 *  - THE REAL MUTATION over HTTP, as a super-admin, through the same
 *    controller an administrator uses. Calling the service directly would skip
 *    the guards, and calling `reconcileAll` directly would test nothing at all.
 *  - NO `revalidateAll()` BY HAND and NO WAITING FOR THE SWEEP. The periodic
 *    timer is deliberately disarmed under test (`NODE_ENV === 'test'`), so if
 *    the push were missing these cases could not pass by accident.
 *  - NO SLEEPS. Every wait is either the client's own disconnect event or a
 *    bounded poll of server-side room membership.
 */
import { Logger } from '@nestjs/common';

import { AuditService } from 'src/modules/audit/audit.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  POS_AVAILABILITY_EVENT,
  RECONCILIATION_FAILURE_EVENT,
  REVALIDATION_INTERVAL_MS,
  ROOM_STAFF_AVAILABILITY,
  ROOM_SUPER_ADMIN,
  RealtimeGateway,
  STOCK_EVENT,
  branchRoom,
  userRoom,
  type ReconciliationFailure,
} from 'src/modules/realtime/realtime.gateway';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  createBranch,
  createProductWithVariant,
  createUser,
  fixtureRoleName,
} from './setup/seed-helpers';
import {
  attemptRealtime,
  connectRealtime,
  type TestRealtimeClient,
} from './support/realtime-client';

describe('RBAC mutations reconcile live sockets', () => {
  let app: TestApp;
  let gateway: RealtimeGateway;
  let admin: CookieJar;
  let open: TestRealtimeClient[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    gateway = app.app.get(RealtimeGateway);
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
    open = [];

    const su = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    admin = await authenticate(app, su.username, su.password, 'admin');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(open.map((client) => client.close()));
    open = [];
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  /** A custom, ACTIVE role created through the real RBAC endpoint. */
  async function createRole(permissions: string[]): Promise<number> {
    const response = await withCookies(app, admin)
      .post('/admin/access/roles')
      .send({
        name: fixtureRoleName('rec'),
        titleFa: 'نقش آزمایشی هم‌زمان‌سازی',
        permissions,
      });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  /** A staff account holding exactly `roleIds`, optionally bound to a branch. */
  async function staffWithRole(
    roleIds: number[],
    branchId: number | null,
  ): Promise<{ userId: number; username: string; password: string }> {
    const created = await createUser(app.dataSource, {
      roles: [],
      branchId,
    });
    const assign = await withCookies(app, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds });
    expect(assign.status).toBe(200);
    return {
      userId: created.user.id,
      username: created.username,
      password: created.password,
    };
  }

  async function socketFor(
    jar: CookieJar,
    audience: 'storefront' | 'admin' | 'pos',
  ): Promise<TestRealtimeClient> {
    const client = await connectRealtime({
      server: app.server,
      cookie: jar.header(),
      audience,
    });
    open.push(client);
    await awaitRooms(client, 2);
    return client;
  }

  /**
   * Wait until the server has finished joining rooms.
   *
   * `connect` fires while `handleConnection` is still running, so a room
   * assertion made immediately can fail for a reason that has nothing to do
   * with what the case is about. Bounded, observable, no sleep.
   */
  async function awaitRooms(
    client: TestRealtimeClient,
    atLeast: number,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    let seen = 'nothing';
    while (Date.now() < deadline) {
      const rooms = await roomsOf(client);
      if (rooms.length >= atLeast) return;
      seen = JSON.stringify(rooms);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `socket ${client.socket.id ?? '?'} never joined ${atLeast} room(s) (saw ${seen})`,
    );
  }

  const roomsOf = async (client: TestRealtimeClient): Promise<string[]> => {
    const sockets = await gateway.server.fetchSockets();
    const mine = sockets.find((socket) => socket.id === client.socket.id);
    return [...(mine?.rooms ?? [])].filter((room) => room !== client.socket.id);
  };

  /** Is the SERVER still holding a socket with this id? */
  const serverHolds = async (client: TestRealtimeClient): Promise<boolean> => {
    const sockets = await gateway.server.fetchSockets();
    return sockets.some((socket) => socket.id === client.socket.id);
  };

  /**
   * Poll until the server has stopped holding the socket.
   *
   * Used where a case must prove a room set is gone rather than that the
   * connection ended; `waitForDisconnect` is used where the client itself is
   * the observable.
   */
  async function awaitServerRelease(client: TestRealtimeClient): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await serverHolds(client))) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `server still holds socket ${client.socket.id ?? '?'} after 5s`,
    );
  }

  /** Move stock, which is what produces the two staff-only frames. */
  async function moveStock(): Promise<void> {
    const { variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 5, price: 100_000 },
    );
    const response = await withCookies(app, admin)
      .post(`/products/variants/${variant.id}/stock/adjust`)
      .send({ mode: 'set', value: 2, reason: 'reconciliation fixture' });
    // The adjust route answers 201 (it writes a movement row), not 200.
    expect(response.status).toBe(201);
  }

  // =========================================================================
  // A. PERMISSION REMOVAL
  // =========================================================================

  describe('A — removing a permission from a live role', () => {
    it('drops the cashier’s socket promptly, with no manual sweep', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['pos.access', 'pos.sell']);
      const cashier = await staffWithRole([roleId], branch.id);
      const jar = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');

      // The entitlement this role confers, before anything changes.
      expect(await roomsOf(client)).toEqual(
        expect.arrayContaining([
          userRoom(cashier.userId),
          ROOM_STAFF_AVAILABILITY,
          branchRoom(branch.id),
        ]),
      );
      expect(await roomsOf(client)).not.toContain(ROOM_SUPER_ADMIN);

      const disconnected = client.waitForDisconnect(5_000);

      /*
       * THE REAL MUTATION. `permissions` is the complete desired set, so an
       * empty array revokes `pos.access` — and with it the POS audience door
       * this socket was admitted through.
       */
      const revoke = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: [] });
      expect(revoke.status).toBe(200);

      /*
       * NOTHING IS CALLED HERE ON PURPOSE. No `revalidateAll()`, and the
       * periodic timer is disarmed under test — so this disconnect can only
       * have come from the `reconcileAll` that `setRolePermissions` performs
       * after its transaction commits.
       */
      await expect(disconnected).resolves.toBeDefined();
      await awaitServerRelease(client);
    });

    it('leaves the dropped socket in no protected room and sends it no further staff frame', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['pos.access']);
      const cashier = await staffWithRole([roleId], branch.id);
      const jar = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');

      const revoke = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: [] });
      expect(revoke.status).toBe(200);
      await awaitServerRelease(client);

      // Not "fewer rooms" — no rooms, because the server is not holding it.
      expect(await roomsOf(client)).toEqual([]);

      // And a stock movement that every till would normally hear about
      // reaches this one not at all.
      await moveStock();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.allReceived(STOCK_EVENT)).toEqual([]);
      expect(client.allReceived(POS_AVAILABILITY_EVENT)).toEqual([]);
    });

    it('revokes only the affected room when the principal keeps its audience', async () => {
      /*
       * THE SURVIVING CASE, which is the more delicate half of the contract: a
       * delegate who keeps `admin.access` but loses `inventory.read` must stay
       * connected and merely lose the staff availability room. A reconcile
       * that disconnected everybody would pass the case above and fail here.
       */
      const roleId = await createRole(['admin.access', 'inventory.read']);
      const delegate = await staffWithRole([roleId], null);
      const jar = await authenticate(
        app,
        delegate.username,
        delegate.password,
        'admin',
      );
      const client = await socketFor(jar, 'admin');
      expect(await roomsOf(client)).toEqual(
        expect.arrayContaining([
          userRoom(delegate.userId),
          ROOM_STAFF_AVAILABILITY,
        ]),
      );

      const narrow = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: ['admin.access'] });
      expect(narrow.status).toBe(200);

      const deadline = Date.now() + 5_000;
      let rooms = await roomsOf(client);
      while (rooms.includes(ROOM_STAFF_AVAILABILITY) && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
        rooms = await roomsOf(client);
      }

      expect(rooms).not.toContain(ROOM_STAFF_AVAILABILITY);
      expect(rooms).toContain(userRoom(delegate.userId));
      expect(client.connected).toBe(true);
      expect(await serverHolds(client)).toBe(true);
    });
  });

  // =========================================================================
  // B. PERMISSION GRANT
  // =========================================================================

  describe('B — granting a permission', () => {
    it('refuses a POS socket before the grant, and does not retroactively admit it', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['admin.access']);
      const staff = await staffWithRole([roleId], branch.id);

      // The POS LOGIN itself is refused: audience eligibility is decided from
      // effective permissions before any token is minted.
      await expect(
        authenticate(app, staff.username, staff.password, 'pos'),
      ).rejects.toThrow(/Login failed/);

      // And so is a POS HANDSHAKE. This account can obtain an admin session,
      // so it has a real credential — just not one for this surface. The
      // gateway must refuse rather than degrade it to an anonymous socket.
      const adminJar = await authenticate(
        app,
        staff.username,
        staff.password,
        'admin',
      );
      const refused = await attemptRealtime({
        server: app.server,
        cookie: adminJar.header(),
        audience: 'pos',
      });
      expect(refused.connected).toBe(false);

      // Now grant the capability through the real RBAC path.
      const grant = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: ['admin.access', 'pos.access'] });
      expect(grant.status).toBe(200);

      /*
       * THE REFUSED SOCKET STAYS REFUSED. Reconciliation re-decides sockets the
       * server is HOLDING; it does not resurrect a connection that was already
       * closed, and a client that was told no must not silently become
       * authorized without a new handshake.
       */
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(refused.connected).toBe(false);
      await refused.close();
    });

    it('admits a NEW POS login after the grant, with exactly the authorized rooms', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['admin.access']);
      const staff = await staffWithRole([roleId], branch.id);

      const grant = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: ['admin.access', 'pos.access'] });
      expect(grant.status).toBe(200);

      const jar = await authenticate(
        app,
        staff.username,
        staff.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');

      const rooms = await roomsOf(client);
      expect(rooms.sort()).toEqual(
        [
          userRoom(staff.userId),
          ROOM_STAFF_AVAILABILITY,
          branchRoom(branch.id),
        ].sort(),
      );
      // A granted capability is not a promotion: the super-admin room is
      // role-gated and this account is not one.
      expect(rooms).not.toContain(ROOM_SUPER_ADMIN);
    });
  });

  // =========================================================================
  // C. ROLE DEACTIVATION
  // =========================================================================

  describe('C — deactivating the role', () => {
    it('drops the socket immediately after commit and withdraws audience eligibility', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['pos.access', 'pos.sell']);
      const cashier = await staffWithRole([roleId], branch.id);
      const jar = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');
      expect(await roomsOf(client)).toContain(ROOM_STAFF_AVAILABILITY);

      const disconnected = client.waitForDisconnect(5_000);

      /*
       * `PermissionService.resolveEffective` skips INACTIVE roles, so
       * deactivating a role strips every capability it confers without editing
       * a single grant. That makes it as much an authorization change as
       * editing the permission set, and `setRoleActive` reconciles for exactly
       * that reason.
       */
      const deactivate = await withCookies(app, admin)
        .patch(`/admin/access/roles/${roleId}/active`)
        .send({ isActive: false });
      expect(deactivate.status).toBe(200);

      await expect(disconnected).resolves.toBeDefined();
      await awaitServerRelease(client);
      expect(await roomsOf(client)).toEqual([]);

      // The capability is gone for good, not just for the open socket: a fresh
      // POS login is now refused too.
      await expect(
        authenticate(app, cashier.username, cashier.password, 'pos'),
      ).rejects.toThrow(/Login failed/);
    });
  });

  // =========================================================================
  // D. TRANSACTION ROLLBACK
  // =========================================================================

  describe('D — a rolled-back authorization change', () => {
    it('does not reconcile, and leaves the authorized socket exactly as it was', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['pos.access', 'pos.sell']);
      const cashier = await staffWithRole([roleId], branch.id);
      const jar = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');
      const before = (await roomsOf(client)).sort();

      /*
       * FORCE THE ROLLBACK FROM INSIDE THE TRANSACTION.
       *
       * `setRolePermissions` writes the audit row through `AuditService.record`
       * with the transaction's own manager, as its last step before commit. A
       * rejection there is therefore a realistic failure (a constraint, a dead
       * connection) at the latest possible moment — the point where a
       * reconcile placed one line too early would already have fired.
       */
      const audit = app.app.get(AuditService);
      const recordSpy = jest
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('simulated audit write failure'));
      const reconcileSpy = jest.spyOn(gateway, 'reconcileAll');

      const attempt = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: [] });

      // The request failed...
      expect(attempt.status).toBeGreaterThanOrEqual(500);
      expect(recordSpy).toHaveBeenCalledTimes(1);

      // ...nothing was reconciled, because nothing committed...
      expect(reconcileSpy).not.toHaveBeenCalled();

      // ...the grants are untouched in the database...
      const grants: Array<{ code: string }> = await app.dataSource.query(
        `SELECT p.code AS code
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp."permissionId"
          WHERE rp."roleId" = $1
          ORDER BY p.code ASC`,
        [roleId],
      );
      expect(grants.map((row) => row.code)).toEqual(['pos.access', 'pos.sell']);

      // ...and the socket is still connected, in the same rooms, because the
      // authorization it depends on never changed.
      expect(client.connected).toBe(true);
      expect(await serverHolds(client)).toBe(true);
      expect((await roomsOf(client)).sort()).toEqual(before);
      expect(branch.id).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // E. UNRELATED USERS
  // =========================================================================

  describe('E — principals whose authorization did not change', () => {
    it('keeps an unrelated cashier connected, with the same room set', async () => {
      const branchA = await createBranch(app.dataSource);
      const branchB = await createBranch(app.dataSource);
      const roleA = await createRole(['pos.access', 'pos.sell']);
      const roleB = await createRole(['pos.access', 'pos.sell']);
      const cashierA = await staffWithRole([roleA], branchA.id);
      const cashierB = await staffWithRole([roleB], branchB.id);

      const jarA = await authenticate(
        app,
        cashierA.username,
        cashierA.password,
        'pos',
      );
      const jarB = await authenticate(
        app,
        cashierB.username,
        cashierB.password,
        'pos',
      );
      const clientA = await socketFor(jarA, 'pos');
      const clientB = await socketFor(jarB, 'pos');
      const roomsBBefore = (await roomsOf(clientB)).sort();

      const disconnectedA = clientA.waitForDisconnect(5_000);

      // Change role A only. `reconcileAll` re-decides EVERY socket — which is
      // the safe choice, and exactly why "does it disconnect the wrong people?"
      // has to be asserted rather than assumed.
      const revoke = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleA}/permissions`)
        .send({ permissions: [] });
      expect(revoke.status).toBe(200);

      await expect(disconnectedA).resolves.toBeDefined();

      // B was re-evaluated and survived unchanged: same connection, same rooms.
      expect(clientB.connected).toBe(true);
      expect(await serverHolds(clientB)).toBe(true);
      expect((await roomsOf(clientB)).sort()).toEqual(roomsBBefore);
      expect(roomsBBefore).toContain(branchRoom(branchB.id));
      expect(roomsBBefore).toContain(ROOM_STAFF_AVAILABILITY);

      // ...and it still receives the staff frames it is entitled to.
      await moveStock();
      await expect(
        clientB.next(POS_AVAILABILITY_EVENT, 5_000),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // F. FAILURE OF THE IMMEDIATE PUSH  (the sweep is the backstop)
  // =========================================================================

  describe('F — when the immediate reconciliation fails', () => {
    it('reports a structured error and lets the next sweep correct it', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['pos.access', 'pos.sell']);
      const cashier = await staffWithRole([roleId], branch.id);
      const jar = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');
      expect(await roomsOf(client)).toContain(ROOM_STAFF_AVAILABILITY);

      /*
       * BREAK THE ENUMERATION ONCE.
       *
       * `reconcileAll` -> `revalidateAll` -> `server.fetchSockets()`. Failing
       * that call is the realistic shape of the failure this must survive (an
       * adapter or transport fault), and it is the one place where the
       * committed RBAC change can silently fail to reach a live socket.
       */
      const logger = (gateway as unknown as { logger: Logger }).logger;
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const fetchSpy = jest
        .spyOn(gateway.server, 'fetchSockets')
        .mockRejectedValueOnce(new Error('simulated adapter failure'));

      const revoke = await withCookies(app, admin)
        .put(`/admin/access/roles/${roleId}/permissions`)
        .send({ permissions: [] });

      /*
       * THE MUTATION STILL SUCCEEDS. This is deliberate and must not regress:
       * a failure to push must never roll back an authorization change that
       * committed. The change is the safe half; the stale socket is the
       * temporary exposure, bounded by the sweep.
       */
      expect(revoke.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();

      // A STRUCTURED, OPERATIONS-READY SIGNAL — not silence, and not a
      // sentence an alert would have to pattern-match.
      const failures = errorSpy.mock.calls
        .map(([first]) => {
          try {
            return JSON.parse(String(first)) as ReconciliationFailure;
          } catch {
            return null;
          }
        })
        .filter(
          (parsed): parsed is ReconciliationFailure =>
            parsed?.event === RECONCILIATION_FAILURE_EVENT,
        );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        scope: 'all',
        stage: 'enumerate',
        reason: 'role permissions changed',
        examined: 0,
        failed: 1,
        backstopWithinMs: REVALIDATION_INTERVAL_MS,
      });
      expect(failures[0].error).toContain('simulated adapter failure');

      // NO CREDENTIAL MATERIAL. The payload names a user id and an audience;
      // it never reaches for the handshake, and `safeErrorText` redacts the
      // two shapes that could carry one if a library echoed a request back.
      const serialised = JSON.stringify(failures[0]);
      expect(serialised).not.toContain('kz_');
      expect(serialised).not.toContain('eyJ');
      expect(serialised).not.toContain('Cookie');
      expect(serialised).not.toContain('password');

      // The socket survived the failed push, still holding a room the database
      // no longer entitles it to. That is the exposure being bounded.
      expect(await serverHolds(client)).toBe(true);
      expect(await roomsOf(client)).toContain(ROOM_STAFF_AVAILABILITY);

      /*
       * THE BACKSTOP. In production this runs on a timer every
       * REVALIDATION_INTERVAL_MS; under test the timer is disarmed and the
       * sweep is driven directly, which exercises the same code path
       * deterministically. It is the bound on the exposure window above.
       */
      const disconnected = client.waitForDisconnect(5_000);
      await gateway.revalidateAll();
      await expect(disconnected).resolves.toBeDefined();
      await awaitServerRelease(client);
    });

    it('reports a per-socket failure and fails CLOSED', async () => {
      const branch = await createBranch(app.dataSource);
      const roleId = await createRole(['pos.access', 'pos.sell']);
      const cashier = await staffWithRole([roleId], branch.id);
      const jar = await authenticate(
        app,
        cashier.username,
        cashier.password,
        'pos',
      );
      const client = await socketFor(jar, 'pos');

      /*
       * The other failure stage: enumeration works, re-deciding ONE socket
       * throws. `revalidateSocket` re-reads the principal from the database,
       * so a failure there means we could not establish that this socket is
       * still entitled — and the only safe answer to that is to close it.
       */
      const logger = (gateway as unknown as { logger: Logger }).logger;
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const loadSpy = jest
        .spyOn(
          gateway as unknown as {
            loadUser: (id: number) => Promise<unknown>;
          },
          'loadUser',
        )
        .mockRejectedValueOnce(new Error('simulated principal read failure'));

      const disconnected = client.waitForDisconnect(5_000);
      await gateway.reconcileUser(
        cashier.userId,
        'integration: forced failure',
      );

      await expect(disconnected).resolves.toBeDefined();
      expect(loadSpy).toHaveBeenCalled();

      const failures = errorSpy.mock.calls
        .map(([first]) => {
          try {
            return JSON.parse(String(first)) as ReconciliationFailure;
          } catch {
            return null;
          }
        })
        .filter(
          (parsed): parsed is ReconciliationFailure =>
            parsed?.event === RECONCILIATION_FAILURE_EVENT,
        );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        scope: 'user',
        stage: 'socket',
        userId: cashier.userId,
        audience: 'pos',
        examined: 1,
        failed: 1,
        backstopWithinMs: REVALIDATION_INTERVAL_MS,
      });
      expect(JSON.stringify(failures[0])).not.toContain('eyJ');
    });
  });
});
