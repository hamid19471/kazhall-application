import { randomInt } from 'node:crypto';

/**
 * ===========================================================================
 * FIXTURE IDENTIFIERS THAT CANNOT COLLIDE
 * ===========================================================================
 *
 * WHAT WAS WRONG WITH THE OLD ONE.
 *
 *   let counter = 0;
 *   export function uniqueSuffix() {
 *     counter += 1;
 *     return `${process.pid.toString(36)}${counter}`;
 *   }
 *
 * Two independent defects, both latent:
 *
 * 1. THE COUNTER RESTARTS, THE PREFIX DOES NOT. Jest gives every TEST FILE a
 *    fresh module registry, so `counter` went back to 0 for each file while
 *    `process.pid` stayed the same. Every suite therefore generated the
 *    identical sequence `user_<pid>1`, `user_<pid>2`, … One measured run
 *    produced 225 distinct usernames for 836 `createUser` calls — `user_16i31`
 *    was generated 24 times. It only ever worked because `resetDb()` truncates
 *    `users` between tests, so the duplicates were never alive at the same
 *    moment. Anything that changed that — a suite building fixtures in
 *    `beforeAll`, a case that skips the reset, a future parallel worker — turns
 *    it into a unique-violation in a fixture, which surfaces as an
 *    incomprehensible failure in whatever test happened to run second.
 *
 * 2. THE MOBILE TRUNCATED. `` `0912${suffix}`.slice(0, 11) `` with a 4-character
 *    base-36 pid leaves exactly 3 characters for the counter, so counter 1000
 *    produced the same 11-character string as counter 100 — on a column with a
 *    UNIQUE constraint. The highest per-file counter measured was 251, so it
 *    had not fired yet. The margin was 4x, not the "never" it looked like.
 *
 * ---------------------------------------------------------------------------
 * THE REPLACEMENT, AND WHY EACH PART IS THERE
 *
 * An identifier is `<worker><run><sequence>`:
 *
 *   worker    1 digit   `JEST_WORKER_ID`, which jest assigns 1..N and which is
 *                       distinct per worker PROCESS. This PARTITIONS the space
 *                       between concurrent workers, so cross-worker uniqueness
 *                       is structural rather than probabilistic.
 *   run       3 digits  cryptographically random, allocated ONCE per process.
 *                       Covers the cases the worker id cannot: more than ten
 *                       workers, a run against a database another run is also
 *                       using, and repeated runs in the same database.
 *   sequence  4 digits  monotonic within the process.
 *
 * THE SEQUENCE LIVES ON `globalThis`, NOT IN THIS MODULE. That is the entire
 * fix for defect 1: jest resets the module registry per test file, so a
 * module-level `let` restarts; a property on `globalThis` belongs to the worker
 * PROCESS and survives. Two different test files in the same worker therefore
 * continue one sequence instead of replaying the same one.
 *
 * IT IS NOT "A PROCESS-GLOBAL COUNTER ALONE". A counter alone collides between
 * workers and between runs; a random token alone collides by birthday; a
 * timestamp alone collides whenever two fixtures are built in the same
 * millisecond. The three together give: structural uniqueness within a worker
 * (sequence), structural uniqueness between workers (worker id), and
 * probabilistic separation between processes and runs (run token).
 *
 * NOTHING HERE RETRIES, SLEEPS, OR WEAKENS A DATABASE CONSTRAINT. The
 * constraints are what these identifiers are checked against.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS LOUDLY AT THE BOUNDARY
 *
 * The sequence is four digits because `users.mobile` must be exactly
 * `090` + eight digits (see {@link fixtureMobile}), and 1 + 3 + 4 = 8.
 * Exhausting it THROWS, naming the count. It does not wrap and it does not
 * truncate — truncation is precisely how defect 2 hid.
 *
 * DETERMINISTIC DEBUGGING INFORMATION. Every identifier carries its worker, run
 * and sequence in readable decimal, so a failing assertion on
 * `user_1_4821_0007` says which worker, which run and which fixture in order.
 * {@link fixtureIdentity} prints the same thing for a diagnostic line.
 */

/** Digits reserved for the per-process sequence. Bounds the fixture count. */
const SEQUENCE_DIGITS = 4;
const SEQUENCE_LIMIT = 10 ** SEQUENCE_DIGITS;

/**
 * Digits reserved for the per-process random run token.
 *
 * THREE, not four, because of the mobile format. `fixtureMobile` must produce
 * `090` + eight digits (see below), leaving 1 + 3 + 4 for worker, run and
 * sequence. The sequence keeps its four digits deliberately — headroom for
 * fixtures matters more here than an extra order of magnitude on a token whose
 * only job is to separate processes that the worker digit already separates.
 */
const RUN_DIGITS = 3;

interface FixtureIdState {
  workerDigit: string;
  runToken: string;
  next: number;
}

/**
 * The allocator's state, hung off `globalThis`.
 *
 * A `Symbol.for` key rather than a plain string: it cannot be clobbered by an
 * unrelated global of the same name, and it is reachable from any module
 * registry in the process, which is the whole point.
 */
const STATE_KEY = Symbol.for('kazhal.integration.fixtureIds');

function state(): FixtureIdState {
  const host = globalThis as unknown as Record<symbol, FixtureIdState>;
  let current = host[STATE_KEY];
  if (!current) {
    /*
     * `JEST_WORKER_ID` is 1-based and set by jest in every worker, including
     * the in-band one. Outside jest (a scratch script importing this helper) it
     * is absent, and 0 is then a perfectly good partition of its own.
     *
     * Taken modulo 10 because the field is one digit. Beyond ten workers the
     * partition stops being structural and the RUN TOKEN carries uniqueness on
     * its own — which is why the run token exists and is random rather than
     * derived.
     */
    const worker = Number(process.env.JEST_WORKER_ID ?? 0);
    current = {
      workerDigit: String(Number.isFinite(worker) ? worker % 10 : 0),
      runToken: String(randomInt(0, 10 ** RUN_DIGITS)).padStart(
        RUN_DIGITS,
        '0',
      ),
      next: 0,
    };
    host[STATE_KEY] = current;
  }
  return current;
}

