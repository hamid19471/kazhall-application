import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Handshake between jest's globalSetup, globalTeardown and the test workers.
 *
 * PER RUN, NOT PER MACHINE. This used to be a single fixed path
 * (`$TMPDIR/kazhal-int-postgres.json`). Two `pnpm test:int` runs at the same
 * time then shared one handle: the second run's setup overwrote it, and the
 * first run's teardown read the second run's container id and `docker rm -f`'d
 * a container that was still under test — the other suite died with
 * ECONNREFUSED and both containers leaked.
 *
 * The path is now unique per run and published through an environment
 * variable, which globalSetup, the workers and globalTeardown all inherit from
 * the same jest process.
 */
export const CONTAINER_STATE_ENV = 'KAZHAL_INT_STATE_FILE';

/** Marks every container this harness starts, so strays are reapable. */
export const CONTAINER_LABEL = 'kazhal-int';

// ===========================================================================
// Provisioning mode
// ===========================================================================

/**
 * Where the integration suite's PostgreSQL comes from.
 *
 * `docker`   (DEFAULT, unchanged) — the harness starts its own throwaway
 *            container through the docker CLI and removes it on teardown. This
 *            is the mode CI and every existing workflow uses, and it stays the
 *            default precisely so that nothing about the review mode below can
 *            change what `pnpm test:int` already does.
 *
 * `external` — the harness connects to a PostgreSQL somebody else provisioned
 *            (the `kazhal-review` compose stack) and never invokes docker at
 *            all. This exists because a reviewer's sandbox may be denied access
 *            to the Docker socket: starting Compose gives them a database, but
 *            it does NOT grant `docker run`. In external mode the suite needs
 *            only a TCP connection, so the socket restriction stops mattering.
 *
 * The mode is read ONLY from a real environment variable, never from the local
 * config file. A config file that could flip the mode would mean the presence
 * of a file on disk silently redirected `pnpm test:int` at a shared server —
 * opting in has to be an explicit act.
 */
export type IntPgMode = 'docker' | 'external';

export const PG_MODE_ENV = 'KAZHAL_INT_PG_MODE';
export const PG_ADMIN_URL_ENV = 'KAZHAL_INT_PG_ADMIN_URL';
export const PG_ENV_FILE_ENV = 'KAZHAL_INT_ENV_FILE';
export const PG_KEEP_DB_ENV = 'KAZHAL_INT_KEEP_DB';

/** Default location of the gitignored local review connection config. */
export const DEFAULT_ENV_FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  '.env.review.local',
);

export function resolveMode(): IntPgMode {
  const raw = (process.env[PG_MODE_ENV] ?? 'docker').trim().toLowerCase();
  if (raw === 'docker' || raw === '') return 'docker';
  if (raw === 'external') return 'external';
  throw new Error(
    `${PG_MODE_ENV} must be "docker" or "external" (got ${JSON.stringify(raw)}).`,
  );
}

/**
 * Minimal `.env` reader for the review connection file.
 *
 * `dotenv` is only a transitive dependency of @nestjs/config and is not
 * resolvable from this package under pnpm's strict layout, so the same tiny
 * parser used by src/database/data-source.ts is repeated here rather than a
 * dependency being added for six lines of work. Values already present in
 * process.env always win, so an explicit CLI variable beats the file.
 */
export function loadReviewEnvFile(
  file = process.env[PG_ENV_FILE_ENV] ?? DEFAULT_ENV_FILE,
): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ===========================================================================
// Fail-closed gate for external mode
// ===========================================================================

/**
 * The table and token an approved disposable review server carries, planted by
 * docker/review-initdb/00-disposable-marker.sql when the server's data
 * directory is first initialised.
 *
 * WHY A SERVER-SIDE MARKER AND NOT AN ENVIRONMENT FLAG. An env var travels with
 * the CLIENT: a stray `KAZHAL_INT_PG_MODE=external` in a shell, plus a
 * DB_HOST/DB_PORT left over from something else, is all it would take to point
 * a suite that creates and drops databases at a real server. This marker
 * travels with the SERVER and only exists on one that was built to be thrown
 * away. If the marker is absent, external mode aborts before issuing a single
 * DDL statement.
 */
export const DISPOSABLE_MARKER_TABLE = 'kazhal_disposable_test_server';
export const DISPOSABLE_MARKER_TOKEN = 'kazhal-disposable-review-server';

