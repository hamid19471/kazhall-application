import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import type { MinioState } from './container';
import {
  CONTAINER_LABEL,
  MINIO_IMAGE,
  S3_ACCESS_KEY_ENV,
  S3_BUCKET_ENV,
  S3_ENDPOINT_ENV,
  S3_SECRET_KEY_ENV,
  TEST_STORAGE,
  CONTAINER_STATE_ENV,
  ContainerState,
  DEFAULT_ENV_FILE,
  DISPOSABLE_MARKER_TABLE,
  DISPOSABLE_MARKER_TOKEN,
  PG_ADMIN_URL_ENV,
  PG_ENV_FILE_ENV,
  PG_MODE_ENV,
  POSTGRES_IMAGE,
  REAP_COMMAND,
  TEST_DB,
  externalDatabaseName,
  loadReviewEnvFile,
  newStateFilePath,
  quoteIdent,
  resolveMode,
} from './container';

/**
 * Provides a REAL PostgreSQL for the integration suite, one of two ways.
 *
 * Why a real database and not sqlite/mocks: everything this suite has to prove
 * is PostgreSQL-specific — partial unique indexes, `ON CONFLICT DO NOTHING`,
 * SAVEPOINT semantics after a unique violation, `FOR UPDATE` lock ordering,
 * `UPDATE ... RETURNING` affected-row assertions, enum types, jsonb. None of
 * that is exercised by an in-memory substitute.
 *
 * MODE `docker` (DEFAULT — unchanged behaviour). The harness starts its own
 * disposable container with the docker CLI. `testcontainers` is NOT installed
 * and must not be added. `-P` publishes 5432 on a RANDOM free host port, which
 * is what lets this run next to a developer's compose stack and lets two
 * checkouts run their suites concurrently. Every container is labelled
 * `kazhal-int=1` plus its own run id, so a stray can always be identified and
 * reaped without guessing.
 *
 * MODE `external` (opt-in, for independent review). The harness connects to a
 * PostgreSQL that somebody else provisioned and NEVER SHELLS OUT TO DOCKER AT
 * ALL. A reviewer whose sandbox is denied the Docker socket can still run the
 * whole suite, because all it needs is a TCP connection to a published loopback
 * port. It creates ONE ISOLATED DATABASE PER RUN on that server and drops only
 * that database on teardown; it never stops, removes or inspects a container.
 *
 * External mode FAILS CLOSED. It refuses to run unless the server it was
 * pointed at carries the disposable-server marker (see container.ts), so it
 * cannot be aimed at a developer or production database by a stray environment
 * variable.
 */

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

/**
 * `docker port <id> 5432` prints one line per published binding, e.g.
 *   0.0.0.0:55123
 *   [::]:55123
 * We connect over IPv4, so prefer the IPv4 binding and only fall back to
 * whatever else is offered.
 */
function resolveMappedPort(
  containerId: string,
  containerPort = '5432',
): number {
  const output = docker(['port', containerId, containerPort]);
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const ipv4 = lines.find((line) => !line.startsWith('['));
  for (const line of [ipv4, ...lines]) {
    if (!line) continue;
    const port = Number(line.split(':').pop());
    if (Number.isInteger(port) && port > 0) return port;
  }
  throw new Error(`Could not parse mapped port from: ${output}`);
}

