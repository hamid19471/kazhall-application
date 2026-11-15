/**
 * ===========================================================================
 * NOTHING MAY HOLD A POSTGRES LOCK ACROSS A TEST BOUNDARY
 * ===========================================================================
 *
 * THE DEFECT THIS FILE EXISTS FOR. `delegated-role-matrix` intermittently hung
 * in `beforeEach`: one `resetDb` took 978 696 ms where every other reset in the
 * same file took 130-230 ms. `resetDb` truncates 28 tables, which needs ACCESS
 * EXCLUSIVE on every one of them, so ANY other connection holding ANY lock on
 * ANY of those tables — including the ACCESS SHARE a plain `SELECT` takes —
 * makes it queue. Three failures in roughly ten runs, always in the same
 * persona: periodic, not random.
 *
 * WHY IT WAS HARD TO CATCH, AND WHY THIS FILE DOES NOT WAIT FOR IT. The
 * collision window is the ~150 ms a reset spends truncating, against timers
 * firing every 30 000 ms and 60 000 ms. Reproducing it by re-running the suite
 * is a lottery: twelve runs under CPU load, and eight more beside three other
 * concurrent suites, produced nothing. So this file does not reproduce the
 * race — it REMOVES the odds, by driving the very same passes DIRECTLY and
 * continuously while resets run. A pass is then in flight during essentially
 * every reset, so a reset that can be blocked WILL be.
 *
 * That is the difference between "we did not see it again" and "it cannot
 * happen": these cases fail loudly on the unfixed code and pass on the fixed
 * code, every time, in under a minute.
 *
 * WHAT IS ASSERTED
 *
 *  1. With both payment passes hammering the same pool, 25 consecutive resets
 *     all complete promptly, and none leaves a backend `idle in transaction`.
 *  2. A reset that fails does not POISON its connection. This is the second
 *     defect and the one that turned a 150 ms collision into a 16-minute stall:
 *     the reset used to be sent as one simple query,
 *     `BEGIN; SET LOCAL lock_timeout; TRUNCATE …; COMMIT;`, and PostgreSQL
 *     discards the remainder of a multi-statement string after an error — so
 *     `COMMIT` never ran, the connection went back to the pool `idle in
 *     transaction` still holding ACCESS EXCLUSIVE on every table it had already
 *     locked, and every later reset queued behind it forever.
 *  3. After the application is closed, NOTHING of it survives: no backend, no
 *     open transaction, no in-flight sweep.
 *  4. The payment sweepers are DISARMED under test even though the environment
 *     explicitly asks for them (as a developer's `apps/api/.env` does; the
 *     suite sets the same values itself so it holds on a clean clone) — the
 *     trigger, fixed at its root and asserted rather than assumed.
 */
import { DataSource } from 'typeorm';

import { PaymentConfig } from 'src/modules/payment/payment.config';
import { PaymentReverificationService } from 'src/modules/payment/payment-reverification.service';
import { FulfilmentRecoveryService } from 'src/modules/payment/fulfilment-recovery.service';

import { createTestApp, TestApp } from './setup/test-app';
import {
  closeTestDataSource,
  getTestDataSource,
  resetDb,
} from './setup/test-db';
import { captureLockState } from './setup/lock-forensics';

/** A reset on a quiet database completes in ~150ms; this is a wide margin. */
const PROMPT_RESET_MS = 5_000;

/** How many resets to run against the hammering sweepers. */
const RESET_ITERATIONS = 25;

/** Backends that belong to this test process, ignoring the forensics pool. */
async function applicationBackends(): Promise<
  Array<{
    pid: number;
    state: string | null;
    applicationName: string | null;
    query: string | null;
  }>
> {
  const snapshot = await captureLockState(0);
  return snapshot.backends
    .filter((b) => b.backendType === 'client backend')
    .filter((b) => b.applicationName !== 'kazhal-lock-forensics')
    .map((b) => ({
      pid: b.pid,
      state: b.state,
      applicationName: b.applicationName,
      query: b.query,
    }));
}

