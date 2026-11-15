import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { Client } from 'pg';
import {
  CONTAINER_LABEL,
  ContainerState,
  PG_KEEP_DB_ENV,
  assertDisposableDatabaseName,
  currentStateFilePath,
  quoteIdent,
} from './container';

/**
 * Undoes exactly what THIS run's globalSetup created, and nothing else.
 *
 * docker mode   — removes the container id recorded in this run's own handle
 *                 file (published through KAZHAL_INT_STATE_FILE). A previous
 *                 version read a shared, machine-wide handle path and so could
 *                 remove a container belonging to a concurrently running suite.
 *                 The container is started with `--rm`, so `docker rm -f` both
 *                 stops and removes it and its anonymous volume.
 *
 * external mode — drops ONLY the per-run database `kazhal_int_<runId>` that
 *                 setup created, and NEVER touches the container hosting it.
 *                 The review stack is externally managed: stopping it would
 *                 take the reviewer's database out from under them, and it is
 *                 not ours to stop. No docker command is executed on this path
 *                 at all, which is the point — external mode must work without
 *                 Docker socket access.
 *
 * Failures here are logged rather than thrown: a teardown error must not turn a
 * green suite red. A leaked container is visible via its `kazhal-int=1` label; a
 * leaked database is visible by its `kazhal_int_` name prefix.
 */

function teardownDockerContainer(state: ContainerState): void {
  removeLabelledContainer(state.containerId, state.runId);
}

/**
 * Remove a container this run started, refusing if the label says otherwise.
 *
 * Shared by the database and the object-storage containers: a recycled docker
 * id must never let one run's teardown take out another run's service, and
 * that guarantee should not exist in only one of the two places.
 */
function removeLabelledContainer(
  containerId: string | null,
  runId: string,
): void {
  if (!containerId) return;
  try {
    // Belt and braces: only remove it if it still carries this run's label,
    // so a recycled container id can never take out someone else's database.
    const label = execFileSync(
      'docker',
      [
        'inspect',
        '-f',
        `{{index .Config.Labels "${CONTAINER_LABEL}-run"}}`,
        containerId,
      ],
      { encoding: 'utf8' },
    ).trim();

    if (label && label !== runId) {
      process.stderr.write(
        `[int] refusing to remove ${containerId.slice(0, 12)}: it belongs to run ${label}, not ${runId}\n`,
      );
      return;
    }
    execFileSync('docker', ['rm', '-f', containerId], {
      stdio: 'ignore',
    });
    process.stdout.write(
      `[int] run ${runId}: removed container ${containerId.slice(0, 12)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[int] WARNING: could not remove container ${containerId}: ${String(error)}\n`,
    );
  }
}

async function teardownExternalDatabase(state: ContainerState): Promise<void> {
  if (!state.adminUrl) return;

  // Escape hatch for a reviewer who wants to inspect the schema and data the
  // run produced. Named loudly because a kept database is a leak until dropped.
  if (process.env[PG_KEEP_DB_ENV] === '1') {
    process.stdout.write(
      `[int] run ${state.runId}: ${PG_KEEP_DB_ENV}=1 — KEEPING database ${state.database}. ` +
        `Drop it yourself when finished:\n` +
        `  DROP DATABASE ${quoteIdent(state.database)};\n`,
    );
    return;
  }

  // Re-validated here, not merely trusted from the state file: teardown is the
  // destructive half, so it re-proves the name is one this harness generates
  // before it will drop anything.
  try {
    assertDisposableDatabaseName(state.database);
  } catch (error) {
    process.stderr.write(`[int] ${String(error)}\n`);
    return;
  }

  const admin = new Client({
    connectionString: state.adminUrl,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await admin.connect();
    // A worker that did not close its pool cleanly leaves backends attached,
    // and DROP DATABASE fails while any session is connected. Terminate only
    // sessions on OUR per-run database.
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [state.database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(state.database)}`);
    process.stdout.write(
      `[int] run ${state.runId}: dropped database ${state.database} (external server left running)\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[int] WARNING: could not drop database ${state.database}: ${String(error)}\n`,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export default async function globalTeardown(): Promise<void> {
  const stateFile = currentStateFilePath();
  if (!stateFile || !existsSync(stateFile)) return;

  let state: ContainerState | undefined;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as ContainerState;
  } catch {
    /* unreadable state file — nothing we can do */
  }

  if (state) {
    if (state.mode === 'external') await teardownExternalDatabase(state);
    else teardownDockerContainer(state);

    // Independent of the database's mode: in `external` mode the endpoint was
    // adopted rather than started, and `containerId` is null, so this is a
    // no-op and the reviewer's own stack is left alone.
    removeLabelledContainer(state.minio?.containerId ?? null, state.runId);
  }

  try {
    unlinkSync(stateFile);
  } catch {
    /* already gone */
  }
}
