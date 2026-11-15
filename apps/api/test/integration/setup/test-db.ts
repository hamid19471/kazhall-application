import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  ContainerState,
  EXTERNAL_DB_PREFIX,
  currentStateFilePath,
} from './container';
import { record } from '../support/diagnostics';
import { describeBlockers, withLockWatchdog } from './lock-forensics';

const SRC = join(__dirname, '..', '..', '..', 'src');

/** Reads the container details written by globalSetup. */
export function testDbConfig(): {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
} {
  if (process.env.DB_HOST && process.env.DB_PORT) {
    return {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_DATABASE ?? 'kazhal_test',
    };
  }

  const stateFile = currentStateFilePath();
  if (!stateFile || !existsSync(stateFile)) {
    throw new Error(
      'No test database configured. Run the suite via `pnpm test:int` so globalSetup starts the container.',
    );
  }

  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as ContainerState;

  return {
    host: state.host,
    port: state.port,
    username: state.username,
    password: state.password,
    database: state.database,
  };
}

export function testDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    ...testDbConfig(),
    entities: [join(SRC, '**', 'entities', '*.entity.ts')],
    migrations: [join(SRC, 'migrations', '*.ts')],
    migrationsTableName: 'migrations',
    // NEVER synchronize in tests. The whole point of this harness is to prove
    // that the MIGRATIONS produce a working schema; synchronizing would test
    // the entity metadata against itself and would hide a broken migration.
    synchronize: false,
    logging: process.env.TYPEORM_LOGGING === 'true',
  };
}

let dataSource: DataSource | null = null;
let migrated = false;

/**
 * Returns the shared DataSource, initialising it and running every migration
 * exactly once per jest process.
 */
export async function getTestDataSource(): Promise<DataSource> {
  if (!dataSource) {
    dataSource = new DataSource(testDataSourceOptions());
  }
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }
  if (!migrated) {
    await dataSource.runMigrations({ transaction: 'all' });
    migrated = true;
  }
  return dataSource;
}

export async function closeTestDataSource(): Promise<void> {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }
  dataSource = null;
  migrated = false;
}

/** Every base table in `public`, excluding the migrations bookkeeping table. */
export async function listTables(ds: DataSource): Promise<string[]> {
  const rows: Array<{ tablename: string }> = await ds.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows
    .map((row) => row.tablename)
    .filter((name) => name !== 'migrations');
}

/**
 * Tables a DATA reset must never empty, because a MIGRATION owns their rows.
 *
 * `permissions` is the whole list. Its rows are inserted by migration 0020 and
 * changed only by later migrations; the application reads them and never
 * writes them, and `PermissionCatalogIntegrityService` refuses to start a
 * process whose catalogue does not match the code. Truncating the table
 * between tests therefore did not "reset state" — it corrupted the schema, and
 * the only reason the old harness survived it was that the service used to
 * silently re-insert the rows on the next lookup. That self-heal is gone, so
 * the harness has to stop breaking the thing it was healing.
 *
 * `migrations` is excluded for the older reason: wiping it would make the next
 * `runMigrations()` re-apply everything.
 */
export const MIGRATION_OWNED_TABLES: readonly string[] = ['permissions'];

/**
 * Empties every table between tests, except the ones a migration owns.
 *
 * A single `TRUNCATE a, b, c RESTART IDENTITY CASCADE` is used rather than a
 * per-table loop: one statement means one lock acquisition, no FK ordering
 * problem, and identity sequences reset so tests can assert on predictable ids.
 *
 * `role_permissions` IS truncated — custom-role grants are test data — and
 * that is safe while `permissions` is preserved, because the foreign key runs
 * from the grant to the catalogue and not the other way round.
 */
