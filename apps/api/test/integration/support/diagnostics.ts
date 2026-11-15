/**
 * ===========================================================================
 * INTEGRATION-HARNESS DIAGNOSTICS — evidence for intermittent failures
 * ===========================================================================
 *
 * WHY THIS EXISTS. `sales-reporting.int-spec.ts › groups totals by cashier`
 * failed once in five full runs and passed every time it was run on its own.
 * The failing response was never captured, so the only thing anyone could say
 * about it afterwards was "flaky" — which is not a diagnosis, it is the
 * absence of one. An intermittent failure that is not recorded when it happens
 * cannot be reasoned about later, because by then the process, the database
 * and the ordering are all gone.
 *
 * This module records, for every integration test in the run, the facts that
 * would have identified the cause: which database the process was talking to,
 * what the shared tables looked like before and after each test, which users a
 * test created, what every login answered, and how long each phase took. It
 * writes them as JSON Lines to the file named by `KAZHAL_INT_DIAG_FILE`, so a
 * bounded repeat loop can keep the evidence from the one iteration that failed
 * and throw the rest away.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT RECORDED
 * ---------------------------------------------------------------------------
 * No password, token, cookie VALUE, bcrypt hash, OTP, JWT or secret is ever
 * written here. A diagnostic file that leaks a credential is a worse problem
 * than the bug it was opened for, and these files are written to a temporary
 * directory and read by tooling, so "it is only local" is not a safeguard.
 *
 *   - Cookies are recorded by NAME ONLY (`access_token`, `refresh_token`),
 *     never by value, and never by length — length is a side channel.
 *   - Login failures record the server's own `error` CODE and `message`, with
 *     the request body omitted entirely, because that body carries the
 *     password.
 *   - Response bodies are passed through {@link redactBody}, which drops any
 *     key whose name looks like a secret and truncates the rest.
 *
 * ZERO COST WHEN OFF. With `KAZHAL_INT_DIAG_FILE` unset every entry point here
 * returns immediately and no SQL is issued, so a normal `pnpm test:int` is
 * unaffected in behaviour and in timing.
 */
import { appendFileSync } from 'node:fs';
import type { DataSource } from 'typeorm';

const DIAG_FILE_ENV = 'KAZHAL_INT_DIAG_FILE';

/** True only when a caller explicitly asked for evidence. */
export function diagnosticsEnabled(): boolean {
  return Boolean(process.env[DIAG_FILE_ENV]);
}

/**
 * Key names whose VALUES are never written, whatever their type.
 *
 * Matched case-insensitively as a substring, so `newPassword`,
 * `password_hash`, `refreshToken` and `otpCode` are all covered without having
 * to enumerate every spelling the codebase might grow.
 */
const SECRET_KEY_PATTERN =
  /(pass|secret|token|cookie|hash|otp|credential|authorization|jwt|signature)/i;

/** A body is evidence, not a payload: 2 KB of it is plenty and bounds the file. */
const MAX_BODY_CHARS = 2000;

/**
 * Deep-copies a response body with every secret-looking value replaced by a
 * marker. The marker states WHICH rule removed the value so that a reader does
 * not mistake redaction for absence.
 */
export function redactBody(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[redacted: too deep]';
  if (input === null || input === undefined) return input ?? null;
  if (typeof input === 'string') {
    return input.length > MAX_BODY_CHARS
      ? `${input.slice(0, MAX_BODY_CHARS)}…[truncated]`
      : input;
  }
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => redactBody(item, depth + 1));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? '[redacted: secret-shaped key]'
        : redactBody(value, depth + 1);
    }
    return out;
  }
  return `[redacted: ${typeof input}]`;
}

/** Cookie NAMES from a `set-cookie` header. Values are never touched. */
export function cookieNames(header: unknown): string[] {
  const list: string[] = Array.isArray(header)
    ? (header as string[])
    : typeof header === 'string'
      ? [header]
      : [];
  return list
    .map((entry) => entry.split(';', 1)[0]?.split('=', 1)[0]?.trim() ?? '')
    .filter(Boolean);
}

// ===========================================================================
// The event log
// ===========================================================================

