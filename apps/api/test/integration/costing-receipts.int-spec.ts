/**
 * POST /admin/costing/variants/:variantId/receipts
 * (docs/PURCHASE-COST-ACCOUNTING.md §3.1, §6, §13).
 *
 * A receipt is the ONLY way valued units enter a live variant, so these cases
 * pin the arithmetic (value += q × c exactly, never through a JS number), the
 * moving average the contract's worked example derives, the ledger evidence,
 * the idempotency contract, and conservation of value under concurrency —
 * against a real PostgreSQL, because the guarantees are the row lock and the
 * compare-and-set, not the code path.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import {
  createPosTestApp,
  posEmitted,
  resetPosEmitted,
  TestApp,
} from './support/pos.harness';
import {
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
  seedVariant,
} from './support/pos.fixtures';
import {
  auditRowsFor,
  costing,
  costingKey,
  movementsOf,
  orderLinesOf,
  poolOf,
  sumCostDelta,
} from './support/costing.fixtures';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';

describe('costing — stock receipts (int)', () => {
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
    resetPosEmitted();
  });

  async function sell(
    cashier: Awaited<ReturnType<typeof loginCashier>>,
    variantId: number,
    quantity: number,
  ): Promise<number> {
    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variantId, quantity }],
      });
    expect(res.status).toBe(201);
    return Number(res.body.data.id);
  }

  it('values a receipt at exactly quantity × unitCost and reports before/after', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });

    const res = await costing(ctx, admin.jar)
      .receipt(variant.id, {
        quantity: 3,
        unitCost: 10_000,
        supplierReference: '  INV-1405-0071  ',
        note: 'اولین خرید',
      })
      .expect(201);

    expect(res.body.data).toEqual({
      movementId: expect.any(Number),
      variantId: variant.id,
      quantity: 3,
      unitCost: '10000',
      incomingValue: '30000',
      before: {
        stock: 0,
        unvaluedQuantity: 0,
        valuedQuantity: 0,
        inventoryCostValue: '0',
        averageUnitCost: null,
        costStatus: 'valued',
      },
      after: {
        stock: 3,
        unvaluedQuantity: 0,
        valuedQuantity: 3,
        inventoryCostValue: '30000',
        averageUnitCost: '10000',
        costStatus: 'valued',
      },
    });

    const pool = await poolOf(ctx.dataSource, variant.id);
    expect(pool).toEqual({
      stock: 3,
      unvaluedQuantity: 0,
      inventoryCostValue: '30000',
      lastPurchaseUnitCost: '10000',
      costStatus: 'valued',
    });

    const [movement] = await movementsOf(ctx.dataSource, variant.id);
    expect(movement).toMatchObject({
      id: res.body.data.movementId,
      reason: 'stock_receipt',
      delta: 3,
      balanceAfter: 3,
      unitCost: '10000',
      costDelta: '30000',
      inventoryValueAfter: '30000',
      unvaluedQuantityDelta: 0,
      unvaluedQuantityAfter: 0,
      // Trimmed, and on the ledger row itself.
      supplierReference: 'INV-1405-0071',
      reasonText: 'اولین خرید',
      orderId: null,
      actorUserId: admin.userId,
    });
  });

  it('moving average across receipts at different prices, then COGS per the §3.1 worked example', async () => {
    const admin = await loginSuperAdmin(ctx);
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { stock: 0, price: 50_000 });
    const api = costing(ctx, admin.jar);

    await api
      .receipt(variant.id, { quantity: 3, unitCost: 10_000 })
      .expect(201);
    const second = await api
      .receipt(variant.id, { quantity: 2, unitCost: '13001' })
      .expect(201);

    // pool: 5 units, 56 002; average ⌊56 002 / 5⌋ = 11 200
    expect(second.body.data.after.inventoryCostValue).toBe('56002');
    expect(second.body.data.after.averageUnitCost).toBe('11200');
    expect(second.body.data.incomingValue).toBe('26002');
    // The remembered price is the LAST receipt's, not the average.
    expect(
      (await poolOf(ctx.dataSource, variant.id)).lastPurchaseUnitCost,
    ).toBe('13001');

    const view = await api.variant(variant.id).expect(200);
    expect(view.body.data).toMatchObject({
      variantId: variant.id,
      stock: 5,
      valuedQuantity: 5,
      inventoryCostValue: '56002',
      averageUnitCost: '11200',
      lastPurchaseUnitCost: '13001',
      costStatus: 'valued',
    });
    // Newest first, with the cost evidence.
    expect(
      view.body.data.recentMovements.map(
        (m: { costDelta: string }) => m.costDelta,
      ),
    ).toEqual(['26002', '30000']);

    // sell 2 → ⌊56 002 × 2 / 5⌋ = 22 400; sell 1 → ⌊33 602 / 3⌋ = 11 200;
    // sell the last 2 → the whole remainder, 22 402.
    const o1 = await sell(cashier, variant.id, 2);
    const o2 = await sell(cashier, variant.id, 1);
    const o3 = await sell(cashier, variant.id, 2);
    const cogs = [
      (await orderLinesOf(ctx.dataSource, o1))[0].cogsTotal,
      (await orderLinesOf(ctx.dataSource, o2))[0].cogsTotal,
      (await orderLinesOf(ctx.dataSource, o3))[0].cogsTotal,
    ];
    expect(cogs).toEqual(['22400', '11200', '22402']);

    const pool = await poolOf(ctx.dataSource, variant.id);
    expect(pool.stock).toBe(0);
    expect(pool.inventoryCostValue).toBe('0');
    // Σ cogs = Σ receipts, exactly.
    expect(cogs.reduce((s, c) => s + BigInt(c!), 0n)).toBe(56_002n);
    // Σ costDelta over the ledger equals the pool value (0).
    expect(await sumCostDelta(ctx.dataSource, variant.id)).toBe('0');
  });

  it('keeps money exact beyond 2^53 (strings in, strings out)', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });
    // 45 000 000 000 Rial × 400 000 units = 1.8 × 10^16 > 2^53
    const res = await costing(ctx, admin.jar)
      .receipt(variant.id, { quantity: 400_000, unitCost: '45000000000' })
      .expect(201);
    expect(res.body.data.incomingValue).toBe('18000000000000000');
    expect((await poolOf(ctx.dataSource, variant.id)).inventoryCostValue).toBe(
      '18000000000000000',
    );
  });

  it('replays the stored response for the same key and body: one movement, value once', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });
    const api = costing(ctx, admin.jar);
    const key = costingKey('receipt-replay');
    const body = { quantity: 4, unitCost: 2_500 };

    const first = await api.receipt(variant.id, body, key).expect(201);
    resetPosEmitted();
    // The same amount as a string is the same request.
    const second = await api
      .receipt(variant.id, { quantity: 4, unitCost: '2500' }, key)
      .expect(201);

    expect(second.body.data).toEqual(first.body.data);
    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(1);
    const pool = await poolOf(ctx.dataSource, variant.id);
    expect(pool.stock).toBe(4);
    expect(pool.inventoryCostValue).toBe('10000');
    // A replay changed nothing, so it announces nothing.
    expect(posEmitted()).toHaveLength(0);
    expect(
      await auditRowsFor(ctx.dataSource, 'inventory.receipt.recorded'),
    ).toHaveLength(1);
  });

  it('a double-submit racing on ONE key applies once and answers every attempt identically', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });
    const api = costing(ctx, admin.jar);
    const key = costingKey('receipt-race');
    const body = { quantity: 2, unitCost: 5_000 };

    const results = await Promise.all([
      api.receipt(variant.id, body, key),
      api.receipt(variant.id, body, key),
      api.receipt(variant.id, body, key),
    ]);
    for (const r of results) expect(r.status).toBe(201);
    const ids = new Set(results.map((r) => r.body.data.movementId));
    expect(ids.size).toBe(1);
    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(1);
    expect((await poolOf(ctx.dataSource, variant.id)).inventoryCostValue).toBe(
      '10000',
    );
  });

  it('refuses the same key with a different body: 409 STOCK_RECEIPT_IDEMPOTENCY_CONFLICT', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });
    const api = costing(ctx, admin.jar);
    const key = costingKey('receipt-conflict');

    await api
      .receipt(variant.id, { quantity: 4, unitCost: 2_500 }, key)
      .expect(201);
    const res = await api
      .receipt(variant.id, { quantity: 4, unitCost: 2_501 }, key)
      .expect(409);
    expect(res.body.error).toBe('STOCK_RECEIPT_IDEMPOTENCY_CONFLICT');

    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(1);
    expect((await poolOf(ctx.dataSource, variant.id)).inventoryCostValue).toBe(
      '10000',
    );
  });

  it('serialises concurrent receipts on one variant: the value is the exact sum', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });
    const api = costing(ctx, admin.jar);
    const receipts: Array<[number, number]> = [
      [3, 10_000],
      [2, 13_001],
      [7, 999],
      [1, 0],
      [11, 4_567],
    ];

    const results = await Promise.all(
      receipts.map(([quantity, unitCost]) =>
        api.receipt(variant.id, { quantity, unitCost }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);

    const expected = receipts.reduce(
      (s, [q, c]) => s + BigInt(q) * BigInt(c),
      0n,
    );
    const pool = await poolOf(ctx.dataSource, variant.id);
    expect(pool.stock).toBe(24);
    expect(pool.inventoryCostValue).toBe(expected.toString());
    const movements = await movementsOf(ctx.dataSource, variant.id);
    expect(movements).toHaveLength(receipts.length);
    expect(await sumCostDelta(ctx.dataSource, variant.id)).toBe(
      expected.toString(),
    );
    // Each movement's "after" is consistent with the one before it.
    let running = 0n;
    for (const m of movements) {
      running += BigInt(m.costDelta!);
      expect(m.inventoryValueAfter).toBe(running.toString());
    }
  });

  it('a receipt racing a POS sale conserves value: Σ receipts = remaining value + COGS sold', async () => {
    const admin = await loginSuperAdmin(ctx);
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { stock: 0, price: 90_000 });
    const api = costing(ctx, admin.jar);

    await api
      .receipt(variant.id, { quantity: 10, unitCost: 1_000 })
      .expect(201);

    const [receipt, sale] = await Promise.all([
      api.receipt(variant.id, { quantity: 5, unitCost: 1_301 }),
      as(ctx, cashier)
        .post('/orders/pos')
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 4 }],
        }),
    ]);
    expect(receipt.status).toBe(201);
    expect(sale.status).toBe(201);

    const [line] = await orderLinesOf(
      ctx.dataSource,
      Number(sale.body.data.id),
    );
    expect(line.costStatus).toBe('known');
    const pool = await poolOf(ctx.dataSource, variant.id);
    expect(pool.stock).toBe(11);
    const receiptsTotal = 10n * 1_000n + 5n * 1_301n;
    expect(BigInt(pool.inventoryCostValue) + BigInt(line.cogsTotal!)).toBe(
      receiptsTotal,
    );
    // Whichever committed first, the COGS is one of the two exact answers.
    expect(['4000', ((16_505n * 4n) / 15n).toString()]).toContain(
      line.cogsTotal,
    );
  });

  it('announces stock numbers only, and audits no Rial figure or free text', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });

    await costing(ctx, admin.jar)
      .receipt(variant.id, {
        quantity: 6,
        unitCost: 777_777,
        supplierReference: 'SUP-777777',
        note: 'قیمت ۷۷۷۷۷۷',
      })
      .expect(201);

    const emits = posEmitted();
    expect(emits.map((e) => e.event)).toEqual(
      expect.arrayContaining(['stock:updated', 'availability:invalidated']),
    );
    const stockEvent = emits.find((e) => e.event === 'stock:updated')!;
    expect(stockEvent.payload).toEqual({
      variantId: variant.id,
      newStock: 6,
      branchId: null,
    });
    expect(JSON.stringify(emits)).not.toMatch(/777|cost|Cost|value/);

    const [row] = await auditRowsFor(
      ctx.dataSource,
      'inventory.receipt.recorded',
    );
    expect(row.targetId).toBe(String(variant.id));
    expect(row.summary).toEqual({
      movementId: expect.any(Number),
      quantity: 6,
      stockBefore: 0,
      stockAfter: 6,
      unvaluedQuantityAfter: 0,
      hasSupplierReference: true,
      hasNote: true,
    });
    expect(JSON.stringify(row.summary)).not.toMatch(/777|SUP-/);
  });

  describe('input contract', () => {
    it.each([
      [{ quantity: 1 }, 'PURCHASE_COST_REQUIRED'],
      [{ quantity: 1, unitCost: null }, 'PURCHASE_COST_INVALID'],
      [{ quantity: 1, unitCost: '1.5' }, 'PURCHASE_COST_INVALID'],
      [{ quantity: 1, unitCost: 12.5 }, 'PURCHASE_COST_INVALID'],
      [{ quantity: 1, unitCost: -1 }, 'PURCHASE_COST_OUT_OF_RANGE'],
      [
        { quantity: 1, unitCost: '99999999999999' },
        'PURCHASE_COST_OUT_OF_RANGE',
      ],
    ])('refuses %j with %s', async (body, code) => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await seedVariant(ctx, { stock: 0 });
      const res = await costing(ctx, admin.jar)
        .receipt(variant.id, body)
        .expect(400);
      expect(res.body.error).toBe(code);
      expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);
    });

    it.each([
      { quantity: 0, unitCost: 1 },
      { quantity: -2, unitCost: 1 },
      { quantity: 1.5, unitCost: 1 },
      { quantity: 1, unitCost: 1, supplierReference: 'x'.repeat(121) },
      { quantity: 1, unitCost: 1, note: 'x'.repeat(501) },
      { quantity: 1, unitCost: 1, extra: true },
    ])('refuses a malformed body %j', async (body) => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await seedVariant(ctx, { stock: 0 });
      await costing(ctx, admin.jar).receipt(variant.id, body).expect(400);
    });

    it('requires a well-formed Idempotency-Key', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await seedVariant(ctx, { stock: 0 });
      const api = costing(ctx, admin.jar);
      const body = { quantity: 1, unitCost: 1 };
      const missing = await api.receipt(variant.id, body, null).expect(400);
      expect(missing.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const invalid = await api.receipt(variant.id, body, 'short').expect(400);
      expect(invalid.body.error).toBe('IDEMPOTENCY_KEY_INVALID');
    });

    it('404s an unknown variant and leaves the key free', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await seedVariant(ctx, { stock: 0 });
      const api = costing(ctx, admin.jar);
      const key = costingKey('receipt-404');
      await api.receipt(999_999, { quantity: 1, unitCost: 1 }, key).expect(404);
      // The refused request committed nothing — not even its key.
      const [{ count }] = await ctx.dataSource.query(
        `SELECT count(*)::int AS count FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      expect(count).toBe(0);
      await api.receipt(variant.id, { quantity: 1, unitCost: 1 }).expect(201);
    });
  });
});
