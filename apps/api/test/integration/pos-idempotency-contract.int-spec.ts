/**
 * WORKSTREAM G — the POS `Idempotency-Key` is part of the request contract.
 *
 * The header used to be optional: accepted when present, skipped when absent
 * (`idempotencyKey?: string`, every claim behind `if (idempotencyKey)`). Retry
 * protection you can forget to ask for is missing in exactly the situations it
 * exists for — a cashier double-tapping "Charge", a terminal retrying a request
 * that timed out after the server had already committed it — and both of those
 * rang the sale up twice and decremented stock twice.
 *
 * Every case below therefore asserts the DATABASE, not just the HTTP status:
 * a 400 that still wrote an order, or a 409 that still moved stock, is the bug
 * this file exists to catch. The concurrency case is a real race between real
 * transactions against the real PostgreSQL — the serialisation under test is
 * the UNIQUE(scope, key) index's, and no mock has one.
 */
import { randomUUID } from 'node:crypto';

import { forceStockForTest } from './setup/seed-helpers';
import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  asRaw,
  Cashier,
  countMovements,
  countOrders,
  loginCashier,
  posKey,
  seedBranch,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  IDEMPOTENCY_KEY_FOREIGN_CASHIER,
  IDEMPOTENCY_KEY_INVALID,
  IDEMPOTENCY_KEY_REQUIRED,
  POS_IDEMPOTENCY_HEADER,
} from 'src/modules/orders/idempotency.helper';
import { IDEMPOTENCY_KEY_REUSED } from 'src/common/services/idempotency.service';

/** Machine-readable code the API promises under `details.code`. */
function codeOf(body: unknown): string | undefined {
  const details = (body as { details?: { code?: unknown } } | null)?.details;
  return typeof details?.code === 'string' ? details.code : undefined;
}

interface StoredOrder {
  cashierUserId: number;
  cashierDisplaySnapshot: string;
  branchId: number;
  branchNameSnapshot: string;
  orderNumber: string;
}

async function readOrder(ctx: TestApp, id: number): Promise<StoredOrder> {
  const [row] = await ctx.dataSource.query<Array<Record<string, unknown>>>(
    `SELECT "cashierUserId", "cashierDisplaySnapshot", "branchId",
            "branchNameSnapshot", "orderNumber"
       FROM orders WHERE id = $1`,
    [id],
  );
  return {
    cashierUserId: Number(row.cashierUserId),
    cashierDisplaySnapshot: String(row.cashierDisplaySnapshot),
    branchId: Number(row.branchId),
    branchNameSnapshot: String(row.branchNameSnapshot),
    orderNumber: String(row.orderNumber),
  };
}

