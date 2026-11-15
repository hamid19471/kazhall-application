import {
  ConfirmationRequiredError,
  DEV_SEED_OPT_IN_VAR,
  DISPOSABLE_MARKER_TABLE,
  DISPOSABLE_MARKER_TOKEN,
  DisposableMarkerError,
  OptInMissingError,
  ProductionRefusedError,
  assertDevSeedAllowed,
  assertDisposableMarker,
  assertResetConfirmed,
  describeTarget,
  formatTarget,
} from './dev-seed.guard';

/**
 * ===========================================================================
 * The dev seeder's fail-closed contract
 * ===========================================================================
 *
 * The previous guard inferred permission: it refused `NODE_ENV=production` and
 * database names matching `prod|production|live`, and treated everything else
 * as consent. Both halves of that are wrong in the same direction — an unset
 * NODE_ENV defaults to `development` in this codebase, and a real production
 * database is very often just called `kazhal`. The cases below are written so
 * that a regression to inference FAILS them rather than quietly passing.
 *
 * `describeTarget` takes the environment as an argument precisely so these
 * cases never mutate `process.env` and never depend on the order they run in.
 */

const ALLOWED = {
  NODE_ENV: 'development',
  [DEV_SEED_OPT_IN_VAR]: 'true',
  DB_HOST: '127.0.0.1',
  DB_PORT: '55433',
  DB_DATABASE: 'kazhal_review',
  DB_USERNAME: 'kazhal_review',
  DB_PASSWORD: 'never-printed',
} as NodeJS.ProcessEnv;

const target = (over: NodeJS.ProcessEnv = {}) =>
  describeTarget({ ...ALLOWED, ...over });

describe('assertDevSeedAllowed', () => {
  it('allows a review target that presents the opt-in', () => {
    expect(() => assertDevSeedAllowed(target())).not.toThrow();
  });

  it('refuses NODE_ENV=production even with the opt-in present', () => {
    expect(() =>
      assertDevSeedAllowed(target({ NODE_ENV: 'production' })),
    ).toThrow(ProductionRefusedError);
  });

  /**
   * THE REGRESSION CASE. An unset NODE_ENV is an absence of information, and
   * the old guard read it as permission. It must now be refused for want of
   * the opt-in — not accepted because "well, it isn't production".
   */
  it('does not treat an unset NODE_ENV as authorisation', () => {
    const env = { ...ALLOWED };
    delete env.NODE_ENV;
    delete env[DEV_SEED_OPT_IN_VAR];
    expect(describeTarget(env).nodeEnv).toBeNull();
    expect(() => assertDevSeedAllowed(describeTarget(env))).toThrow(
      OptInMissingError,
    );
  });

  it('refuses when the opt-in is absent', () => {
    const env = { ...ALLOWED };
    delete env[DEV_SEED_OPT_IN_VAR];
    expect(() => assertDevSeedAllowed(describeTarget(env))).toThrow(
      OptInMissingError,
    );
  });

  it.each(['false', 'TRUE', '1', 'yes', ''])(
    'refuses when the opt-in is %p rather than exactly "true"',
    (value) => {
      expect(() =>
        assertDevSeedAllowed(target({ [DEV_SEED_OPT_IN_VAR]: value })),
      ).toThrow(OptInMissingError);
    },
  );

  /**
   * An ordinary name proves nothing either way, so it is decided by the opt-in
   * and the marker — not by the name. The old guard's name regex would have
   * waved this through on the strength of the name alone.
   */
  it('does not accept an ordinary database name such as "kazhal" without the opt-in', () => {
    const env = { ...ALLOWED, DB_DATABASE: 'kazhal' };
    delete env[DEV_SEED_OPT_IN_VAR];
    expect(() => assertDevSeedAllowed(describeTarget(env))).toThrow(
      OptInMissingError,
    );
  });

  it('accepts an ordinary database name once the opt-in is presented, leaving the marker to decide', () => {
    expect(() =>
      assertDevSeedAllowed(target({ DB_DATABASE: 'kazhal' })),
    ).not.toThrow();
  });

  it('refuses a production-looking database name regardless of the opt-in', () => {
    // Kept from the old guard as belt-and-braces: it costs nothing and catches
    // the one case a careful naming convention makes obvious.
    expect(() =>
      assertDevSeedAllowed(
        target({ NODE_ENV: 'production', DB_DATABASE: 'kazhal_prod' }),
      ),
    ).toThrow(ProductionRefusedError);
  });
});

