import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import {
  closeTestDataSource,
  getTestDataSource,
  listTables,
  resetDb,
  scratchDatabaseName,
  testDataSourceOptions,
  testDbConfig,
} from './setup/test-db';

/**
 * Proves the integration harness itself works:
 *   1. globalSetup started a real PostgreSQL container,
 *   2. every migration applies to an empty database,
 *   3. the resulting schema is the one docs/ARCHITECTURE.md section 4 describes,
 *   4. every migration's down() genuinely reverses its up(),
 *   5. resetDb() empties the database between tests.
 *
 * Everything downstream (workstreams B, C and D) builds on these guarantees, so
 * they are asserted explicitly rather than assumed.
 */

/**
 * `@types/pg` is not installed, so `pg`'s exports are implicitly `any`.
 * Narrow the small surface used here rather than scattering eslint-disable
 * comments. (Installing @types/pg would remove the need for this.)
 */
interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
type PgClientCtor = new (config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionTimeoutMillis?: number;
}) => PgClientLike;
const PgClient = Client as unknown as PgClientCtor;

/** The 20 tables migration 0001 must create. */
const BASELINE_TABLES = [
  'addresses',
  'bookmark_products',
  'branches',
  'cart_items',
  'categories',
  'customers',
  'order_items',
  'orders',
  'payment',
  'product_attribute',
  'product_attribute_value',
  'product_category',
  'product_images',
  'product_variants',
  'products',
  'refresh_tokens',
  'roles',
  'user_roles',
  'users',
  'variant_product_attribute_value',
] as const;

/**
 * TOTAL APPLICATION TABLES after every migration.
 *
 * 20 from the baseline + 4 added by 0002 + 1 added by 0017 (`otp_challenges`)
 * + 1 added by 0018 (`payment_actions`) + 2 added by 0020 (`permissions`,
 * `role_permissions`) + 1 added by 0022 (`admin_audit_log`) + 1 added by 0030
 * (`product_branch_visibility`) + 1 by 0035 (`object_deletion_jobs`) + 1 by 0037
 * (`order_item_adjustments`) + 5 by 0038 (monthly pricing plans) = 37. Asserted
 * explicitly because it is a claim made in the documentation, and a documented
 * number nobody checks is a number that quietly stops being true.
 */
const APPLICATION_TABLE_COUNT = 37;

/**
 * The migration class names, read from `src/migrations/*.ts` in timestamp
 * order. TypeORM registers a migration under its `name` property, which by
 * convention is `<ClassName><timestamp>` and equals the filename's
 * `<timestamp>-<ClassName>` reversed.
 */
function migrationClassNames(): string[] {
  const dir = join(__dirname, '..', '..', 'src', 'migrations');
  return readdirSync(dir)
    .filter((file) => /^\d+-.+\.ts$/.test(file))
    .sort()
    .map((file) => {
      const [timestamp, rest] = file.replace(/\.ts$/, '').split('-');
      return `${rest}${timestamp}`;
    });
}

/** The 4 tables migration 0002 adds. */
const NEW_TABLES = [
  'idempotency_keys',
  'order_actions',
  'stock_movements',
  'stock_reservations',
] as const;

/**
 * Tables added by migrations later than 0002. Kept separate from NEW_TABLES so
 * the "4 new inventory/audit tables" assertion keeps saying what it is named
 * after instead of quietly becoming "N tables from various migrations".
 *
 * `otp_challenges` (0017) holds OTP state that used to live in a single Redis
 * key with no cooldown, no rate limit, no attempt bound and no atomic
 * consumption.
 *
 * `payment_actions` (0018) is the append-only audit of every MANUAL
 * RECONCILIATION decision — the operator, the reason, the from/to states and the
 * provider reference. Before it there was nowhere to record what a human decided
 * about money the system refused to move on its own.
 *
 * `permissions` / `role_permissions` (0020) replace three fixed role NAMES with
 * delegatable CAPABILITIES, which is what lets the owner hand one employee the
 * order queue without also handing them the ability to void a paid sale.
 *
 * `admin_audit_log` (0022) records administrative acts that no per-document
 * trail can hold — who gave a role the power to void sales, who reset a
 * cashier's password, who closed a branch. Append-only at the database, like
 * `payment_actions`.
 */
