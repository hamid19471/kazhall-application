import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PERMISSION_CATALOG } from 'src/modules/auth/permissions/permission.catalog';
import { PermissionService } from 'src/modules/auth/permissions/permission.service';
import { PermissionCatalogIntegrityService } from 'src/modules/auth/permissions/permission-catalog-integrity.service';
import { Role } from 'src/modules/auth/entities/role.entity';
import { TestApp, createTestApp } from './setup/test-app';
import {
  getTestDataSource,
  listTables,
  resetDb,
  scratchDatabaseName,
  testDataSourceOptions,
  testDbConfig,
} from './setup/test-db';

/**
 * ===========================================================================
 * PERMISSION CATALOGUE — MIGRATION DISCIPLINE
 * ===========================================================================
 *
 * The catalogue used to be upserted into the database on every boot, and
 * re-inserted opportunistically whenever a lookup missed. This suite exists to
 * prove that it no longer is, and that the read-only check which replaced it
 * actually refuses to start a process whose table and code disagree.
 *
 * The central technique is a DATABASE TRIGGER that raises on any write to
 * `permissions`. Counting rows before and after a boot cannot prove "zero
 * writes" — an idempotent upsert leaves the count unchanged — and
 * `pg_stat_user_tables` is collected asynchronously, so it can lag. A trigger
 * is synchronous and unavoidable: if the application writes so much as one
 * row, the statement raises, boot fails, and the test fails with it.
 */

const ACTIVE_CODES = PERMISSION_CATALOG.map((spec) => spec.code).sort();

/**
 * CODES THE TABLE STILL HOLDS, RETIRED, AND WHICH THE CODE NO LONGER DECLARES.
 *
 * `reports.read` was removed from `PERMISSION_CATALOG` and retired in the
 * database by migration 0028 (sales reporting is the built-in `super_admin`
 * role's, not a delegable capability). The row deliberately SURVIVES: deleting
 * it would CASCADE through `role_permissions` and destroy the record of who had
 * been granted it, and a retired code already grants nothing — every
 * `PermissionService` query filters `retiredAt IS NULL`.
 *
 * So the table's row count is `PERMISSION_CATALOG.length + RETIRED_CODES.length`
 * and NOT the catalogue length. Asserting the catalogue length over ALL rows —
 * which this file used to do — now fails for the right reason, and updating the
 * assertion rather than the migration is the correct response: the extra row is
 * the intended end state, and these cases exist to pin exactly that.
 */
const RETIRED_CODES = ['reports.read'] as const;
const ALL_STORED_CODES = [...ACTIVE_CODES, ...RETIRED_CODES].sort();

/** Raises on any row-level write, and on TRUNCATE, against `permissions`. */
const ARM_WRITE_GUARD = `
  CREATE OR REPLACE FUNCTION kz_test_block_permission_writes()
  RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'permission catalogue was written at runtime (% on %)',
      TG_OP, TG_TABLE_NAME;
  END $fn$;

  DROP TRIGGER IF EXISTS kz_test_no_permission_row_writes ON "permissions";
  CREATE TRIGGER kz_test_no_permission_row_writes
    BEFORE INSERT OR UPDATE OR DELETE ON "permissions"
    FOR EACH ROW EXECUTE FUNCTION kz_test_block_permission_writes();

  DROP TRIGGER IF EXISTS kz_test_no_permission_truncate ON "permissions";
  CREATE TRIGGER kz_test_no_permission_truncate
    BEFORE TRUNCATE ON "permissions"
    FOR EACH STATEMENT EXECUTE FUNCTION kz_test_block_permission_writes();
`;

const DISARM_WRITE_GUARD = `
  DROP TRIGGER IF EXISTS kz_test_no_permission_row_writes ON "permissions";
  DROP TRIGGER IF EXISTS kz_test_no_permission_truncate ON "permissions";
  DROP FUNCTION IF EXISTS kz_test_block_permission_writes();
`;

