import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Role } from '../entities/role.entity';
import { User } from 'src/modules/user/entities/user.entity';
import { assertRolesActive } from './assignable-roles';
import {
  RoleErrorCodes,
  RoleMessages,
} from 'src/common/constants/role.messages';
import { UserMessages } from 'src/common/constants/user.messages';
import { PermissionService } from '../permissions/permission.service';
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  PERMISSION_GROUPS,
} from '../permissions/permission.catalog';
import {
  isSystemRoleName,
  systemRolePermissions,
} from '../permissions/system-roles';
import {
  assertSuperAdminSurvives,
  lockRoleById,
  lockSuperAdminRole,
} from './role-safety';
import { AuditService, AuditActor } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

export interface RoleSummary {
  id: number;
  name: string;
  titleFa: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  userCount: number;
  permissionCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: string[];
  /** True when the set is owned by code and this API will refuse to change it. */
  permissionsReadOnly: boolean;
}

export interface EffectiveAccess {
  userId: number;
  identifier: string;
  isActive: boolean;
  roles: Array<{
    id: number;
    name: string;
    titleFa: string;
    isSystem: boolean;
    isActive: boolean;
  }>;
  permissions: string[];
  /** Which surfaces this user may open a session on, derived from permissions. */
  audiences: string[];
}

/**
 * ===========================================================================
 * ROLE AND PERMISSION ADMINISTRATION
 * ===========================================================================
 *
 * Every write here is guarded by four rules, in this order, and each of them
 * exists because skipping it produces a state the API cannot recover from:
 *
 *  1. SYSTEM ROLES ARE IMMUTABLE. `super_admin`, `sale` and `site` cannot be
 *     renamed, deactivated, or re-permissioned. Their capability sets live in
 *     `permissions/system-roles.ts`, and a row that could strip `rbac.manage`
 *     from `super_admin` is a lockout with no route able to undo it.
 *  2. NO ESCALATION. An actor may only confer capabilities it holds itself.
 *     Without this, anyone with `rbac.manage` could create a role carrying
 *     every permission in the catalogue and assign it to themselves — which
 *     makes `rbac.manage` equivalent to `super_admin` and the whole delegation
 *     model decorative.
 *  3. THE ADMINISTRATOR INVARIANT. Role assignment changes run through
 *     `assertSuperAdminSurvives` inside a transaction holding the
 *     `super_admin` row FOR UPDATE — see `role-safety.ts` for why an
 *     unserialised count is not a check.
 *  4. EVERY CHANGE IS AUDITED, in the same transaction as the change, so a
 *     committed permission change without a record of who made it is not
 *     representable.
 */
