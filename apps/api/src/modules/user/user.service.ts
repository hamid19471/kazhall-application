import { InjectRepository } from '@nestjs/typeorm';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import UserRoleEnum from './enums/user-role.enum';
import { Role } from 'src/modules/auth/entities/role.entity';
import { RefreshToken } from 'src/modules/auth/entities/refresh-token.entity';
import { FindAllUsersDto } from './dto/find-all-users.dto';
import { Branch } from '../branch/entities/branch.entity';
import * as bcrypt from 'bcrypt';
import { UserMessages } from 'src/common/constants/user.messages';
import { RoleMessages } from 'src/common/constants/role.messages';
import { BranchMessages } from 'src/common/constants/branch.messages';
import {
  assertSuperAdminSurvives,
  lockSuperAdminRole,
} from 'src/modules/auth/services/role-safety';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Branch)
    private readonly branchRepository: Repository<Branch>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,

    /**
     * Ending a session has to reach the websocket too. Called post-commit
     * only: a rolled-back password change or deactivation must not disconnect
     * anybody.
     */
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Customer self-registration. Needs no role lock: it only ever ADDS the
   * built-in `site` role, which `RoleService.removeRole` refuses to delete, so
   * there is neither a vanishing-role race nor an administrator invariant in
   * play — and this is the one high-frequency role-assigning path, so it must
   * not serialise on a shared row.
   */
  async createSiteUser(mobile: string): Promise<User> {
    // check exist user
    const existUser = await this.userRepository.findOne({ where: { mobile } });
    if (existUser)
      throw new BadRequestException(UserMessages.USER_ALREADY_EXISTS);

    // cehck exist role
    const existRole = await this.roleRepository.findOne({
      where: { name: UserRoleEnum.site },
    });
    if (!existRole) {
      throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
    }

    // create user
    const newUser = this.userRepository.create({
      mobile,
      roles: [existRole],
    });
    return await this.userRepository.save(newUser);
  }

  async create(createUserDto: CreateUserDto) {
    const { username, password, role, branchId } = createUserDto;

    // cehck exist role
    if (!role || role.length === 0) {
      throw new BadRequestException(UserMessages.USER_ROLE_REQUIRED);
    }
    const existRole = await this.roleRepository.find({
      where: { name: In(role) },
    });
    if (existRole.length !== role.length) {
      throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
    }

    //check exist branch
    // Explicitly typed: an untyped `let` is inferred `any`, which made
    // `branch: branchToFind` below an unchecked assignment.
    let branchToFind: Branch | null | undefined;
    if (branchId) {
      branchToFind = await this.branchRepository.findOne({
        where: { id: branchId },
      });
      if (!branchToFind)
        throw new BadRequestException(BranchMessages.BRANCH_NOT_FOUND);
    }

    //hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // create user
    const newUser = this.userRepository.create({
      username,
      password: hashedPassword,
      branch: branchToFind,
      roles: existRole,
    });

    return await this.userRepository.save(newUser);
  }

  async findAll(query: FindAllUsersDto) {
    const { role, page, limit } = query;
    const queryBuilder = this.userRepository
      .createQueryBuilder('users')
      .leftJoinAndSelect('users.roles', 'roles');
    if (role) {
      queryBuilder.where('roles.name=:role', { role });
    }
    queryBuilder.skip((page - 1) * limit).take(limit);
    const [users, total] = await queryBuilder.getManyAndCount();
    return {
      data: users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
  async findOne(id: number) {
    const user = await this.userRepository.findOneBy({ id });
    if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);
    return user;
  }
  async findOneById(userId: number) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: {
        roles: true,
      },
    });
    if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);
    return user;
  }
  findOneByUsername(username: string) {
    return this.userRepository.findOne({
      where: { username },
      relations: {
        roles: true,
        branch: true,
      },
    });
  }
  findOneByMobile(mobile: string) {
    return this.userRepository.findOne({
      where: { mobile },
      relations: { roles: true },
    });
  }

  /**
   * `role` REPLACES the whole set — it does not merge. That makes this a
   * super_admin-stripping path just as much as `DELETE /roles/remove` is:
   * `PATCH /users/{lastAdminId} { "role": ["sale"] }` used to demote the last
   * administrator and answer 200.
   *
   * The read of the current role set, the administrator census and the write
   * therefore all run in ONE transaction, and the census takes the
   * `super_admin` row FOR UPDATE, so it is serialised against every other
   * super_admin membership change (see `role-safety.ts`).
   */
  async update(id: number, updateUserDto: UpdateUserDto) {
    const { username, password, role, branchId } = updateUserDto;

    // Hashed BEFORE the transaction opens: bcrypt at cost 10 takes ~100ms and
    // holding the super_admin row lock across it would serialise unrelated
    // administrator edits behind a CPU-bound loop.
    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;

    const updated = await this.userRepository.manager.transaction(
      async (manager) => {
        const user = await manager.findOne(User, {
          where: { id },
          relations: { roles: true },
        });
        if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

        if (username) {
          user.username = username;
        }

        if (hashedPassword) {
          user.password = hashedPassword;
          // Recorded for the operator's benefit — the admin user screen shows
          // "password last changed" — but NOT what invalidates a session any
          // more. That is `passwordVersion`, bumped below.
          user.passwordChangedAt = new Date();
        }

        if (role) {
          // LOCK ORDER: the super_admin row is always taken first.
          await lockSuperAdminRole(manager);

          const existRoles = await manager.find(Role, {
            where: {
              name: In(role),
            },
          });

          if (existRoles.length !== role.length) {
            throw new NotFoundException(RoleMessages.ROLE_NOT_FOUND);
          }

          // Only a replacement that DROPS super_admin can break the invariant;
          // one that keeps or adds it never can.
          if (!role.includes(UserRoleEnum.superAdmin)) {
            await assertSuperAdminSurvives(manager, user.id, 'role-removed');
          }

          user.roles = existRoles;
        }

        if (branchId !== undefined) {
          if (branchId === null) {
            user.branch = null;
          } else {
            const branch = await manager.findOne(Branch, {
              where: { id: branchId },
            });

            if (!branch) {
              throw new BadRequestException(BranchMessages.BRANCH_NOT_FOUND);
            }

            user.branch = branch;
          }
        }

        const saved = await manager.save(user);

        /*
         * THE SESSION EPOCH MOVES IN THE SAME TRANSACTION AS THE PASSWORD.
         *
         * Written as `"passwordVersion" + 1` in SQL rather than as
         * `user.passwordVersion + 1` in JavaScript, and issued AFTER
         * `manager.save` so it cannot be overwritten by the entity's own value.
         * The read-modify-write then happens inside PostgreSQL under this row's
         * lock, so two concurrent password changes produce 5 and 6 rather than
         * both reading 4 and both writing 5 — which would leave one of the two
         * changes unable to kill the other's sessions.
         *
         * Revoking the refresh rows in the SAME transaction makes the kill
         * explicit rather than implied by the claim check, and keeps
         * `activeSessionCount` on the admin screen truthful straight away.
         */
        if (hashedPassword) {
          await bumpPasswordVersion(manager, id);
          await revokeActiveSessions(manager, id);
        }

        return saved;
      },
    );

    /*
     * AND DROP THE LIVE SOCKETS — after the commit, and only if the password
     * actually changed.
     *
     * The epoch bump makes the sweep drop them within one 60-second interval
     * anyway, so this is about closing that window rather than about
     * correctness. For a till left signed in all day, a minute of a
     * superseded session still receiving branch stock frames is a minute too
     * many.
     */
    if (hashedPassword) {
      await this.realtime.disconnectUser(id, 'password changed');
    }

    return updated;
  }
  /**
   * Retention rule (docs/ARCHITECTURE.md §3).
   *
   * A staff member who has sold anything is NEVER hard-deleted -- deleting them
   * would either destroy the answer to "who sold this" or be blocked outright
   * by `orders.cashierUserId`'s ON DELETE RESTRICT. Such a user is soft
   * deactivated instead: `deactivatedAt` is stamped, login must fail from then
   * on, and every past sale keeps both the FK and the display snapshot.
   *
   * A user with no sales history has nothing to retain and is deleted for real.
   *
   * BOTH outcomes can lock the system out of itself, so both are guarded:
   * the hard delete takes the user's `user_roles` rows with it
   * (`user_roles."usersId"` is ON DELETE CASCADE), and the soft deactivation
   * leaves the assignment in place but makes login fail — an administrator who
   * cannot authenticate is not an administrator.
   */
  async remove(id: number): Promise<{ softDeactivated: boolean }> {
    return this.userRepository.manager.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id },
        relations: { roles: true },
      });
      if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

      const salesCount = await manager.count(Order, {
        where: [{ cashierUserId: id }, { userId: id }],
      });

      if (salesCount > 0) {
        if (!user.deactivatedAt) {
          await assertSuperAdminSurvives(manager, user.id, 'access-revoked');
          user.deactivatedAt = new Date();
          await manager.save(user);
        }
        return { softDeactivated: true };
      }

      await assertSuperAdminSurvives(manager, user.id, 'role-removed');
      await manager.remove(user);
      return { softDeactivated: false };
    });
  }

  /**
   * THE ONLY WRITER OF `users.password`, apart from `create`/`update`.
   *
   * It always stamps `passwordChangedAt`, because a password write that did
   * not would leave every session minted under the OLD password alive — and
   * `passwordChangedAt` is the documented "kill every session now" lever that
   * both `JwtStrategy` and `AuthService.refreshToken` read.
   *
   * `mustChangePassword` is explicit rather than inferred: an ADMINISTRATOR
   * reset sets it (the value is temporary and must be replaced), a
   * SELF-SERVICE change clears it. Inferring it from the caller would put the
   * decision in the wrong place.
   */
  async applyPasswordChange(
    id: number,
    plaintextPassword: string,
    options: { mustChangePassword: boolean },
  ): Promise<void> {
    // Hashed BEFORE the transaction so the ~100ms bcrypt cost is not held
    // inside a row lock, matching `update()`.
    const hashed = await bcrypt.hash(plaintextPassword, 10);

    /*
     * ONE TRANSACTION: new hash, new epoch, dead sessions.
     *
     * All three are the same event. Splitting them would leave a window in
     * which the password had changed but the old sessions were still usable —
     * which is the entire thing this path exists to prevent.
     *
     * The epoch is incremented IN SQL (`"passwordVersion" + 1`) rather than
     * computed in JavaScript, so the read-modify-write happens under the row's
     * own lock and two concurrent changes cannot both write the same value.
     */
    await this.userRepository.manager.transaction(async (manager) => {
      const result = await manager.query<Array<{ passwordVersion: number }>>(
        `UPDATE "users"
            SET "password"           = $2,
                "passwordChangedAt"  = now(),
                "mustChangePassword" = $3,
                "passwordVersion"    = "passwordVersion" + 1
          WHERE "id" = $1
        RETURNING "passwordVersion"`,
        [id, hashed, options.mustChangePassword],
      );

      if (result.length === 0) {
        throw new NotFoundException(UserMessages.USER_NOT_FOUND);
      }

      await revokeActiveSessions(manager, id);
    });

    /*
     * Post-commit. This path had no socket side effect at all, so the
     * self-service `POST /auth/<aud>/change-password` and the administrator's
     * forced-reset both moved the password epoch, revoked the refresh rows —
     * and left the live socket connected until the next sweep noticed the
     * epoch. `UserService.update`'s password branch already did this; this
     * sibling did not.
     *
     * Dropping rather than reconciling: a new epoch invalidates the token this
     * socket authenticated with, so there is nothing left to re-decide.
     */
    await this.realtime.disconnectUser(id, 'password changed');
  }

  /** Explicit soft deactivation, independent of whether the user has sales. */
  async deactivate(id: number): Promise<User> {
    const deactivated = await this.userRepository.manager.transaction(
      async (manager) => {
        const user = await manager.findOne(User, {
          where: { id },
          relations: { roles: true },
        });
        if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);

        if (user.deactivatedAt) {
          throw new BadRequestException(UserMessages.USER_ALREADY_DEACTIVATED);
        }

        await assertSuperAdminSurvives(manager, user.id, 'access-revoked');

        user.deactivatedAt = new Date();
        return manager.save(user);
      },
    );

    /*
     * Post-commit. A deactivation that rolled back must not disconnect a
     * working account.
     *
     * `loadUser` already treats a deactivated user as unknown, so the sweep
     * drops these sockets within one interval on its own. This makes it
     * immediate: revoking someone's access and leaving their till streaming
     * branch stock for another minute is not what the operator asked for.
     */
    await this.realtime.disconnectUser(id, 'user deactivated');

    return deactivated;
  }

  async reactivate(id: number): Promise<User> {
    const user = await this.findOneById(id);
    user.deactivatedAt = null;
    return this.userRepository.save(user);
  }

  /** Used by auth: a deactivated principal must not be able to log in. */
  countActiveById(id: number): Promise<number> {
    return this.userRepository.count({
      where: { id, deactivatedAt: IsNull() },
    });
  }

  /** Staff who can still be picked as a cashier. */
  findActiveStaff() {
    return this.userRepository.find({
      where: { deactivatedAt: IsNull(), username: Not(IsNull()) },
      relations: { roles: true },
    });
  }
  /**
   * `addRole(user, role)` / `removeRole(user, role)` used to live here and were
   * DELIBERATELY removed rather than left as convenience wrappers.
   *
   * They took an already-loaded `User`, mutated `user.roles` and saved — no
   * transaction, no lock, no census. `RoleService.removeRoleFromUser` called
   * `removeRole` and so had no way to be safe, and anything else that reached
   * for them would have silently reopened the last-administrator hole. The
   * only supported way to change a role assignment is now
   * `RoleService.addRoleToUser` / `RoleService.removeRoleFromUser` or this
   * service's `update`, all of which hold the `super_admin` row lock.
   */
}