/**
 * Every database this harness creates is named `kazhal_int_<runId>`.
 *
 * ONE ISOLATED DATABASE PER RUN. Sharing a single database between runs would
 * mean `resetDb()`'s TRUNCATE could collide with a concurrent run, and it would
 * put this suite's tables in the same namespace as anything else on the server.
 * A per-run database also makes teardown a single `DROP DATABASE` whose target
 * name the harness itself generated — it can never name a database it did not
 * create.
 */
export const EXTERNAL_DB_PREFIX = 'kazhal_int_';
const EXTERNAL_DB_NAME_RE = /^kazhal_int_[a-z0-9_]{1,40}$/;

export function externalDatabaseName(runId: string): string {
  const name = `${EXTERNAL_DB_PREFIX}${runId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
  assertDisposableDatabaseName(name);
  return name;
}

/**
 * Guard applied on BOTH sides — before CREATE and again before DROP. Teardown
 * re-validates rather than trusting the state file, so a hand-edited or
 * corrupted handle cannot turn the drop into a weapon.
 */
export function assertDisposableDatabaseName(name: string): void {
  if (!EXTERNAL_DB_NAME_RE.test(name)) {
    throw new Error(
      `Refusing to create or drop database ${JSON.stringify(name)}: external mode ` +
        `only ever touches databases matching ${EXTERNAL_DB_NAME_RE}. This is the ` +
        `guard that stops the suite dropping a database it did not create.`,
    );
  }
}

/** `"kazhal_int_x"` — quoted for use as a SQL identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ContainerState {
  /** Which provisioning path produced this database. */
  mode: IntPgMode;
  runId: string;
  /** docker mode only; null in external mode — nothing was containerised by us. */
  containerId: string | null;
  /**
   * external mode only. Connection string for the MAINTENANCE database used to
   * CREATE and DROP the per-run database. Never used by the tests themselves.
   */
  adminUrl?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /**
   * The disposable object storage this run provisioned, or `null` when none is
   * available.
   *
   * OPTIONAL ON PURPOSE. Almost a thousand specs have nothing to do with
   * images, and making every one of them wait for a second container would be
   * a poor trade. Only the storage specs require it, and they say so out loud
   * rather than passing vacuously — see `requireStorage()`.
   */
  minio: MinioState | null;
}

/** A disposable S3-compatible endpoint, provisioned per run. */
export interface MinioState {
  /** `null` when the endpoint was supplied externally rather than started by us. */
  containerId: string | null;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/**
 * Pinned to the SAME release as `docker-compose.yml`, and already cached on
 * this machine. Two different MinIO versions between the developer stack and
 * the test harness is exactly the difference that makes a failure impossible
 * to reproduce.
 */
export const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';

export const TEST_STORAGE = {
  accessKey: 'kazhal_int_key',
  /** MinIO refuses a root password shorter than 8 characters. */
  secretKey: 'kazhal_int_secret',
  bucket: 'kazhal-int-products',
} as const;

/**
 * Opt-in endpoint for `external` mode, where the harness never runs docker.
 * A reviewer who has the compose stack up can point the storage specs at its
 * MinIO; without it they skip rather than fail.
 */
export const S3_ENDPOINT_ENV = 'KAZHAL_INT_S3_ENDPOINT';
export const S3_ACCESS_KEY_ENV = 'KAZHAL_INT_S3_ACCESS_KEY';
export const S3_SECRET_KEY_ENV = 'KAZHAL_INT_S3_SECRET_KEY';
export const S3_BUCKET_ENV = 'KAZHAL_INT_S3_BUCKET';

/**
 * postgres:17-alpine is ALREADY CACHED on this machine. Do not change the tag:
 * a different tag would force a network pull that CI may not be able to do.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

export const TEST_DB = {
  username: 'postgres',
  password: 'kazhal_test_pw',
  database: 'kazhal_test',
} as const;

export function newStateFilePath(): { path: string; runId: string } {
  const runId = `${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`;
  return { path: join(tmpdir(), `kazhal-int-postgres-${runId}.json`), runId };
}

/** Path published by this run's globalSetup, if any. */
export function currentStateFilePath(): string | undefined {
  return process.env[CONTAINER_STATE_ENV];
}

/**
 * Reap every container this harness has ever started, whoever started it:
 *
 *   docker rm -f $(docker ps -aq --filter label=kazhal-int=1)
 *
 * Safe only when no integration run is in flight. Applies to `docker` mode
 * only — external mode never creates a container, so there is nothing to reap.
 */
export const REAP_COMMAND = `docker rm -f $(docker ps -aq --filter label=${CONTAINER_LABEL}=1)`;