describe('POS sale — Idempotency-Key is required and dependable (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
  });

  const saleBody = (variantId: number, quantity = 2) => ({
    paymentMethod: PaymentMethodEnum.CASH,
    items: [{ productVariantId: variantId, quantity }],
  });

  // =======================================================================
  // 1. Missing key -> rejected, and nothing at all was written
  // =======================================================================
  describe('1. a sale without an Idempotency-Key is refused', () => {
    it('rejects the request with 400 IDEMPOTENCY_KEY_REQUIRED and writes no order and no stock movement', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });

      // `asRaw` sends exactly what the test sets. `as()` stands in for the POS
      // frontend and would generate a key, hiding the very thing under test.
      const res = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .send(saleBody(variant.id));

      expect(res.status).toBe(400);
      expect(codeOf(res.body)).toBe(IDEMPOTENCY_KEY_REQUIRED);
      // The message has to tell a POS vendor what to do, and has to say the
      // client generates the key — otherwise the first "fix" is a text box
      // asking a cashier for a UUID.
      expect(String(res.body.message)).toMatch(/Idempotency-Key/i);
      expect(String(res.body.message)).toMatch(/cashiers never type/i);

      // The point of the whole change: a rejected request is a request that
      // did not happen.
      expect(await countOrders(ctx.dataSource)).toBe(0);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(10);
      expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['a tab', '\t'],
      ['too short to be unique', 'k1'],
      ['containing a space', 'sale key 0001'],
      ['containing a comma (a doubled header)', 'key-aaaaaa,key-bbbbbb'],
      ['longer than the documented bound', 'k'.repeat(201)],
    ])('rejects a %s key without touching stock', async (_label, key) => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 300_000, stock: 4 });

      const res = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(saleBody(variant.id, 1));

      expect(res.status).toBe(400);
      // Empty and whitespace-only are "you sent nothing"; the rest are "you
      // sent something malformed". Both are 400, and both are specific.
      expect([IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_KEY_INVALID]).toContain(
        codeOf(res.body),
      );
      expect(await countOrders(ctx.dataSource)).toBe(0);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);
      expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
    });

    it('accepts the recommended format: a client-generated UUIDv4', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 300_000, stock: 4 });

      /*
       * A REAL UUIDv4, from the platform — not `posKey()`.
       *
       * This case is about the FORMAT the contract recommends a POS client
       * generate, so the key has to be one. It used to call `posKey()` and
       * then assert the result matched the UUID pattern, which quietly made
       * the case a test of the fixture helper rather than of the endpoint —
       * and it broke the moment the helper was replaced with the collision-
       * free allocator (which deliberately produces readable, traceable keys
       * like `fixture-18560045-543700` instead of opaque UUIDs).
       *
       * Every other case in this file still uses `posKey()`, which is right:
       * they need uniqueness and a name, not a particular shape.
       */
      const key = randomUUID();
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(saleBody(variant.id, 1))
        .expect(201);
    });
  });

  // =======================================================================
  // 2. Same key, same payload -> ONE sale, replayed
  // =======================================================================
  describe('2. retrying the same attempt replays the first response', () => {
    it('returns the same order id and orderNumber and decrements stock exactly once', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });
      const key = posKey('replay');
      const body = saleBody(variant.id, 2);

      const first = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);

      // The terminal never saw the first response (timeout) and retries.
      const second = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);

      // A third time, because "idempotent" is not "idempotent once".
      const third = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(third.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);
      expect(third.body.data.orderNumber).toBe(first.body.data.orderNumber);
      expect(second.body.data.totalPrice).toBe(first.body.data.totalPrice);

      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(8);
      expect(await countMovements(ctx.dataSource, variant.id)).toBe(1);
    });

    it('scopes the key to POS sales, so an unrelated feature cannot collide with it', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 100_000, stock: 5 });
      const key = posKey('scoped');

      await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(saleBody(variant.id, 1))
        .expect(201);

      const [row] = await ctx.dataSource.query<
        Array<{ scope: string; status: string }>
      >(`SELECT scope, status FROM idempotency_keys WHERE "key" = $1`, [key]);
      expect(row.scope).toBe('pos_sale');
      expect(row.status).toBe('completed');
    });
  });

  // =======================================================================
  // 3. Same key, DIFFERENT payload -> specific 409, first sale untouched
  // =======================================================================
  describe('3. reusing a key for a different sale is refused, not replayed', () => {
    it('answers 409 IDEMPOTENCY_KEY_REUSED and leaves the original sale and stock untouched', async () => {
      const branch = await seedBranch(ctx, 'Central');
      const cashier = await loginCashier(ctx, branch, { username: 'reuse_a' });
      const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });
      const key = posKey('reuse');

      const first = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(saleBody(variant.id, 2))
        .expect(201);
      const before = await readOrder(ctx, Number(first.body.data.id));

      // Same key, genuinely different sale. Replaying the first response here
      // would hand the cashier a receipt for goods they did not sell.
      const conflicting = saleBody(variant.id, 3);
      const a = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(conflicting);
      const b = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(conflicting);

      expect(a.status).toBe(409);
      expect(b.status).toBe(409);
      expect(codeOf(a.body)).toBe(IDEMPOTENCY_KEY_REUSED);
      // Deterministic: the same rejection every time, never "409 then 201".
      expect(codeOf(b.body)).toBe(codeOf(a.body));
      expect(String(b.body.message)).toBe(String(a.body.message));

      // Nothing new exists, and the original is byte-for-byte what it was.
      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(8);
      expect(await countMovements(ctx.dataSource, variant.id)).toBe(1);
      expect(await readOrder(ctx, Number(first.body.data.id))).toEqual(before);
    });

    it('treats a payload that differs only in JSON key order as the SAME request', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 300_000, stock: 10 });
      const key = posKey('canonical');

      const first = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 2 }],
        })
        .expect(201);

      // A different client library serialising the same object. Hashing raw
      // bytes would call this a key-reuse attack; hashing canonical JSON does
      // not.
      const second = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send({
          items: [{ quantity: 2, productVariantId: variant.id }],
          paymentMethod: PaymentMethodEnum.CASH,
        })
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(8);
    });
  });

  // =======================================================================
  // 4. N concurrent requests with the same key -> exactly ONE sale
  // =======================================================================
  describe('4. simultaneous double-taps produce exactly one sale', () => {
    it('serialises 6 in-flight requests on the unique index: one sale, one decrement, six identical 201s', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      // Stock is deliberately far above what one sale needs: if the losers did
      // the work instead of replaying, they would SUCCEED and the failure would
      // show up as extra orders rather than as a stock error.
      const variant = await seedVariant(ctx, { price: 250_000, stock: 50 });
      const key = posKey('concurrent');
      const body = saleBody(variant.id, 2);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          asRaw(ctx, cashier)
            .post('/orders/pos')
            .set(POS_IDEMPOTENCY_HEADER, key)
            .send(body),
        ),
      );

      // GUARANTEED CONTRACT: every caller succeeds with the same sale. The
      // losers block on the unique INSERT until the winner commits and then
      // replay its stored response, so there is no "one wins, the rest get an
      // error" outcome to tolerate here.
      expect(results.map((r) => r.status)).toEqual([
        201, 201, 201, 201, 201, 201,
      ]);

      const ids = new Set(results.map((r) => Number(r.body.data.id)));
      const numbers = new Set(
        results.map((r) => String(r.body.data.orderNumber)),
      );
      expect(ids.size).toBe(1);
      expect(numbers.size).toBe(1);

      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(48);
      expect(await countMovements(ctx.dataSource, variant.id)).toBe(1);

      // Exactly one key row, and it is completed.
      const [row] = await ctx.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count FROM idempotency_keys WHERE "key" = $1 AND status = 'completed'`,
        [key],
      );
      expect(Number(row.count)).toBe(1);
    });

    it('lets the retry of a FAILED attempt through instead of blocking it as "in progress"', async () => {
      const branch = await seedBranch(ctx);
      const cashier = await loginCashier(ctx, branch);
      const variant = await seedVariant(ctx, { price: 250_000, stock: 1 });
      const key = posKey('failed-then-restocked');

      // The sale fails on stock. Its key row must roll back with it: a sale
      // that never happened must not veto its own retry.
      const failed = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(saleBody(variant.id, 5));
      expect(failed.status).toBe(409);
      expect(codeOf(failed.body)).not.toBe(IDEMPOTENCY_KEY_REUSED);

      const [row] = await ctx.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count FROM idempotency_keys WHERE "key" = $1`,
        [key],
      );
      expect(Number(row.count)).toBe(0);

      // Same key, same payload, now that the shelf has been restocked.
      await forceStockForTest(ctx.dataSource, variant.id, 20);
      const retry = await asRaw(ctx, cashier)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(saleBody(variant.id, 5))
        .expect(201);

      expect(retry.body.data.id).toBeGreaterThan(0);
      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(15);
    });
  });

  // =======================================================================
  // 5. A replay never re-attributes the sale
  // =======================================================================
  describe('5. replays keep the ORIGINAL cashier and branch', () => {
    async function twoCashiers(): Promise<{
      branchName: string;
      branchId: number;
      a: Cashier;
      b: Cashier;
    }> {
      const branch = await seedBranch(ctx, 'Central');
      const a = await loginCashier(ctx, branch, { username: 'attrib_a' });
      const b = await loginCashier(ctx, branch, { username: 'attrib_b' });
      return { branchName: branch.name, branchId: branch.id, a, b };
    }

    it('replays to the ORIGINAL cashier with the original attribution intact', async () => {
      const { a, branchId, branchName } = await twoCashiers();
      const variant = await seedVariant(ctx, { price: 400_000, stock: 8 });
      const key = posKey('attrib-self');
      const body = saleBody(variant.id, 1);

      const first = await asRaw(ctx, a)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);
      const replay = await asRaw(ctx, a)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);

      expect(replay.body.data.cashierUserId).toBe(a.userId);
      expect(replay.body.data.cashierDisplaySnapshot).toBe('attrib_a');
      expect(replay.body.data.branchId).toBe(branchId);
      expect(replay.body.data.branchNameSnapshot).toBe(branchName);

      expect(await readOrder(ctx, Number(first.body.data.id))).toMatchObject({
        cashierUserId: a.userId,
        cashierDisplaySnapshot: 'attrib_a',
        branchId,
        branchNameSnapshot: branchName,
      });
    });

    /**
     * DECISION, documented here because the requirement asked for one: a
     * cashier replaying somebody else's key is REFUSED, not served.
     *
     * The stored response carries the original seller, so replaying it to a
     * different cashier answers "here is your sale" with another person's
     * receipt — a completed sale on this terminal, attributed to someone else
     * in the ledger, and no trace of why the till is short at close of day.
     * It is also the only shape a key-guessing probe can take, and one that
     * would leak another cashier's sale total. There is no legitimate client
     * behaviour behind it: the terminal making a sale generates that sale's
     * key.
     *
     * Enforced in `assertPosSaleKeyOwnedBy` (controller-side, before the sale
     * transaction opens). Note that the request would be refused even without
     * it, because `requestHashOf` includes `cashierUserId` — but with the
     * generic "different request payload" 409, which is untrue and
     * unactionable when the body was byte-identical, as it is here.
     */
    it('REFUSES a replay by a different cashier with 409 IDEMPOTENCY_KEY_FOREIGN_CASHIER and does not re-attribute the sale', async () => {
      const { a, b, branchId, branchName } = await twoCashiers();
      const variant = await seedVariant(ctx, { price: 400_000, stock: 8 });
      const key = posKey('attrib-foreign');
      const body = saleBody(variant.id, 2);

      const first = await asRaw(ctx, a)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);
      const before = await readOrder(ctx, Number(first.body.data.id));
      expect(before.cashierUserId).toBe(a.userId);

      // Cashier B, byte-identical body, A's key.
      const stolen = await asRaw(ctx, b)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body);

      expect(stolen.status).toBe(409);
      expect(codeOf(stolen.body)).toBe(IDEMPOTENCY_KEY_FOREIGN_CASHIER);
      // And A's receipt is not disclosed in the refusal.
      expect(JSON.stringify(stolen.body)).not.toContain(before.orderNumber);

      // The persisted sale is untouched: still A's, still A's branch, still
      // one sale, still one decrement.
      expect(await readOrder(ctx, Number(first.body.data.id))).toEqual(before);
      expect(before).toMatchObject({
        cashierUserId: a.userId,
        cashierDisplaySnapshot: 'attrib_a',
        branchId,
        branchNameSnapshot: branchName,
      });
      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(6);
      expect(await countMovements(ctx.dataSource, variant.id)).toBe(1);
    });

    it('refuses a replay by a cashier in a DIFFERENT branch too', async () => {
      const north = await seedBranch(ctx, 'North');
      const south = await seedBranch(ctx, 'South');
      const a = await loginCashier(ctx, north, { username: 'attrib_north' });
      const b = await loginCashier(ctx, south, { username: 'attrib_south' });
      const variant = await seedVariant(ctx, { price: 400_000, stock: 8 });
      const key = posKey('attrib-cross-branch');
      const body = saleBody(variant.id, 1);

      const first = await asRaw(ctx, a)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body)
        .expect(201);

      const crossed = await asRaw(ctx, b)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, key)
        .send(body);

      expect(crossed.status).toBe(409);
      expect(codeOf(crossed.body)).toBe(IDEMPOTENCY_KEY_FOREIGN_CASHIER);

      expect(await readOrder(ctx, Number(first.body.data.id))).toMatchObject({
        cashierUserId: a.userId,
        branchId: north.id,
        branchNameSnapshot: 'North',
      });
      expect(await countOrders(ctx.dataSource)).toBe(1);
      expect(await stockOf(ctx.dataSource, variant.id)).toBe(7);
    });

    it('does not let a body-supplied cashierId change who a fresh sale is attributed to', async () => {
      const { a, b } = await twoCashiers();
      const variant = await seedVariant(ctx, { price: 400_000, stock: 8 });

      // Attribution comes from the verified token and nowhere else; the key
      // does not weaken that.
      const res = await asRaw(ctx, b)
        .post('/orders/pos')
        .set(POS_IDEMPOTENCY_HEADER, posKey('forge'))
        .send({ ...saleBody(variant.id, 1), cashierId: a.userId })
        .expect(201);

      expect(res.body.data.cashierUserId).toBe(b.userId);
      expect(await readOrder(ctx, Number(res.body.data.id))).toMatchObject({
        cashierUserId: b.userId,
        cashierDisplaySnapshot: 'attrib_b',
      });
    });
  });
});