async function waitForPostgres(
  state: ContainerState,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    // If the container died (or someone else removed it) there is no point
    // polling for another 90 seconds — fail with the real reason. Only
    // meaningful in docker mode; in external mode we own no container and must
    // not inspect one.
    if (state.mode === 'docker' && state.containerId) {
      let running = '';
      try {
        running = docker([
          'inspect',
          '-f',
          '{{.State.Running}}',
          state.containerId,
        ]);
      } catch {
        throw new Error(
          `Container ${state.containerId.slice(0, 12)} disappeared while starting up. ` +
            `Another integration run may have removed it; check for strays with:\n  ${REAP_COMMAND}`,
        );
      }
      if (running !== 'true') {
        const logs = docker(['logs', '--tail', '30', state.containerId]);
        throw new Error(`Container exited during startup:\n${logs}`);
      }
    }

    const client = new Client({
      host: state.host,
      port: state.port,
      user: state.username,
      password: state.password,
      database: state.database,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await client.connect();
      // A connectable postgres is not necessarily a ready one during the
      // entrypoint's temporary-server phase; issue a real query.
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(
    `PostgreSQL did not become ready within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

// ===========================================================================
// docker mode — self-provisioned disposable container (the original path)
// ===========================================================================

function setupDocker(runId: string): Omit<ContainerState, 'minio'> {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    throw new Error(
      'Docker is not available. The integration suite needs a running Docker daemon, ' +
        `or an externally provisioned PostgreSQL (${PG_MODE_ENV}=external — see ` +
        'docs/REVIEW-DATABASE.md).',
    );
  }

  const containerId = docker([
    'run',
    '-d',
    '--rm',
    '--label',
    `${CONTAINER_LABEL}=1`,
    '--label',
    `${CONTAINER_LABEL}-run=${runId}`,
    '-e',
    `POSTGRES_PASSWORD=${TEST_DB.password}`,
    '-e',
    `POSTGRES_USER=${TEST_DB.username}`,
    '-e',
    `POSTGRES_DB=${TEST_DB.database}`,
    '-P',
    POSTGRES_IMAGE,
    'postgres',
    // This database is thrown away at the end of the run, so durability buys
    // nothing and costs a lot of wall-clock time.
    '-c',
    'fsync=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'synchronous_commit=off',

    /*
     * =======================================================================
     * NO CONNECTION MAY HOLD LOCKS ACROSS A TEST BOUNDARY — ENFORCED BY THE
     * SERVER, NOT BY EVERY CALLER REMEMBERING
     * =======================================================================
     *
     * `resetDb` TRUNCATEs 28 tables between tests and needs ACCESS EXCLUSIVE
     * on all of them, so one connection sitting `idle in transaction` stalls
     * the entire file. A measured run of `delegated-role-matrix` lost 978 696
     * ms to exactly that — 97.8% of the whole run — with every reset before and
     * after it taking 120-230 ms, and the file completing normally in 4.8 s
     * once the lock cleared.
     *
     * Application-side discipline is necessary but CANNOT be sufficient, and
     * that is the point of setting this here. A transaction can be stranded by
     * a leaked `QueryRunner`, by a multi-statement string that errored before
     * its `COMMIT` (both real defects found and fixed in this pass) — and also
     * by something no amount of care in this repository can reach: a TCP
     * connection silently dropped between the test process and the container.
     * PostgreSQL does not notice a vanished peer; the backend keeps its locks
     * until the kernel exhausts its retransmission budget, which on macOS is
     * ~15-16 minutes. That is the 978-second signature, and no `finally` block
     * can shorten it.
     *
     * `idle_in_transaction_session_timeout` closes the whole class: a backend
     * that opens a transaction and then stops is terminated after 15 seconds,
     * whatever the reason, and its locks are released with it. FIFTEEN
     * seconds, not one: every legitimate transaction in this codebase is a
     * handful of statements with no network call inside it, so nothing real
     * idles for that long — but the harness shares a machine with other suites
     * and a bound tight enough to trip under ordinary I/O contention would
     * trade a rare real failure for a frequent false one. It is deliberately
     * LONGER than `resetDb`'s own 10 s `lock_timeout`, so a blocked reset
     * still fails first and reports WHO was holding the lock, rather than the
     * holder being killed silently and the cause never being learned.
     *
     * The TCP keepalives are the same defence one layer down: they let the
     * server notice a dead peer in ~30 s instead of ~2 hours, so a dropped
     * connection is reaped even if it was idle OUTSIDE a transaction.
     *
     * This is a TEST-CONTAINER setting. It is not a production configuration
     * change, and it is not a retry, a sleep or a suppression: it is an
     * invariant — no transaction idles here — asserted by the server itself
     * and verified in `db-lock-lifecycle.int-spec.ts`.
     */
    '-c',
    'idle_in_transaction_session_timeout=15000',
    '-c',
    'tcp_keepalives_idle=30',
    '-c',
    'tcp_keepalives_interval=10',
    '-c',
    'tcp_keepalives_count=3',
  ]);

  return {
    mode: 'docker',
    runId,
    containerId,
    host: '127.0.0.1',
    port: resolveMappedPort(containerId),
    username: TEST_DB.username,
    password: TEST_DB.password,
    database: TEST_DB.database,
  };
}

// ===========================================================================
// external mode — reviewer-supplied PostgreSQL, no docker involvement
// ===========================================================================

/**
 * THE FAIL-CLOSED GATE.
 *
 * Before any DDL, this asserts that the server we were pointed at carries the
 * disposable-server marker planted by docker/review-initdb. A server that was
 * not built to be thrown away has no such table, so a misdirected
 * `KAZHAL_INT_PG_ADMIN_URL` aborts here instead of creating and dropping
 * databases on somebody's real instance.
 */
async function assertApprovedDisposableTarget(client: Client): Promise<void> {
  const present = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${DISPOSABLE_MARKER_TABLE}`],
  );
  if (!present.rows[0]?.exists) {
    throw new Error(
      `REFUSING TO RUN. The PostgreSQL named by ${PG_ADMIN_URL_ENV} does not carry the ` +
        `disposable-test-server marker (table public.${DISPOSABLE_MARKER_TABLE}).\n` +
        `External mode creates and drops databases, so it will only ever talk to a server ` +
        `that was explicitly built to be thrown away.\n` +
        `Start the review stack and point at it:\n` +
        `  docker compose -p kazhal-review -f docker-compose.yml -f docker-compose.review.yml up -d`,
    );
  }

  const token = await client.query<{ token: string }>(
    `SELECT token FROM public.${DISPOSABLE_MARKER_TABLE} WHERE token = $1`,
    [DISPOSABLE_MARKER_TOKEN],
  );
  if (token.rows.length !== 1) {
    throw new Error(
      `REFUSING TO RUN. public.${DISPOSABLE_MARKER_TABLE} exists but does not contain the ` +
        `expected token ${JSON.stringify(DISPOSABLE_MARKER_TOKEN)}. This is not an approved ` +
        `disposable review target.`,
    );
  }
}

/**
 * THE SAME "NO CONNECTION HOLDS LOCKS ACROSS A TEST BOUNDARY" INVARIANT THAT
 * DOCKER MODE GETS FROM `docker run -c`, APPLIED TO THE PER-RUN DATABASE.
 *
 * Docker mode sets `idle_in_transaction_session_timeout` and the TCP
 * keepalives as SERVER flags on a container it owns outright (see the long
 * comment in `setupDocker`). External mode has no such licence: the server is
 * shared with whatever else a reviewer is running on it, so a server-wide
 * `ALTER SYSTEM` would be this harness reconfiguring somebody else's
 * PostgreSQL. It also cannot simply skip them — without the timeout there is
 * no defence at all against the failure mode the whole lock workstream exists
 * for (a dropped TCP connection leaving a backend holding ACCESS EXCLUSIVE
 * until the kernel gives up retransmitting), and `db-lock-lifecycle.int-spec`
 * asserts the invariant as configuration and FAILS in external mode without
 * it — which is how this gap was found.
 *
 * `ALTER DATABASE` is the exact scope that is both sufficient and permitted:
 * it binds the settings to the disposable `kazhal_int_<runId>` database this
 * harness just created and will drop, it applies to every connection the
 * suite opens (they all connect to that database), and it touches nothing
 * else on the server. The name was generated and re-validated by
 * `externalDatabaseName`, so the interpolation carries nothing the harness did
 * not construct.
 *
 * The values are deliberately IDENTICAL to the docker-mode flags — the point
 * is one invariant with one number, not two modes that behave differently.
 * 15 s stays longer than `resetDb`'s 10 s `lock_timeout` so a blocked reset
 * still fails first and names the holder.
 *
 * NOTE ON `current_setting`: the keepalives report `0` on a unix-socket
 * connection because the kernel option does not apply there. The suite always
 * connects over TCP, where they report the values set here.
 */
async function applyLockLifecycleGuards(
  admin: Client,
  database: string,
): Promise<void> {
  const settings: Array<[string, string]> = [
    ['idle_in_transaction_session_timeout', `'15s'`],
    ['tcp_keepalives_idle', '30'],
    ['tcp_keepalives_interval', '10'],
    ['tcp_keepalives_count', '3'],
  ];
  for (const [name, value] of settings) {
    await admin.query(
      `ALTER DATABASE ${quoteIdent(database)} SET ${name} = ${value}`,
    );
  }
}

async function setupExternal(
  runId: string,
): Promise<Omit<ContainerState, 'minio'>> {
  // The mode came from a real environment variable; the CONNECTION may come
  // from the gitignored local config file so no credential has to be typed on
  // a command line or committed.
  loadReviewEnvFile();

  const adminUrl = process.env[PG_ADMIN_URL_ENV];
  if (!adminUrl) {
    throw new Error(
      `${PG_MODE_ENV}=external requires ${PG_ADMIN_URL_ENV} (a libpq connection URL for the ` +
        `MAINTENANCE database on the disposable review server).\n` +
        `Put it in ${DEFAULT_ENV_FILE} (gitignored), or point ${PG_ENV_FILE_ENV} at another file.`,
    );
  }

  const database = externalDatabaseName(runId);

  const admin = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw new Error(
      `Could not connect to the external review PostgreSQL named by ${PG_ADMIN_URL_ENV}: ` +
        `${String(error)}\nIs the review stack up? ` +
        `docker compose -p kazhal-review -f docker-compose.yml -f docker-compose.review.yml ps`,
    );
  }

  let host: string;
  let port: number;
  let username: string;
  let password: string;
  try {
    await assertApprovedDisposableTarget(admin);

    // The name was generated by externalDatabaseName() and re-validated
    // against the disposable-name pattern inside it, so this interpolation
    // cannot carry anything the harness did not construct itself. It is
    // interpolated because CREATE DATABASE takes an identifier, not a bind
    // parameter.
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);

    await applyLockLifecycleGuards(admin, database);

    // Read the connection parameters back off the live connection rather than
    // re-parsing the URL by hand: whatever libpq resolved is what the tests
    // must use.
    const params = admin as unknown as {
      connectionParameters: {
        host: string;
        port: number;
        user: string;
        password: string;
      };
    };
    host = params.connectionParameters.host;
    port = Number(params.connectionParameters.port);
    username = params.connectionParameters.user;
    password = params.connectionParameters.password;
  } finally {
    await admin.end().catch(() => undefined);
  }

  return {
    mode: 'external',
    runId,
    containerId: null,
    adminUrl,
    host,
    port,
    username,
    password,
    database,
  };
}