interface StoredRow {
  id: number;
  code: string;
  groupKey: string;
  labelFa: string;
  descriptionFa: string;
  risk: string;
  retiredAt: Date | null;
}

describe('permission catalogue — boot is read-only', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await getTestDataSource();
    await resetDb(ds);
  });

  /**
   * The catalogue must be intact when this file finishes, whatever any
   * individual test did to it. A leaked corruption would not fail here — it
   * would fail the NEXT suite's app boot, in a file that has nothing to do
   * with permissions, which is the worst possible place to debug it.
   */
  afterAll(async () => {
    await ds.query(DISARM_WRITE_GUARD);
    const codes = await ds.query<Array<{ code: string }>>(
      `SELECT "code" FROM "permissions" WHERE "retiredAt" IS NULL ORDER BY "code"`,
    );
    expect(codes.map((row) => row.code)).toEqual(ACTIVE_CODES);
  });

  // =========================================================================
  // The migration owns the rows
  // =========================================================================

  it('has exactly the catalogue the migrations inserted, and nothing else', async () => {
    const rows = await ds.query<StoredRow[]>(
      `SELECT "code", "groupKey", "labelFa", "descriptionFa", "risk", "retiredAt"
         FROM "permissions" ORDER BY "code"`,
    );

    expect(rows).toHaveLength(PERMISSION_CATALOG.length + RETIRED_CODES.length);
    for (const spec of PERMISSION_CATALOG) {
      const row = rows.find((candidate) => candidate.code === spec.code);
      expect(row).toBeDefined();
      expect(row!.groupKey).toBe(spec.groupKey);
      expect(row!.labelFa).toBe(spec.labelFa);
      expect(row!.descriptionFa).toBe(spec.descriptionFa);
      expect(row!.risk).toBe(spec.risk);
      expect(row!.retiredAt).toBeNull();
    }

    // And the retired codes are present, retired, and NOT declared by the code.
    for (const code of RETIRED_CODES) {
      const row = rows.find((candidate) => candidate.code === code);
      expect(row).toBeDefined();
      expect(row!.retiredAt).not.toBeNull();
      expect(ACTIVE_CODES).not.toContain(code);
    }
  });

  it('survives a data reset, because a migration owns it and not the harness', async () => {
    const before = await ds.query<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM "permissions"`,
    );
    await resetDb(ds);
    const after = await ds.query<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM "permissions"`,
    );

    // The harness used to TRUNCATE this table between every test, which only
    // worked because the application silently re-inserted the rows afterwards.
    expect(after[0].n).toBe(before[0].n);
    expect(Number(after[0].n)).toBe(
      PERMISSION_CATALOG.length + RETIRED_CODES.length,
    );
  });

  // =========================================================================
  // Zero writes at boot
  // =========================================================================

  it('boots with a valid catalogue and writes NOTHING', async () => {
    await ds.query(ARM_WRITE_GUARD);

    // Row identity, not row contents: an UPDATE that rewrites a row to the
    // same values still moves its physical location and bumps its transaction
    // id, so this catches a "harmless" no-op upsert that a value comparison
    // would miss.
    const fingerprint = async () =>
      ds.query<Array<{ f: string }>>(
        `SELECT string_agg("ctid"::text || ':' || "xmin"::text, ',' ORDER BY "id") AS f
           FROM "permissions"`,
      );

    const before = await fingerprint();
    let app: TestApp | undefined;
    try {
      app = await createTestApp();
    } finally {
      await app?.close();
      await ds.query(DISARM_WRITE_GUARD);
    }
    const after = await fingerprint();

    expect(after[0].f).toBe(before[0].f);
  });

  it('lets several instances start at once without racing to write', async () => {
    await ds.query(ARM_WRITE_GUARD);

    // The old design had every booting instance run 45 upserts. `ON CONFLICT`
    // kept that from corrupting anything, but it still meant N processes
    // taking row locks on a table every authenticated request reads. Reading
    // makes the race unrepresentable rather than merely survivable.
    let apps: TestApp[] = [];
    try {
      apps = await Promise.all([
        createTestApp(),
        createTestApp(),
        createTestApp(),
      ]);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await ds.query(DISARM_WRITE_GUARD);
    }

    const codes = await ds.query<Array<{ code: string }>>(
      `SELECT "code" FROM "permissions" ORDER BY "code"`,
    );
    // Every stored code, retired ones included — the claim is that booting
    // wrote NOTHING, so the row set must be exactly what the migrations left.
    expect(codes.map((row) => row.code)).toEqual(ALL_STORED_CODES);
  });

  // =========================================================================
  // Fail-fast on drift
  // =========================================================================

  /**
   * Corrupts the catalogue, runs the assertion, and always puts it back.
   *
   * The repair is targeted rather than a wholesale reload because
   * `role_permissions` has `ON DELETE CASCADE`: emptying and re-inserting the
   * table to "restore" it would silently destroy grants, which is the very
   * failure the retired-permission lifecycle exists to avoid.
   */
  const withCorruption = async (
    corrupt: () => Promise<void>,
    repair: () => Promise<void>,
    assertion: () => Promise<void>,
  ): Promise<void> => {
    await corrupt();
    try {
      await assertion();
    } finally {
      await repair();
    }
  };

  const expectBootRefused = async (...mustMention: string[]): Promise<void> => {
    let app: TestApp | undefined;
    let error: unknown;
    try {
      app = await createTestApp();
    } catch (caught) {
      error = caught;
    } finally {
      await app?.close();
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('refusing to start');
    for (const fragment of mustMention) expect(message).toContain(fragment);
  };

  it('refuses to start when a required code is missing from the database', async () => {
    const [row] = await ds.query<StoredRow[]>(
      `SELECT * FROM "permissions" WHERE "code" = 'orders.void'`,
    );

    await withCorruption(
      async () => {
        await ds.query(
          `DELETE FROM "permissions" WHERE "code" = 'orders.void'`,
        );
      },
      async () => {
        await ds.query(
          `INSERT INTO "permissions"
             ("id", "code", "groupKey", "labelFa", "descriptionFa", "risk", "createdAt", "retiredAt")
           VALUES ($1, $2, $3, $4, $5, $6, now(), NULL)`,
          [
            row.id,
            row.code,
            row.groupKey,
            row.labelFa,
            row.descriptionFa,
            row.risk,
          ],
        );
        await ds.query(
          `SELECT setval(pg_get_serial_sequence('permissions', 'id'),
                         (SELECT max("id") FROM "permissions"))`,
        );
      },
      async () => {
        // A missing code means `@RequirePermissions('orders.void')` names
        // something no role can ever be granted: the route is unreachable and
        // nothing in the running system says so.
        await expectBootRefused('MISSING FROM THE DATABASE', 'orders.void');
      },
    );
  });

  it('refuses to start when catalogue metadata has drifted', async () => {
    const [row] = await ds.query<StoredRow[]>(
      `SELECT * FROM "permissions" WHERE "code" = 'orders.read'`,
    );

    await withCorruption(
      async () => {
        await ds.query(
          `UPDATE "permissions" SET "labelFa" = $1 WHERE "code" = 'orders.read'`,
          ['برچسب نادرست'],
        );
      },
      async () => {
        await ds.query(
          `UPDATE "permissions" SET "labelFa" = $1 WHERE "code" = 'orders.read'`,
          [row.labelFa],
        );
      },
      async () => {
        // The Persian label is what an administrator reads in the confirmation
        // dialog before granting the capability. A drifted label means they
        // consented to a description of a capability, not the capability.
        await expectBootRefused(
          'METADATA MISMATCH',
          'orders.read',
          'labelFa',
          'برچسب نادرست',
        );
      },
    );
  });

  it('refuses to start when the database offers an ACTIVE code no guard checks', async () => {
    await withCorruption(
      async () => {
        await ds.query(
          `INSERT INTO "permissions" ("code", "groupKey", "labelFa", "descriptionFa", "risk")
           VALUES ('orders.teleport', 'orders', 'جابه‌جایی آنی سفارش', 'یک دسترسی جعلی', 'normal')`,
        );
      },
      async () => {
        await ds.query(
          `DELETE FROM "permissions" WHERE "code" = 'orders.teleport'`,
        );
      },
      async () => {
        // An administrator could tick this, the screen would say the role has
        // it, and no guard would ever consult it — authority that exists in
        // the UI and nowhere else.
        await expectBootRefused(
          'ACTIVE IN THE DATABASE BUT NOT DECLARED IN CODE',
          'orders.teleport',
        );
      },
    );
  });

  it('STARTS when that same undeclared code has been retired by a migration', async () => {
    await withCorruption(
      async () => {
        await ds.query(
          `INSERT INTO "permissions"
             ("code", "groupKey", "labelFa", "descriptionFa", "risk", "retiredAt")
           VALUES ('orders.teleport', 'orders', 'جابه‌جایی آنی سفارش',
                   'یک دسترسی بازنشسته', 'normal', now())`,
        );
      },
      async () => {
        await ds.query(
          `DELETE FROM "permissions" WHERE "code" = 'orders.teleport'`,
        );
      },
      async () => {
        // Retirement is the supported way to remove a capability. If a retired
        // row also blocked startup, the only way to remove one would be a
        // DELETE — and that cascades through `role_permissions`, stripping the
        // capability from every custom role that held it with no record left.
        const app = await createTestApp();
        try {
          const codes = await app.dataSource.query<Array<{ code: string }>>(
            `SELECT "code" FROM "permissions" WHERE "retiredAt" IS NULL ORDER BY "code"`,
          );
          expect(codes.map((row) => row.code)).toEqual(ACTIVE_CODES);
        } finally {
          await app.close();
        }
      },
    );
  });

  /*
   * THE SUBJECT IS `audit.read`, NOT `reports.read`.
   *
   * This case used to retire `reports.read` and put it back. That is no longer
   * a corruption: migration 0028 retired `reports.read` permanently and removed
   * it from `PERMISSION_CATALOG`, so the "restore" half would have UN-retired a
   * code the catalogue no longer declares — leaving the database in the state
   * the NEXT boot refuses, and turning an unrelated later test into a mystery.
   *
   * `audit.read` is an ordinary active code that the code still requires, which
   * is exactly what this case needs. The subject is incidental; the assertion
   * is about the differ.
   */
  it('refuses to start when a code the CODE still requires has been retired', async () => {
    await withCorruption(
      async () => {
        await ds.query(
          `UPDATE "permissions" SET "retiredAt" = now() WHERE "code" = 'audit.read'`,
        );
      },
      async () => {
        await ds.query(
          `UPDATE "permissions" SET "retiredAt" = NULL WHERE "code" = 'audit.read'`,
        );
      },
      async () => {
        await expectBootRefused(
          'RETIRED IN THE DATABASE BUT STILL REQUIRED BY CODE',
          'audit.read',
        );
      },
    );
  });

  it('names the missing table when the schema is behind the migrations', async () => {
    const app = await createTestApp();
    try {
      const service = app.app.get(PermissionCatalogIntegrityService);
      const broken = {
        query: () =>
          Promise.reject(
            new Error('relation "permissions" does not exist at character 42'),
          ),
      };
      // The single most likely cause of a read failure is a database that has
      // not been migrated, so the message says so instead of surfacing a raw
      // PostgreSQL error.
      await expect(
        (
          service as unknown as { dataSource: unknown; verify(): Promise<void> }
        ).verify.call({ ...service, dataSource: broken, logger: console }),
      ).rejects.toThrow('Run the migrations before starting the API');
    } finally {
      await app.close();
    }
  });

  // =========================================================================
  // Grants outlive a restart
  // =========================================================================

  it('keeps custom-role grants and built-in capabilities across a restart', async () => {
    await resetDb(ds);

    const [customRole] = await ds.query<Array<{ id: number }>>(
      `INSERT INTO "roles" ("name", "titleFa", "isSystem", "isActive")
       VALUES ('restart_probe', 'آزمون راه‌اندازی دوباره', false, true)
       RETURNING "id"`,
    );
    const [builtInRole] = await ds.query<Array<{ id: number }>>(
      `INSERT INTO "roles" ("name", "titleFa", "isSystem", "isActive")
       VALUES ('super_admin', 'مدیر ارشد', true, true)
       RETURNING "id"`,
    );

    const granted = ['orders.read', 'inventory.read'];
    await ds.query(
      `INSERT INTO "role_permissions" ("roleId", "permissionId")
       SELECT $1, "id" FROM "permissions" WHERE "code" = ANY($2::text[])`,
      [customRole.id, granted],
    );

    // Restart: a whole new container, resolving from the same database.
    const app = await createTestApp();
    try {
      const permissions = app.app.get(PermissionService);

      const custom = await permissions.resolveEffective([
        { id: customRole.id, name: 'restart_probe', isActive: true } as Role,
      ]);
      expect(custom.sort()).toEqual([...granted].sort());

      // The built-in set comes from code, so it cannot be lost to a database
      // change — which is the property that keeps a freshly migrated or
      // truncated database from having no usable administrator.
      const builtIn = await permissions.resolveEffective([
        { id: builtInRole.id, name: 'super_admin', isActive: true } as Role,
      ]);
      expect(builtIn).toContain('rbac.manage');
      expect(builtIn).toContain('admin.access');
      expect(builtIn).toHaveLength(PERMISSION_CATALOG.length - 1); // no storefront.access
    } finally {
      await app.close();
    }

    // And the grant rows themselves are untouched by the restart.
    const [surviving] = await ds.query<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM "role_permissions" WHERE "roleId" = $1`,
      [customRole.id],
    );
    expect(Number(surviving.n)).toBe(granted.length);

    await resetDb(ds);
  });

  it('stops a retired permission from granting anything, without losing the grant', async () => {
    await resetDb(ds);

    const [role] = await ds.query<Array<{ id: number }>>(
      `INSERT INTO "roles" ("name", "titleFa", "isSystem", "isActive")
       VALUES ('retire_probe', 'آزمون بازنشستگی', false, true) RETURNING "id"`,
    );
    await ds.query(
      `INSERT INTO "role_permissions" ("roleId", "permissionId")
       SELECT $1, "id" FROM "permissions" WHERE "code" = 'inventory.read'`,
      [role.id],
    );

    const app = await createTestApp();
    try {
      const permissions = app.app.get(PermissionService);
      const roleRow = {
        id: role.id,
        name: 'retire_probe',
        isActive: true,
      } as Role;

      expect(await permissions.resolveEffective([roleRow])).toEqual([
        'inventory.read',
      ]);

      await ds.query(
        `UPDATE "permissions" SET "retiredAt" = now() WHERE "code" = 'inventory.read'`,
      );
      try {
        // Inert immediately — no restart, no cache to wait out.
        expect(await permissions.resolveEffective([roleRow])).toEqual([]);

        // But the grant row is still there, so retirement is reversible and
        // "which roles held this?" is still answerable.
        const [kept] = await ds.query<Array<{ n: string }>>(
          `SELECT count(*)::text AS n FROM "role_permissions" WHERE "roleId" = $1`,
          [role.id],
        );
        expect(Number(kept.n)).toBe(1);
      } finally {
        await ds.query(
          `UPDATE "permissions" SET "retiredAt" = NULL WHERE "code" = 'inventory.read'`,
        );
      }

      expect(await permissions.resolveEffective([roleRow])).toEqual([
        'inventory.read',
      ]);
    } finally {
      await app.close();
      await resetDb(ds);
    }
  });
});

/**
 * Rollback determinism, on a database of its own.
 *
 * The migration used to build its rows by importing the live catalogue, which
 * meant `up()` produced whatever the source file happened to say at the moment
 * it ran. Two databases migrated a week apart would then hold different
 * catalogues from the same migration, and `down()` followed by `up()` would
 * not return a database to the state it started in. The rows are a frozen
 * literal now, and this asserts the consequence: the same migration produces
 * byte-identical rows every time it is applied.
 */
describe('permission catalogue — migration up/down determinism', () => {
  const dbName = scratchDatabaseName('permcatalog');
  let ds: DataSource;

  const adminClient = async (): Promise<Client> => {
    const config = testDbConfig();
    const client = new Client({ ...config, user: config.username });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    const admin = await adminClient();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    ds = new DataSource({
      ...testDataSourceOptions(),
      database: dbName,
    } as never);
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    const admin = await adminClient();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('produces identical catalogue rows on every application', async () => {
    const snapshot = async (): Promise<string> => {
      const rows = await ds.query<Array<{ row: string }>>(
        `SELECT "code" || '|' || "groupKey" || '|' || "labelFa" || '|' ||
                "descriptionFa" || '|' || "risk" || '|' ||
                coalesce("retiredAt"::text, 'active') AS row
           FROM "permissions" ORDER BY "code"`,
      );
      return rows.map((entry) => entry.row).join('\n');
    };

    const applied = await ds.runMigrations({ transaction: 'all' });
    const first = await snapshot();
    expect(first.split('\n')).toHaveLength(
      PERMISSION_CATALOG.length + RETIRED_CODES.length,
    );

    // Revert everything, newest first.
    for (let i = 0; i < applied.length; i += 1) {
      await ds.undoLastMigration({ transaction: 'all' });
    }
    expect(await listTables(ds)).toHaveLength(0);

    await ds.runMigrations({ transaction: 'all' });
    const second = await snapshot();

    expect(second).toBe(first);
  });

  it('inserts rows matching the code catalogue it was frozen from', async () => {
    // If this ever fails, the catalogue was edited without a migration — which
    // is precisely the state the boot-time check refuses to start in.
    const rows = await ds.query<
      Array<{
        code: string;
        groupKey: string;
        labelFa: string;
        descriptionFa: string;
        risk: string;
      }>
    >(
      `SELECT "code", "groupKey", "labelFa", "descriptionFa", "risk"
         FROM "permissions" WHERE "retiredAt" IS NULL ORDER BY "code"`,
    );

    expect(rows.map((row) => row.code)).toEqual(ACTIVE_CODES);
    for (const spec of PERMISSION_CATALOG) {
      const row = rows.find((candidate) => candidate.code === spec.code)!;
      expect({
        groupKey: row.groupKey,
        labelFa: row.labelFa,
        descriptionFa: row.descriptionFa,
        risk: row.risk,
      }).toEqual({
        groupKey: spec.groupKey,
        labelFa: spec.labelFa,
        descriptionFa: spec.descriptionFa,
        risk: spec.risk,
      });
    }
  });

  it('leaves no permissions table behind after a full revert', async () => {
    const applied = await ds.query<Array<{ name: string }>>(
      `SELECT name FROM migrations ORDER BY id DESC`,
    );
    for (let i = 0; i < applied.length; i += 1) {
      await ds.undoLastMigration({ transaction: 'all' });
    }

    const tables = await listTables(ds);
    expect(tables).not.toContain('permissions');
    expect(tables).not.toContain('role_permissions');

    // Put it back so the afterAll drop is the only teardown that matters.
    await ds.runMigrations({ transaction: 'all' });
  });
});