describe('formatTarget', () => {
  it('names the host, port, database and user', () => {
    expect(formatTarget(target())).toContain('127.0.0.1:55433/kazhal_review');
    expect(formatTarget(target())).toContain('as kazhal_review');
  });

  it('reports an unset NODE_ENV as unset rather than inventing "development"', () => {
    const env = { ...ALLOWED };
    delete env.NODE_ENV;
    expect(formatTarget(describeTarget(env))).toContain('NODE_ENV=unset');
  });

  /** Nothing secret may reach a log line. */
  it('never prints the password', () => {
    expect(formatTarget(target())).not.toContain('never-printed');
  });
});

describe('assertDisposableMarker', () => {
  /** Records every statement, so a test can prove nothing was mutated. */
  type MarkerRows = Array<Record<string, unknown>>;

  function recorder(result: MarkerRows | (() => never)) {
    const statements: string[] = [];
    return {
      statements,
      query: jest.fn((sql: string): Promise<unknown> => {
        statements.push(sql);
        if (typeof result === 'function') result();
        return Promise.resolve(result);
      }),
    };
  }

  it('passes when the server carries the marker row', async () => {
    const ds = recorder([{ token: DISPOSABLE_MARKER_TOKEN }]);
    await expect(assertDisposableMarker(ds, target())).resolves.toBeUndefined();
    expect(ds.statements).toHaveLength(1);
  });

  it('refuses when the marker table holds no matching row', async () => {
    const ds = recorder([]);
    await expect(assertDisposableMarker(ds, target())).rejects.toThrow(
      DisposableMarkerError,
    );
  });

  it('refuses when the marker row is malformed', async () => {
    const ds = recorder([{ token: 42 }]);
    await expect(assertDisposableMarker(ds, target())).rejects.toThrow(
      DisposableMarkerError,
    );
  });

  it('refuses when the token is present but wrong', async () => {
    const ds = recorder([{ token: 'some-other-server' }]);
    await expect(assertDisposableMarker(ds, target())).rejects.toThrow(
      DisposableMarkerError,
    );
  });

  /** An unreadable marker is not a present one. */
  it('refuses when the marker table is missing or unreadable', async () => {
    const ds = recorder(() => {
      throw new Error(`relation "${DISPOSABLE_MARKER_TABLE}" does not exist`);
    });
    await expect(assertDisposableMarker(ds, target())).rejects.toThrow(
      DisposableMarkerError,
    );
  });

  /**
   * THE POINT OF THE WHOLE GUARD: it must refuse BEFORE anything is written.
   * The only statement it may ever issue is the marker SELECT.
   */
  it('issues nothing but a SELECT, so a refusal cannot have mutated anything', async () => {
    const ds = recorder([]);
    await expect(assertDisposableMarker(ds, target())).rejects.toThrow(
      DisposableMarkerError,
    );
    expect(ds.statements).toHaveLength(1);
    expect(ds.statements[0]).toMatch(/^\s*SELECT\b/i);
    for (const sql of ds.statements) {
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i,
      );
    }
  });
});

describe('assertResetConfirmed', () => {
  it('refuses without --yes', () => {
    expect(() => assertResetConfirmed(['node', 'dev-reset-cli.ts'])).toThrow(
      ConfirmationRequiredError,
    );
  });

  it('accepts with --yes', () => {
    expect(() =>
      assertResetConfirmed(['node', 'dev-reset-cli.ts', '--yes']),
    ).not.toThrow();
  });

  /** Reset needs BOTH the opt-in and the confirmation; neither implies the other. */
  it('is independent of the opt-in, so --yes alone authorises nothing', () => {
    const env = { ...ALLOWED };
    delete env[DEV_SEED_OPT_IN_VAR];
    expect(() => assertResetConfirmed(['--yes'])).not.toThrow();
    expect(() => assertDevSeedAllowed(describeTarget(env))).toThrow(
      OptInMissingError,
    );
  });
});
