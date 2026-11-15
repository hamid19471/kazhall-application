import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { Server } from 'node:http';
import * as cookieParser from 'cookie-parser';
import * as request from 'supertest';
import { SessionAudience } from 'src/modules/auth/audience';
import { AppModule } from 'src/app.module';
import { GlobalExceptionFilter } from 'src/common/exceptions/global.exception';
import { ResponseFormatInterceptor } from 'src/common/interceptors/response-format.interceptor';
import { RedisService } from 'src/database/redis.service';
import { getTestDataSource } from './test-db';
import { cookieNames, record, redactBody } from '../support/diagnostics';

/**
 * Boots the REAL application module against the disposable PostgreSQL from
 * globalSetup, with exactly the same global pipes / filters / interceptors that
 * main.ts installs. If a test passes here it passes against the deployed app;
 * a harness that quietly omits the ValidationPipe or the response envelope
 * would let broken DTOs and broken response shapes through.
 *
 * AppModule disables TypeORM `synchronize` when NODE_ENV is 'test', so the
 * schema under test is the one the MIGRATIONS produced and nothing else. A
 * `column ... does not exist` failure here is a real migration gap, not a
 * harness bug.
 */

/**
 * In-memory stand-in for Redis.
 *
 * RedisService.onModuleInit dials a real server, so without this every app
 * boot in CI would hang and then fail on a connection error. OTP storage is the
 * only thing auth needs from it and a Map reproduces the semantics exactly,
 * including TTL expiry.
 */
export class InMemoryRedisService {
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  onModuleInit(): void {
    /* nothing to connect to */
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }

  incr(key: string): Promise<number> {
    const next = Number(this.store.get(key)?.value ?? '0') + 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    return Promise.resolve(next);
  }

