import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PERMISSION_CATALOG } from './permission.catalog';
import {
  StoredPermissionRow,
  diffCatalogue,
  formatCatalogueProblems,
} from './permission-catalog.integrity';

/**
 * Verifies at boot that the `permissions` table matches the code catalogue.
 *
 * READ-ONLY. This service issues exactly one statement, a SELECT. It performs
 * no INSERT, UPDATE or DELETE under any circumstance, including the
 * circumstance where doing so would obviously "fix" the problem — see the
 * header of `permission-catalog.integrity.ts` for why that convenience was
 * removed.
 *
 * Because it only reads, any number of API instances may boot simultaneously
 * against the same database with no coordination, no advisory lock and no
 * possibility of one instance's startup rewriting rows another instance has
 * already validated.
 */
@Injectable()
export class PermissionCatalogIntegrityService implements OnModuleInit {
  private readonly logger = new Logger(PermissionCatalogIntegrityService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.verify();
  }

  /**
   * Throws unless the stored catalogue matches the code catalogue exactly.
   *
   * Separated from `onModuleInit` so tests can drive it directly against a
   * database they have deliberately corrupted, without booting a container.
   */
  async verify(): Promise<void> {
    let stored: StoredPermissionRow[];

    try {
      stored = await this.dataSource.query<StoredPermissionRow[]>(
        `SELECT "code", "groupKey", "labelFa", "descriptionFa", "risk", "retiredAt"
           FROM "permissions"`,
      );
    } catch (error) {
      const message = (error as Error).message;
      // The single most likely cause, called out by name: the schema is behind.
      const hint = /relation .*permissions.* does not exist/i.test(message)
        ? '\nThe "permissions" table does not exist. Run the migrations before starting the API.'
        : '';
      throw new Error(
        `Permission catalogue integrity check could not run — refusing to start.\n` +
          `Reading the "permissions" table failed: ${message}${hint}`,
      );
    }

    const problems = diffCatalogue(stored, PERMISSION_CATALOG);
    if (problems.length > 0) {
      throw new Error(formatCatalogueProblems(problems));
    }

    const retired = stored.filter((row) => row.retiredAt !== null).length;
    this.logger.log(
      `Permission catalogue verified: ${PERMISSION_CATALOG.length} active code(s) match the database` +
        (retired > 0 ? `, ${retired} retired row(s) ignored` : '') +
        '. No rows were written.',
    );
  }
}