describe('database lock lifecycle (int)', () => {
  // =========================================================================
  // 1. The background sweepers must not be able to block a reset
  // =========================================================================

  describe('with every background pass hammering the same pool', () => {
    let app: TestApp;
    const savedEnv = {
      PAYMENT_REVERIFY_ENABLED: process.env.PAYMENT_REVERIFY_ENABLED,
      FULFILMENT_RECOVERY_ENABLED: process.env.FULFILMENT_RECOVERY_ENABLED,
    };

    beforeAll(async () => {
      /*
       * ARM THE ENV EXPLICITLY, rather than trusting a developer's
       * `apps/api/.env` to do it. That file is gitignored, so a clean clone or
       * CI has none, and the "the env asks and is overruled" assertion below
       * would fail for a reason that has nothing to do with the gate. Values
       * already in `process.env` take precedence over anything ConfigModule
       * reads from a file, so this is exactly the hostile configuration the
       * gate must withstand, on every machine.
       */
      process.env.PAYMENT_REVERIFY_ENABLED = 'true';
      process.env.FULFILMENT_RECOVERY_ENABLED = 'true';
      app = await createTestApp();
    });

    afterAll(async () => {
      await app.close();
      await closeTestDataSource();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('leaves the payment sweepers DISARMED under test, whatever .env says', () => {
      /*
       * THE TRIGGER, ASSERTED AT ITS ROOT.
       *
       * `apps/api/.env` sets `PAYMENT_REVERIFY_ENABLED=true` and
       * `FULFILMENT_RECOVERY_ENABLED=true`, and `ConfigModule` loads that file
       * during integration runs. The gates used to be
       * `env ?? (NODE_ENV !== 'test')`, which READS as "off in tests" and was
       * not: the explicit branch won, and two timers fired every 30 and 60
       * seconds inside every suite that calls `createTestApp`, opening
       * transactions that took `RowShareLock` on `orders` and `payment` — two
       * of the 28 tables the harness TRUNCATEs between tests.
       *
       * The gate now checks `NODE_ENV === 'test'` FIRST and is not
       * overridable, so a developer's local `.env` cannot arm a background job
       * inside a test process.
       */
      const config = app.app.get(PaymentConfig, { strict: false });
      expect({
        reverify: config.reverifyEnabled,
        recovery: config.recoveryEnabled,
        envSaysReverify: process.env.PAYMENT_REVERIFY_ENABLED,
        envSaysRecovery: process.env.FULFILMENT_RECOVERY_ENABLED,
      }).toEqual({
        reverify: false,
        recovery: false,
        // Proves the assertion above is not passing merely because the file
        // happened to be absent: the env DOES ask for them, and is overruled.
        envSaysReverify: 'true',
        envSaysRecovery: 'true',
      });

      const reverify = app.app.get(PaymentReverificationService, {
        strict: false,
      });
      const recovery = app.app.get(FulfilmentRecoveryService, {
        strict: false,
      });
      expect((reverify as unknown as { timer: unknown }).timer).toBeNull();
      expect((recovery as unknown as { timer: unknown }).timer).toBeNull();
    });

    it('completes every reset promptly while sweeps run against it', async () => {
      /*
       * THE COLLISION, FORCED RATHER THAN AWAITED.
       *
       * The timers are disarmed, so this drives the very same passes DIRECTLY
       * and continuously while resets run. That is a strictly harsher version
       * of what the 30-second timer used to do by accident: instead of one
       * chance every 30 000 ms to land inside a ~150 ms truncate, a pass is in
       * flight during essentially every reset.
       *
       * Twelve runs of `delegated-role-matrix` under CPU load reproduced
       * nothing; this reproduces the conflict on the first iteration, every
       * time. A test that waits for a 3-in-10 race is not a test.
       */
      const reverify = app.app.get(PaymentReverificationService, {
        strict: false,
      });
      const recovery = app.app.get(FulfilmentRecoveryService, {
        strict: false,
      });

      let hammering = true;
      let passes = 0;
      const hammer = (async () => {
        while (hammering) {
          await Promise.all([
            reverify.sweep().catch(() => undefined),
            recovery.recover().catch(() => undefined),
          ]);
          passes += 1;
        }
      })();

      const durations: number[] = [];
      try {
        for (let i = 0; i < RESET_ITERATIONS; i += 1) {
          const started = Date.now();
          await resetDb(app.dataSource);
          durations.push(Date.now() - started);
        }
      } finally {
        hammering = false;
        // Awaited, not abandoned: leaving this running would make THIS spec
        // the thing that leaks work into the next one.
        await hammer;
      }

      // The hammer really ran — otherwise the assertion below is vacuous.
      expect(passes).toBeGreaterThan(0);

      const worst = Math.max(...durations);
      const sorted = [...durations].sort((a, b) => a - b);
      // Printed, not just asserted: the DISTRIBUTION is the evidence that the
      // sweeps really do contend for the same locks, and a future reader needs
      // the numbers rather than a bare pass.
      console.log(
        `[lock-lifecycle] ${passes} sweep passes; reset ms ` +
          `min=${sorted[0]} median=${sorted[Math.floor(sorted.length / 2)]} worst=${worst}`,
      );
      // A genuine failure arrives as the lock-forensics error from `resetDb`,
      // naming the backend and statement that held the lock. This is the
      // backstop for a reset that was merely slow.
      expect({ worst, iterations: durations.length }).toEqual({
        worst: expect.any(Number),
        iterations: RESET_ITERATIONS,
      });
      expect(worst).toBeLessThan(PROMPT_RESET_MS);
    });

    it('leaves no backend idle in transaction between resets', async () => {
      await resetDb(app.dataSource);

      /*
       * THE SHAPE OF THE LEAK, ASSERTED DIRECTLY.
       *
       * `idle in transaction` is a connection that opened a transaction and
       * then stopped: it holds every lock it took until something closes it.
       * ONE is enough to stall every later reset in the file, so the assertion
       * is zero, not "few".
       */
      const idleInTransaction = (await applicationBackends()).filter(
        (b) => b.state === 'idle in transaction',
      );
      expect(idleInTransaction).toEqual([]);
    });
  });

  // =========================================================================
  // 2. A failed reset must not poison its connection
  // =========================================================================

  describe('when a reset cannot get its lock', () => {
    let blocker: DataSource;

    afterEach(async () => {
      if (blocker?.isInitialized) await blocker.destroy();
    });

    it('fails fast, names the holder, and releases its own connection clean', async () => {
      const shared = await getTestDataSource();

      /*
       * A DELIBERATE HOLDER. Its own DataSource — not the harness pool — so
       * this test cannot strand a connection the rest of the suite depends on,
       * and `afterEach` destroys it whatever happens.
       *
       * It takes ACCESS SHARE on `users` (a plain `SELECT` inside an open
       * transaction) and simply sits there. That is the mildest possible lock,
       * which is the point: even a read blocks TRUNCATE.
       */
      blocker = new DataSource({
        ...(shared.options as object),
        applicationName: 'kazhal-lock-lifecycle-blocker',
      } as never);
      await blocker.initialize();

      const runner = blocker.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query('SELECT count(*) FROM users');

        // The reset must now fail — promptly, and saying who.
        const started = Date.now();
        let message = '';
        try {
          await resetDb(shared);
          throw new Error(
            'resetDb unexpectedly succeeded while a lock was held',
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        const waited = Date.now() - started;

        expect(message).toMatch(/could not acquire ACCESS EXCLUSIVE/);
        // It names a suspect rather than shrugging.
        expect(message).toMatch(
          /kazhal-lock-lifecycle-blocker|idle in transaction|pid \d+/,
        );
        // `lock_timeout` is 10s; anything near the 120s hook timeout means the
        // bound is not being applied.
        expect(waited).toBeLessThan(30_000);
      } finally {
        await runner.rollbackTransaction().catch(() => undefined);
        await runner.release();
      }

      /*
       * AND NOW THE PART THAT MATTERS. The holder is gone, so the very next
       * reset must succeed. It does NOT if the failed reset left its own
       * connection `idle in transaction` — which is exactly what a
       * `BEGIN; …; TRUNCATE …; COMMIT;` sent as one string does, because
       * PostgreSQL discards the rest of the string after the error and the
       * `COMMIT` never runs.
       */
      await expect(resetDb(shared)).resolves.toBeUndefined();

      const idleInTransaction = (await applicationBackends()).filter(
        (b) => b.state === 'idle in transaction',
      );
      expect(idleInTransaction).toEqual([]);
    });
  });

  // =========================================================================
  // 3. The server itself refuses to let a transaction idle
  // =========================================================================

  describe('a stranded transaction', () => {
    it('is reaped by the server, so no caller can hold locks indefinitely', async () => {
      const shared = await getTestDataSource();

      const [settings] = await shared.query<
        Array<{ idle_timeout: string; keepalive_idle: string }>
      >(
        `SELECT current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
                current_setting('tcp_keepalives_idle')                  AS keepalive_idle`,
      );

      /*
       * THE INVARIANT, ASSERTED AS CONFIGURATION.
       *
       * This is the only defence that reaches the failure mode no `finally`
       * block can: a TCP connection dropped between the test process and the
       * container leaves the backend holding its locks until the kernel gives
       * up retransmitting — ~15-16 minutes on macOS, which is the 978-second
       * signature this whole file exists for.
       *
       * It must be LONGER than `resetDb`'s 10s `lock_timeout`, so a blocked
       * reset still fails first and names the holder; if these two ever
       * crossed, the holder would be killed silently and the cause would never
       * be learned.
       */
      expect({
        idleInTransaction: settings.idle_timeout,
        keepaliveIdle: settings.keepalive_idle,
        // `current_setting` renders each in the GUC's own unit: the timeout
        // carries `s`, the keepalive is a bare count of seconds.
      }).toEqual({ idleInTransaction: '15s', keepaliveIdle: '30' });
      expect(Number.parseInt(settings.idle_timeout, 10)).toBeGreaterThan(10);
    });

    it('cannot stall a reset for longer than the server permits', async () => {
      const shared = await getTestDataSource();

      /*
       * A CONNECTION DELIBERATELY ABANDONED MID-TRANSACTION — the exact shape
       * of the defect, with no application bug required to produce it.
       *
       * Its own DataSource, so abandoning it cannot strand a connection the
       * rest of the suite needs, and it is destroyed in `finally` whatever
       * happens.
       */
      const abandoned = new DataSource({
        ...(shared.options as object),
        applicationName: 'kazhal-abandoned-transaction',
      } as never);
      await abandoned.initialize();
      const runner = abandoned.createQueryRunner();

      try {
        await runner.connect();
        await runner.startTransaction();
        await runner.query('SELECT count(*) FROM users');
        // ...and now nothing. No commit, no rollback, no release.

        const started = Date.now();
        let outcome: 'blocked' | 'succeeded' = 'succeeded';
        try {
          await resetDb(shared);
        } catch {
          outcome = 'blocked';
        }
        const firstAttemptMs = Date.now() - started;

        // The first reset is expected to fail: the holder is still inside its
        // 15s grace period, and `lock_timeout` is 10s. That is the DESIGNED
        // order — the report names the holder before the server reaps it.
        expect({ outcome, promptly: firstAttemptMs < 30_000 }).toEqual({
          outcome: 'blocked',
          promptly: true,
        });

        /*
         * And now the part that makes this a fix rather than a diagnosis: the
         * server terminates the stranded backend, so a LATER reset succeeds
         * without anybody having cleaned up. Bounded by a deadline and by
         * observable state — the backend disappearing — not by a fixed sleep.
         */
        const deadline = Date.now() + 40_000;
        let recovered = false;
        while (Date.now() < deadline && !recovered) {
          const stillThere = (await applicationBackends()).some(
            (b) => b.applicationName === 'kazhal-abandoned-transaction',
          );
          if (!stillThere) recovered = true;
        }
        expect({ reaped: recovered }).toEqual({ reaped: true });

        await expect(resetDb(shared)).resolves.toBeUndefined();
      } finally {
        await runner.release().catch(() => undefined);
        if (abandoned.isInitialized) await abandoned.destroy();
      }
    }, 90_000);
  });

  // =========================================================================
  // 4. Closing the application really closes everything
  // =========================================================================

  describe('after the application is closed', () => {
    it('leaves no backend of its own behind', async () => {
      const before = await applicationBackends();

      const app = await createTestApp();
      // Do some real work so the pool actually opens connections.
      await resetDb(app.dataSource);
      const during = await applicationBackends();
      expect(during.length).toBeGreaterThan(before.length);

      await app.close();

      /*
       * `app.close()` destroys the DataSource, which ends every backend it
       * opened. A pool that outlived its application would keep holding
       * whatever it held — and would be invisible, because no test owns it any
       * more.
       *
       * Bounded wait, not a sleep: PostgreSQL reaps a disconnected backend
       * asynchronously, so the assertion is "within a deadline", and it fails
       * naming what is still there.
       */
      const deadline = Date.now() + 10_000;
      let remaining = await applicationBackends();
      while (remaining.length > before.length && Date.now() < deadline) {
        remaining = await applicationBackends();
      }
      expect({
        before: before.length,
        remaining: remaining.map(
          (b) => `${b.pid} ${b.state} ${b.applicationName}`,
        ),
      }).toEqual({
        before: before.length,
        remaining: expect.any(Array),
      });
      expect(remaining.length).toBeLessThanOrEqual(before.length);
    });
  });
});
