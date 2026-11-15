import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { Role } from 'src/modules/auth/entities/role.entity';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import {
  AdminUserKindFilter,
  AdminUserQueryDto,
  AdminUserStatusFilter,
} from './dto/admin-user-query.dto';
import {
  CreateStaffUserDto,
  ResetUserPasswordDto,
  UpdateStaffUserDto,
} from './dto/admin-user.dto';
import {
  UserErrorCodes,
  UserMessages,
} from 'src/common/constants/user.messages';
import {
  RoleMessages,
  RoleErrorCodes,
} from 'src/common/constants/role.messages';
import { BranchMessages } from 'src/common/constants/branch.messages';
import { PermissionService } from 'src/modules/auth/permissions/permission.service';
import {
  isSystemRoleName,
  systemRolePermissions,
} from 'src/modules/auth/permissions/system-roles';
import { assertSuperAdminSurvives } from 'src/modules/auth/services/role-safety';
import {
  AssignableRoleView,
  assertRolesActive,
  isAssignable,
  toAssignableRoleView,
} from 'src/modules/auth/services/assignable-roles';
import { AuditService, AuditActor } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { ForbiddenException } from '@nestjs/common';
import { RefreshToken } from 'src/modules/auth/entities/refresh-token.entity';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

export interface AdminRoleRef {
  id: number;
  name: string;
  titleFa: string;
  isSystem: boolean;
  isActive: boolean;
}

export interface AdminUserRow {
  id: number;
  username: string | null;
  mobile: string | null;
  identifier: string;
  isStaff: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  branchId: number | null;
  branchName: string | null;
  branchIsActive: boolean | null;
  roles: AdminRoleRef[];
  /**
   * Which surfaces this account can currently open a session on, derived from
   * effective permissions exactly the way login derives it. This is the answer
   * to "can this cashier actually log into the till right now".
   */
  canAccess: { storefront: boolean; admin: boolean; pos: boolean };
  activeSessionCount: number;
  createdAt: Date;
}

export interface AdminUserDetail extends AdminUserRow {
  permissions: string[];
  sessionsByAudience: Record<string, number>;
  /** POS sales rung up by this user. Bounds the "can this be deleted" answer. */
  salesCount: number;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
}

interface RawUserRow {
  id: number;
  username: string | null;
  mobile: string | null;
  branchId: number | null;
  branchName: string | null;
  branchIsActive: boolean | null;
  deactivatedAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  activeSessionCount: string;
  roles: AdminRoleRef[] | null;
}

/**
 * ===========================================================================
 * STAFF ADMINISTRATION
 * ===========================================================================
 *
 * WHAT THIS NEVER RETURNS, at any depth, on any route: `users.password`,
 * `refresh_tokens.tokenHash`, any JWT, any OTP challenge, any secret. Every
 * projection below is an explicit column list for that reason — a
 * `SELECT u.*` or an entity return would leak the password hash the first time
 * somebody added a route.
 *
 * The lifecycle rules it enforces, and why each one exists:
 *
 *  - DEACTIVATION REVOKES SESSIONS. `users.deactivatedAt` stops NEW logins,
 *    and `JwtStrategy` refuses a deactivated principal on every request — but
 *    the refresh tokens would otherwise sit there valid, so a reactivation
 *    would silently resurrect month-old sessions. Deactivating therefore
 *    revokes every refresh token in the same transaction.
 *  - THE LAST USABLE ADMINISTRATOR IS PROTECTED, through the same
 *    `assertSuperAdminSurvives` census the role paths use, holding the
 *    `super_admin` row FOR UPDATE.
 *  - NO ESCALATION. Creating a user with a role confers everything that role
 *    grants, so the actor must hold it all — the same rule `RbacService`
 *    applies to granting.
 *  - NO HARD DELETE. There is no delete route here at all. `orders.cashierUserId`
 *    is ON DELETE RESTRICT and `stock_movements.actorUserId` / audit rows
 *    reference staff; retiring somebody is deactivation, which keeps every
 *    attribution intact.
 */