/** One allocation: the worker digit, the run token and a fresh sequence. */
export interface FixtureId {
  workerDigit: string;
  runToken: string;
  sequence: string;
  /** `<worker><run><sequence>` — exactly nine digits. */
  digits: string;
}

export function nextFixtureId(): FixtureId {
  const current = state();
  if (current.next >= SEQUENCE_LIMIT) {
    throw new Error(
      `Fixture identifier sequence exhausted after ${SEQUENCE_LIMIT} allocations ` +
        `in this worker (run ${current.runToken}). The sequence is ${SEQUENCE_DIGITS} ` +
        `digits because users.mobile must be exactly "090" + 8 digits. Widen the ` +
        `field deliberately rather than letting an identifier wrap or truncate — ` +
        `truncation on a UNIQUE column is the original defect this allocator replaced.`,
    );
  }
  const sequence = String(current.next).padStart(SEQUENCE_DIGITS, '0');
  current.next += 1;
  return {
    workerDigit: current.workerDigit,
    runToken: current.runToken,
    sequence,
    digits: `${current.workerDigit}${current.runToken}${sequence}`,
  };
}

/**
 * The historical name, kept so the ~25 existing call sites need no edit.
 *
 * Returns `<worker>_<run>_<sequence>` — only `[a-z0-9_]`, so the
 * `.replace(/[^a-z0-9_]/g, '')` several specs apply before using it as a role
 * name is now a no-op rather than a silent mangling.
 */
export function uniqueSuffix(): string {
  const id = nextFixtureId();
  return `${id.workerDigit}_${id.runToken}_${id.sequence}`;
}

/**
 * An Iranian mobile number in the PRODUCTION format the API validates:
 * `^09\d{9}$`, exactly 11 characters.
 *
 * PINNED TO THE `090` RANGE, which is unassigned in Iran — the same choice
 * `docs/DEV-SEED.md` makes for the dev seed accounts, and for the same reason:
 * no fixture can name a real subscriber. The previous helper built `0912…`,
 * which is a live Hamrah-e Avval prefix.
 *
 * The format is otherwise the real one, so a DTO that tightens its mobile
 * validation fails here rather than in production.
 */
export function fixtureMobile(): string {
  const id = nextFixtureId();
  return `090${id.digits}`;
}

/** A staff username matching the production `^[a-zA-Z0-9_]+$`. */
export function fixtureUsername(prefix = 'user'): string {
  const id = nextFixtureId();
  return `${prefix}_${id.workerDigit}_${id.runToken}_${id.sequence}`;
}

/**
 * A custom role name matching the production `^[a-z][a-z0-9_]{2,39}$`.
 *
 * The prefix is lower-cased and stripped rather than trusted: a caller passing
 * `Role-Name` would otherwise produce a 400 from the API that reads like a bug
 * in the code under test.
 */
export function fixtureRoleName(prefix = 'role'): string {
  const id = nextFixtureId();
  const safe = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'role';
  const name = `${safe}_${id.workerDigit}_${id.runToken}_${id.sequence}`;
  return name.slice(0, 40);
}

/** A SKU. No production format is enforced on it beyond uniqueness. */
/**
 * A collision-free «کد محصول» for a fixture.
 *
 * Shares `nextFixtureId()` with every other fixture identifier, so it is
 * unique across concurrent workers and across runs. Upper-cased ASCII with a
 * single hyphen, which is what `ck_products_product_code_format` accepts.
 */
export function fixtureProductCode(prefix = 'KZT'): string {
  // `.digits` — `nextFixtureId()` returns the STRUCTURED id; interpolating the
  // object itself yields "[object Object]", which the code CHECK constraint
  // rejects (and which is exactly how this was caught).
  return `${prefix}-${nextFixtureId().digits}`;
}

export function fixtureSku(prefix = 'SKU'): string {
  const id = nextFixtureId();
  return `${prefix}-${id.workerDigit}${id.runToken}-${id.sequence}`;
}

/**
 * A POS idempotency key obeying the production contract:
 * `^[A-Za-z0-9._:-]+$`, 8..200 characters (`idempotency.helper.ts`).
 *
 * The label is sanitised to the accepted charset so a caller can name the case
 * a key came from — `posKey('replay')` — without risking a 400 that looks like
 * the endpoint rejecting the test's intent rather than its formatting.
 */
export function fixtureIdempotencyKey(label?: string): string {
  const id = nextFixtureId();
  const safe = (label ?? 'fixture').replace(/[^A-Za-z0-9._:-]/g, '');
  const key = `${safe || 'fixture'}-${id.digits}-${randomInt(0, 1_000_000)
    .toString()
    .padStart(6, '0')}`;
  return key.slice(0, 200);
}

/**
 * One line naming this worker's identity, for a diagnostic record.
 *
 * The point of printing it is that two fixtures that DID collide can be traced
 * to the worker and run that produced them, instead of leaving "a duplicate key
 * appeared" as the whole of the evidence.
 */
export function fixtureIdentity(): {
  workerDigit: string;
  runToken: string;
  allocated: number;
} {
  const current = state();
  return {
    workerDigit: current.workerDigit,
    runToken: current.runToken,
    allocated: current.next,
  };
}

/** Test-only: the bound, so a boundary case does not restate the literal. */
export const FIXTURE_SEQUENCE_LIMIT = SEQUENCE_LIMIT;
