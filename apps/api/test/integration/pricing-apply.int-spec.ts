/**
 * Applying and rolling back monthly pricing plans (docs/MONTHLY-PRICING.md §6).
 *
 * The properties that matter most: all-or-nothing, idempotent, safe under
 * concurrency, never applying a stale calculation, never overwriting a later
 * legitimate price, and never touching a historical order or its COGS.
 */
import { PricingRunnerService } from 'src/modules/pricing/pricing-runner.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import { createProduct, createVariant } from './setup/seed-helpers';
import { fixtureIdempotencyKey } from './setup/fixture-ids';
import {
  applicableOf,
  calculated,
  examplePlan,
  listAt,
  livePrice,
  pricingClient,
  recordAt,
  rowOf,
  rowsOf,
  seedPricedCatalog,
  stringAt,
  settledRun,
  valueVariant,
} from './support/pricing.fixtures';

describe('applying and rolling back pricing plans (int)', () => {
  let ctx: TestApp;
  let cookie: string;
  let client: ReturnType<typeof pricingClient>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  // A run kicked by a test's last request must finish before the next test
  // truncates the tables it is writing.
  afterEach(async () => {
    await ctx.app.get(PricingRunnerService, { strict: false }).idle();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    cookie = (await ctx.loginAs([UserRoleEnum.superAdmin])).cookie;
    client = pricingClient(ctx, cookie);
  });

  async function valued(price: number, cost = 1_000_000n) {
    const product = await createProduct(ctx.dataSource);
    const variant = await createVariant(ctx.dataSource, product, { price });
    await valueVariant(ctx.dataSource, variant.id, {
      stock: 10,
      unitCost: cost,
    });
    return { productId: product.id, variantId: variant.id };
  }

  /** A plan calculated and approved, ready to apply. */
  async function approvedPlan() {
    const planId = await examplePlan(ctx, cookie);
    await calculated(ctx, cookie, planId);
    const count = applicableOf(await client.summary(planId).expect(200));
    await client.approve(planId, count).expect(201);
    return { planId, count };
  }

  async function applied(planId: number, count: number, key?: string) {
    const res = await client.apply(planId, count, key).expect(202);
    return settledRun(ctx, cookie, planId, rowOf(res).id);
  }

  async function auditRows(prefix = 'pricing.') {
    return ctx.dataSource.query(
      `SELECT action, summary FROM admin_audit_log WHERE action LIKE $1 ORDER BY id`,
      [`${prefix}%`],
    );
  }

  // ==========================================================================

  it('applies every approved price in one run, records history and audits without a Rial', async () => {
    const a = await valued(1_900_000);
    const b = await valued(1_500_000, 900_000n); // 900 000 / 0.5 = 1 800 000 (+20 %: not above 20 %)
    const { planId, count } = await approvedPlan();
    expect(count).toBe(2);

    const run = await applied(planId, count);
    expect(run).toMatchObject({
      kind: 'apply',
      status: 'succeeded',
      result: { changed: 2 },
    });
    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('2000000');
    expect(await livePrice(ctx.dataSource, b.variantId)).toBe('1800000');

    const plan = (await client.get(planId).expect(200)).body.data;
    expect(plan.status).toBe('APPLIED');
    expect(plan.appliedAt).not.toBeNull();

    const changes = (await client.changes(planId).expect(200)).body;
    expect(changes.total).toBe(2);
    expect(changes.data[0]).toMatchObject({
      kind: 'apply',
      oldPriceRial: '1900000',
      newPriceRial: '2000000',
      calculationMethod: 'TARGET_REVENUE',
      formulaVersion: 1,
    });
    expect(changes.data[0].changedByDisplay).toBeTruthy();

    // audit.read is delegable: the audit trail carries counts, never an amount
    const rows = await auditRows();
    expect(rows.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        'pricing.plan.created',
        'pricing.plan.calculated',
        'pricing.plan.approved',
        'pricing.plan.applied',
      ]),
    );
    const text = JSON.stringify(rows);
    for (const figure of [
      '1900000',
      '2000000',
      '1800000',
      '1000000000',
      '5000000000',
      '600000000',
    ]) {
      expect(text).not.toContain(figure);
    }
    expect(
      rows.find((r: { action: string }) => r.action === 'pricing.plan.applied')
        .summary,
    ).toMatchObject({
      variantsChanged: 2,
      productsChanged: 2,
    });
  });

  it('is idempotent: the same key replays the same run and never applies twice', async () => {
    const a = await valued(1_900_000);
    const { planId, count } = await approvedPlan();
    const key = fixtureIdempotencyKey('apply-once');

    const first = await client.apply(planId, count, key).expect(202);
    const second = await client.apply(planId, count, key).expect(202);
    expect(second.body.data.id).toBe(first.body.data.id);
    await settledRun(ctx, cookie, planId, rowOf(first).id);
    const third = await client.apply(planId, count, key).expect(202);
    expect(third.body.data).toMatchObject({
      id: first.body.data.id,
      status: 'succeeded',
    });

    // same key, different request → refused; new key after success → refused
    expect(
      (await client.apply(planId, count + 1, key).expect(409)).body.error,
    ).toBe('PRICING_IDEMPOTENCY_KEY_REUSED');
    await client.apply(planId, count).expect(409);

    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('2000000');
    expect((await client.changes(planId).expect(200)).body.total).toBe(1);
    await client.apply(planId, count, 'x').expect(400); // malformed key
  });

  it('lets exactly one of two concurrent apply requests through', async () => {
    const a = await valued(1_900_000);
    const { planId, count } = await approvedPlan();
    const [one, two] = await Promise.all([
      client.apply(planId, count, fixtureIdempotencyKey('race-a')),
      client.apply(planId, count, fixtureIdempotencyKey('race-b')),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([202, 409]);
    const winner = one.status === 202 ? one : two;
    await settledRun(ctx, cookie, planId, rowOf(winner).id);
    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('2000000');
    expect((await client.changes(planId).expect(200)).body.total).toBe(1);
  });

  it('refuses a stale calculation: nothing is written, the stale rows are marked', async () => {
    const a = await valued(1_900_000);
    const b = await valued(1_900_000);
    const c = await valued(1_900_000);
    const { planId, count } = await approvedPlan();
    expect(count).toBe(3);

    // after approval, one price is edited by hand and one cost changes
    await ctx.dataSource.query(
      `UPDATE product_variants SET price = 1950000 WHERE id = $1`,
      [b.variantId],
    );
    await valueVariant(ctx.dataSource, c.variantId, {
      stock: 10,
      unitCost: 1_100_000n,
    });

    const run = await applied(planId, count);
    expect(run).toMatchObject({
      status: 'failed',
      errorCode: 'PRICING_PREVIEW_STALE',
      result: { staleCount: 2, changed: 0 },
    });
    expect(run.errorMessage).toMatch(/هیچ قیمتی تغییر نکرد/);
    // all or nothing: the one fresh row was not written either
    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('1900000');
    expect(await livePrice(ctx.dataSource, b.variantId)).toBe('1950000');
    expect(await livePrice(ctx.dataSource, c.variantId)).toBe('1900000');

    const plan = (await client.get(planId).expect(200)).body.data;
    expect(plan).toMatchObject({
      status: 'READY_FOR_REVIEW',
      approvedAt: null,
      lastErrorCode: 'PRICING_PREVIEW_STALE',
    });
    const stale = rowsOf(
      await client.items(planId, { view: 'all', stale: true }).expect(200),
    );
    expect(stale.map((row) => stringAt(row, 'staleReason')).sort()).toEqual([
      'COST_CHANGED',
      'PRICE_CHANGED',
    ]);
    expect(stale.every((row) => row.included === false)).toBe(true);
    await client
      .updateItem(planId, stale[0].id, { included: true })
      .expect(409);

    // the fresh row can still be approved and applied on its own
    await client.approve(planId, 1).expect(201);
    const retry = await applied(planId, 1);
    expect(retry.status).toBe('succeeded');
    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('2000000');
    expect(await livePrice(ctx.dataSource, b.variantId)).toBe('1950000');
  });

  it('rolls the whole batch back when one write fails mid-way, then retries cleanly', async () => {
    const catalog = await seedPricedCatalog(ctx.dataSource, 1_200, 'FAIL');
    const { planId, count } = await approvedPlan();
    // More than one 500-row write chunk, so the injected failure lands after
    // earlier chunks were already written inside the same transaction.
    expect(count).toBeGreaterThan(500);

    // a test-only trigger makes the write of ONE late variant fail (≥ 2nd chunk)
    const victim = catalog.variantIds[catalog.variantIds.length - 3];
    await ctx.dataSource.query(
      `CREATE OR REPLACE FUNCTION test_fail_price() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.id = ${victim} AND NEW.price IS DISTINCT FROM OLD.price THEN
         RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
    );
    await ctx.dataSource.query(
      `CREATE TRIGGER test_fail_price BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION test_fail_price()`,
    );
    const before = await ctx.dataSource.query(
      `SELECT id, price::text AS price FROM product_variants WHERE id = ANY($1::int[]) ORDER BY id`,
      [catalog.variantIds],
    );
    try {
      const run = await applied(planId, count);
      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'PRICING_RUN_FAILED',
      });
      const after = await ctx.dataSource.query(
        `SELECT id, price::text AS price FROM product_variants WHERE id = ANY($1::int[]) ORDER BY id`,
        [catalog.variantIds],
      );
      expect(after).toEqual(before);
      expect((await client.changes(planId).expect(200)).body.total).toBe(0);
      const plan = (await client.get(planId).expect(200)).body.data;
      expect(plan).toMatchObject({
        status: 'FAILED',
        lastErrorCode: 'PRICING_RUN_FAILED',
      });
    } finally {
      await ctx.dataSource.query(
        `DROP TRIGGER IF EXISTS test_fail_price ON product_variants`,
      );
      await ctx.dataSource.query(`DROP FUNCTION IF EXISTS test_fail_price()`);
    }

    // the approval survived the failure: a retry with a NEW key applies everything
    const retry = await applied(planId, count, fixtureIdempotencyKey('retry'));
    expect(retry).toMatchObject({
      status: 'succeeded',
      result: { changed: count },
    });
    expect(await livePrice(ctx.dataSource, victim)).toBe('2000000');
    expect(
      (await client.changes(planId, { limit: 1 }).expect(200)).body.total,
    ).toBe(count);
  });

  it('rolls back safely: restores what it wrote and never overwrites a later change', async () => {
    const a = await valued(1_900_000);
    const b = await valued(1_900_000);
    const nullPrice = await valued(0);
    await ctx.dataSource.query(
      `UPDATE product_variants SET price = NULL WHERE id = $1`,
      [nullPrice.variantId],
    );
    const planId = await examplePlan(ctx, cookie);
    await calculated(ctx, cookie, planId);
    // the missing-price row needs review: approve it explicitly
    const review = rowsOf(
      await client
        .items(planId, { view: 'all', status: 'NEEDS_REVIEW' })
        .expect(200),
    );
    expect(review).toHaveLength(1);
    await client
      .updateItem(planId, review[0].id, { included: true })
      .expect(200);
    await client.approve(planId, 3).expect(201);
    await applied(planId, 3);
    expect(await livePrice(ctx.dataSource, nullPrice.variantId)).toBe(
      '2000000',
    );

    // a later, legitimate manual change on one variant
    await ctx.dataSource.query(
      `UPDATE product_variants SET price = 2222222 WHERE id = $1`,
      [b.variantId],
    );
    const preview = (await client.rollbackPreview(planId).expect(200)).body
      .data;
    expect(preview).toMatchObject({ applied: 3, restorable: 2, conflicts: 1 });

    const key = fixtureIdempotencyKey('rollback');
    const started = await client.rollback(planId, key).expect(202);
    const run = await settledRun(ctx, cookie, planId, rowOf(started).id);
    expect(run).toMatchObject({
      kind: 'rollback',
      status: 'succeeded',
      result: { restored: 2, conflictCount: 1 },
    });
    expect(listAt(recordAt(run, 'result'), 'conflicts')[0]).toMatchObject({
      variantId: b.variantId,
      appliedPriceRial: '2000000',
      currentPriceRial: '2222222',
    });
    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('1900000');
    expect(await livePrice(ctx.dataSource, b.variantId)).toBe('2222222'); // untouched
    expect(await livePrice(ctx.dataSource, nullPrice.variantId)).toBeNull(); // restored exactly

    const plan = (await client.get(planId).expect(200)).body.data;
    expect(plan.status).toBe('ROLLED_BACK');
    const history = (
      await client.changes(planId, { kind: 'rollback' }).expect(200)
    ).body;
    expect(history.total).toBe(2);
    expect(
      history.data.every(
        (row: { revertsChangeId: number }) => row.revertsChangeId > 0,
      ),
    ).toBe(true);

    // idempotent replay, then nothing more to do
    expect((await client.rollback(planId, key).expect(202)).body.data.id).toBe(
      started.body.data.id,
    );
    await client.rollback(planId).expect(409);
    await client.update(planId, { title: 'x' }).expect(409);
    await client.remove(planId).expect(409);

    // history is append-only at the database
    await expect(
      ctx.dataSource.query(
        `UPDATE pricing_price_changes SET "newPriceRial" = 1 WHERE "planId" = $1`,
        [planId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.dataSource.query(
        `DELETE FROM pricing_price_changes WHERE "planId" = $1`,
        [planId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('never changes a historical order line, its COGS or the profit report', async () => {
    const a = await valued(1_900_000);
    // a completed POS sale at the old price, through the real sale path
    const [branch] = await ctx.dataSource.query(
      `INSERT INTO branches (name) VALUES ('شعبهٔ فروش') RETURNING id`,
    );
    const cashier = await ctx.loginAs([UserRoleEnum.sale], undefined, {
      branchId: Number(branch.id),
    });
    const sale = await ctx
      .request()
      .post('/orders/pos')
      .set('Cookie', cashier.cookie)
      .set('Idempotency-Key', fixtureIdempotencyKey('pos'))
      .send({
        items: [{ productVariantId: a.variantId, quantity: 2 }],
        paymentMethod: 'cash',
      });
    expect([200, 201]).toContain(sale.status);

    const lineBefore = await ctx.dataSource.query(
      `SELECT unit_price::text, total_price::text, "cogsTotal"::text, "costStatus" FROM order_items WHERE "variantId" = $1`,
      [a.variantId],
    );
    expect(lineBefore).toHaveLength(1);
    expect(lineBefore[0]).toMatchObject({
      unit_price: '1900000',
      total_price: '3800000',
      cogsTotal: '2000000',
      costStatus: 'known',
    });
    const profitBefore = (
      await ctx
        .request()
        .get('/reports/profit/summary')
        .set('Cookie', cookie)
        .expect(200)
    ).body;

    const { planId, count } = await approvedPlan();
    await applied(planId, count);
    expect(await livePrice(ctx.dataSource, a.variantId)).toBe('2000000');

    const lineAfter = await ctx.dataSource.query(
      `SELECT unit_price::text, total_price::text, "cogsTotal"::text, "costStatus" FROM order_items WHERE "variantId" = $1`,
      [a.variantId],
    );
    expect(lineAfter).toEqual(lineBefore);
    const profitAfter = (
      await ctx
        .request()
        .get('/reports/profit/summary')
        .set('Cookie', cookie)
        .expect(200)
    ).body;
    expect(profitAfter.totals).toEqual(profitBefore.totals);

    // a NEW sale is charged the new price
    await ctx
      .request()
      .post('/orders/pos')
      .set('Cookie', cashier.cookie)
      .set('Idempotency-Key', fixtureIdempotencyKey('pos-2'))
      .send({
        items: [{ productVariantId: a.variantId, quantity: 1 }],
        paymentMethod: 'cash',
      });
    const lines = await ctx.dataSource.query(
      `SELECT unit_price::text FROM order_items WHERE "variantId" = $1 ORDER BY id`,
      [a.variantId],
    );
    expect(lines.map((l: { unit_price: string }) => l.unit_price)).toEqual([
      '1900000',
      '2000000',
    ]);

    // the public product and the till catalogue show the new price
    const pub = await ctx.request().get(`/products/${a.productId}`).expect(200);
    expect(JSON.stringify(pub.body)).toContain('2000000');
    const catalog = await ctx
      .request()
      .get('/inventory/catalog')
      .set('Cookie', cashier.cookie);
    expect(catalog.status).toBe(200);
    expect(JSON.stringify(catalog.body)).toContain('2000000');
  });

  it('prices through the real costing receipt path, end to end', async () => {
    const product = await createProduct(ctx.dataSource);
    const variant = await createVariant(ctx.dataSource, product, {
      price: 1_000_000,
      stock: 0,
    });
    // receive 3 @ 1 000 000 and 2 @ 1 500 000 → exact average ⌊6 000 000 / 5⌋ = 1 200 000
    for (const [quantity, unitCost, n] of [
      [3, 1_000_000, 1],
      [2, 1_500_000, 2],
    ]) {
      await ctx
        .request()
        .post(`/admin/costing/variants/${variant.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', fixtureIdempotencyKey(`receipt-${n}`))
        .send({ quantity, unitCost })
        .expect(201);
    }
    const planId = await examplePlan(ctx, cookie);
    await calculated(ctx, cookie, planId);
    const item = (await client.items(planId, { view: 'all' }).expect(200)).body
      .data[0];
    expect(item).toMatchObject({
      costBasisRial: '1200000',
      proposedPriceRial: '2400000',
      status: 'NEEDS_REVIEW',
      reasons: ['LARGE_INCREASE'],
    });
  });
});
