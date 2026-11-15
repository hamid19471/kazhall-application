import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from '../../user/user.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '../entities/role.entity';
import { Repository } from 'typeorm';
import { RoleMessages } from 'src/common/constants/role.messages';
import { AuditService, AuditActor } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import {
  assertSuperAdminSurvives,
  builtInRoleProtected,
  countRoleAssignments,
  isBuiltInRoleName,
  isSuperAdminRoleName,
  lockRoleById,
  roleInUse,
  shareLockRoleById,
} from './role-safety';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

@Injectable()
export class RoleService {
  constructor(
    /** Role membership is authorization; live sockets are re-decided on change. */
    private readonly realtime: RealtimeGateway,
    private readonly userService: UserService,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    /**
     * Role membership is a security-sensitive change, so every one of the
     * three writes below records WHO made it in the same transaction as the
     * change itself. An assignment that committed without a record of who
     * granted it is exactly the gap the audit trail exists to close.
     */
    private readonly audit: AuditService,
  ) {}

  /**
   * `createRole` USED TO BE HERE AND IS GONE.
   *
   * Its only caller was `POST /roles`, which could not succeed: the DTO
   * accepted only `UserRoleEnum` members and the seeder creates all three on
   * bootstrap, so every request hit the duplicate check. Keeping the method
   * would keep a way to insert a `roles` row that authorises nothing (no guard
   * consults the catalogue) and that `DELETE /roles/:id` would then refuse to
   * remove once anyone held it. See the note on `RoleController`.
   */
  async getAllRoles() {
    return await this.roleRepository.find();
  }

  /**
   * Safe role deletion.
   *
   * The naive version was `getRoleById(id)` followed by `delete(id)`, which had
   * two failure modes, both silent:
   *
   *  - `user_roles."rolesId"` is ON DELETE CASCADE, so deleting the
   *    `super_admin` row demoted every administrator in a single request and
   *    returned 200;
   *  - even for a custom role, nothing stopped the delete while users still
   *    held it.
   *
   * The whole check-then-delete now runs in ONE transaction that opens by
   * taking the role's own row FOR UPDATE. That lock is what makes the count
   * meaningful:
   *
   *  - a concurrent `POST /roles/assign` takes a SHARE lock on the same row
   *    (see `addRoleToUser`), so it either lands before this transaction —
   *    and is then visible to the count, which refuses — or waits until after
   *    the delete has committed and fails its own existence check. It can no
   *    longer insert an assignment that the CASCADE would silently erase;
   *  - a concurrent duplicate delete blocks on the same row and, once the
   *    winner commits, Postgres re-evaluates the locked row, finds it gone,
   *    and returns zero rows — so the loser answers 404, never a second 200.
   */
  async removeRole(id: number, actor?: AuditActor): Promise<void> {
    await this.roleRepository.manager.transaction(async (manager) => {
      const role = await lockRoleById(manager, id);
      if (!role) throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);

      // Matched on NAME: `roles.id` differs per environment and seed run, so
      // an id-based allow-list would protect the wrong row elsewhere.
      if (isBuiltInRoleName(role.name)) {
        throw builtInRoleProtected(role.name);
      }

      const assignedUserCount = await countRoleAssignments(manager, role.id);
      if (assignedUserCount > 0) {
        throw roleInUse(role.name, assignedUserCount);
      }

      await manager.query(`DELETE FROM roles WHERE id = $1`, [role.id]);

      if (actor) {
        await this.audit.record(
          {
            actor,
            action: AuditAction.ROLE_DELETED,
            targetType: AuditTarget.ROLE,
            targetId: role.id,
            targetLabel: role.name,
            summary: { before: { name: role.name } },
          },
          manager,
        );
      }
    });
  }

  /**
   * Adds one role to a user, leaving their other roles alone.
   *
   * Transactional and SHARE-locked on the role row so that the assignment
   * cannot be inserted into a role that a concurrent `DELETE /roles/{id}` is
   * about to remove (the CASCADE would take the fresh assignment with it and
   * both requests would report success).
   *
   * `ON CONFLICT DO NOTHING` closes a second race: two identical assignments
   * firing together used to both pass the "already holds it?" read and then
   * collide on the `user_roles` primary key, i.e. a 500. Now exactly one
   * inserts and the other gets the normal 400.
   */
  async addRoleToUser(
    userId: number,
    roleId: number,
    actor?: AuditActor,
  ): Promise<void> {
    const user = await this.userService.findOneById(userId);

    await this.roleRepository.manager.transaction(async (manager) => {
      const role = await shareLockRoleById(manager, roleId);
      if (!role) throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);

      const inserted = await manager.query<Array<{ usersId: number }>>(
        `INSERT INTO user_roles ("usersId", "rolesId")
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING "usersId"`,
        [user.id, role.id],
      );

      if (inserted.length === 0) {
        throw new BadRequestException(RoleMessages.ROLE_ALREADY_EXISTS);
      }

      if (actor) {
        await this.audit.record(
          {
            actor,
            action: AuditAction.USER_ROLES_CHANGED,
            targetType: AuditTarget.USER,
            targetId: user.id,
            targetLabel: user.identifier,
            summary: { granted: [role.name] },
          },
          manager,
        );
      }
    });

    // A role grant changes what this principal's sockets may receive.
    await this.realtime.reconcileUser(userId, 'role granted');
  }

  /**
   * Removes one role from a user.
   *
   * This is the most direct route to an unadministrable system: the very last
   * `super_admin` assignment can be taken away here, and every route that
   * could put it back is itself `@Roles(super_admin)`.
   *
   * Exactly ONE `roles` row lock is taken (the target's), which is both the
   * serialisation point for the administrator census when that target IS
   * `super_admin` and the reason this path can never deadlock against role
   * deletion or role assignment — see the lock-order note in `role-safety.ts`.
   */
  async removeRoleFromUser(
    userId: number,
    roleId: number,
    actor?: AuditActor,
  ): Promise<void> {
    const user = await this.userService.findOneById(userId);

    await this.roleRepository.manager.transaction(async (manager) => {
      const role = await lockRoleById(manager, roleId);
      if (!role) throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);

      const held = await manager.query<Array<{ usersId: number }>>(
        `SELECT "usersId" FROM user_roles
          WHERE "usersId" = $1 AND "rolesId" = $2`,
        [user.id, role.id],
      );
      if (held.length === 0) {
        throw new BadRequestException(RoleMessages.USER_ROLE_INVALID);
      }

      if (isSuperAdminRoleName(role.name)) {
        // Re-locks the same row we already hold FOR UPDATE: a no-op here, and
        // the single place the census is defined for every caller.
        await assertSuperAdminSurvives(manager, user.id, 'role-removed');
      }

      await manager.query(
        `DELETE FROM user_roles WHERE "usersId" = $1 AND "rolesId" = $2`,
        [user.id, role.id],
      );

      if (actor) {
        await this.audit.record(
          {
            actor,
            action: AuditAction.USER_ROLES_CHANGED,
            targetType: AuditTarget.USER,
            targetId: user.id,
            targetLabel: user.identifier,
            summary: { revoked: [role.name] },
          },
          manager,
        );
      }
    });

    // Revoking a grant is the direction that matters: the socket may now be
    // holding a room, or a whole surface, it is no longer entitled to.
    await this.realtime.reconcileUser(userId, 'role revoked');
  }

  async getUserRoles(userId: number) {
    const user = await this.userService.findOneById(userId);
    return user.roles;
  }
}