const LATER_TABLES = [
  'otp_challenges',
  'payment_actions',
  // 0020 — permission-based authorisation.
  'permissions',
  'role_permissions',
  // 0022 — the append-only administrative trail.
  'admin_audit_log',
  'product_branch_visibility',
  // 0035 — durable "these bytes must go" tombstones, so a failed S3 delete is
  // a retry rather than a permanently forgotten object.
  'object_deletion_jobs',
  // 0037 — the append-only reversal ledger: which units of which sold line
  // came back, how much revenue went back, and the exact COGS restored.
  'order_item_adjustments',
  // 0038 — monthly cost-recovery pricing plans: the plan, its cost lines, its
  // durable runs, the persisted preview and the append-only price history.
  'pricing_plans',
  'pricing_plan_cost_entries',
  'pricing_plan_runs',
  'pricing_plan_items',
  'pricing_price_changes',
] as const;

describe('integration harness smoke test', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await getTestDataSource();
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  it('connects to the disposable PostgreSQL container', async () => {
    const [{ version }] =
      await ds.query<Array<{ version: string }>>('SELECT version()');
    expect(version).toContain('PostgreSQL 17');
  });

  it('has applied every migration', async () => {
    const applied = await ds.query<Array<{ name: string }>>(
      `SELECT name FROM migrations ORDER BY timestamp`,
    );

    // Derived from the files on disk rather than hardcoded. A hardcoded list
    // means every new migration fails this test for the wrong reason -- the
    // assertion stops saying "every migration ran" and starts saying "the list
    // is out of date", which is noise that teaches people to edit the number
    // without reading it. Discovering the expected set makes the test assert
    // the thing it is named after: nothing on disk was skipped.
    expect(applied.map((row) => row.name)).toEqual(migrationClassNames());

    // Nothing left pending: the entity metadata and the migrations agree
    // closely enough that runMigrations() has nothing more to do.
    await expect(ds.showMigrations()).resolves.toBe(false);
  });

  it('creates all 20 baseline tables', async () => {
    const tables = await listTables(ds);
    for (const table of BASELINE_TABLES) {
      expect(tables).toContain(table);
    }
    expect(BASELINE_TABLES).toHaveLength(20);
  });

  it('creates the 4 new inventory/audit tables', async () => {
    const tables = await listTables(ds);
    for (const table of NEW_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('creates the tables added by migrations later than 0002', async () => {
    const tables = await listTables(ds);
    for (const table of LATER_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('has exactly the expected tables and nothing else', async () => {
    const tables = await listTables(ds);
    expect([...tables].sort()).toEqual(
      [...BASELINE_TABLES, ...NEW_TABLES, ...LATER_TABLES].sort(),
    );
    expect(
      BASELINE_TABLES.length + NEW_TABLES.length + LATER_TABLES.length,
    ).toBe(APPLICATION_TABLE_COUNT);
  });

  it('creates the partial indexes the concurrency design depends on', async () => {
    const rows = await ds.query<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    // One successful payment per order — the structural block on
    // double-fulfilment (docs/ARCHITECTURE.md section 2).
    const oneSuccess = byName.get('uq_payment_one_success_per_order');
    expect(oneSuccess).toBeDefined();
    expect(oneSuccess).toMatch(/CREATE UNIQUE INDEX/);
    expect(oneSuccess).toMatch(/WHERE \(?status = 'success'/);

    // Soft-removed basket lines must not block re-adding a product.
    const activeCartLine = byName.get('uq_cart_items_active_line');
    expect(activeCartLine).toBeDefined();
    expect(activeCartLine).toMatch(/CREATE UNIQUE INDEX/);
    expect(activeCartLine).toMatch(/userId/);
    expect(activeCartLine).toMatch(/productId/);
    expect(activeCartLine).toMatch(/variantId/);
    expect(activeCartLine).toMatch(/WHERE \(?status = 'active'/);

    // Reservation lookups only ever care about live holds.
    for (const name of [
      'idx_res_active_variant',
      'idx_res_active_expiry',
      'idx_res_active_cart_item',
      'idx_res_active_order',
    ]) {
      expect(byName.get(name)).toMatch(/WHERE \(?status = 'active'/);
    }

    expect(byName.get('uq_payment_track_id')).toMatch(
      /WHERE \(?track_id IS NOT NULL/,
    );
  });

  it('drops the old 3-column cart unique constraint', async () => {
    const rows = await ds.query<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'cart_items'::regclass AND contype = 'u'`,
    );
    expect(rows.map((row) => row.conname)).not.toContain(
      'UQ_0b6d1659abfc7f1a86f789b94e2',
    );
  });

  it('enforces uq_payment_one_success_per_order', async () => {
    await resetDb(ds);
    await ds.query(
      `INSERT INTO orders (channel, status, total_price) VALUES ('online', 'pending', 0)`,
    );
    await ds.query(
      `INSERT INTO payment ("orderId", amount, status) VALUES (1, 100, 'success')`,
    );
    // A second SUCCESS for the same order must be impossible.
    await expect(
      ds.query(
        `INSERT INTO payment ("orderId", amount, status) VALUES (1, 100, 'success')`,
      ),
    ).rejects.toThrow(/uq_payment_one_success_per_order/);
    // A second FAILED attempt is fine.
    await expect(
      ds.query(
        `INSERT INTO payment ("orderId", amount, status) VALUES (1, 100, 'failed')`,
      ),
    ).resolves.toBeDefined();
    await resetDb(ds);
  });

  it('resetDb() empties tables and restarts identities', async () => {
    await ds.query(`INSERT INTO roles (name) VALUES ('smoke_role')`);
    const before = await ds.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM roles`,
    );
    expect(before[0].n).toBe(1);

    await resetDb(ds);

    const after = await ds.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM roles`,
    );
    expect(after[0].n).toBe(0);

    const inserted = await ds.query<Array<{ id: number }>>(
      `INSERT INTO roles (name) VALUES ('smoke_role') RETURNING id`,
    );
    expect(inserted[0].id).toBe(1);

    await resetDb(ds);
  });
});

/**
 * down() is only real if it has been run. This exercises the full
 * up -> down -> up cycle on a SEPARATE database so it cannot disturb the
 * database the rest of the suite uses.
 */
describe('migration down() round trip', () => {
  const roundTripDb = scratchDatabaseName('roundtrip');
  let ds: DataSource;

  beforeAll(async () => {
    const config = testDbConfig();
    const admin = new PgClient({ ...config, user: config.username });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${roundTripDb}`);
    await admin.query(`CREATE DATABASE ${roundTripDb}`);
    await admin.end();

    ds = new DataSource({
      ...testDataSourceOptions(),
      database: roundTripDb,
    } as never);
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    const config = testDbConfig();
    const admin = new PgClient({ ...config, user: config.username });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${roundTripDb}`);
    await admin.end();
  });

  it('applies, fully reverts, and re-applies every migration', async () => {
    const expectedCount = migrationClassNames().length;

    const migrations = await ds.runMigrations({ transaction: 'all' });
    expect(migrations).toHaveLength(expectedCount);
    expect(await listTables(ds)).toHaveLength(APPLICATION_TABLE_COUNT);

    // Revert them all, newest first.
    for (let i = 0; i < migrations.length; i += 1) {
      await ds.undoLastMigration({ transaction: 'all' });
    }

    // No application table and no leftover enum type may survive a full revert.
    expect(await listTables(ds)).toHaveLength(0);
    const types = await ds.query<Array<{ typname: string }>>(
      `SELECT typname FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'`,
    );
    expect(types).toHaveLength(0);

    // And the whole thing goes back up cleanly.
    const reapplied = await ds.runMigrations({ transaction: 'all' });
    expect(reapplied).toHaveLength(expectedCount);
    expect(await listTables(ds)).toHaveLength(APPLICATION_TABLE_COUNT);
  });
});