@Injectable()
export class RbacService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly permissionService: PermissionService,
    private readonly audit: AuditService,
    /**
     * An RBAC change is an AUTHORIZATION change, and a live socket holds rooms
     * granted by the authorization that existed when it connected.
     *
     * Every write below therefore reconciles sockets after it commits. Without
     * it, taking `pos.access` away from a role left every holder's till socket
     * in its branch room — receiving exact stock counts — until their access
     * token happened to expire.
     */
    private readonly realtime: RealtimeGateway,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  /**
   * The catalogue, grouped, for the permission checklist.
   *
   * SYNCHRONOUS, and that is the point. It used to `await ensureCatalogOnce()`
   * first — a write path, on a read — so that a stale `permissions` table
   * would be repaired before the checklist was rendered. Migrations own those
   * rows now and the boot-time integrity check refuses to start a process
   * whose table disagrees with the code, so by the time anybody can call this
   * the two are known to match and there is nothing to await.
   */
  catalogue() {
    return {
      groups: PERMISSION_GROUPS.map((group) => ({
        key: group.key,
        titleFa: group.titleFa,
        permissions: PERMISSION_CATALOG.filter(
          (permission) => permission.groupKey === group.key,
        ).map((permission) => ({
          code: permission.code,
          labelFa: permission.labelFa,
          descriptionFa: permission.descriptionFa,
          risk: permission.risk,
        })),
      })),
    };
  }

  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.dataSource.getRepository(Role).find({
      order: { isSystem: 'DESC', id: 'ASC' },
    });

    // ONE query for every role's user count, not one per role. A per-role
    // count is the N+1 the brief explicitly forbids on the dashboard, and the
    // reasoning does not stop at the dashboard.
    const counts = await this.dataSource.query<
      Array<{ rolesId: number; count: string }>
    >(
      `SELECT "rolesId", COUNT(*)::text AS count FROM "user_roles" GROUP BY "rolesId"`,
    );
    const userCounts = new Map(
      counts.map((row) => [Number(row.rolesId), Number(row.count)]),
    );

    const grantCounts = await this.dataSource.query<
      Array<{ roleId: number; count: string }>
    >(
      `SELECT "roleId", COUNT(*)::text AS count FROM "role_permissions" GROUP BY "roleId"`,
    );
    const grants = new Map(
      grantCounts.map((row) => [Number(row.roleId), Number(row.count)]),
    );

    return roles.map((role) => {
      const builtIn = systemRolePermissions(role.name);
      return {
        id: role.id,
        name: role.name,
        titleFa: role.titleFa ?? role.name,
        description: role.description ?? null,
        isSystem: isSystemRoleName(role.name),
        isActive: role.isActive !== false,
        userCount: userCounts.get(role.id) ?? 0,
        permissionCount: builtIn ? builtIn.length : (grants.get(role.id) ?? 0),
      };
    });
  }

  async readRole(id: number): Promise<RoleDetail> {
    const role = await this.dataSource.getRepository(Role).findOne({
      where: { id },
    });
    if (!role) throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);

    const permissions = await this.permissionService.permissionsForRole(role);
    const userCount = await this.countHolders(this.dataSource.manager, id);
    const system = isSystemRoleName(role.name);

    return {
      id: role.id,
      name: role.name,
      titleFa: role.titleFa ?? role.name,
      description: role.description ?? null,
      isSystem: system,
      isActive: role.isActive !== false,
      userCount,
      permissionCount: permissions.length,
      permissions: permissions.sort(),
      permissionsReadOnly: system,
    };
  }

  /**
   * What one user can actually do, expanded exactly the way every request
   * expands it. The access-control screen shows this so an administrator never
   * has to add up several roles in their head.
   */
  async effectiveAccess(userId: number): Promise<EffectiveAccess> {
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
      relations: { roles: true },
    });
    if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

    const permissions = await this.permissionService.resolveEffective(
      user.roles ?? [],
    );

    return {
      userId: user.id,
      identifier: user.identifier,
      isActive: !user.deactivatedAt,
      roles: (user.roles ?? []).map((role) => ({
        id: role.id,
        name: role.name,
        titleFa: role.titleFa ?? role.name,
        isSystem: isSystemRoleName(role.name),
        isActive: role.isActive !== false,
      })),
      permissions: permissions.sort(),
      audiences: (['storefront', 'admin', 'pos'] as const).filter((audience) =>
        permissions.includes(`${audience}.access`),
      ),
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async createRole(
    input: {
      name: string;
      titleFa: string;
      description?: string;
      permissions?: string[];
    },
    actor: AuditActor,
    actorPermissions: readonly string[],
  ): Promise<RoleDetail> {
    const requested = input.permissions ?? [];
    this.assertKnownPermissions(requested);
    this.assertNoEscalation(requested, actorPermissions);

    if (isSystemRoleName(input.name)) {
      throw new ConflictException({
        error: RoleErrorCodes.ROLE_NAME_TAKEN,
        message: RoleMessages.ROLE_NAME_TAKEN,
        roleName: input.name,
      });
    }

    const roleId = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.getRepository(Role).findOne({
        where: { name: input.name },
      });
      if (existing) {
        throw new ConflictException({
          error: RoleErrorCodes.ROLE_NAME_TAKEN,
          message: RoleMessages.ROLE_NAME_TAKEN,
          roleName: input.name,
        });
      }

      const created = await manager.getRepository(Role).save(
        manager.getRepository(Role).create({
          name: input.name,
          titleFa: input.titleFa,
          description: input.description ?? null,
          isSystem: false,
          isActive: true,
        }),
      );

      await this.writeGrants(manager, created.id, requested, actor.userId);

      await this.audit.record(
        {
          actor,
          action: AuditAction.ROLE_CREATED,
          targetType: AuditTarget.ROLE,
          targetId: created.id,
          targetLabel: input.titleFa,
          summary: {
            after: {
              name: input.name,
              titleFa: input.titleFa,
              permissions: [...requested].sort(),
            },
          },
        },
        manager,
      );

      return created.id;
    });

    return this.readRole(roleId);
  }

  async updateRole(
    id: number,
    input: { titleFa?: string; description?: string },
    actor: AuditActor,
  ): Promise<RoleDetail> {
    await this.dataSource.transaction(async (manager) => {
      const role = await this.loadCustomRoleForUpdate(manager, id);

      const before = {
        titleFa: role.titleFa,
        description: role.description,
      };
      if (input.titleFa !== undefined) role.titleFa = input.titleFa;
      if (input.description !== undefined) {
        role.description = input.description;
      }
      await manager.getRepository(Role).save(role);

      await this.audit.record(
        {
          actor,
          action: AuditAction.ROLE_UPDATED,
          targetType: AuditTarget.ROLE,
          targetId: role.id,
          targetLabel: role.titleFa ?? role.name,
          summary: {
            before,
            after: { titleFa: role.titleFa, description: role.description },
          },
        },
        manager,
      );
    });

    return this.readRole(id);
  }

  /**
   * Replaces a custom role's grant set.
   *
   * The whole set is replaced rather than patched, so "what this role can do"
   * is always exactly what the administrator last confirmed, and a lost
   * revocation cannot hide inside a partial update.
   */
  async setRolePermissions(
    id: number,
    permissions: string[],
    actor: AuditActor,
    actorPermissions: readonly string[],
  ): Promise<RoleDetail> {
    this.assertKnownPermissions(permissions);
    this.assertNoEscalation(permissions, actorPermissions);

    await this.dataSource.transaction(async (manager) => {
      const role = await this.loadCustomRoleForUpdate(manager, id);

      const before = await this.permissionService.permissionsForRole(
        role,
        manager,
      );

      // An administrator may only REVOKE what they could have granted. Without
      // this, a principal with `rbac.manage` but no `orders.void` could strip
      // `orders.void` from the role that holds it — sabotage rather than
      // escalation, but the same missing check.
      this.assertNoEscalation(
        before.filter((code) => !permissions.includes(code)),
        actorPermissions,
      );

      await manager.query(
        `DELETE FROM "role_permissions" WHERE "roleId" = $1`,
        [role.id],
      );
      await this.writeGrants(manager, role.id, permissions, actor.userId);

      await this.audit.record(
        {
          actor,
          action: AuditAction.ROLE_PERMISSIONS_CHANGED,
          targetType: AuditTarget.ROLE,
          targetId: role.id,
          targetLabel: role.titleFa ?? role.name,
          summary: {
            before: { permissions: [...before].sort() },
            after: { permissions: [...permissions].sort() },
            granted: permissions.filter((code) => !before.includes(code)),
            revoked: before.filter((code) => !permissions.includes(code)),
          },
        },
        manager,
      );
    });

    /*
     * A role's grants changed, so every holder's entitlement changed. Sockets
     * are re-decided for all of them rather than for a user list resolved
     * here: "who holds this role?" is a query this service would have to
     * duplicate, and missing one user is a socket that keeps a room it is no
     * longer entitled to.
     */
    await this.realtime.reconcileAll('role permissions changed');

    return this.readRole(id);
  }

  async setRoleActive(
    id: number,
    isActive: boolean,
    actor: AuditActor,
  ): Promise<RoleDetail> {
    await this.dataSource.transaction(async (manager) => {
      const role = await this.loadCustomRoleForUpdate(manager, id);
      if (role.isActive === isActive) return;

      role.isActive = isActive;
      await manager.getRepository(Role).save(role);

      await this.audit.record(
        {
          actor,
          action: isActive
            ? AuditAction.ROLE_ACTIVATED
            : AuditAction.ROLE_DEACTIVATED,
          targetType: AuditTarget.ROLE,
          targetId: role.id,
          targetLabel: role.titleFa ?? role.name,
          summary: { after: { isActive } },
        },
        manager,
      );
    });

    // Deactivating a role silently strips every capability it confers
    // (`resolveEffective` skips inactive roles), so it is as much an
    // authorization change as editing its grants.
    await this.realtime.reconcileAll('role activation changed');

    return this.readRole(id);
  }

  /**
   * Replaces a user's role set.
   *
   * Same shape as `UserService.update`'s `role` field and guarded the same
   * way, but keyed on `roles.id` so CUSTOM roles can be assigned — the old
   * path took `UserRoleEnum` names and therefore could only ever express the
   * three built-ins.
   */
  async setUserRoles(
    userId: number,
    roleIds: number[],
    actor: AuditActor,
    actorPermissions: readonly string[],
  ): Promise<EffectiveAccess> {
    await this.dataSource.transaction(async (manager) => {
      // LOCK ORDER: the super_admin row is always taken first. See
      // `role-safety.ts` — violating this is how deadlocks, not bugs, appear.
      await lockSuperAdminRole(manager);

      const user = await manager.getRepository(User).findOne({
        where: { id: userId },
        relations: { roles: true },
      });
      if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

      const roles =
        roleIds.length === 0
          ? []
          : await manager
              .getRepository(Role)
              .createQueryBuilder('role')
              .where('role.id IN (:...ids)', { ids: roleIds })
              .getMany();

      if (roles.length !== roleIds.length) {
        throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
      }

      /*
       * THE SAME ASSIGNABLE-ROLE RULE AS `POST /admin/users`.
       *
       * A DEACTIVATED role confers nothing — `resolveEffective` skips it — so
       * assigning one leaves the user with an account the operator believes
       * they have just configured and which in fact has no capabilities at
       * all. It also passes the escalation check below trivially, because the
       * empty set is a subset of everything, so without this the silent
       * failure would look like a success. Shared with the create path via
       * `assignable-roles.ts` so the two cannot drift.
       */
      assertRolesActive(roles);

      const before = (user.roles ?? []).map((role) => role.name);
      const after = roles.map((role) => role.name);

      // Assigning a role CONFERS everything it grants, so the escalation rule
      // applies to assignment exactly as it applies to granting: an actor may
      // not hand somebody a capability it does not hold itself.
      const conferred = await this.permissionService.resolveEffective(
        roles,
        manager,
      );
      this.assertNoEscalation(conferred, actorPermissions);

      // The administrator invariant. Only a replacement that DROPS
      // `super_admin` can break it; one that keeps or adds it never can.
      if (!after.includes(String(UserRoleEnum.superAdmin))) {
        await assertSuperAdminSurvives(manager, user.id, 'role-removed');
      }

      user.roles = roles;
      await manager.getRepository(User).save(user);

      await this.audit.record(
        {
          actor,
          action: AuditAction.USER_ROLES_CHANGED,
          targetType: AuditTarget.USER,
          targetId: user.id,
          targetLabel: user.identifier,
          summary: {
            before: { roles: [...before].sort() },
            after: { roles: [...after].sort() },
          },
        },
        manager,
      );
    });

    // One principal changed, so only their sockets need re-deciding.
    await this.realtime.reconcileUser(userId, 'user roles changed');

    return this.effectiveAccess(userId);
  }

  // =========================================================================
  // Guards
  // =========================================================================

  private assertKnownPermissions(codes: readonly string[]): void {
    const unknown = codes.filter((code) => !PERMISSION_CODES.has(code));
    if (unknown.length > 0) {
      throw new BadRequestException({
        error: RoleErrorCodes.UNKNOWN_PERMISSION,
        message: RoleMessages.UNKNOWN_PERMISSION,
        unknownPermissions: unknown,
      });
    }
  }

  /**
   * THE ESCALATION RULE.
   *
   * `super_admin` holds the whole catalogue, so this is a no-op for the owner
   * and only ever bites a delegated `rbac.manage` holder — which is exactly
   * the principal it exists for.
   */
  private assertNoEscalation(
    codes: readonly string[],
    actorPermissions: readonly string[],
  ): void {
    const held = new Set(actorPermissions);
    const beyond = codes.filter((code) => !held.has(code));
    if (beyond.length > 0) {
      throw new ForbiddenException({
        error: RoleErrorCodes.PERMISSION_ESCALATION,
        message: RoleMessages.PERMISSION_ESCALATION,
        beyondActorAuthority: beyond,
      });
    }
  }

  /**
   * Locks a role row and refuses if it is a built-in. The lock is what makes
   * the subsequent read-modify-write safe against a concurrent edit or delete.
   */
  private async loadCustomRoleForUpdate(
    manager: EntityManager,
    id: number,
  ): Promise<Role> {
    const locked = await lockRoleById(manager, id);
    if (!locked) throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
    if (isSystemRoleName(locked.name)) {
      throw new ConflictException({
        error: RoleErrorCodes.SYSTEM_ROLE_IMMUTABLE,
        message: RoleMessages.SYSTEM_ROLE_IMMUTABLE,
        roleName: locked.name,
      });
    }
    const role = await manager.getRepository(Role).findOne({ where: { id } });
    if (!role) throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
    return role;
  }

  private async writeGrants(
    manager: EntityManager,
    roleId: number,
    codes: readonly string[],
    grantedByUserId: number | null,
  ): Promise<void> {
    if (codes.length === 0) return;
    const ids = await this.permissionService.idsForCodes(codes, manager);
    const missing = codes.filter((code) => !ids.has(code));
    if (missing.length > 0) {
      // Reachable only if the catalogue row vanished between validation and
      // here — i.e. never, unless somebody deleted rows out of band.
      throw new BadRequestException({
        error: RoleErrorCodes.UNKNOWN_PERMISSION,
        message: RoleMessages.UNKNOWN_PERMISSION,
        unknownPermissions: missing,
      });
    }
    for (const code of codes) {
      await manager.query(
        `INSERT INTO "role_permissions" ("roleId", "permissionId", "grantedByUserId")
         VALUES ($1, $2, $3)
         ON CONFLICT ("roleId", "permissionId") DO NOTHING`,
        [roleId, ids.get(code), grantedByUserId],
      );
    }
  }

  private async countHolders(
    manager: EntityManager,
    roleId: number,
  ): Promise<number> {
    const rows = await manager.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "user_roles" WHERE "rolesId" = $1`,
      [roleId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