@Injectable()
export class AdminUserService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly permissionService: PermissionService,
    private readonly audit: AuditService,

    /**
     * Ending a session has to reach the websocket as well as the refresh rows.
     * Used post-commit only — see {@link AdminUserService.revokeSessions}.
     */
    private readonly realtime: RealtimeGateway,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async list(query: AdminUserQueryDto): Promise<{
    data: AdminUserRow[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      params.push(`%${query.search.toLowerCase()}%`);
      where.push(
        `(LOWER(COALESCE(u."username", '')) LIKE $${params.length} OR ` +
          `COALESCE(u."mobile", '') LIKE $${params.length})`,
      );
    }
    if (query.roleId !== undefined) {
      params.push(query.roleId);
      where.push(
        `EXISTS (SELECT 1 FROM "user_roles" ur2 WHERE ur2."usersId" = u."id" AND ur2."rolesId" = $${params.length})`,
      );
    }
    if (query.branchId !== undefined) {
      params.push(query.branchId);
      where.push(`u."branchId" = $${params.length}`);
    }
    if (query.status === AdminUserStatusFilter.ACTIVE) {
      where.push(`u."deactivatedAt" IS NULL`);
    } else if (query.status === AdminUserStatusFilter.DEACTIVATED) {
      where.push(`u."deactivatedAt" IS NOT NULL`);
    }
    if (query.kind === AdminUserKindFilter.STAFF) {
      where.push(`u."username" IS NOT NULL`);
    } else if (query.kind === AdminUserKindFilter.CUSTOMER) {
      where.push(`u."username" IS NULL`);
    }

    const predicate = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "users" u ${predicate}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    // ONE query for the page, roles included. `json_agg ... FILTER` keeps a
    // user with no roles as `[]` rather than `[null]`, which a naive
    // `json_agg` over a LEFT JOIN produces and which then crashes the mapper.
    const rows = await this.dataSource.query<RawUserRow[]>(
      `SELECT u."id", u."username", u."mobile", u."branchId",
              b."name" AS "branchName", b."isActive" AS "branchIsActive",
              u."deactivatedAt", u."mustChangePassword", u."createdAt",
              (SELECT COUNT(*)::text FROM "refresh_tokens" rt
                WHERE rt."userId" = u."id" AND rt."revoked" = false
                  AND rt."expiresAt" > now()) AS "activeSessionCount",
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', r."id", 'name', r."name",
                    'titleFa', COALESCE(r."titleFa", r."name"),
                    'isSystem', r."isSystem", 'isActive', r."isActive"
                  ) ORDER BY r."id"
                ) FILTER (WHERE r."id" IS NOT NULL),
                '[]'
              ) AS roles
         FROM "users" u
         LEFT JOIN "branches" b ON b."id" = u."branchId"
         LEFT JOIN "user_roles" ur ON ur."usersId" = u."id"
         LEFT JOIN "roles" r ON r."id" = ur."rolesId"
         ${predicate}
        GROUP BY u."id", b."name", b."isActive"
        ORDER BY u."deactivatedAt" NULLS FIRST, u."id" ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, (query.page - 1) * query.limit],
    );

    const data = await this.decorate(rows);
    return {
      data,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    };
  }

  async detail(id: number): Promise<AdminUserDetail> {
    const rows = await this.dataSource.query<RawUserRow[]>(
      `SELECT u."id", u."username", u."mobile", u."branchId",
              b."name" AS "branchName", b."isActive" AS "branchIsActive",
              u."deactivatedAt", u."mustChangePassword", u."createdAt",
              (SELECT COUNT(*)::text FROM "refresh_tokens" rt
                WHERE rt."userId" = u."id" AND rt."revoked" = false
                  AND rt."expiresAt" > now()) AS "activeSessionCount",
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', r."id", 'name', r."name",
                    'titleFa', COALESCE(r."titleFa", r."name"),
                    'isSystem', r."isSystem", 'isActive', r."isActive"
                  ) ORDER BY r."id"
                ) FILTER (WHERE r."id" IS NOT NULL),
                '[]'
              ) AS roles
         FROM "users" u
         LEFT JOIN "branches" b ON b."id" = u."branchId"
         LEFT JOIN "user_roles" ur ON ur."usersId" = u."id"
         LEFT JOIN "roles" r ON r."id" = ur."rolesId"
        WHERE u."id" = $1
        GROUP BY u."id", b."name", b."isActive"`,
      [id],
    );
    if (rows.length === 0) {
      throw new NotFoundException(UserMessages.USER_NOT_FOUND);
    }

    const [row] = await this.decorate(rows);
    const raw = rows[0];

    const sessions = await this.dataSource.query<
      Array<{ audience: string; count: string }>
    >(
      `SELECT "audience", COUNT(*)::text AS count
         FROM "refresh_tokens"
        WHERE "userId" = $1 AND "revoked" = false AND "expiresAt" > now()
        GROUP BY "audience"`,
      [id],
    );

    const sales = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "orders" WHERE "cashierUserId" = $1`,
      [id],
    );

    const lifecycle = await this.dataSource.query<
      Array<{ passwordChangedAt: Date | null }>
    >(`SELECT "passwordChangedAt" FROM "users" WHERE "id" = $1`, [id]);

    const permissions = await this.effectivePermissions(raw.roles ?? []);

    return {
      ...row,
      permissions: [...permissions].sort(),
      sessionsByAudience: Object.fromEntries(
        sessions.map((s) => [s.audience, Number(s.count)]),
      ),
      salesCount: Number(sales[0]?.count ?? 0),
      passwordChangedAt: lifecycle[0]?.passwordChangedAt ?? null,
      deactivatedAt: raw.deactivatedAt,
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(
    dto: CreateStaffUserDto,
    actor: AuditActor,
    actorPermissions: readonly string[],
  ): Promise<AdminUserDetail> {
    // Hashed BEFORE the transaction: bcrypt at cost 10 is ~100ms of CPU and
    // holding a lock across it serialises unrelated staff edits behind it.
    const hashed = await bcrypt.hash(dto.password, 10);

    const id = await this.dataSource.transaction(async (manager) => {
      const roles = await this.loadRoles(manager, dto.roleIds);
      await this.assertNoEscalation(manager, roles, actorPermissions);

      await this.assertUsernameFree(manager, dto.username, null);
      if (dto.mobile) {
        await this.assertMobileFree(manager, dto.mobile, null);
      }

      const branch = await this.resolveBranch(manager, dto.branchId ?? null);

      const user = await manager.getRepository(User).save(
        manager.getRepository(User).create({
          username: dto.username,
          password: hashed,
          mobile: dto.mobile ?? undefined,
          branch,
          roles,
          // Default TRUE: a password somebody else chose is a temporary
          // credential by definition, and the administrator has to be able to
          // opt out explicitly rather than by accident.
          mustChangePassword: dto.mustChangePassword !== false,
          passwordChangedAt: new Date(),
        }),
      );

      await this.audit.record(
        {
          actor,
          action: AuditAction.USER_CREATED,
          targetType: AuditTarget.USER,
          targetId: user.id,
          targetLabel: dto.username,
          summary: {
            after: {
              username: dto.username,
              mobile: dto.mobile ?? null,
              branchId: branch?.id ?? null,
              roles: roles.map((role) => role.name).sort(),
              mustChangePassword: dto.mustChangePassword !== false,
            },
          },
        },
        manager,
      );

      return user.id;
    });

    return this.detail(id);
  }

  async update(
    id: number,
    dto: UpdateStaffUserDto,
    actor: AuditActor,
  ): Promise<AdminUserDetail> {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id } });
      if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

      const before = {
        username: user.username ?? null,
        mobile: user.mobile ?? null,
        branchId: user.branchId ?? null,
      };

      if (dto.username !== undefined && dto.username !== user.username) {
        await this.assertUsernameFree(manager, dto.username, id);
        user.username = dto.username;
      }
      if (dto.mobile !== undefined) {
        if (dto.mobile === null) {
          user.mobile = null as unknown as string;
        } else if (dto.mobile !== user.mobile) {
          await this.assertMobileFree(manager, dto.mobile, id);
          user.mobile = dto.mobile;
        }
      }
      if (dto.branchId !== undefined) {
        user.branch = await this.resolveBranch(manager, dto.branchId);
        user.branchId = dto.branchId ?? (null as unknown as number);
      }

      await manager.getRepository(User).save(user);

      const after = {
        username: user.username ?? null,
        mobile: user.mobile ?? null,
        branchId: user.branchId ?? null,
      };

      await this.audit.record(
        {
          actor,
          action: AuditAction.USER_UPDATED,
          targetType: AuditTarget.USER,
          targetId: id,
          targetLabel: after.username ?? after.mobile ?? `user#${id}`,
          summary: { before, after },
        },
        manager,
      );

      if (before.branchId !== after.branchId) {
        // Recorded separately as well: "who moved this cashier to that shop"
        // is a question asked on its own, and burying it inside a generic
        // update row makes it unsearchable.
        await this.audit.record(
          {
            actor,
            action: AuditAction.USER_BRANCH_CHANGED,
            targetType: AuditTarget.USER,
            targetId: id,
            targetLabel: after.username ?? `user#${id}`,
            summary: {
              before: { branchId: before.branchId },
              after: { branchId: after.branchId },
            },
          },
          manager,
        );
      }
    });

    /*
     * Post-commit socket reconciliation. A staff edit can change the branch
     * posting or the role set, and a live socket's branch room was granted by
     * the posting it had at handshake — so moving a cashier between shops used
     * to leave them in their OLD branch room, receiving the wrong counter's
     * traffic, until the next sweep. `reconcileUser` recomputes rooms from the
     * database and leaves the stale one.
     */
    await this.realtime.reconcileUser(id, 'staff account updated');

    return this.detail(id);
  }

  /**
   * Deactivation, and the session revocation that must come with it.
   *
   * `users.deactivatedAt` alone stops new logins and is re-checked on every
   * request, but the refresh tokens would survive — so a later reactivation
   * would silently bring month-old sessions back to life. Both happen in one
   * transaction.
   */
  async setActive(
    id: number,
    isActive: boolean,
    actor: AuditActor,
  ): Promise<AdminUserDetail> {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { id },
        relations: { roles: true },
      });
      if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

      const currentlyActive = !user.deactivatedAt;
      if (currentlyActive === isActive) return;

      if (!isActive) {
        // The administrator invariant: an administrator who cannot
        // authenticate is not an administrator.
        await assertSuperAdminSurvives(manager, user.id, 'access-revoked');
      }

      user.deactivatedAt = isActive ? null : new Date();
      await manager.getRepository(User).save(user);

      let revoked = 0;
      if (!isActive) {
        revoked = await revokeActiveSessions(manager, id);
      }

      await this.audit.record(
        {
          actor,
          action: isActive
            ? AuditAction.USER_ACTIVATED
            : AuditAction.USER_DEACTIVATED,
          targetType: AuditTarget.USER,
          targetId: id,
          targetLabel: user.identifier,
          summary: { after: { isActive }, sessionsRevoked: revoked },
        },
        manager,
      );
    });

    /*
     * Post-commit. `UserService.deactivate` has always done this; this path —
     * the one the admin console actually calls — did not, so deactivating a
     * user from the users screen revoked their refresh rows and left their
     * live socket streaming until the next sweep. Two paths to the same
     * outcome, one of them with a sixty-second hole.
     *
     * Only on deactivation: reactivating an account has no socket to close.
     */
    if (!isActive) {
      await this.realtime.disconnectUser(
        id,
        'user deactivated by administrator',
      );
    }

    return this.detail(id);
  }

  async revokeSessions(
    id: number,
    actor: AuditActor,
  ): Promise<{ revoked: number }> {
    const result = await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id } });
      if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

      const revoked = await revokeActiveSessions(manager, id);

      await this.audit.record(
        {
          actor,
          action: AuditAction.USER_SESSIONS_REVOKED,
          targetType: AuditTarget.USER,
          targetId: id,
          targetLabel: user.identifier,
          summary: { sessionsRevoked: revoked },
        },
        manager,
      );

      return { revoked };
    });

    /*
     * OUTSIDE THE TRANSACTION, ON PURPOSE.
     *
     * Same post-commit rule as every other realtime side effect here: a
     * revocation that rolls back must not disconnect anybody. The `await` on
     * the transaction above is the commit boundary, so nothing below it can
     * observe uncommitted state.
     *
     * Revoking the refresh rows does not end a live websocket — the account is
     * still active and its password epoch has not moved, so the gateway's
     * re-validation sweep finds nothing wrong with the socket. An administrator
     * revoking a compromised account's sessions means "get them off", and this
     * is the half that reaches the socket.
     */
    await this.realtime.disconnectUser(id, 'sessions revoked by administrator');

    return result;
  }

  /**
   * ADMINISTRATOR-SET TEMPORARY PASSWORD.
   *
   * The system never generates and displays a password. A generated credential
   * rendered in a browser tab ends up in a screenshot, in scrollback, and in
   * whatever the administrator pastes it into; one the administrator types is
   * something they already control the handover of. Either way the value is
   * live for exactly one sign-in: `mustChangePassword` is set, and every route
   * except introspection, rotation, sign-out and the change itself answers
   * 403 until it is replaced.
   *
   * The existing password is never shown, and cannot be: the column holds a
   * bcrypt hash.
   */
  async resetPassword(
    id: number,
    dto: ResetUserPasswordDto,
    actor: AuditActor,
  ): Promise<{ revoked: number }> {
    const hashed = await bcrypt.hash(dto.temporaryPassword, 10);

    const result = await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id } });
      if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

      if (!user.username) {
        throw new BadRequestException({
          error: UserErrorCodes.NOT_A_STAFF_ACCOUNT,
          message: UserMessages.NOT_A_STAFF_ACCOUNT,
          userId: id,
        });
      }

      /*
       * THE EPOCH MOVES IN THE SAME STATEMENT AS THE PASSWORD.
       *
       * `"passwordVersion" + 1` is arithmetic PostgreSQL performs under this
       * row's lock. Computing it in JavaScript would make it a read, a gap and
       * a write: two administrators resetting the same account at the same
       * moment would both read 4 and both write 5, and the second reset would
       * then be unable to invalidate the session the first had already issued
       * under version 5.
       */
      await manager.query(
        `UPDATE "users"
            SET "password" = $2,
                "passwordChangedAt" = now(),
                "mustChangePassword" = true,
                "passwordVersion" = "passwordVersion" + 1
          WHERE "id" = $1`,
        [id, hashed],
      );

      // The version bump already invalidates every ACCESS token from the old
      // epoch and blocks rotation of every refresh token from it. Revoking the
      // rows as well makes the kill explicit rather than implied, and makes
      // `activeSessionCount` tell the truth immediately. Same transaction, so
      // there is no instant at which the password has changed and the old
      // sessions are still counted as live.
      const revoked = await revokeActiveSessions(manager, id);

      await this.audit.record(
        {
          actor,
          action: AuditAction.USER_PASSWORD_RESET,
          targetType: AuditTarget.USER,
          targetId: id,
          targetLabel: user.identifier,
          // NO PASSWORD, hashed or otherwise. `AuditService.redact` would drop
          // it anyway; not putting it here is the first line of that defence.
          summary: { sessionsRevoked: revoked, mustChangePassword: true },
        },
        manager,
      );

      return { revoked };
    });

    /*
     * Post-commit, like every other realtime side effect here.
     *
     * The epoch bump above means the sweep WOULD eventually drop these
     * sockets — but "eventually" is up to a full 60-second interval, and an
     * administrator resetting the password on a compromised staff account is
     * not asking for it to keep receiving order and stock frames for another
     * minute. This closes that window; the sweep stays as the backstop for
     * anything that reaches the database by another route.
     */
    await this.realtime.disconnectUser(id, 'password reset by administrator');

    return result;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Attaches effective permissions and surface access to a page of rows using
   * ONE extra query for every custom role on the page — never one per user.
   */
  private async decorate(rows: RawUserRow[]): Promise<AdminUserRow[]> {
    const customRoleIds = new Set<number>();
    for (const row of rows) {
      for (const role of row.roles ?? []) {
        if (!isSystemRoleName(role.name) && role.isActive !== false) {
          customRoleIds.add(Number(role.id));
        }
      }
    }
    const customGrants = await this.permissionService.permissionsByRoleIds([
      ...customRoleIds,
    ]);

    return rows.map((row) => {
      const permissions = this.expand(row.roles ?? [], customGrants);
      return {
        id: Number(row.id),
        username: row.username,
        mobile: row.mobile,
        identifier: row.username ?? row.mobile ?? `user#${row.id}`,
        isStaff: row.username !== null,
        isActive: row.deactivatedAt === null,
        mustChangePassword: row.mustChangePassword === true,
        branchId: row.branchId === null ? null : Number(row.branchId),
        branchName: row.branchName,
        branchIsActive: row.branchIsActive,
        roles: (row.roles ?? []).map((role) => ({
          id: Number(role.id),
          name: role.name,
          titleFa: role.titleFa,
          isSystem: isSystemRoleName(role.name),
          isActive: role.isActive !== false,
        })),
        canAccess: {
          storefront: permissions.has('storefront.access'),
          admin: permissions.has('admin.access'),
          pos: permissions.has('pos.access'),
        },
        activeSessionCount: Number(row.activeSessionCount ?? 0),
        createdAt: row.createdAt,
      };
    });
  }

  private expand(
    roles: readonly AdminRoleRef[],
    customGrants: Map<number, string[]>,
  ): Set<string> {
    const codes = new Set<string>();
    for (const role of roles) {
      if (role.isActive === false) continue;
      const builtIn = systemRolePermissions(role.name);
      if (builtIn) {
        for (const code of builtIn) codes.add(code);
        continue;
      }
      for (const code of customGrants.get(Number(role.id)) ?? []) {
        codes.add(code);
      }
    }
    return codes;
  }

  private async effectivePermissions(
    roles: readonly AdminRoleRef[],
  ): Promise<Set<string>> {
    const customRoleIds = roles
      .filter((role) => !isSystemRoleName(role.name) && role.isActive !== false)
      .map((role) => Number(role.id));
    const grants =
      await this.permissionService.permissionsByRoleIds(customRoleIds);
    return this.expand(roles, grants);
  }

  private async loadRoles(
    manager: EntityManager,
    roleIds: readonly number[],
  ): Promise<Role[]> {
    const roles = await manager
      .getRepository(Role)
      .createQueryBuilder('role')
      .where('role.id IN (:...ids)', { ids: [...roleIds] })
      .getMany();
    if (roles.length !== roleIds.length) {
      throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
    }
    // A deactivated role confers NOTHING — `resolveEffective` skips it — so
    // assigning one silently produces an account with no capabilities while
    // passing the escalation check trivially (the empty set is a subset of
    // everything). Refused by name. See `assignable-roles.ts`.
    assertRolesActive(roles);
    return roles;
  }

  // =====================================================================
  // ASSIGNABLE ROLES — what a user form may offer, without `rbac.read`
  // =====================================================================

  /**
   * The roles this principal could actually confer, as the reduced view a user
   * form needs.
   *
   * WHY THIS ENDPOINT EXISTS. The create-user form needs a role to submit, and
   * the only list of roles was `GET /admin/access/roles`, which is gated on
   * `rbac.read`. So a delegated user manager holding `users.create` could open
   * the form and never complete it, and the obvious workaround — granting them
   * `rbac.read` — hands them the whole access-control catalogue, every custom
   * role and every user's effective permissions, as an accidental dependency
   * of being allowed to hire a cashier. Capability creep by form layout.
   *
   * WHAT IT DOES NOT WEAKEN. The answer is computed with exactly the rule the
   * MUTATIONS apply, from the same module, so this is not a second opinion: it
   * is the same opinion, asked earlier. An operator can no more escalate
   * through this list than they could by guessing role ids, because the list
   * is a projection of what `POST /admin/users` and
   * `PUT /admin/access/users/:id/roles` would accept — and both of them
   * re-check on the way in rather than trusting that the client asked first.
   */
  async listAssignableRoles(
    actorPermissions: readonly string[],
  ): Promise<AssignableRoleView[]> {
    const held = new Set(actorPermissions);

    // ACTIVE ONLY, in the query. An inactive role is not merely unassignable
    // (rule 2 in `assignable-roles.ts`); it must not appear in the response at
    // all, or the endpoint becomes a way to enumerate switched-off roles.
    const roles = await this.dataSource
      .getRepository(Role)
      .createQueryBuilder('role')
      .where('role.isActive = :active', { active: true })
      .orderBy('role.isSystem', 'DESC')
      .addOrderBy('role.id', 'ASC')
      .getMany();

    // ONE batched query for every custom role's grants, rather than one per
    // role: `permissionsByRoleIds` exists precisely to keep this off the N+1
    // path. Built-in roles cost no query at all — their sets live in code.
    const customRoleIds = roles
      .filter((role) => !isSystemRoleName(role.name))
      .map((role) => role.id);
    const grants =
      await this.permissionService.permissionsByRoleIds(customRoleIds);

    const assignable: AssignableRoleView[] = [];
    for (const role of roles) {
      const conferred =
        systemRolePermissions(role.name) ?? grants.get(role.id) ?? [];
      if (!isAssignable(conferred, held)) continue;
      assignable.push(toAssignableRoleView(role, conferred.length));
    }
    return assignable;
  }

  /**
   * Creating an account with a role CONFERS everything that role grants, so
   * the same non-escalation rule that governs granting governs this.
   */
  private async assertNoEscalation(
    manager: EntityManager,
    roles: readonly Role[],
    actorPermissions: readonly string[],
  ): Promise<void> {
    const conferred = await this.permissionService.resolveEffective(
      roles,
      manager,
    );
    const held = new Set(actorPermissions);
    const beyond = conferred.filter((code) => !held.has(code));
    if (beyond.length > 0) {
      throw new ForbiddenException({
        error: RoleErrorCodes.PERMISSION_ESCALATION,
        message: RoleMessages.PERMISSION_ESCALATION,
        beyondActorAuthority: beyond,
      });
    }
  }

  private async assertUsernameFree(
    manager: EntityManager,
    username: string,
    exceptUserId: number | null,
  ): Promise<void> {
    const rows = await manager.query<Array<{ id: number }>>(
      `SELECT "id" FROM "users" WHERE "username" = $1 AND ($2::int IS NULL OR "id" <> $2)`,
      [username, exceptUserId],
    );
    if (rows.length > 0) {
      throw new ConflictException({
        error: UserErrorCodes.USERNAME_TAKEN,
        message: UserMessages.USERNAME_TAKEN,
        username,
      });
    }
  }

  private async assertMobileFree(
    manager: EntityManager,
    mobile: string,
    exceptUserId: number | null,
  ): Promise<void> {
    const rows = await manager.query<Array<{ id: number }>>(
      `SELECT "id" FROM "users" WHERE "mobile" = $1 AND ($2::int IS NULL OR "id" <> $2)`,
      [mobile, exceptUserId],
    );
    if (rows.length > 0) {
      throw new ConflictException({
        error: UserErrorCodes.MOBILE_TAKEN,
        message: UserMessages.MOBILE_TAKEN,
        mobile,
      });
    }
  }

  private async resolveBranch(
    manager: EntityManager,
    branchId: number | null,
  ): Promise<Branch | null> {
    if (branchId === null) return null;
    const branch = await manager.getRepository(Branch).findOne({
      where: { id: branchId },
    });
    if (!branch) {
      throw new BadRequestException(BranchMessages.BRANCH_NOT_FOUND);
    }
    return branch;
  }
}

