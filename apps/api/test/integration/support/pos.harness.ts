/**
 * Workstream C's entry point onto workstream A's integration harness.
 *
 * WHY THIS EXISTS: A's `createTestApp()` boots `AppModule`, and `ReportsModule`
 * (new in workstream C) is not registered in `AppModule` yet -- that edit is
 * lead-owned. Importing `[AppModule, ReportsModule]` side by side gives the
 * reporting controller a route table without touching a file C does not own,
 * and once the lead adds `ReportsModule` to `AppModule` this keeps working
 * unchanged (Nest instantiates a module once no matter how often it is
 * imported). Everything else -- the disposable PostgreSQL, migrations, the
 * cookie jar, the global pipes -- is A's.
 */
import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as cookieParser from 'cookie-parser';

import { AppModule } from 'src/app.module';
import { ReportsModule } from 'src/modules/reports/reports.module';
import { GlobalExceptionFilter } from 'src/common/exceptions/global.exception';
import { ResponseFormatInterceptor } from 'src/common/interceptors/response-format.interceptor';
import { RedisService } from 'src/database/redis.service';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

import {
  InMemoryRedisService,
  TestApp,
  bindTestServer,
  closeTestServer,
} from '../setup/test-app';

export { authenticate, withCookies, CookieJar } from '../setup/test-app';
export type { TestApp } from '../setup/test-app';

/** One realtime frame the stubbed gateway was asked to publish. */
export interface RecordedPosEmit {
  event: string;
  payload: unknown;
}

/*
 * WHY THE STUB RECORDS.
 *
 * Several guarantees in this suite are about a frame that must NOT go out: a
 * refused sale announces nothing, because announcing an availability change
 * for a transaction that rolled back would tell every client to re-read a
 * change that never happened. A stub whose methods return `undefined` cannot
 * distinguish "did not emit" from "emitted and we did not look", so it records.
 *
 * Module-level, and therefore per test FILE: Jest gives each spec file its own
 * module registry, so two suites cannot see each other's frames. Reset it in
 * `beforeEach` with `resetPosEmitted()`.
 */
const posEmits: RecordedPosEmit[] = [];

/** Every frame recorded since the last `resetPosEmitted()`. */
export function posEmitted(): readonly RecordedPosEmit[] {
  return posEmits;
}

export function resetPosEmitted(): void {
  posEmits.length = 0;
}

export async function createPosTestApp(): Promise<TestApp> {
  const redis = new InMemoryRedisService();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ReportsModule],
  })
    .overrideProvider(RedisService)
    .useValue(redis)
    // R7: realtime notifications are advisory and post-commit. A live
    // socket.io server attached to the test HTTP server would leak handles and
    // prove nothing, so the gateway is stubbed and correctness is asserted
    // against the database instead.
    .overrideProvider(RealtimeGateway)
    .useValue({
      server: { emit: () => undefined, to: () => ({ emit: () => undefined }) },
      // Must mirror the gateway's scoped API, otherwise the stub hides the
      // fact that production code is calling `server.emit` directly.
      emitOrderEvent: (event: string, payload: unknown) => {
        posEmits.push({ event, payload });
      },
      emitStockEvent: (payload: unknown) => {
        posEmits.push({ event: 'stock:updated', payload });
      },
      emitAvailabilityEvent: (payload: unknown) => {
        posEmits.push({ event: 'availability:invalidated', payload });
      },
      emitToUser: (userId: number, event: string, payload: unknown) => {
        posEmits.push({ event: `user:${userId}/${event}`, payload });
      },
      /*
       * NOT AN EMITTER, AND THAT IS WHY IT HAS TO BE HERE.
       *
       * `disconnectUser` ends a user's live sockets and is called by the
       * session-revocation, deactivation and password-change paths. Those are
       * ordinary HTTP endpoints, so a stub missing this method does not hide a
       * missing notification — it makes `PATCH /users/:id` throw a TypeError
       * and answer 500. (It did: `sales-reporting.int-spec` caught it.)
       *
       * The stub is `as unknown as RealtimeGateway`-shaped, so the compiler
       * cannot enforce this mirror; adding every method the gateway exposes to
       * application code is the only thing that keeps it honest.
       */
      disconnectUser: () => Promise.resolve(0),
      reconcileUser: () => Promise.resolve(0),
      reconcileAll: () => Promise.resolve(),
      /*
       * THE NEW PUBLISHER — and the reason this stub keeps needing additions.
       *
       * It is `as unknown as RealtimeGateway`-shaped, so the compiler cannot
       * check that it mirrors the gateway's API. A missing method is therefore
       * not a missing notification: it is a `TypeError` inside a committed
       * transaction's post-commit block, which surfaces as `POST /orders/pos`
       * answering 500. That is exactly how it failed when
       * `publishAvailabilityInvalidation` replaced `emitAvailabilityEvent`.
       *
       * Every method the application calls on the gateway belongs here.
       */
      emitPosAvailabilityEvent: (payload: unknown) => {
        posEmits.push({ event: 'pos:availability:invalidated', payload });
      },
      publishAvailabilityInvalidation: (
        variantIds: readonly number[],
        reason: string,
      ) => {
        /*
         * Recorded PER VARIANT, mirroring the real publisher: it resolves each
         * id to its product and emits one frame per variant. An empty id list
         * records nothing, which is what a transaction that touched no
         * availability must look like.
         */
        for (const variantId of variantIds) {
          posEmits.push({
            event: 'availability:invalidated',
            payload: { variantId, reason },
          });
        }
        return Promise.resolve();
      },
    })
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();

  // Mirrors main.ts exactly.
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

  await app.init();

  /*
   * BIND ONCE — the same treatment `createTestApp` gives its server, from the
   * same function, for the same reason.
   *
   * THIS HARNESS USED TO RETURN AN UNBOUND SERVER. `app.getHttpServer()` after
   * `app.init()` is built but NOT listening, so supertest opened and closed an
   * ephemeral listener for every single request. A port freed by one request
   * can be handed straight back out by the operating system, and when it was,
   * a request landed on an unrelated listener and came back with that
   * listener's response.
   *
   * The eight suites built on this harness — `sales-reporting`,
   * `dashboard-date-semantics`, `reports-money-precision`, `order-number-length`
   * and the four POS specs — therefore carried a race that had already been
   * diagnosed and fixed in the other harness. It presented as
   * `sales-reporting › groups totals by cashier` failing once in five full runs
   * and never in isolation, with "the failing response not captured" — because
   * the response had not come from this application at all.
   *
   * See `bindTestServer` for the full account.
   */
  const server = await bindTestServer(app);

  return {
    app,
    dataSource: app.get(DataSource),
    redis,
    server,
    close: () => closeTestServer(app, server),
  };
}
