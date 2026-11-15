/**
 * ===========================================================================
 * FIXTURE IDENTIFIERS — uniqueness, production format, and the boundary
 * ===========================================================================
 *
 * THE TWO DEFECTS THIS FILE EXISTS FOR, both found by instrumenting a full run
 * rather than by anything failing:
 *
 * 1. `uniqueSuffix()` was `${process.pid.toString(36)}${counter}` with the
 *    counter at module scope. Jest resets the module registry per TEST FILE, so
 *    the counter restarted while the pid did not, and every suite replayed the
 *    same sequence. One measured run produced 225 distinct usernames for 836
 *    `createUser` calls — `user_16i31` appeared 24 times. It survived only
 *    because `resetDb()` truncated `users` between tests.
 *
 * 2. The generated mobile was `` `0912${suffix}`.slice(0, 11) ``, which
 *    TRUNCATED. With a four-character base-36 pid, counter 1000 produced the
 *    same 11-character string as counter 100 — on a UNIQUE column. The highest
 *    per-file counter measured was 251; the margin was 4x.
 *
 * These cases assert the replacement in the terms the defects were in: the
 * module registry resetting, a second worker, a repeated run, the exact
 * production formats, and the boundary refusing rather than wrapping.
 *
 * WHERE THE DATABASE COMES IN. Format and in-memory uniqueness are necessary
 * but not sufficient: what actually broke would have been a UNIQUE violation.
 * The last block therefore inserts a few thousand fixtures for real and lets
 * PostgreSQL be the judge.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import {
  FIXTURE_SEQUENCE_LIMIT,
  fixtureIdempotencyKey,
  fixtureIdentity,
  fixtureMobile,
  fixtureRoleName,
  fixtureSku,
  fixtureUsername,
  nextFixtureId,
  uniqueSuffix,
} from './setup/fixture-ids';
import { createUser } from './setup/seed-helpers';
import type { DataSource } from 'typeorm';

/** The production validators these fixtures must satisfy. */
const IRAN_MOBILE = /^09\d{9}$/;
const USERNAME = /^[a-zA-Z0-9_]+$/;
const ROLE_NAME = /^[a-z][a-z0-9_]{2,39}$/;
const IDEMPOTENCY_CHARSET = /^[A-Za-z0-9._:-]+$/;
const IDEMPOTENCY_MIN = 8;
const IDEMPOTENCY_MAX = 200;

/** The allocator's own global state key, so a case can simulate a fresh one. */
const STATE_KEY = Symbol.for('kazhal.integration.fixtureIds');

/**
 * Runs `body` as if it were a DIFFERENT jest worker process.
 *
 * Clearing the `globalThis` slot is exactly what a new worker process starts
 * with, and `JEST_WORKER_ID` is what jest sets differently in each one. The
 * previous state is restored afterwards so the rest of this file — and every
 * later suite in this worker — keeps its own sequence.
 */