export interface DiagnosticEvent {
  /** Milliseconds since the Unix epoch — comparable across suites and runs. */
  at: number;
  /** Milliseconds since this jest PROCESS started — comparable within a run. */
  sinceStart: number;
  pid: number;
  /** The jest test file, so cross-suite ordering is reconstructable. */
  suite: string | null;
  /** `expect.getState().currentTestName` at the moment of the event. */
  test: string | null;
  kind: string;
  [key: string]: unknown;
}

const PROCESS_START = Date.now();

let currentSuite: string | null = null;
let currentTest: string | null = null;

export function setCurrentSuite(name: string | null): void {
  currentSuite = name;
}

export function setCurrentTest(name: string | null): void {
  currentTest = name;
}

/**
 * Appends one event. Synchronous on purpose: an intermittent failure often
 * takes the process down with it, and a buffered writer would lose exactly the
 * last few lines that matter.
 */
export function record(
  kind: string,
  fields: Record<string, unknown> = {},
): void {
  const file = process.env[DIAG_FILE_ENV];
  if (!file) return;
  const event: DiagnosticEvent = {
    at: Date.now(),
    sinceStart: Date.now() - PROCESS_START,
    pid: process.pid,
    suite: currentSuite,
    test: currentTest,
    kind,
    ...fields,
  };
  try {
    appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    /* diagnostics must never fail a test */
  }
}

// ===========================================================================
// Shared-state fingerprint
// ===========================================================================

/**
 * The tables whose contents are shared between suites, or are owned by a
 * migration and must survive `resetDb`.
 *
 * Recording a row count for each of these BEFORE and AFTER every test answers
 * the question the original report could not: "did another suite modify shared
 * roles, permissions, users or cookies?" A count that changes across a test
 * boundary the test itself did not cross is cross-suite leakage, and a
 * `permissions` count that ever moves is a `resetDb` that truncated a
 * migration-owned table.
 */
const SHARED_TABLES = [
  'permissions',
  'role_permissions',
  'roles',
  'users',
  'user_roles',
  'orders',
  'order_items',
  'order_actions',
  'refresh_tokens',
  'branches',
] as const;

export interface SharedStateFingerprint {
  counts: Record<string, number | string>;
  /**
   * Order-independent digest of the permission catalogue. It is the one table
   * `resetDb` must NOT empty, so its identity — not merely its size — is worth
   * carrying.
   */
  permissionDigest: string | null;
  database: string;
  target: string;
  /** The transaction state of the connection the fingerprint was read on. */
  inTransaction: boolean;
}

export async function fingerprintSharedState(
  ds: DataSource,
): Promise<SharedStateFingerprint | null> {
  if (!diagnosticsEnabled()) return null;

  const counts: Record<string, number | string> = {};
  for (const table of SHARED_TABLES) {
    try {
      const rows: Array<{ n: string }> = await ds.query(
        `SELECT COUNT(*)::text AS n FROM "public"."${table}"`,
      );
      counts[table] = Number(rows[0]?.n ?? '0');
    } catch (error) {
      counts[table] = `[unavailable: ${errorLabel(error)}]`;
    }
  }

  let permissionDigest: string | null = null;
  try {
    const rows: Array<{ digest: string | null }> = await ds.query(
      `SELECT md5(string_agg(code, ',' ORDER BY code)) AS digest FROM "public"."permissions"`,
    );
    permissionDigest = rows[0]?.digest ?? null;
  } catch {
    permissionDigest = null;
  }

  let inTransaction = false;
  try {
    const rows: Array<{ s: string }> = await ds.query(
      `SELECT CASE WHEN pg_current_xact_id_if_assigned() IS NULL THEN 'idle' ELSE 'in-transaction' END AS s`,
    );
    inTransaction = rows[0]?.s === 'in-transaction';
  } catch {
    /* older servers: leave false rather than guess */
  }

  const options = ds.options as {
    host?: string;
    port?: number;
    database?: string;
  };
  return {
    counts,
    permissionDigest,
    database: String(options.database ?? ''),
    // Host and port only. No username and no password: the connection target
    // is a fact about the run, the credential is not.
    target: `${options.host ?? ''}:${options.port ?? ''}`,
    inTransaction,
  };
}

/** A short, non-leaking label for an arbitrary thrown value. */
export function errorLabel(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message.slice(0, 300)}`;
  return String(error).slice(0, 300);
}
