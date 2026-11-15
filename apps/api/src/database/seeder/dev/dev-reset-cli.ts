/**
 * DESTRUCTIVE development reset — `pnpm seed:dev:reset -- --yes`.
 *
 * Empties every application table and re-seeds from scratch. This exists as a
 * SEPARATE command on purpose: `pnpm seed:dev` must never silently delete a
 * reviewer's data, so the only way to lose rows is to type this command and
 * the `--yes` flag.
 *
 * The `migrations` table is preserved — the schema is not rebuilt, only its
 * contents are cleared, so this is a data reset and not a migration reset.
 *
 * IMPORTANT: `../../data-source` must be the FIRST import (tsconfig-paths).
 */
import dataSource from '../../data-source';
import { DevSeedService } from './dev-seed.service';
import { invalidateCatalogCache } from './dev-seed.cache';
import {
  DISPOSABLE_MARKER_TABLE,
  assertDevSeedAllowed,
  assertDisposableMarker,
  assertMigrationsApplied,
  assertResetConfirmed,
  describeTarget,
  formatTarget,
} from './dev-seed.guard';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const target = describeTarget();

  // BOTH are required, and both before a connection is opened: the explicit
  // opt-in that every dev-seed command needs, and the destructive command's
  // own separate confirmation.
  assertDevSeedAllowed(target);
  assertResetConfirmed(process.argv);

  out(`Target: ${formatTarget(target)}`);
  out('Resetting — every application table will be emptied.');

  try {
    await dataSource.initialize();
  } catch (error) {
    throw new Error(
      `Cannot reach the database at ${target.host}:${target.port}. ` +
        `Is the review stack up?\n` +
        `  cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    /*
     * Server-side permission, before the TRUNCATE. A disposable-marker check
     * is what stops this command emptying a database that merely happened to
     * be reachable.
     */
    await assertDisposableMarker(dataSource, target);
    await assertMigrationsApplied(dataSource);

    /*
     * One TRUNCATE across every table except `migrations`. CASCADE handles the
     * foreign keys and RESTART IDENTITY resets the sequences, so a reset
     * database seeds to the same ids every time — which is what makes a
     * reset-then-seed reproducible rather than merely empty.
     *
     * TRUNCATE also side-steps the `payment_actions` append-only trigger,
     * which fires on DELETE but not on TRUNCATE. That is the intended escape
     * hatch for a disposable database, and the reason this is not a DELETE.
     */
    /*
     * `migrations` is preserved because this is a DATA reset, not a schema one.
     *
     * `permissions` is preserved for the same reason, one level down: its rows
     * are not data, they are schema that happens to live in a table. A
     * migration inserts them, only a migration changes them, and the API
     * refuses to start if they do not match the code catalogue — so emptying
     * them here would leave a database that seeds perfectly and then cannot be
     * started. `role_permissions` IS emptied, because custom-role grants are
     * genuinely data; the foreign key runs from the grant to the catalogue, so
     * clearing one without the other is sound.
     *
     * The disposable marker is preserved because truncating it would destroy
     * the very permission that authorises this command — the first run of this
     * reset emptied it and every subsequent seed was then correctly refused. A
     * guard you can erase by running the thing it guards is not a guard.
     */
    const rows: Array<{ table_name: string }> = await dataSource.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name <> 'migrations'
          AND table_name <> 'permissions'
          AND table_name <> $1`,
      [DISPOSABLE_MARKER_TABLE],
    );
    const tables = rows.map((r) => `"public"."${r.table_name}"`);
    if (tables.length) {
      await dataSource.query(
        `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`,
      );
    }
    out(`  emptied ${tables.length} table(s).`);

    const timeZone = process.env.REPORT_TIMEZONE || 'Asia/Tehran';
    const report = await new DevSeedService(dataSource, timeZone).seed();
    out(`  ${await invalidateCatalogCache()}`);

    out();
    out('Reset and re-seed complete.');
    for (const key of Object.keys(report.counts) as Array<
      keyof typeof report.counts
    >) {
      out(`  ${key.padEnd(20)} ${String(report.counts[key]).padStart(6)}`);
    }
    out();
    out(
      '  Credentials: run `pnpm seed:dev` for the account table, or see docs/DEV-SEED.md',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nReset failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