export async function resetDb(ds?: DataSource): Promise<void> {
  const source = ds ?? (await getTestDataSource());
  const tables = (await listTables(source)).filter(
    (name) => !MIGRATION_OWNED_TABLES.includes(name),
  );
  if (tables.length === 0) return;

  const quoted = tables.map((name) => `"public"."${name}"`).join(', ');
  const startedAt = Date.now();

  /*
   * ===========================================================================
   * FAIL FAST WHEN THE RESET CANNOT GET ITS LOCK
   * ===========================================================================
   *
   * `TRUNCATE` needs ACCESS EXCLUSIVE on every table named, so any connection
   * still holding a lock from the PREVIOUS test blocks it — and PostgreSQL's
   * default `lock_timeout` is 0, meaning "wait forever".
   *
   * That is not hypothetical. A measured run of `delegated-role-matrix` showed
   * ONE reset taking 978 696 ms where every other reset in the same file took
   * 130-230 ms. What the suite reported was
   *
   *     Exceeded timeout of 120000 ms for a hook
   *
   * pointing at `beforeEach`, which is true and completely uninformative: it
   * names the hook that gave up, not the statement that was waiting, nor that
   * it was waiting at all. Sixteen minutes of silence then a timeout is the
   * worst possible shape for an intermittent failure — there is nothing in the
   * output to act on, and the obvious response (raise the hook timeout) makes
   * the wait longer rather than the cause visible.
   *
   * `lock_timeout` turns that into an immediate, named error:
   *
   *     canceling statement due to lock timeout
   *
   * and the wrapper below adds WHICH tables and HOW LONG, so the failure says
   * "the previous test left work in flight" instead of "a hook was slow".
   *
   * TEN SECONDS, not one: a healthy reset acquires in single-digit
   * milliseconds, but this harness shares a machine with other suites and
   * their containers, and a bound tight enough to trip under ordinary I/O
   * contention would trade a rare real failure for a frequent false one.
   *
   * `SET LOCAL` scopes it to the transaction, so it cannot leak into the
   * session and change how the code under test behaves.
   *
   * -------------------------------------------------------------------------
   * AN OWNED QUERY RUNNER, NOT A MULTI-STATEMENT STRING
   *
   * This used to be sent as ONE simple query:
   *
   *     BEGIN; SET LOCAL lock_timeout = '10s'; TRUNCATE ...; COMMIT;
   *
   * which is a latent disaster, and measurably so. PostgreSQL DISCARDS THE
   * REST OF A MULTI-STATEMENT STRING once any statement in it errors, so the
   * moment the TRUNCATE hit the lock timeout the `COMMIT` was never executed.
   * `pg` then returned that connection to the pool -- it issues no `ROLLBACK`
   * and no `DISCARD ALL` on release -- so the connection sat in the pool
   * `idle in transaction`, still holding ACCESS EXCLUSIVE on every table the
   * TRUNCATE had already locked before it failed.
   *
   * From that moment the database was unusable for the rest of the file: the
   * next query on that connection answers
   *
   *     current transaction is aborted, commands ignored until end of
   *     transaction block
   *
   * and every later reset queues behind locks nobody will ever release. One
   * ~150ms collision became a permanent stall.
   * `db-lock-lifecycle.int-spec.ts` reproduces exactly that, deterministically.
   *
   * An explicitly owned `QueryRunner` fixes it because the three obligations
   * become separable: `rollbackTransaction()` in `catch` ends the transaction,
   * and `release()` in `finally` returns the connection whatever happened --
   * INCLUDING when the rollback itself throws, which is why the release sits
   * outside the rollback's own try.
   */
  const runner = source.createQueryRunner();
  let error: unknown;
  let captures: Awaited<ReturnType<typeof withLockWatchdog>>['captures'] = [];

  try {
    await runner.connect();
    await runner.startTransaction();

    const watched = await withLockWatchdog('resetDb', async () => {
      await runner.query(`SET LOCAL lock_timeout = '10s'`);
      await runner.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    });
    error = watched.error;
    captures = watched.captures;

    if (error) {
      // A rollback failure is swallowed on purpose: the ORIGINAL error is the
      // one worth reporting, and a connection that cannot be rolled back is
      // about to be released anyway, which ends its transaction regardless.
      await runner.rollbackTransaction().catch(() => undefined);
    } else {
      await runner.commitTransaction();
    }
  } finally {
    // Unconditional, and outside every try above it. A connection that is not
    // released is a connection that keeps its locks forever.
    await runner.release();
  }

  if (error) {
    const waited = Date.now() - startedAt;
    /*
     * `error` is `unknown`, and a non-Error thrown value must not reach
     * template interpolation: `String({})` is the useless `[object Object]`,
     * which would replace the one piece of evidence this message exists to
     * carry. `JSON.stringify` keeps a plain object readable, and the `??`
     * covers the values it cannot represent at all (`undefined`, a cycle).
     */
    const message =
      error instanceof Error
        ? error.message
        : ((): string => {
            try {
              return (
                JSON.stringify(error) ?? Object.prototype.toString.call(error)
              );
            } catch {
              return Object.prototype.toString.call(error);
            }
          })();
    if (/lock timeout/i.test(message)) {
      /*
       * NAME THE HOLDER. `lock_timeout` alone says only that somebody was
       * holding a lock; the watchdog above snapshotted `pg_stat_activity` and
       * `pg_locks` WHILE the block was live, so the message can say which
       * backend, which suite tagged it, what state it was in, how old its
       * transaction was, and the statement that took the lock.
       */
      throw new Error(
        `resetDb could not acquire ACCESS EXCLUSIVE after ${waited}ms on ` +
          `${tables.length} tables. This is work left IN FLIGHT by the ` +
          `previous test — an un-awaited request, an unreleased QueryRunner, ` +
          `an open transaction, or a background job — not a slow database.\n` +
          `  ${describeBlockers(captures)}\n` +
          `Original: ${message}`,
      );
    }
    /*
     * Rethrown as an Error even when something else was thrown: a caller that
     * catches this needs a stack, and `throw <unknown>` loses one. The
     * original value is folded into the message rather than passed as `cause`,
     * because this project's `lib` target predates `Error.cause` and a
     * diagnostic must not depend on a field the runtime may drop.
     */
    throw error instanceof Error
      ? error
      : new Error(`resetDb failed: ${message}`);
  }

  // Inert unless KAZHAL_INT_DIAG_FILE is set. Names the database that was
  // actually truncated and how long the exclusive lock took to acquire: a
  // reset that waited on another connection is evidence of work still in
  // flight from the previous test.
  record('resetDb', {
    database: (source.options as { database?: string }).database ?? null,
    tableCount: tables.length,
    preserved: [...MIGRATION_OWNED_TABLES],
    durationMs: Date.now() - startedAt,
  });
}

/**
 * Name for a throwaway database a single spec creates for itself (the
 * migration up/down/up round trip).
 *
 * PER RUN, and carrying the `kazhal_int_` prefix, for two reasons:
 *
 *  - it used to be the fixed `kazhal_migration_roundtrip`, and the spec opens
 *    with `DROP DATABASE IF EXISTS` — so two suites running at once would drop
 *    each other's round-trip database mid-migration;
 *  - the prefix is what marks a database as one this harness created, which is
 *    what makes a leaked one identifiable (and, in external mode, safe to
 *    remove) instead of an unexplained database on a shared server.
 */
export function scratchDatabaseName(purpose: string): string {
  const runId = (process.env.DB_DATABASE ?? 'local').replace(
    new RegExp(`^${EXTERNAL_DB_PREFIX}`),
    '',
  );
  const suffix = `${purpose}_${runId}`
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase();
  return `${EXTERNAL_DB_PREFIX}${suffix}`.slice(0, 60);
}