function asWorker<T>(workerId: string, body: () => T): T {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const savedState = host[STATE_KEY];
  const savedEnv = process.env.JEST_WORKER_ID;
  delete host[STATE_KEY];
  process.env.JEST_WORKER_ID = workerId;
  try {
    return body();
  } finally {
    if (savedEnv === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = savedEnv;
    host[STATE_KEY] = savedState;
  }
}

describe('fixture identifier uniqueness (int)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await getTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(ds);
  });

  // =======================================================================
  // 1. Production formats
  // =======================================================================

  describe('every generated identifier obeys its production format', () => {
    it('mobile: exactly `09` + nine digits, in the unassigned 090 range', () => {
      for (let i = 0; i < 200; i += 1) {
        const mobile = fixtureMobile();
        expect(mobile).toMatch(IRAN_MOBILE);
        expect(mobile).toHaveLength(11);
        // The `090` range is unassigned in Iran (docs/DEV-SEED.md), so a
        // fixture can never name a real subscriber. The old helper built
        // `0912…`, a live Hamrah-e Avval prefix.
        expect(mobile.startsWith('090')).toBe(true);
      }
    });

    it('username: matches the API regex and needs no sanitising', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(fixtureUsername()).toMatch(USERNAME);
      }
      expect(fixtureUsername('cashier')).toMatch(/^cashier_/);
    });

    it('role name: matches the API regex and fits the 40-character bound', () => {
      for (const prefix of ['role', 'Delegated-Role', 'x', 'A'.repeat(60)]) {
        const name = fixtureRoleName(prefix);
        expect(name).toMatch(ROLE_NAME);
        expect(name.length).toBeLessThanOrEqual(40);
      }
    });

    it('idempotency key: matches the charset and the 8..200 length bound', () => {
      for (const label of [undefined, 'replay', 'weird label/with?chars', '']) {
        const key = fixtureIdempotencyKey(label);
        expect(key).toMatch(IDEMPOTENCY_CHARSET);
        expect(key.length).toBeGreaterThanOrEqual(IDEMPOTENCY_MIN);
        expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_MAX);
      }
    });

    it('suffix: only [a-z0-9_], so the sanitising call sites are now no-ops', () => {
      // Several specs write `uniqueSuffix().replace(/[^a-z0-9_]/g, '')` before
      // using it in a role name. That replace used to be load-bearing; it must
      // now change nothing, or the sanitising is hiding a format change.
      for (let i = 0; i < 100; i += 1) {
        const suffix = uniqueSuffix();
        expect(suffix.replace(/[^a-z0-9_]/g, '')).toBe(suffix);
      }
    });
  });

  // =======================================================================
  // 2. Uniqueness across the things that used to break it
  // =======================================================================

  describe('uniqueness', () => {
    it('does not repeat within one worker, across many allocations', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 2_000; i += 1) {
        const id = nextFixtureId().digits;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      expect(seen.size).toBe(2_000);
    });

    it('SURVIVES A MODULE REGISTRY RESET — the original defect', () => {
      /*
       * This is defect 1, reproduced directly. Jest resets the module registry
       * per test file; `jest.resetModules()` does the same thing on demand. A
       * module-level counter restarts and replays; the allocator's state lives
       * on `globalThis`, which belongs to the PROCESS, so it continues.
       */
      const before = fixtureMobile();
      jest.resetModules();

      // `require` on purpose: the point is to re-evaluate the module the way a
      // fresh test file would, which an ESM import (hoisted, cached once) cannot
      // express.
      const reloaded: typeof import('./setup/fixture-ids') =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./setup/fixture-ids');
      const after = reloaded.fixtureMobile();

      expect(after).not.toBe(before);
      // ...and the sequence CONTINUED rather than restarting at zero.
      expect(Number(after.slice(-4))).toBeGreaterThan(Number(before.slice(-4)));
    });

    it('partitions between concurrent workers by construction', () => {
      // Not "unlikely to collide" — the worker digit makes an overlap
      // impossible for the first ten workers, which is what a `maxWorkers`
      // bump would produce.
      const one = asWorker('1', () => [fixtureMobile(), fixtureMobile()]);
      const two = asWorker('2', () => [fixtureMobile(), fixtureMobile()]);
      const three = asWorker('3', () => [fixtureMobile(), fixtureMobile()]);

      const all = [...one, ...two, ...three];
      expect(new Set(all).size).toBe(all.length);

      // Same sequence position, different worker: the OLD scheme produced the
      // identical string here.
      expect(one[0]).not.toBe(two[0]);
      expect(one[0].slice(-4)).toBe(two[0].slice(-4));
    });

    it('separates two runs in the same worker slot', () => {
      // Two processes that jest gave the same worker id — a repeated run
      // against a shared database. The random run token is what separates
      // them; a counter alone could not.
      const runA = asWorker('1', () => fixtureMobile());
      const runB = asWorker('1', () => fixtureMobile());
      expect(runA).not.toBe(runB);
    });

    it('reports which worker and run produced an identifier', () => {
      // Deterministic debugging information: a collision must be traceable to
      // the worker and run that made it, not merely reported as a duplicate.
      const identity = fixtureIdentity();
      expect(identity.workerDigit).toMatch(/^\d$/);
      expect(identity.runToken).toMatch(/^\d{3}$/);
      expect(identity.allocated).toBeGreaterThan(0);

      const username = fixtureUsername();
      expect(username).toContain(identity.runToken);
    });
  });

  // =======================================================================
  // 3. The boundary
  // =======================================================================

  it('REFUSES at the sequence boundary instead of wrapping or truncating', () => {
    /*
     * Defect 2 was a silent truncation at exactly this kind of boundary. The
     * replacement throws, and the message names the limit and the reason, so
     * whoever hits it widens the field deliberately.
     */
    asWorker('9', () => {
      for (let i = 0; i < FIXTURE_SEQUENCE_LIMIT; i += 1) nextFixtureId();
      expect(() => nextFixtureId()).toThrow(/sequence exhausted/i);
      expect(() => fixtureMobile()).toThrow(/090/);
    });
  });

  it('never emits a mobile longer or shorter than the column allows', () => {
    // The specific shape that used to be produced by truncation: an 11-char
    // string that is a PREFIX of another. Asserted over the whole span the
    // sequence can take, not just the first few.
    asWorker('4', () => {
      const seen = new Set<string>();
      for (let i = 0; i < FIXTURE_SEQUENCE_LIMIT; i += 1) {
        const mobile = fixtureMobile();
        expect(mobile).toHaveLength(11);
        seen.add(mobile);
      }
      expect(seen.size).toBe(FIXTURE_SEQUENCE_LIMIT);
    });
  });

  // =======================================================================
  // 4. PostgreSQL is the judge
  // =======================================================================

  it('inserts thousands of fixtures without a UNIQUE violation', async () => {
    /*
     * The end the defect would actually have been felt at. `users.username` and
     * `users.mobile` are both UNIQUE, and `resetDb()` is deliberately NOT
     * called in the middle of this loop — every row stays alive at once, which
     * is the condition the old scheme was only ever saved from by truncation
     * between tests.
     */
    const COUNT = 1_500;
    const usernames: string[] = [];
    const mobiles: string[] = [];

    for (let i = 0; i < COUNT; i += 1) {
      const username = fixtureUsername();
      const mobile = fixtureMobile();
      usernames.push(username);
      mobiles.push(mobile);
      await ds.query(
        `INSERT INTO users (username, mobile, password) VALUES ($1, $2, 'x')`,
        [username, mobile],
      );
    }

    const [row] = await ds.query<Array<{ n: string }>>(
      `SELECT COUNT(*)::text AS n FROM users`,
    );
    expect(Number(row.n)).toBe(COUNT);
    expect(new Set(usernames).size).toBe(COUNT);
    expect(new Set(mobiles).size).toBe(COUNT);
  });

  it('lets the real createUser helper build many live accounts at once', async () => {
    // The same guarantee through the helper every spec actually calls, with
    // roles and hashing, rather than through a bare INSERT.
    const made = await Promise.all(
      Array.from({ length: 40 }, () => createUser(ds)),
    );
    const names = made.map((m) => m.username);
    expect(new Set(names).size).toBe(names.length);

    const [row] = await ds.query<Array<{ n: string }>>(
      `SELECT COUNT(DISTINCT mobile)::text AS n FROM users WHERE mobile IS NOT NULL`,
    );
    expect(Number(row.n)).toBe(names.length);
  });

  it('generates POS idempotency keys the endpoint accepts as distinct', () => {
    // `idempotency_keys.key` is UNIQUE per scope; two fixtures reusing a key
    // would make one sale silently replay the other.
    const keys = Array.from({ length: 500 }, (_, i) =>
      fixtureIdempotencyKey(i % 2 === 0 ? 'sale' : undefined),
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(IDEMPOTENCY_CHARSET);
  });

  it('generates SKUs the catalogue accepts as distinct', () => {
    const skus = Array.from({ length: 500 }, () => fixtureSku());
    expect(new Set(skus).size).toBe(skus.length);
  });
});