/**
 * `users."passwordVersion" += 1`, in SQL, under the row's own lock.
 *
 * NEVER `user.passwordVersion + 1`. A JavaScript increment is a read, a gap,
 * and a write: two administrators resetting the same account at the same
 * moment would both read 4 and both write 5, and the second change would then
 * be unable to invalidate the sessions the first one had already handed out
 * under version 5. Doing the arithmetic inside the UPDATE makes the two
 * statements serialise on the row and produce 5 and 6.
 */
async function bumpPasswordVersion(
  manager: EntityManager,
  userId: number,
): Promise<number> {
  const rows = await manager.query<Array<{ passwordVersion: number }>>(
    `UPDATE "users"
        SET "passwordVersion" = "passwordVersion" + 1
      WHERE "id" = $1
    RETURNING "passwordVersion"`,
    [userId],
  );
  if (rows.length === 0) {
    throw new NotFoundException(UserMessages.USER_NOT_FOUND);
  }
  return Number(rows[0].passwordVersion);
}

/**
 * Revokes every live refresh-token row for a user, in the caller's transaction.
 *
 * The `pv` claim check already makes those tokens unusable; this makes the
 * kill EXPLICIT, so `activeSessionCount` on the admin user screen tells the
 * truth immediately instead of counting sessions that would fail on first use.
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
