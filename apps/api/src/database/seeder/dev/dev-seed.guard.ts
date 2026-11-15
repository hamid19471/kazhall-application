import { DataSource } from 'typeorm';

/**
 * The safety rail between a review dataset and somebody's real shop.
 *
 * FAIL CLOSED. The seeder must refuse unless it has POSITIVE evidence that the
 * target is disposable. The earlier version inferred permission instead, and
 * inference is what makes a guard dangerous:
 *
 *  - `NODE_ENV` is unset on plenty of real machines, and this codebase defaults
 *    an unset value to `development`. "Nobody told me this was production" is
 *    not the same fact as "somebody told me this is a review box", so an unset
 *    NODE_ENV now authorises NOTHING on its own.
 *  - A production database is very often just called `kazhal`. Pattern-matching
 *    the NAME for `prod|production|live` catches the careful naming convention
 *    and misses the careless one, which is precisely backwards.
 *
 * So permission now has to be presented, twice, from two independent places:
 *
 *  1. `KAZHAL_ALLOW_DEV_SEED=true` — an explicit statement by whoever ran the
 *     command. It travels with the CLIENT.
 *  2. The `kazhal_disposable_test_server` marker table — planted only by
 *     `docker/review-initdb/00-disposable-marker.sql` when a throwaway
 *     PostgreSQL is first initialised. It travels with the SERVER, so it cannot
 *     be set by accident from a shell.
 *
 * Either alone is weak; a real database would have to satisfy both to be
 * touched. There is deliberately NO force flag, NO bypass and NO production
 * escape hatch: if this refuses, the answer is to point it at a review
 * database, never to argue with it.
 */

/** Opt-in variable. Must be exactly `true`; anything else refuses. */
export const DEV_SEED_OPT_IN_VAR = 'KAZHAL_ALLOW_DEV_SEED';

/**
 * MUST match `docker/review-initdb/00-disposable-marker.sql` and the
 * integration harness (`test/integration/setup/container.ts`). Duplicated here
 * rather than imported because `src/` may not depend on `test/`.
 */
export const DISPOSABLE_MARKER_TABLE = 'kazhal_disposable_test_server';
export const DISPOSABLE_MARKER_TOKEN = 'kazhal-disposable-review-server';

export class ProductionRefusedError extends Error {}
export class OptInMissingError extends Error {}
export class DisposableMarkerError extends Error {}
export class PendingMigrationsError extends Error {}
export class ConfirmationRequiredError extends Error {}

export interface SeedTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  /** `null` when NODE_ENV is genuinely unset — never silently defaulted. */
  nodeEnv: string | null;
  optIn: string | null;
}

export function describeTarget(
  env: NodeJS.ProcessEnv = process.env,
): SeedTarget {
  return {
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_DATABASE ?? 'kazhal',
    username: env.DB_USERNAME ?? 'postgres',
    nodeEnv: env.NODE_ENV ?? null,
    optIn: env[DEV_SEED_OPT_IN_VAR] ?? null,
  };
}

/**
 * `host:port/database as user` — never a password, token, hash or cookie.
 */
export function formatTarget(t: SeedTarget): string {
  return (
    `${t.host}:${t.port}/${t.database} as ${t.username} ` +
    `(NODE_ENV=${t.nodeEnv ?? 'unset'})`
  );
}

/**
 * Client-side permission. Runs BEFORE a connection is opened, so a refused
 * target never even sees a login attempt.
 */
export function assertDevSeedAllowed(target: SeedTarget): void {
  if (target.nodeEnv === 'production') {
    throw new ProductionRefusedError(
      'NODE_ENV=production — the development seeder refuses to run. ' +
        'There is no supported way to seed review data into production.',
    );
  }

  if (target.optIn !== 'true') {
    throw new OptInMissingError(
      `${DEV_SEED_OPT_IN_VAR} is ${
        target.optIn === null ? 'not set' : `"${target.optIn}"`
      } — refusing.\n` +
        `  This command writes fake customers, sales and payment cases. It runs ` +
        `only when you say so explicitly:\n` +
        `      ${DEV_SEED_OPT_IN_VAR}=true pnpm seed:dev\n` +
        `  An unset NODE_ENV is NOT authorisation: this codebase treats unset as ` +
        `"development", and that is an assumption, not a fact about your database.`,
    );
  }
}

interface MarkerRow {
  token?: unknown;
}

/**
 * All the marker check needs: something that can run one parameterised query.
 *
 * Narrower than `DataSource` on purpose — it keeps the guard honest about the
 * fact that it only ever READS, and it lets a test hand in a recorder that
 * proves no statement other than the SELECT was issued.
 */
export interface MarkerQueryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Server-side permission. Runs AFTER connecting and BEFORE the first write or
 * TRUNCATE, because it is the only check that can see which database it is.
 *
 * Every failure mode lands in the same refusal: table absent, no rows, wrong
 * token, malformed row, or the query itself erroring (permissions, a server
 * that has no such relation). Fail closed — an unreadable marker is not a
 * present one.
 */
export async function assertDisposableMarker(
  ds: MarkerQueryable,
  target: SeedTarget,
): Promise<void> {
  const refuse = (why: string): never => {
    throw new DisposableMarkerError(
      `${formatTarget(target)} does not carry the disposable-review marker — refusing.\n` +
        `  ${why}\n` +
        `  Only a PostgreSQL initialised by docker/review-initdb/00-disposable-marker.sql ` +
        `carries table "${DISPOSABLE_MARKER_TABLE}" with token "${DISPOSABLE_MARKER_TOKEN}".\n` +
        `  Start one with:\n` +
        `      docker compose -p kazhal-review -f apps/api/docker-compose.yml \\\n` +
        `        -f apps/api/docker-compose.review.yml up -d --wait`,
    );
  };

  let rows: unknown;
  try {
    rows = await ds.query(
      `SELECT token FROM "public"."${DISPOSABLE_MARKER_TABLE}" WHERE token = $1 LIMIT 1`,
      [DISPOSABLE_MARKER_TOKEN],
    );
  } catch (error) {
    return refuse(
      `The marker table could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return refuse('The marker table holds no row with the expected token.');
  }

  const token = (rows[0] as MarkerRow | null)?.token;
  if (typeof token !== 'string' || token !== DISPOSABLE_MARKER_TOKEN) {
    return refuse(
      `The marker row is malformed: expected token "${DISPOSABLE_MARKER_TOKEN}", got ${JSON.stringify(token)}.`,
    );
  }
}

/** The destructive command needs a second, separate confirmation. */
export function assertResetConfirmed(argv: readonly string[]): void {
  if (!argv.includes('--yes')) {
    throw new ConfirmationRequiredError(
      'Refusing to delete data without confirmation.\n' +
        '  This empties EVERY application table.\n' +
        `  Re-run with:  ${DEV_SEED_OPT_IN_VAR}=true pnpm seed:dev:reset -- --yes`,
    );
  }
}

/**
 * The schema must already be what the migrations say it is. Seeding onto a
 * half-migrated database produces failures that look like seeder bugs.
 */
export async function assertMigrationsApplied(ds: DataSource): Promise<void> {
  if (await ds.showMigrations()) {
    throw new PendingMigrationsError(
      'There are pending migrations. Run `pnpm migration:run` before seeding.',
    );
  }
}
