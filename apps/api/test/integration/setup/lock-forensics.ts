import { DataSource, DataSourceOptions } from 'typeorm';
import { testDataSourceOptions } from './test-db';
import { record } from '../support/diagnostics';

/**
 * ===========================================================================
 * WHO IS HOLDING THE LOCK
 * ===========================================================================
 *
 * `resetDb` truncates 28 tables between tests, which needs ACCESS EXCLUSIVE on
 * every one of them. Any other connection holding ANY lock on ANY of those
 * tables — including the ACCESS SHARE that a plain `SELECT` takes — makes the
 * TRUNCATE queue behind it.
 *
 * A measured run of `delegated-role-matrix` showed ONE reset taking 978 696 ms
 * where every other reset in the same file took 130-230 ms. `lock_timeout`
 * turns that into a prompt failure, but a prompt failure that says "somebody
 * was holding a lock" names no culprit and cannot be acted on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CAPTURE RUNS *DURING* THE TRUNCATE, NOT AFTER IT FAILS
 *
 * By the time `lock_timeout` fires, the blocker has often finished — the
 * evidence is gone precisely because the wait ended. So the capture is armed as
 * a WATCHDOG: the TRUNCATE is issued, and if it has not returned within
 * {@link FORENSICS_DELAYS_MS}, a snapshot is taken while the block is still
 * live. A reset that completes normally cancels the watchdog and costs nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT USES ITS OWN CONNECTION POOL
 *
 * The blocked TRUNCATE is running on a connection from the application's pool.
 * Asking that same pool for another connection can queue behind the very
 * saturation being diagnosed, and would then time out instead of reporting.
 * This module keeps a tiny pool of its own (`max: 2`), created lazily on first
 * use and closed by `closeLockForensics()` in globalTeardown.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CAPTURED, AND WHY EACH FIELD EARNS ITS PLACE
 *
 *   pid, state, wait_event_type/wait_event   what the backend is doing now
 *   backend_type                             separates a client backend from
 *                                            autovacuum, which also takes locks
 *                                            and is NOT a leak
 *   xact_start, state_change, query_start    an `idle in transaction` backend
 *                                            with an old `xact_start` is a
 *                                            LEAKED TRANSACTION; a `active`
 *                                            backend with a recent query_start
 *                                            is merely slow
 *   query                                    the statement that took the lock
 *   application_name                         set per-suite by `tagConnection`,
 *                                            so the row names the SUITE that
 *                                            leaked it
 *   client_addr, client_port, datname        distinguishes this test process
 *                                            from a stray psql or another
 *                                            concurrently running suite
 *   locktype/relation/mode/granted           which table, which lock mode, and
 *                                            whether it is held or waited on
 *
 * Nothing here mutates anything. There is deliberately no `pg_terminate_backend`
 * and no `pg_cancel_backend`: killing the holder would hide the defect behind a
 * green run, which is the opposite of the point.
 */

/** When to snapshot, measured from the moment the TRUNCATE is issued. */
export const FORENSICS_DELAYS_MS = [2_000, 6_000] as const;

/** One backend, as PostgreSQL sees it. */
export interface BackendSnapshot {
  pid: number;
  datname: string | null;
  state: string | null;
  backendType: string | null;
  applicationName: string | null;
  clientAddr: string | null;
  clientPort: number | null;
  waitEventType: string | null;
  waitEvent: string | null;
  xactStart: string | null;
  queryStart: string | null;
  stateChange: string | null;
  xactAgeMs: number | null;
  queryAgeMs: number | null;
  blockedBy: number[];
  query: string | null;
}

/** One lock row, joined to the table it is on. */
export interface LockSnapshot {
  pid: number;
  locktype: string;
  relation: string | null;
  mode: string;
  granted: boolean;
}

export interface LockForensics {
  capturedAfterMs: number;
  selfPid: number | null;
  backends: BackendSnapshot[];
  locks: LockSnapshot[];
  /** PIDs that are blocking somebody, with nobody blocking them. */
  rootBlockers: number[];
}

