import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  IdempotencyKey,
  IdempotencyScope,
  IdempotencyStatus,
} from 'src/common/entities/idempotency-key.entity';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_REQUEST_IN_PROGRESS,
  IdempotencyService,
} from 'src/common/services/idempotency.service';
import {
  closeTestDataSource,
  getTestDataSource,
  resetDb,
} from './setup/test-db';

/**
 * These cases exist because the interesting behaviour is PostgreSQL's, not
 * JavaScript's.
 *
 * A unique violation ABORTS the enclosing transaction: every following
 * statement then fails with `25P02 current transaction is aborted`. An
 * implementation that catches the 23505 and simply SELECTs the existing row on
 * the same manager therefore never reaches its own reuse / in-progress / replay
 * branches — they compile, they read correctly, and they are dead code, with
 * every retried key returning 500. Only the SAVEPOINT / ROLLBACK TO SAVEPOINT
 * form makes them reachable, and only a real database can tell the two apart.
 *
 * So each case below asserts BOTH the outcome and that the transaction is still
 * usable afterwards.
 */

const SCOPE = IdempotencyScope.POS_SALE;

function conflictCode(error: unknown): string | undefined {
  if (!(error instanceof ConflictException)) return undefined;
  const payload = error.getResponse();
  return typeof payload === 'object' && payload !== null
    ? (payload as { code?: string }).code
    : undefined;
}