  /**
   * Mirrors `RedisService.incrWithExpiry`, including the two properties the
   * per-IP OTP send limit depends on:
   *
   *  - an EXPIRED key starts a fresh window at 1, rather than resuming the old
   *    count (the real `INCR` sees no key at all once Redis has expired it);
   *  - the TTL is stamped once and NOT pushed forward by later increments, so
   *    the window is fixed rather than sliding.
   *
   * Get either wrong and the harness would report a passing rate limit that
   * the deployed app does not have.
   */
  incrWithExpiry(
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const existing = this.store.get(key);
    const live = existing && existing.expiresAt > Date.now() ? existing : null;

    if (!live) {
      this.store.set(key, {
        value: '1',
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return Promise.resolve({ count: 1, ttlSeconds });
    }

    const count = Number(live.value) + 1;
    this.store.set(key, { value: String(count), expiresAt: live.expiresAt });
    return Promise.resolve({
      count,
      ttlSeconds: Math.max(1, Math.ceil((live.expiresAt - Date.now()) / 1000)),
    });
  }

  /** Test affordance: drop everything between cases. */
  flush(): void {
    this.store.clear();
  }
}

export interface TestApp {
  app: INestApplication;
  dataSource: DataSource;
  redis: InMemoryRedisService;
  /** Pass straight to `request(server)` for supertest. */
  server: Server;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  /** Hook to add further provider overrides before the module is compiled. */
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export async function createTestApp(
  options: CreateTestAppOptions = {},
): Promise<TestApp> {
  // AppModule gates TypeORM's `synchronize` on NODE_ENV. It MUST be 'test'
  // here: with synchronize on, TypeORM would quietly reconcile the schema from
  // the entity metadata after the migrations ran, so a missing migration would
  // still produce a green suite (exactly how an unmigrated column shipped
  // once). globalSetup sets this too; asserting it here means a spec that
  // builds an app outside `pnpm test:int` cannot silently lose the guarantee.
  process.env.NODE_ENV = 'test';

  /*
   * THE STOREFRONT'S PASSWORD DOOR, opened for the suite only.
   *
   * Production customer authentication is an OTP and stays one; `POST
   * /auth/storefront/review-login` answers 403 unless an operator has
   * deliberately set `KAZHAL_ENABLE_REVIEW_LOGIN=true` AND the process is not
   * in production (`review-login.policy.ts`).
   *
   * Without this line every spec that signs a CUSTOMER in fails with
   * `REVIEW_LOGIN_DISABLED` — 122 of them — for a reason that has nothing to
   * do with what they assert: there is no SMS provider in the harness, so an
   * OTP cannot be delivered and a password is the only door available. It is
   * set here rather than in a shell wrapper so `pnpm test:int` and a
   * single-file `jest` invocation behave identically.
   *
   * `NODE_ENV = 'test'` above keeps the production half of the policy intact,
   * and `audience-isolation.int-spec.ts` flips this to `'false'` itself to
   * prove the door really does close — so the disabled behaviour is still
   * covered.
   */
  process.env.KAZHAL_ENABLE_REVIEW_LOGIN = 'true';

  // Ensure the schema exists BEFORE Nest connects.
  //
  // `getTestDataSource()` is what actually runs the migrations (once per jest
  // process). Without this, a suite that only uses `createTestApp()` boots
  // against an un-migrated database and dies with `relation "roles" does not
  // exist` -- but ONLY when it runs first. In a full run some alphabetically
  // earlier suite calls `resetDb()` -> `getTestDataSource()` and migrates on
  // its behalf, so it passes by accident of ordering. That coupling showed up
  // as an intermittent 2-test failure in the full suite and a deterministic
  // 20-test failure in isolation. Bootstrapping explicitly removes it.
  await getTestDataSource();

  const redis = new InMemoryRedisService();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RedisService)
    .useValue(redis);

  if (options.customise) builder = options.customise(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();

  // ---- must mirror main.ts exactly ----
  app.useGlobalInterceptors(
    new ResponseFormatInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // -------------------------------------

  await app.init();

  const server = await bindTestServer(app);

  const dataSource = app.get(DataSource);

  return {
    app,
    dataSource,
    redis,
    server,
    close: () => closeTestServer(app, server),
  };
}

// ===========================================================================
// THE ONE PLACE A TEST HTTP SERVER IS BOUND
// ===========================================================================

/**
 * BIND ONCE, FOR THE WHOLE SUITE.
 *
 * `app.init()` builds the HTTP server but never listens on it. supertest copes
 * with that by calling `server.listen(0)` ITSELF for every single request and
 * closing it again afterwards — so a full run opens and closes an ephemeral
 * listener several hundred times.
 *
 * That churn is a real race, not a theoretical one. supertest resolves the
 * request URL from `server.address().port` and only then dials it; in between,
 * the listener can be closed and the operating system is free to hand that same
 * ephemeral port to something else. When it does, the request lands on another
 * listener entirely and comes back as that listener's response — a
 * `426 Upgrade Required` from the HTTP server `ws` stands up on a port of its
 * own, for instance. It shows up roughly once every eight full runs, in a
 * different, unrelated suite each time, and NEVER in isolation, because in
 * isolation almost nothing else on the machine is churning ephemeral ports.
 *
 * That is exactly the signature that gets mislabelled "flaky test" and retried
 * away — and exactly what it looks like from the outside: an assertion failing
 * on a response nobody can explain afterwards, because the response never came
 * from the application at all.
 *
 * Listening once removes the whole class: `server.address()` is non-null from
 * the start, so supertest reuses this one socket for every request and never
 * opens or closes a listener of its own.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SHARED FUNCTION AND NOT A BLOCK INSIDE `createTestApp`
 *
 * It WAS a block inside `createTestApp`. `support/pos.harness.ts` builds its
 * own Nest application (it composes `AppModule` with `ReportsModule` and stubs
 * the realtime gateway) and returned `app.getHttpServer()` directly — so the
 * eight suites that use it, `sales-reporting.int-spec.ts` among them, never got
 * the fix. The race had been diagnosed, explained at length, and fixed in one
 * of the two harnesses.
 *
 * A fix that one of two harnesses can silently miss is not a fix, so the bind
 * lives here, both harnesses call it, and {@link assertBound} makes a harness
 * that forgets fail immediately and loudly instead of once every few runs.
 */
export async function bindTestServer(app: INestApplication): Promise<Server> {
  const server = app.getHttpServer() as Server;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  assertBound(server);
  return server;
}

/**
 * Refuses a server supertest would have to bind for itself.
 *
 * `server.address()` is `null` for a server that is not listening, which is
 * precisely the state that hands the port lifecycle to supertest. Checking it
 * turns "a harness forgot to bind" from an intermittent, cross-suite,
 * unreproducible failure into a deterministic error in that harness's own
 * `beforeAll`.
 */
export function assertBound(server: Server): void {
  if (server.address() === null) {
    throw new Error(
      'Test HTTP server is not listening. Bind it once with `bindTestServer(app)` ' +
        'instead of handing an unbound server to supertest: supertest would then ' +
        'open and close an ephemeral listener per request, and a reused port makes ' +
        'a request land on an unrelated listener roughly once every few full runs.',
    );
  }
}

/**
 * Closes the listener FIRST, then the application.
 *
 * `app.close()` closes the HTTP server too, but only after it has run every
 * module's shutdown hook. Closing the listener first stops a request arriving
 * during that window.
 */
export async function closeTestServer(
  app: INestApplication,
  server: Server,
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.close();
}

// ===========================================================================
// Cookie jar
// ===========================================================================

/**
 * The API authenticates with httpOnly cookies, not bearer headers, so a test
 * client has to carry a cookie jar. supertest does not do this for you.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Absorb every `Set-Cookie` from a response. */
  absorb(response: { headers: Record<string, unknown> }): this {
    const raw = response.headers['set-cookie'];
    const list: string[] = Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === 'string'
        ? [raw]
        : [];

    for (const entry of list) {
      const [pair] = entry.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An empty value with Expires in the past is a deletion (logout).
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  /** Value for a `Cookie:` request header. */
  header(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  clear(): void {
    this.cookies.clear();
  }
}

/**
 * Logs in to ONE application and returns a jar holding that audience's cookie
 * pair. Throws with the server's own message on failure so a broken fixture is
 * diagnosable from the assertion, not from a later 401.
 *
 * The audience is explicit because there is no shared session any more: a test
 * that wants a till session and a test that wants an admin session are asking
 * for genuinely different things, and used to be unable to say so.
 */
export async function authenticate(
  testApp: TestApp,
  username: string,
  password: string,
  requested?: SessionAudience,
): Promise<CookieJar> {
  // When a case does not say which application it is signing in to, the user's
  // own roles decide — a cashier goes to the till, an administrator to the
  // admin console, a customer to the shop. That is what a person testing by
  // hand would do, and it keeps every case that predates audiences meaning
  // exactly what it meant. A case testing a cross-surface refusal names the
  // audience explicitly and this inference is skipped.
  const audience = requested ?? (await inferAudience(testApp, username));
  const loginPath =
    audience === 'storefront'
      ? '/auth/storefront/review-login'
      : `/auth/${audience}/login`;

  const startedAt = Date.now();
  const response = await request(testApp.server)
    .post(loginPath)
    .send({ username, password });

  /*
   * DIAGNOSTIC RECORD OF EVERY LOGIN — see support/diagnostics.ts.
   *
   * Inert unless KAZHAL_INT_DIAG_FILE is set. It captures the four facts a
   * post-mortem of an intermittent authentication failure needs and cannot
   * reconstruct afterwards: which audience the harness chose, what the server
   * answered, WHICH cookies came back, and how long it took. The request body
   * is never recorded, because it carries the password; the response body goes
   * through `redactBody`, and cookies are recorded by NAME only.
   */
  record('login', {
    username,
    audience,
    requestedAudience: requested ?? null,
    loginPath,
    status: response.status,
    // The server's own machine-readable code, which is what distinguishes
    // "wrong password" from "audience not permitted" from "rate limited".
    errorCode:
      (response.body as { error?: unknown } | undefined)?.error ?? null,
    setCookieNames: cookieNames(response.headers['set-cookie']),
    body: response.status >= 400 ? redactBody(response.body) : undefined,
    durationMs: Date.now() - startedAt,
  });

  if (response.status !== 201 && response.status !== 200) {
    throw new Error(
      `Login failed for "${username}" (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }

  return new CookieJar().absorb(response);
}

async function inferAudience(
  testApp: TestApp,
  username: string,
): Promise<SessionAudience> {
  const rows: Array<{ name: string }> = await testApp.dataSource.query(
    `SELECT r.name FROM users u
       JOIN user_roles ur ON ur."usersId" = u.id
       JOIN roles r ON r.id = ur."rolesId"
      WHERE u.username = $1`,
    [username],
  );
  const roles = rows.map((r) => r.name);
  if (roles.includes('sale')) return 'pos';
  if (roles.includes('super_admin')) return 'admin';
  return 'storefront';
}

/**
 * HTTP verbs a cookie-carrying test client exposes. Each returns a normal
 * supertest `Test`, so `.send()`, `.expect()`, `.query()` etc. all chain as
 * usual.
 */
export interface CookieClient {
  get(url: string): request.Test;
  post(url: string): request.Test;
  put(url: string): request.Test;
  patch(url: string): request.Test;
  delete(url: string): request.Test;
  head(url: string): request.Test;
}

/**
 * `withCookies(testApp, jar).get('/branch')` — attaches the jar to every
 * request.
 *
 * Written out verb by verb rather than as a Proxy over supertest's agent: the
 * Proxy version needed an unsound cast (supertest v7 returns `TestAgent`, not
 * the removed `SuperTest`) and it silently wrapped non-request methods too.
 */
export function withCookies(testApp: TestApp, jar: CookieJar): CookieClient {
  const send = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head',
    url: string,
  ): request.Test =>
    request(testApp.server)[method](url).set('Cookie', jar.header());

  return {
    get: (url) => send('get', url),
    post: (url) => send('post', url),
    put: (url) => send('put', url),
    patch: (url) => send('patch', url),
    delete: (url) => send('delete', url),
    head: (url) => send('head', url),
  };
}