// ===========================================================================

/**
 * ===========================================================================
 * DISPOSABLE OBJECT STORAGE.
 *
 * The storage specs run against a REAL S3 implementation, not a mocked SDK. A
 * mock proves that the code calls the methods the mock expects; it cannot tell
 * you that a bucket which does not exist answers `NoSuchBucket`, that the
 * public URL a browser receives is reachable, or that a key survives a round
 * trip. Those are the three things the upload pipeline actually has to get
 * right, and all three are properties of the server rather than of our code.
 *
 * Labelled and torn down exactly like the PostgreSQL container, so a
 * half-finished run leaves nothing behind that `kazhal-int=1` cannot find.
 * ===========================================================================
 */
function setupMinio(runId: string): MinioState | null {
  let containerId: string;
  try {
    containerId = docker([
      'run',
      '-d',
      '--rm',
      '--label',
      `${CONTAINER_LABEL}=1`,
      '--label',
      `${CONTAINER_LABEL}-run=${runId}`,
      '-e',
      `MINIO_ROOT_USER=${TEST_STORAGE.accessKey}`,
      '-e',
      `MINIO_ROOT_PASSWORD=${TEST_STORAGE.secretKey}`,
      '-P',
      MINIO_IMAGE,
      'server',
      '/data',
    ]);
  } catch (error) {
    // Storage is optional — see ContainerState.minio. A machine that cannot
    // pull or run this image still runs every other spec.
    process.stderr.write(
      `[int] WARNING: could not start ${MINIO_IMAGE}; storage specs will skip. ${String(error)}\n`,
    );
    return null;
  }

  const port = resolveMappedPort(containerId, '9000');
  return {
    containerId,
    endpoint: `http://127.0.0.1:${port}`,
    accessKey: TEST_STORAGE.accessKey,
    secretKey: TEST_STORAGE.secretKey,
    bucket: TEST_STORAGE.bucket,
  };
}