/**
 * Revokes every live refresh token of one user and returns how many there
 * were.
 *
 * THE QUERY BUILDER, NOT `manager.query`, and the reason is a bug this very
 * helper shipped with. `EntityManager.query` does NOT normalise its result
 * across statement kinds under the PostgreSQL driver:
 *
 *   INSERT ... RETURNING  ->  [{...}]              (a rows array)
 *   UPDATE ... RETURNING  ->  [[{...}], 2]         (rows AND affected count)
 *   DELETE ... RETURNING  ->  [[{...}], 1]         (likewise)
 *
 * So the obvious `rows.length` on an UPDATE returns 2 — the length of the
 * TUPLE — no matter how many sessions were actually cut. It is never 0 and
 * never 1, which is exactly the kind of wrong that looks plausible in an audit
 * row and in an API response. `.execute().affected` is the driver-agnostic
 * count TypeORM defines for this, and it is what `AuthService.logout` already
 * uses for the same table.
 */
async function revokeActiveSessions(
  manager: EntityManager,
  userId: number,
): Promise<number> {
  const result = await manager
    .createQueryBuilder()
    .update(RefreshToken)
    .set({ revoked: true })
    .where('"userId" = :userId', { userId })
    .andWhere('revoked = false')
    .execute();
  return result.affected ?? 0;
}
