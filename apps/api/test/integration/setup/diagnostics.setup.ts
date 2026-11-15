/**
 * Per-test diagnostic hooks, registered as `setupFilesAfterEnv`.
 *
 * INERT UNLESS ASKED FOR. Everything below short-circuits when
 * `KAZHAL_INT_DIAG_FILE` is unset, which is every ordinary `pnpm test:int`.
 * It is switched on only by the bounded repeat loops used to chase an
 * intermittent failure, so the suite's normal behaviour and timing are
 * unchanged. See `test/integration/support/diagnostics.ts` for what is and is
 * not recorded — no credential of any kind ever is.
 *
 * WHAT IT ANSWERS. An intermittent failure is almost always a fact about the
 * ORDER and the SHARED STATE, not about the failing assertion. So each test is
 * bracketed with a fingerprint of every table two suites could fight over,
 * plus its own wall-clock timing and the jest file it came from. Comparing the
 * `test:end` fingerprint of one test with the `test:start` fingerprint of the
 * next shows immediately whether anything changed in between that no test
 * asked for.
 */
import {
  diagnosticsEnabled,
  fingerprintSharedState,
  record,
  setCurrentSuite,
  setCurrentTest,
} from '../support/diagnostics';
import { getTestDataSource } from './test-db';
import { closeLockForensics } from './lock-forensics';

/*
 * ===========================================================================
 * TAG EVERY POSTGRES CONNECTION WITH THE SUITE THAT OPENED IT
 * ===========================================================================
 *
 * UNCONDITIONAL, unlike everything below it. `pg` uses `PGAPPNAME` as the
 * default `application_name`, so setting it here — before any suite calls
 * `createTestApp()` and opens a pool — makes every backend in
 * `pg_stat_activity` name its own spec file.
 *
 * That is what turns "some connection was holding a lock" into "the connection
 * `delegated-role-matrix.int-spec.ts` opened was holding a lock", which is the
 * difference between a diagnosis and a shrug. It costs one environment
 * variable, changes no application code, and is visible in production tooling
 * only if somebody points it at a test database.
 *
 * It is set outside the `diagnosticsEnabled()` gate on purpose: the lock
 * failure message in `resetDb` reads this name, and that message has to be
 * useful on the FIRST failure, not only on a re-run with diagnostics armed.
 */
{
  const path = expect.getState().testPath ?? null;
  const file = path ? path.split('/').slice(-1)[0] : 'unknown-suite';
  process.env.PGAPPNAME = `kz-int:${file}`.slice(0, 63);
}

/*
 * The forensics pool is opened LAZILY — only when a reset actually blocks — so
 * for an ordinary run this closes nothing. It is registered unconditionally
 * because an open pool holds a socket, and `forceExit` is off: a pool left open
 * by a single blocked reset would hang the whole worker at exit, turning a
 * diagnostic aid into a new failure mode.
 */
afterAll(async () => {
  await closeLockForensics();
});

if (diagnosticsEnabled()) {
  // `expect.getState().testPath` is the absolute path of the file currently
  // executing — the only reliable way to name the suite from inside a hook.
  const testPath = expect.getState().testPath ?? null;
  const suite = testPath ? testPath.split('/').slice(-1)[0] : null;
  setCurrentSuite(suite);

  beforeAll(() => {
    record('suite:start', {
      argv: process.argv.slice(2),
      // Which fixtures the harness will let a spec build. Recorded because
      // `audience-isolation.int-spec.ts` deliberately flips the review-login
      // door, and a spec that leaves it flipped would break every later login.
      reviewLoginEnabled: process.env.KAZHAL_ENABLE_REVIEW_LOGIN ?? null,
      nodeEnv: process.env.NODE_ENV ?? null,
      seedOnBootstrap: process.env.SEED_ON_BOOTSTRAP ?? null,
    });
  });

  afterAll(() => {
    record('suite:end', {
      reviewLoginEnabled: process.env.KAZHAL_ENABLE_REVIEW_LOGIN ?? null,
    });
  });

  beforeEach(async () => {
    const name = expect.getState().currentTestName ?? null;
    setCurrentTest(name);
    record('test:start', {
      fingerprint: await safeFingerprint(),
    });
  });

  afterEach(async () => {
    record('test:end', {
      fingerprint: await safeFingerprint(),
    });
    setCurrentTest(null);
  });
}

/**
 * The fingerprint must never be the reason a test fails. A suite may run
 * before any database exists, or may deliberately close the connection, and in
 * both cases "no fingerprint" is the honest answer rather than an error.
 */
async function safeFingerprint(): Promise<unknown> {
  try {
    const ds = await getTestDataSource();
    return await fingerprintSharedState(ds);
  } catch (error) {
    return { unavailable: String(error).slice(0, 200) };
  }
}