describe('IdempotencyService (real PostgreSQL)', () => {
  let ds: DataSource;
  const service = new IdempotencyService();

  beforeAll(async () => {
    ds = await getTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(ds);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  it('hashes canonically: key order in the payload does not change the hash', () => {
    expect(service.hashRequest({ a: 1, b: [1, 2], c: { d: 4, e: 5 } })).toBe(
      service.hashRequest({ c: { e: 5, d: 4 }, b: [1, 2], a: 1 }),
    );
    // Array ORDER is significant — two different baskets are two different
    // requests.
    expect(service.hashRequest({ items: [1, 2] })).not.toBe(
      service.hashRequest({ items: [2, 1] }),
    );
  });

  it('claims a fresh key and completes it', async () => {
    const hash = service.hashRequest({ items: [{ variantId: 1, qty: 2 }] });

    const recordId = await ds.transaction(async (manager) => {
      const claim = await service.claim(manager, SCOPE, 'key-fresh', hash);
      expect(claim.replayed).toBe(false);
      if (claim.replayed) throw new Error('unreachable');

      await service.complete(manager, claim.recordId, 201, { orderId: 42 });
      return claim.recordId;
    });

    const row = await ds
      .getRepository(IdempotencyKey)
      .findOneByOrFail({ id: recordId });
    expect(row.status).toBe(IdempotencyStatus.COMPLETED);
    expect(row.responseStatus).toBe(201);
    expect(row.responseBody).toEqual({ orderId: 42 });
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it('REPLAYS a completed key instead of doing the work twice', async () => {
    const hash = service.hashRequest({ items: [{ variantId: 1, qty: 2 }] });

    await ds.transaction(async (manager) => {
      const claim = await service.claim(manager, SCOPE, 'key-replay', hash);
      if (claim.replayed) throw new Error('first claim must be fresh');
      await service.complete(manager, claim.recordId, 201, { orderId: 7 });
    });

    // The retry. This is the branch that was unreachable before the savepoint
    // fix — it used to blow up with 25P02 instead of replaying.
    const replay = await ds.transaction(async (manager) => {
      const claim = await service.claim<{ orderId: number }>(
        manager,
        SCOPE,
        'key-replay',
        hash,
      );
      expect(claim.replayed).toBe(true);

      // Proof the transaction survived the unique violation: an ordinary query
      // still works on the same manager.
      const [{ ok }] =
        await manager.query<Array<{ ok: number }>>('SELECT 1 AS ok');
      expect(Number(ok)).toBe(1);

      return claim;
    });

    expect(replay).toMatchObject({
      replayed: true,
      responseStatus: 201,
      responseBody: { orderId: 7 },
    });

    // And no duplicate row was created.
    await expect(
      ds
        .getRepository(IdempotencyKey)
        .countBy({ scope: SCOPE, key: 'key-replay' }),
    ).resolves.toBe(1);
  });

  it('409 IDEMPOTENCY_KEY_REUSED when the same key arrives with a different payload', async () => {
    const original = service.hashRequest({ items: [{ variantId: 1, qty: 2 }] });
    const different = service.hashRequest({
      items: [{ variantId: 1, qty: 9 }],
    });

    await ds.transaction(async (manager) => {
      const claim = await service.claim(manager, SCOPE, 'key-reuse', original);
      if (claim.replayed) throw new Error('first claim must be fresh');
      await service.complete(manager, claim.recordId, 201, { orderId: 1 });
    });

    let captured: unknown;
    await ds.transaction(async (manager) => {
      try {
        await service.claim(manager, SCOPE, 'key-reuse', different);
      } catch (error) {
        captured = error;
      }
      // Transaction still usable after the rejection.
      const [{ ok }] =
        await manager.query<Array<{ ok: number }>>('SELECT 1 AS ok');
      expect(Number(ok)).toBe(1);
    });

    expect(captured).toBeInstanceOf(ConflictException);
    expect((captured as ConflictException).getStatus()).toBe(409);
    expect(conflictCode(captured)).toBe(IDEMPOTENCY_KEY_REUSED);
  });

  it('409 IDEMPOTENCY_REQUEST_IN_PROGRESS while the first attempt is still running', async () => {
    const hash = service.hashRequest({ items: [] });

    // Simulate a claim that was made and committed but never completed (the
    // first request is mid-flight, or its process died).
    await ds.getRepository(IdempotencyKey).insert({
      scope: SCOPE,
      key: 'key-inflight',
      requestHash: hash,
      status: IdempotencyStatus.IN_PROGRESS,
    });

    let captured: unknown;
    await ds.transaction(async (manager) => {
      try {
        await service.claim(manager, SCOPE, 'key-inflight', hash);
      } catch (error) {
        captured = error;
      }
      const [{ ok }] =
        await manager.query<Array<{ ok: number }>>('SELECT 1 AS ok');
      expect(Number(ok)).toBe(1);
    });

    expect(conflictCode(captured)).toBe(IDEMPOTENCY_REQUEST_IN_PROGRESS);
  });

  it('rolls the key back with the business transaction, so a failed request can be retried', async () => {
    const hash = service.hashRequest({ items: [{ variantId: 3, qty: 1 }] });

    await expect(
      ds.transaction(async (manager) => {
        await service.claim(manager, SCOPE, 'key-rollback', hash);
        throw new Error('business failure after the key was claimed');
      }),
    ).rejects.toThrow('business failure');

    // The key must NOT survive: a sale that never happened must not block its
    // own retry.
    await expect(
      ds
        .getRepository(IdempotencyKey)
        .countBy({ scope: SCOPE, key: 'key-rollback' }),
    ).resolves.toBe(0);

    // ...and the retry succeeds.
    await ds.transaction(async (manager) => {
      const claim = await service.claim(manager, SCOPE, 'key-rollback', hash);
      expect(claim.replayed).toBe(false);
    });
  });

  it('peek() replays a completed key without opening a write transaction', async () => {
    const hash = service.hashRequest({ items: [{ variantId: 5, qty: 1 }] });

    await ds.transaction(async (manager) => {
      const claim = await service.claim(manager, SCOPE, 'key-peek', hash);
      if (claim.replayed) throw new Error('first claim must be fresh');
      await service.complete(manager, claim.recordId, 200, { ok: true });
    });

    await expect(
      service.peek(ds.manager, SCOPE, 'key-peek', hash),
    ).resolves.toMatchObject({ replayed: true, responseBody: { ok: true } });

    // Unknown key => nothing to replay, caller proceeds to claim().
    await expect(
      service.peek(ds.manager, SCOPE, 'key-unknown', hash),
    ).resolves.toBeNull();
  });

  it('scopes keys independently: the same key string in two scopes does not collide', async () => {
    const hash = service.hashRequest({ any: 'payload' });

    await ds.transaction(async (manager) => {
      const a = await service.claim(manager, SCOPE, 'shared', hash);
      const b = await service.claim(
        manager,
        IdempotencyScope.PAYMENT_VERIFY,
        'shared',
        hash,
      );
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
    });

    await expect(
      ds.getRepository(IdempotencyKey).countBy({ key: 'shared' }),
    ).resolves.toBe(2);
  });
});