let pool: DataSource | null = null;

async function forensicsPool(): Promise<DataSource> {
  if (pool?.isInitialized) return pool;
  pool = new DataSource({
    ...testDataSourceOptions(),
    // Its own pool, so a saturated application pool cannot starve the
    // diagnosis of the saturation.
    extra: { max: 2 },
    // No entities are needed to read the catalogue views, and loading them
    // would make this module depend on the schema it is diagnosing.
    entities: [],
    migrations: [],
    // Names itself in `pg_stat_activity`, so the diagnosis never mistakes the
    // observer for a suspect.
    applicationName: 'kazhal-lock-forensics',
  } as DataSourceOptions);
  await pool.initialize();
  return pool;
}

/** Closes the forensics pool. Safe to call when it was never opened. */
export async function closeLockForensics(): Promise<void> {
  if (pool?.isInitialized) await pool.destroy();
  pool = null;
}

interface RawBackend {
  pid: number;
  datname: string | null;
  state: string | null;
  backend_type: string | null;
  application_name: string | null;
  client_addr: string | null;
  client_port: number | null;
  wait_event_type: string | null;
  wait_event: string | null;
  xact_start: string | null;
  query_start: string | null;
  state_change: string | null;
  xact_age_ms: string | null;
  query_age_ms: string | null;
  blocked_by: number[] | null;
  query: string | null;
}

interface RawLock {
  pid: number;
  locktype: string;
  relation: string | null;
  mode: string;
  granted: boolean;
}

/**
 * Reads `pg_stat_activity` and `pg_locks` for the database under test.
 *
 * Scoped to `current_database()` so a concurrently running suite — which has
 * its own container and its own database — cannot appear as a suspect.
 */
export async function captureLockState(
  capturedAfterMs: number,
): Promise<LockForensics> {
  const ds = await forensicsPool();

  const backends = await ds.query<RawBackend[]>(`
    SELECT a.pid,
           a.datname,
           a.state,
           a.backend_type,
           a.application_name,
           host(a.client_addr) AS client_addr,
           a.client_port,
           a.wait_event_type,
           a.wait_event,
           a.xact_start::text   AS xact_start,
           a.query_start::text  AS query_start,
           a.state_change::text AS state_change,
           round(extract(epoch from (now() - a.xact_start))  * 1000)::text AS xact_age_ms,
           round(extract(epoch from (now() - a.query_start)) * 1000)::text AS query_age_ms,
           pg_blocking_pids(a.pid) AS blocked_by,
           left(regexp_replace(a.query, '\\s+', ' ', 'g'), 400) AS query
      FROM pg_stat_activity a
     WHERE a.datname = current_database()
       AND a.pid <> pg_backend_pid()
     ORDER BY a.pid
  `);

  const locks = await ds.query<RawLock[]>(`
    SELECT l.pid,
           l.locktype,
           CASE WHEN l.relation IS NOT NULL
                THEN l.relation::regclass::text
                ELSE NULL END AS relation,
           l.mode,
           l.granted
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE a.datname = current_database()
       AND l.locktype IN ('relation', 'transactionid', 'advisory')
     ORDER BY l.granted, l.pid
  `);

  const [self] = await ds.query<Array<{ pid: number }>>(
    `SELECT pg_backend_pid() AS pid`,
  );

  const mapped: BackendSnapshot[] = backends.map((row) => ({
    pid: row.pid,
    datname: row.datname,
    state: row.state,
    backendType: row.backend_type,
    applicationName: row.application_name,
    clientAddr: row.client_addr,
    clientPort: row.client_port,
    waitEventType: row.wait_event_type,
    waitEvent: row.wait_event,
    xactStart: row.xact_start,
    queryStart: row.query_start,
    stateChange: row.state_change,
    xactAgeMs: row.xact_age_ms === null ? null : Number(row.xact_age_ms),
    queryAgeMs: row.query_age_ms === null ? null : Number(row.query_age_ms),
    blockedBy: row.blocked_by ?? [],
    query: row.query,
  }));

  // A ROOT blocker blocks somebody and is blocked by nobody: the head of the
  // chain, and the only backend worth naming in a failure message.
  const blocking = new Set<number>();
  for (const backend of mapped) {
    for (const pid of backend.blockedBy) blocking.add(pid);
  }
  const blockedPids = new Set(
    mapped.filter((b) => b.blockedBy.length > 0).map((b) => b.pid),
  );
  const rootBlockers = [...blocking].filter((pid) => !blockedPids.has(pid));

  return {
    capturedAfterMs,
    selfPid: self?.pid ?? null,
    backends: mapped,
    locks: locks.map((row) => ({
      pid: row.pid,
      locktype: row.locktype,
      relation: row.relation,
      mode: row.mode,
      granted: row.granted,
    })),
    rootBlockers,
  };
}