/** An endpoint somebody else provisioned (external mode). */
function adoptExternalMinio(): MinioState | null {
  const endpoint = process.env[S3_ENDPOINT_ENV]?.trim();
  const accessKey = process.env[S3_ACCESS_KEY_ENV]?.trim();
  const secretKey = process.env[S3_SECRET_KEY_ENV]?.trim();
  if (!endpoint || !accessKey || !secretKey) return null;
  return {
    containerId: null,
    endpoint,
    accessKey,
    secretKey,
    bucket: process.env[S3_BUCKET_ENV]?.trim() || TEST_STORAGE.bucket,
  };
}

async function waitForMinio(state: MinioState): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'never attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${state.endpoint}/minio/health/live`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `MinIO at ${state.endpoint} did not become ready within 60s (${lastError}).`,
  );
}

/**
 * Create the bucket.
 *
 * DONE BY THE HARNESS, NEVER BY THE APPLICATION. That is the same rule the
 * production design follows — bucket provisioning is a deployment act, and an
 * API that creates buckets on demand turns a typo in `S3_BUCKET` into a new
 * empty bucket that silently accepts uploads nobody can find. The harness IS
 * the deployment here, so it does it.
 *
 * Idempotent: an existing bucket (external mode, reusing a stack) is accepted.
 */
