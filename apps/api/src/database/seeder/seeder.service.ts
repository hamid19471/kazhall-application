import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Role } from 'src/modules/auth/entities/role.entity';
import { User } from 'src/modules/user/entities/user.entity';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

export interface SeedResult {
  rolesCreated: string[];
  adminCreated: boolean;
  adminSkippedReason?: string;
}

/**
 * Idempotent bootstrap seeding.
 *
 * A freshly migrated database has no roles, so `UserService.createSiteUser`
 * throws ROLE_NOT_FOUND on the very first OTP request and no super_admin exists
 * to create one — the deployment is unusable until someone hand-writes rows.
 *
 * IDEMPOTENCE is a hard requirement, not a nicety: this runs on EVERY
 * application bootstrap, on every instance, possibly concurrently during a
 * rolling deploy. Every write therefore goes through `ON CONFLICT DO NOTHING`
 * against a real unique constraint (`roles.name`, `users.username`) rather than
 * a check-then-insert, which would race.
 */
@Injectable()
export class SeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeederService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Runs after the DI graph is up and the database connection is live.
   * Opt out with `SEED_ON_BOOTSTRAP=false` (e.g. for a read-only replica).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get<string>('SEED_ON_BOOTSTRAP') === 'false') {
      this.logger.log('SEED_ON_BOOTSTRAP=false — skipping bootstrap seeding.');
      return;
    }

    try {
      const result = await this.seed();
      this.logSummary(result);
    } catch (error) {
      // Never take the whole application down because seeding failed; log
      // loudly instead. A migration that has not been run yet is the usual
      // cause and it must be diagnosable from the logs.
      this.logger.error(
        `Bootstrap seeding failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async seed(): Promise<SeedResult> {
    return this.dataSource.transaction(async (manager) => {
      const rolesCreated = await this.seedRoles(manager);
      const admin = await this.seedSuperAdmin(manager);
      return { rolesCreated, ...admin };
    });
  }

  /** Creates the three UserRoleEnum roles. Existing rows are left untouched. */
  async seedRoles(manager?: EntityManager): Promise<string[]> {
    const em = manager ?? this.dataSource.manager;
    const created: string[] = [];

    for (const name of Object.values(UserRoleEnum)) {
      const result = await em
        .createQueryBuilder()
        .insert()
        .into(Role)
        .values({ name })
        .orIgnore() // ON CONFLICT DO NOTHING against UQ roles.name
        .execute();

      // ON CONFLICT DO NOTHING returns zero rows when the role already existed.
      if (Array.isArray(result.raw) && result.raw.length > 0) {
        created.push(name);
      }
    }

    return created;
  }

  /**
   * Creates the first super_admin from BOOTSTRAP_ADMIN_USERNAME /
   * BOOTSTRAP_ADMIN_PASSWORD.
   *
   * Deliberately does NOT update an existing user: re-running must never reset
   * a live administrator's password back to whatever is in the environment,
   * and must never silently re-grant super_admin to an account it was
   * deliberately removed from.
   */
  private async seedSuperAdmin(
    manager: EntityManager,
  ): Promise<{ adminCreated: boolean; adminSkippedReason?: string }> {
    const username = this.configService.get<string>('BOOTSTRAP_ADMIN_USERNAME');
    const password = this.configService.get<string>('BOOTSTRAP_ADMIN_PASSWORD');

    if (!username || !password) {
      return {
        adminCreated: false,
        adminSkippedReason:
          'BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD not set',
      };
    }

    const existing = await manager
      .getRepository(User)
      .findOne({ where: { username }, relations: { roles: true } });

    if (existing) {
      return { adminCreated: false, adminSkippedReason: 'already exists' };
    }

    const superAdminRole = await manager
      .getRepository(Role)
      .findOne({ where: { name: UserRoleEnum.superAdmin } });

    if (!superAdminRole) {
      return {
        adminCreated: false,
        adminSkippedReason: 'super_admin role missing',
      };
    }

    const insert = await manager
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({
        username,
        password: await bcrypt.hash(password, 10),
      })
      .orIgnore() // concurrent bootstrap of a second instance
      .execute();

    const insertedRows = (
      Array.isArray(insert.raw) ? insert.raw : []
    ) as Array<{ id?: number }>;
    const insertedId = insertedRows[0]?.id;
    if (insertedId === undefined) {
      return { adminCreated: false, adminSkippedReason: 'already exists' };
    }

    await manager
      .createQueryBuilder()
      .relation(User, 'roles')
      .of(insertedId)
      .add(superAdminRole.id);

    return { adminCreated: true };
  }

  private logSummary(result: SeedResult): void {
    if (result.rolesCreated.length) {
      this.logger.log(`Seeded roles: ${result.rolesCreated.join(', ')}`);
    }
    if (result.adminCreated) {
      // The username is operationally useful; the password never is.
      this.logger.log(
        `Seeded bootstrap super_admin "${this.configService.get<string>(
          'BOOTSTRAP_ADMIN_USERNAME',
        )}". Change this password immediately.`,
      );
    } else if (result.adminSkippedReason) {
      this.logger.debug(
        `Bootstrap super_admin not created (${result.adminSkippedReason}).`,
      );
    }
    if (!result.rolesCreated.length && !result.adminCreated) {
      this.logger.log('Seeding: nothing to do, database already bootstrapped.');
    }
  }
}