/**
 * Runs `work`, and if it has not settled by each delay, snapshots the database.
 *
 * The snapshots are recorded through the diagnostics channel (inert unless
 * `KAZHAL_INT_DIAG_FILE` is set) AND returned, so a failure message can name
 * the blocker even when diagnostics are off.
 */
export async function withLockWatchdog<T>(
  label: string,
  work: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; captures: LockForensics[] }> {
  const captures: LockForensics[] = [];
  let settled = false;

  const timers = FORENSICS_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      if (settled) return;
      void captureLockState(delay)
        .then((snapshot) => {
          if (settled) return;
          captures.push(snapshot);
          record('lockForensics', { label, ...snapshot });
        })
        .catch((error) => {
          record('lockForensicsFailed', { label, delay, error: String(error) });
        });
    }, delay),
  );
  // The watchdog must never be the reason a test process stays alive.
  for (const timer of timers) timer.unref?.();

  try {
    const result = await work();
    return { result, captures };
  } catch (error) {
    return { error, captures };
  } finally {
    settled = true;
    for (const timer of timers) clearTimeout(timer);
  }
}

/** A short, readable account of who was blocking, for an error message. */
export function describeBlockers(captures: LockForensics[]): string {
  const latest = captures[captures.length - 1];
  if (!latest) {
    return 'no forensic snapshot was taken (the block cleared before the watchdog fired)';
  }
  const byPid = new Map(latest.backends.map((b) => [b.pid, b]));
  const suspects =
    latest.rootBlockers.length > 0
      ? latest.rootBlockers
      : latest.backends
          .filter((b) => b.state === 'idle in transaction')
          .map((b) => b.pid);

  if (suspects.length === 0) {
    return (
      `no backend was reported as blocking, and none was idle in transaction. ` +
      `${latest.backends.length} backend(s) on this database: ` +
      latest.backends
        .map(
          (b) =>
            `pid ${b.pid} ${b.state ?? '?'} (${b.applicationName ?? 'unnamed'})`,
        )
        .join('; ')
    );
  }

  return suspects
    .map((pid) => {
      const b = byPid.get(pid);
      if (!b) return `pid ${pid} (gone by capture time)`;
      const held = latest.locks
        .filter((l) => l.pid === pid && l.granted && l.relation)
        .map((l) => `${l.relation}:${l.mode}`);
      return (
        `pid ${pid} [${b.applicationName ?? 'unnamed'}] state=${b.state ?? '?'} ` +
        `backend=${b.backendType ?? '?'} ` +
        `wait=${b.waitEventType ?? '-'}/${b.waitEvent ?? '-'} ` +
        `xact_age=${b.xactAgeMs ?? '-'}ms query_age=${b.queryAgeMs ?? '-'}ms ` +
        `from=${b.clientAddr ?? '?'}:${b.clientPort ?? '?'} ` +
        `holds=[${held.join(', ') || 'none'}] ` +
        `query=${JSON.stringify(b.query)}`
      );
    })
    .join('\n  ');
}
