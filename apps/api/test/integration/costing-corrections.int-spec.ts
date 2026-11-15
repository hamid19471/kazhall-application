/**
 * POST /admin/costing/variants/:variantId/corrections
 * (docs/PURCHASE-COST-ACCOUNTING.md §2.1, §3.1, §6).
 *
 * A correction changes physical stock outside a sale, and states what the
 * change does to value explicitly:
 *
 *   positive + unitCost          → valued at that cost
 *   positive + costUnknown: true → unvalued (unknown, never zero)
 *   negative, neither            → unknown-cost units first, then an exact
 *                                  allocation — an INVENTORY LOSS carried on
 *                                  the movement, never on an order line
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import {
  createPosTestApp,
  posEmitted,
  resetPosEmitted,
  TestApp,
} from './support/pos.harness';
import { loginSuperAdmin, seedVariant } from './support/pos.fixtures';
import {
  auditRowsFor,
  costing,
  costingKey,
  movementsOf,
  poolOf,
  sumCostDelta,
} from './support/costing.fixtures';
import { forceStockForTest } from './setup/seed-helpers';
import {
  ReservationKind,
  ReservationStatus,
} from 'src/modules/inventory/entities/stock-reservation.entity';

describe('costing — stock corrections (int)', () => {
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

  /** A variant holding 3 @ 10 000 + 2 @ 13 001 = 5 units worth 56 002. */
  async function valuedVariant(
    jar: Awaited<ReturnType<typeof loginSuperAdmin>>['jar'],
  ) {
    const variant = await seedVariant(ctx, { stock: 0 });
    const api = costing(ctx, jar);
    await api
      .receipt(variant.id, { quantity: 3, unitCost: 10_000 })
      .expect(201);
    await api
      .receipt(variant.id, { quantity: 2, unitCost: 13_001 })
      .expect(201);
    return variant;
  }

  it('positive + unitCost: valued at exactly q × unitCost', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await valuedVariant(admin.jar);

    const res = await costing(ctx, admin.jar)
      .correction(variant.id, {
        quantityDelta: 2,
        unitCost: '1500',
        reason: '  شمارش انبار: دو عدد پیدا شد  ',
      })
      .expect(201);

    expect(res.body.data).toMatchObject({
      movementId: expect.any(Number),
      variantId: variant.id,
      quantityDelta: 2,
      costPolicy: 'valued',
      costRemoved: null,
      before: { stock: 5, inventoryCostValue: '56002' },
      after: {
        stock: 7,
        unvaluedQuantity: 0,
        inventoryCostValue: '59002',
        costStatus: 'valued',
      },
    });
    const movements = await movementsOf(ctx.dataSource, variant.id);
    expect(movements.at(-1)).toMatchObject({
      id: res.body.data.movementId,
      reason: 'inventory_correction',
      delta: 2,
      balanceAfter: 7,
      unitCost: '1500',
      costDelta: '3000',
      inventoryValueAfter: '59002',
      unvaluedQuantityDelta: 0,
      reasonText: 'شمارش انبار: دو عدد پیدا شد',
    });
    // A correction is not a purchase: the remembered price is untouched.
    expect(
      (await poolOf(ctx.dataSource, variant.id)).lastPurchaseUnitCost,
    ).toBe('13001');
  });

  it('positive + costUnknown: units are unvalued, the value does not move', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await valuedVariant(admin.jar);

    const res = await costing(ctx, admin.jar)
      .correction(variant.id, {
        quantityDelta: 3,
        costUnknown: true,
        reason: 'برگشت از نمایشگاه، قیمت نامعلوم',
      })
      .expect(201);

    expect(res.body.data).toMatchObject({
      costPolicy: 'unvalued',
      costRemoved: null,
      after: {
        stock: 8,
        unvaluedQuantity: 3,
        valuedQuantity: 5,
        inventoryCostValue: '56002',
        // The average is over the VALUED units only — unknown is never zero.
        averageUnitCost: '11200',
        costStatus: 'unvalued',
      },
    });
    const pool = await poolOf(ctx.dataSource, variant.id);
    expect(pool).toMatchObject({
      stock: 8,
      unvaluedQuantity: 3,
      inventoryCostValue: '56002',
      costStatus: 'unvalued',
    });
    const last = (await movementsOf(ctx.dataSource, variant.id)).at(-1)!;
    expect(last).toMatchObject({
      reason: 'inventory_correction',
      delta: 3,
      unitCost: null,
      costDelta: '0',
      unvaluedQuantityDelta: 3,
      unvaluedQuantityAfter: 3,
    });
  });

  it('negative: removes an exact proportional share, on the movement and on no order line', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await valuedVariant(admin.jar);

    const res = await costing(ctx, admin.jar)
      .correction(variant.id, { quantityDelta: -2, reason: 'دو عدد شکسته' })
      .expect(201);

    // ⌊56 002 × 2 / 5⌋ = 22 400
    expect(res.body.data).toMatchObject({
      quantityDelta: -2,
      costPolicy: 'removed',
      costRemoved: '22400',
      after: { stock: 3, inventoryCostValue: '33602' },
    });
    const last = (await movementsOf(ctx.dataSource, variant.id)).at(-1)!;
    expect(last).toMatchObject({
      reason: 'inventory_correction',
      delta: -2,
      unitCost: null,
      costDelta: '-22400',
      inventoryValueAfter: '33602',
      orderId: null,
    });
    // An inventory loss is never sales COGS: no order line exists to carry it.
    const [{ count }] = await ctx.dataSource.query(
      `SELECT count(*)::int AS count FROM order_items`,
    );
    expect(count).toBe(0);
    expect(await sumCostDelta(ctx.dataSource, variant.id)).toBe('33602');

    // Removing every remaining unit takes the whole remainder.
    const all = await costing(ctx, admin.jar)
      .correction(variant.id, { quantityDelta: -3, reason: 'تخلیهٔ کامل' })
      .expect(201);
    expect(all.body.data.costRemoved).toBe('33602');
    expect(await poolOf(ctx.dataSource, variant.id)).toMatchObject({
      stock: 0,
      inventoryCostValue: '0',
    });
  });

  it('negative: unknown-cost units leave first', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 0 });
    await forceStockForTest(ctx.dataSource, variant.id, 2); // 2 unvalued
    await costing(ctx, admin.jar)
      .receipt(variant.id, { quantity: 4, unitCost: 1_000 })
      .expect(201);

    const res = await costing(ctx, admin.jar)
      .correction(variant.id, { quantityDelta: -3, reason: 'سه عدد گم شد' })
      .expect(201);
    // 2 unknown leave first, then 1 of the 4 valued: ⌊4000 × 1 / 4⌋ = 1000
    expect(res.body.data.costRemoved).toBe('1000');
    expect(res.body.data.after).toMatchObject({
      stock: 3,
      unvaluedQuantity: 0,
      inventoryCostValue: '3000',
      costStatus: 'valued',
    });
  });

  it('announces the stock change with stock numbers only', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await valuedVariant(admin.jar);
    resetPosEmitted();

    await costing(ctx, admin.jar)
      .correction(variant.id, { quantityDelta: -1, reason: 'یک عدد معیوب' })
      .expect(201);
    const stockEvent = posEmitted().find((e) => e.event === 'stock:updated');
    expect(stockEvent?.payload).toEqual({
      variantId: variant.id,
      newStock: 4,
      branchId: null,
    });
  });

  it('audits quantities and policy — no Rial figure and no reason text', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await valuedVariant(admin.jar);

    await costing(ctx, admin.jar)
      .correction(variant.id, {
        quantityDelta: 1,
        unitCost: 987_654,
        reason: 'خرید نقدی به قیمت ۹۸۷۶۵۴',
      })
      .expect(201);
    const [row] = await auditRowsFor(
      ctx.dataSource,
      'inventory.correction.recorded',
    );
    expect(row.summary).toEqual({
      movementId: expect.any(Number),
      quantityDelta: 1,
      costPolicy: 'valued',
      stockBefore: 5,
      stockAfter: 6,
      unvaluedQuantityBefore: 0,
      unvaluedQuantityAfter: 0,
      basketReserved: 0,
      orderAllocated: 0,
      allowBelowReserved: false,
    });
    expect(JSON.stringify(row.summary)).not.toMatch(/987|۹۸۷|قیمت/);
  });

  describe('cost policy', () => {
    it.each([
      [{ quantityDelta: 2 }, 'unitCost'],
      [{ quantityDelta: 2, costUnknown: false }, 'unitCost'],
      [{ quantityDelta: 2, unitCost: 100, costUnknown: true }, 'costUnknown'],
      [{ quantityDelta: -2, unitCost: 100 }, 'unitCost'],
      [{ quantityDelta: -2, costUnknown: true }, 'costUnknown'],
    ])(
      'refuses %j with PURCHASE_COST_INVALID naming %s',
      async (body, field) => {
        const admin = await loginSuperAdmin(ctx);
        const variant = await valuedVariant(admin.jar);
        const res = await costing(ctx, admin.jar)
          .correction(variant.id, { ...body, reason: 'آزمون سیاست' })
          .expect(400);
        expect(res.body.error).toBe('PURCHASE_COST_INVALID');
        expect(res.body.details.field).toBe(field);
        expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(2);
      },
    );

    it.each([
      { quantityDelta: 0, reason: 'صفر نیست' },
      { quantityDelta: 1.5, costUnknown: true, reason: 'اعشاری' },
      { quantityDelta: 1, costUnknown: true, reason: '   ' },
      { quantityDelta: 1, costUnknown: true, reason: 'abc' },
      { quantityDelta: 1, costUnknown: true, reason: 'x'.repeat(501) },
      { quantityDelta: 1, costUnknown: true },
      { quantityDelta: 2_000_000_000, costUnknown: true, reason: 'بسیار زیاد' },
    ])('refuses a malformed body %j', async (body) => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      await costing(ctx, admin.jar).correction(variant.id, body).expect(400);
    });

    it('refuses a unit cost with its stable code', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      const res = await costing(ctx, admin.jar)
        .correction(variant.id, {
          quantityDelta: 1,
          unitCost: '12.5',
          reason: 'قیمت اعشاری',
        })
        .expect(400);
      expect(res.body.error).toBe('PURCHASE_COST_INVALID');
    });
  });

  describe('stock bounds', () => {
    it('refuses to go below zero', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      await costing(ctx, admin.jar)
        .correction(variant.id, { quantityDelta: -6, reason: 'بیش از موجودی' })
        .expect(400);
      expect(await poolOf(ctx.dataSource, variant.id)).toMatchObject({
        stock: 5,
        inventoryCostValue: '56002',
      });
    });

    it('refuses to drop below reserved stock unless allowBelowReserved', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      await ctx.dataSource.query(
        `INSERT INTO "stock_reservations"
           ("variantId","kind","status","quantity","expiresAt")
         VALUES ($1,$2,$3,$4,$5)`,
        [
          variant.id,
          ReservationKind.ORDER,
          ReservationStatus.ACTIVE,
          4,
          new Date(Date.now() + 3_600_000),
        ],
      );

      const refused = await costing(ctx, admin.jar)
        .correction(variant.id, { quantityDelta: -2, reason: 'زیر رزرو' })
        .expect(409);
      expect(refused.body.error).toBe('STOCK_BELOW_RESERVED');
      expect((await poolOf(ctx.dataSource, variant.id)).stock).toBe(5);

      const allowed = await costing(ctx, admin.jar)
        .correction(variant.id, {
          quantityDelta: -2,
          reason: 'زیر رزرو با اجازه',
          allowBelowReserved: true,
        })
        .expect(201);
      expect(allowed.body.data.after.stock).toBe(3);
    });

    it('a positive correction is never refused for reservations', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await seedVariant(ctx, { stock: 0 });
      await ctx.dataSource.query(
        `INSERT INTO "stock_reservations"
           ("variantId","kind","status","quantity","expiresAt")
         VALUES ($1,$2,$3,$4,$5)`,
        [
          variant.id,
          ReservationKind.ORDER,
          ReservationStatus.ACTIVE,
          4,
          new Date(Date.now() + 3_600_000),
        ],
      );
      await costing(ctx, admin.jar)
        .correction(variant.id, {
          quantityDelta: 1,
          costUnknown: true,
          reason: 'یک عدد پیدا شد',
        })
        .expect(201);
    });
  });

  describe('idempotency', () => {
    it('replays the same key + body, and refuses a different body with IDEMPOTENCY_KEY_REUSED', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      const api = costing(ctx, admin.jar);
      const key = costingKey('correction-replay');
      const body = { quantityDelta: -1, reason: 'یک عدد معیوب' };

      const first = await api.correction(variant.id, body, key).expect(201);
      const second = await api.correction(variant.id, body, key).expect(201);
      expect(second.body.data).toEqual(first.body.data);
      expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(3);
      expect((await poolOf(ctx.dataSource, variant.id)).stock).toBe(4);

      const reused = await api
        .correction(variant.id, { ...body, quantityDelta: -2 }, key)
        .expect(409);
      expect(reused.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await poolOf(ctx.dataSource, variant.id)).stock).toBe(4);
    });

    it('requires the header', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      const res = await costing(ctx, admin.jar)
        .correction(
          variant.id,
          { quantityDelta: -1, reason: 'بدون کلید' },
          null,
        )
        .expect(400);
      expect(res.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('a refused correction leaves its key free for the fixed retry', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await valuedVariant(admin.jar);
      const api = costing(ctx, admin.jar);
      const key = costingKey('correction-retry');
      await api
        .correction(variant.id, { quantityDelta: -9, reason: 'بیش از حد' }, key)
        .expect(400);
      // Same key, corrected body: the first attempt committed nothing.
      await api
        .correction(variant.id, { quantityDelta: -1, reason: 'بیش از حد' }, key)
        .expect(201);
    });
  });
});
