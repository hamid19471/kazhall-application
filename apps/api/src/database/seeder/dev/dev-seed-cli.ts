/**
 * Development / review seeder entrypoint — `pnpm seed:dev`.
 *
 * Idempotent and additive. Running it twice leaves every count unchanged; it
 * never deletes anything. To start from an empty database use the separate,
 * explicitly destructive `pnpm seed:dev:reset`.
 *
 * IMPORTANT: `../../data-source` must be the FIRST import — loading it
 * registers tsconfig-paths, which is what makes the `src/...` imports inside
 * the service resolvable under plain `node -r ts-node/register`.
 */
import dataSource from '../../data-source';
import { DevSeedService } from './dev-seed.service';
import { invalidateCatalogCache } from './dev-seed.cache';
import {
  assertDevSeedAllowed,
  assertDisposableMarker,
  assertMigrationsApplied,
  describeTarget,
  formatTarget,
} from './dev-seed.guard';
import { DEV_PASSWORD, SEED_USERS } from './dev-seed.data';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const target = describeTarget();

  // Client-side permission, BEFORE opening a connection: a refused target
  // should not even see a login attempt from this command.
  assertDevSeedAllowed(target);

  out(`Target: ${formatTarget(target)}`);

  try {
    await dataSource.initialize();
  } catch (error) {
    throw new Error(
      `Cannot reach the database at ${target.host}:${target.port}. ` +
        `Is the review stack up? ` +
        `(docker compose -p kazhal-review -f docker-compose.yml -f docker-compose.review.yml up -d --wait)\n` +
        `  cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    /*
     * Server-side permission, before ANY write. This is the only check that can
     * see which database it actually reached, and it is a SELECT — nothing has
     * been mutated by the time it can refuse.
     */
    await assertDisposableMarker(dataSource, target);
    await assertMigrationsApplied(dataSource);

    const timeZone = process.env.REPORT_TIMEZONE || 'Asia/Tehran';
    const seeder = new DevSeedService(dataSource, timeZone);

    const before = await seeder.countAll(dataSource.manager);
    const report = await seeder.seed();
    report.notes.push(await invalidateCatalogCache());

    out();
    out('Seed complete.');
    out();
    out('  entity                before   after   created');
    out('  ------------------------------------------------');
    for (const key of Object.keys(report.counts) as Array<
      keyof typeof report.counts
    >) {
      const b = before[key];
      const a = report.counts[key];
      const made = report.created[key as string] ?? 0;
      out(
        `  ${key.padEnd(20)} ${String(b).padStart(6)}  ${String(a).padStart(6)}` +
          `  ${made === 0 ? '       —' : String(made).padStart(8)}`,
      );
    }

    out();
    out('  DEVELOPMENT / REVIEW ONLY — NEVER USE IN PRODUCTION');
    out(`  Every account below signs in with the password: ${DEV_PASSWORD}`);
    out();
    out('  username                role          branch');
    out('  ----------------------------------------------------------------');
    for (const u of SEED_USERS) {
      out(
        `  ${u.username.padEnd(22)}${u.role.padEnd(14)}` +
          `${u.branch ?? '—'}${u.deactivated ? '   [DEACTIVATED]' : ''}`,
      );
    }
    out();
    out('  API             http://localhost:8000/health');
    out(
      '  Web (customer)  http://localhost:8001/auth/sign-in   — OTP only, see docs/DEV-SEED.md',
    );
    out('  Web (admin)     http://localhost:8001/admin');
    out('  Store (POS)     http://localhost:8002/login');
    out();

    if (report.notes.length) {
      out('  notes:');
      for (const n of report.notes) out(`    - ${n}`);
      out();
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nSeed failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