async function createTestBucket(state: MinioState): Promise<void> {
  const { S3Client, CreateBucketCommand, PutBucketPolicyCommand } =
    await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: state.endpoint,
    credentials: {
      accessKeyId: state.accessKey,
      secretAccessKey: state.secretKey,
    },
    forcePathStyle: true,
  });

  try {
    try {
      await client.send(new CreateBucketCommand({ Bucket: state.bucket }));
    } catch (error) {
      // Idempotent: an existing bucket (external mode, reusing a stack) is fine.
      const name = (error as { name?: string }).name ?? '';
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw error;
      }
    }

    /*
     * ANONYMOUS READ, exactly as `docker compose` configures the developer
     * stack (`mc anonymous set download`). The published URL is meant to be
     * fetched by a customer's browser with no credentials, so a spec asserting
     * "this URL actually serves the image" has to run against a bucket
     * configured the way the documented one is.
     *
     * OUTSIDE the create/catch above, deliberately: applying it only when the
     * bucket was freshly created would silently skip it whenever the bucket
     * already existed, which is exactly the shape of bug that makes a policy
     * "work on my machine".
     *
     * Whether PRODUCTION serves images from a public bucket or through signed
     * URLs is the owner's decision and is not implied by this.
     */
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: state.bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${state.bucket}/*`],
            },
          ],
        }),
      }),
    );
  } finally {
    client.destroy();
  }
}

export default async function globalSetup(): Promise<void> {
  const mode = resolveMode();
  const { path: stateFile, runId } = newStateFilePath();

  const base =
    mode === 'external' ? await setupExternal(runId) : setupDocker(runId);
  const state: ContainerState = {
    ...base,
    minio: mode === 'external' ? adoptExternalMinio() : setupMinio(runId),
  };

  // Publish first: if readiness polling throws, globalTeardown still has
  // enough to clean up with.
  process.env[CONTAINER_STATE_ENV] = stateFile;
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

  await waitForPostgres(state);

  process.env.NODE_ENV = 'test';
  process.env.DB_HOST = state.host;
  process.env.DB_PORT = String(state.port);
  process.env.DB_USERNAME = state.username;
  process.env.DB_PASSWORD = state.password;
  process.env.DB_DATABASE = state.database;

  // Deterministic secrets so config validation passes without a developer .env.
  process.env.JWT_SECRET_KEY ??= 'integration-test-jwt-secret-key-0123456789';
  process.env.OTP_HMAC_SECRET ??= 'integration-test-otp-hmac-secret-0123456789';
  process.env.JWT_ACCESS_EXPIRATION ??= '15m';
  process.env.JWT_REFRESH_EXPIRATION ??= '2d';
  // The bootstrap seeder must not fire behind the tests' backs.
  process.env.SEED_ON_BOOTSTRAP ??= 'false';

  /*
   * Publish storage configuration the same way the database's is published, so
   * an application built by `createTestApp` resolves it through the ordinary
   * `StorageModule` factory rather than through a test-only override. What the
   * specs exercise is therefore the real boot path.
   *
   * The PUBLIC base deliberately differs from the endpoint — it points at the
   * same server but through a distinguishable path — so a spec can prove a
   * stored URL is built from `S3_PUBLIC_BASE_URL` and never from the internal
   * endpoint.
   */
  if (state.minio) {
    await waitForMinio(state.minio);
    await createTestBucket(state.minio);

    process.env.S3_ENDPOINT = state.minio.endpoint;
    process.env.S3_PUBLIC_BASE_URL = `${state.minio.endpoint}/${state.minio.bucket}`;
    process.env.S3_ACCESS_KEY = state.minio.accessKey;
    process.env.S3_SECRET_KEY = state.minio.secretKey;
    process.env.S3_BUCKET = state.minio.bucket;
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_FORCE_PATH_STYLE = 'true';
  }

  const provenance =
    state.mode === 'docker'
      ? `self-provisioned ${POSTGRES_IMAGE} container ${state.containerId!.slice(0, 12)}`
      : `EXTERNAL server (no docker involved), database ${state.database}`;
  process.stdout.write(
    `\n[int] run ${runId}: PostgreSQL ready on ${state.host}:${state.port} — ${provenance}\n`,
  );
  process.stdout.write(
    state.minio
      ? `[int] run ${runId}: object storage ready on ${state.minio.endpoint} (bucket ${state.minio.bucket})\n`
      : `[int] run ${runId}: NO object storage — storage specs will skip\n`,
  );
}
