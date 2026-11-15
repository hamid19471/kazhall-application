/**
 * Legacy valuation, the costing reads and the remembered purchase price
 * (docs/PURCHASE-COST-ACCOUNTING.md §6, §10, §13).
 *
 *   POST /admin/costing/variants/:variantId/valuation
 *   GET  /admin/costing/variants/:variantId
 *   GET  /admin/costing/products/:productId
 *   GET  /admin/costing/unvalued
 *   PUT  /admin/costing/variants/:variantId/purchase-price
 *
 * A "legacy" variant here is one whose stock arrived without a cost: a raw
 * INSERT carrying stock, which `trg_product_variants_pool_guard` records as
 * UNVALUED — exactly the state migration 0037 leaves pre-existing stock in.
 */
import { getTestDataSource, resetDb } from './setup/test-db';
import {
  createPosTestApp,
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
} from './support/costing.fixtures';
import {
  createProduct,
  createProductWithVariant,
  createVariant,
} from './setup/seed-helpers';

describe('costing — legacy valuation and reads (int)', () => {
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

  async function legacyVariant(stock = 7) {
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock, price: 80_000 },
    );
    return { product, variant };
  }

  it('the pool guard records raw-inserted stock as unvalued (the legacy state)', async () => {
    const { variant } = await legacyVariant(7);
    expect(await poolOf(ctx.dataSource, variant.id)).toMatchObject({
      stock: 7,
      unvaluedQuantity: 7,
      inventoryCostValue: '0',
      costStatus: 'unvalued',
    });
  });

  it('initialises with a unit cost: totalValue = unitCost × expectedUnvaluedQuantity', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(7);

    const res = await costing(ctx, admin.jar)
      .valuation(variant.id, {
        expectedUnvaluedQuantity: 7,
        unitCost: 2_000,
        note: 'ارزش‌گذاری از فاکتورهای قدیمی',
      })
      .expect(201);

    expect(res.body.data).toEqual({
      movementId: expect.any(Number),
      variantId: variant.id,
      valuedUnits: 7,
      totalValue: '14000',
      before: {
        stock: 7,
        unvaluedQuantity: 7,
        valuedQuantity: 0,
        inventoryCostValue: '0',
        averageUnitCost: null,
        costStatus: 'unvalued',
      },
      after: {
        stock: 7,
        unvaluedQuantity: 0,
        valuedQuantity: 7,
        inventoryCostValue: '14000',
        averageUnitCost: '2000',
        costStatus: 'valued',
      },
    });

    const [movement] = await movementsOf(ctx.dataSource, variant.id);
    expect(movement).toMatchObject({
      id: res.body.data.movementId,
      reason: 'valuation_initialization',
      // The one reason allowed a zero delta: value moves, stock does not.
      delta: 0,
      balanceAfter: 7,
      costDelta: '14000',
      inventoryValueAfter: '14000',
      unvaluedQuantityDelta: -7,
      unvaluedQuantityAfter: 0,
      reasonText: 'ارزش‌گذاری از فاکتورهای قدیمی',
    });
    expect(await poolOf(ctx.dataSource, variant.id)).toMatchObject({
      stock: 7,
      unvaluedQuantity: 0,
      inventoryCostValue: '14000',
      costStatus: 'valued',
    });
  });

  it('initialises with a total value, exact beyond 2^53', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(3);

    const res = await costing(ctx, admin.jar)
      .valuation(variant.id, {
        expectedUnvaluedQuantity: 3,
        totalValue: '12345678901234567',
      })
      .expect(201);
    expect(res.body.data.totalValue).toBe('12345678901234567');
    // ⌊12345678901234567 / 3⌋ = 4115226300411522
    expect(res.body.data.after.averageUnitCost).toBe('4115226300411522');
    expect((await poolOf(ctx.dataSource, variant.id)).inventoryCostValue).toBe(
      '12345678901234567',
    );
  });

  it('values only the unvalued part of a mixed pool', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(3);
    const api = costing(ctx, admin.jar);
    await api.receipt(variant.id, { quantity: 2, unitCost: 100 }).expect(201);

    const res = await api
      .valuation(variant.id, { expectedUnvaluedQuantity: 3, totalValue: 900 })
      .expect(201);
    expect(res.body.data.valuedUnits).toBe(3);
    expect(res.body.data.after).toMatchObject({
      stock: 5,
      unvaluedQuantity: 0,
      inventoryCostValue: '1100',
      averageUnitCost: '220',
    });
  });

  it('refuses a stale expectedUnvaluedQuantity with INVENTORY_VALUATION_STALE', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(7);

    const res = await costing(ctx, admin.jar)
      .valuation(variant.id, { expectedUnvaluedQuantity: 6, unitCost: 2_000 })
      .expect(409);
    expect(res.body.error).toBe('INVENTORY_VALUATION_STALE');
    expect(await poolOf(ctx.dataSource, variant.id)).toMatchObject({
      unvaluedQuantity: 7,
      inventoryCostValue: '0',
    });
    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);
  });

  it('refuses a second valuation with a new key: INVENTORY_ALREADY_VALUED', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(7);
    const api = costing(ctx, admin.jar);
    await api
      .valuation(variant.id, { expectedUnvaluedQuantity: 7, unitCost: 2_000 })
      .expect(201);

    const again = await api
      .valuation(variant.id, { expectedUnvaluedQuantity: 7, unitCost: 2_000 })
      .expect(409);
    expect(again.body.error).toBe('INVENTORY_ALREADY_VALUED');

    // A variant that was never unvalued is "already valued" too.
    const fresh = await seedVariant(ctx, { stock: 0 });
    const none = await api
      .valuation(fresh.id, { expectedUnvaluedQuantity: 0, totalValue: 0 })
      .expect(409);
    expect(none.body.error).toBe('INVENTORY_ALREADY_VALUED');
    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(1);
  });

  it('replays the same key + body; a different body on that key is IDEMPOTENCY_KEY_REUSED', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(7);
    const api = costing(ctx, admin.jar);
    const key = costingKey('valuation-replay');
    const body = { expectedUnvaluedQuantity: 7, unitCost: 2_000 };

    const first = await api.valuation(variant.id, body, key).expect(201);
    // Not ALREADY_VALUED: the retry of a completed request is its replay.
    const second = await api.valuation(variant.id, body, key).expect(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(1);

    const reused = await api
      .valuation(variant.id, { ...body, unitCost: 2_001 }, key)
      .expect(409);
    expect(reused.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  describe('input contract', () => {
    it.each([
      [{ expectedUnvaluedQuantity: 7 }, 'PURCHASE_COST_REQUIRED'],
      [
        { expectedUnvaluedQuantity: 7, unitCost: 1, totalValue: 7 },
        'PURCHASE_COST_INVALID',
      ],
      [
        { expectedUnvaluedQuantity: 7, totalValue: '1.5' },
        'PURCHASE_COST_INVALID',
      ],
      [
        { expectedUnvaluedQuantity: 7, totalValue: -1 },
        'PURCHASE_COST_OUT_OF_RANGE',
      ],
      [
        { expectedUnvaluedQuantity: 7, totalValue: '9223372036854775808' },
        'PURCHASE_COST_OUT_OF_RANGE',
      ],
      [
        { expectedUnvaluedQuantity: 7, unitCost: '99999999999999' },
        'PURCHASE_COST_OUT_OF_RANGE',
      ],
    ])('refuses %j with %s', async (body, code) => {
      const admin = await loginSuperAdmin(ctx);
      const { variant } = await legacyVariant(7);
      const res = await costing(ctx, admin.jar)
        .valuation(variant.id, body)
        .expect(400);
      expect(res.body.error).toBe(code);
    });

    it('refuses a pool value that would overflow bigint with PURCHASE_COST_OUT_OF_RANGE, not a 500', async () => {
      const admin = await loginSuperAdmin(ctx);
      const { variant } = await legacyVariant(3);
      const api = costing(ctx, admin.jar);
      await api
        .receipt(variant.id, { quantity: 1, unitCost: 45_000_000_000 })
        .expect(201);
      const res = await api
        .valuation(variant.id, {
          expectedUnvaluedQuantity: 3,
          totalValue: '9223372036854775807',
        })
        .expect(400);
      expect(res.body.error).toBe('PURCHASE_COST_OUT_OF_RANGE');
    });

    it('404s an unknown variant', async () => {
      const admin = await loginSuperAdmin(ctx);
      await costing(ctx, admin.jar)
        .valuation(999_999, { expectedUnvaluedQuantity: 1, unitCost: 1 })
        .expect(404);
    });
  });

  it('audits the valuation without a Rial figure', async () => {
    const admin = await loginSuperAdmin(ctx);
    const { variant } = await legacyVariant(7);
    await costing(ctx, admin.jar)
      .valuation(variant.id, {
        expectedUnvaluedQuantity: 7,
        totalValue: 4_444_444,
        note: 'ارزش ۴۴۴۴۴۴۴',
      })
      .expect(201);
    const [row] = await auditRowsFor(
      ctx.dataSource,
      'inventory.valuation.initialized',
    );
    expect(row.summary).toEqual({
      movementId: expect.any(Number),
      valuedUnits: 7,
      stock: 7,
      enteredAs: 'total_value',
      hasNote: true,
    });
    expect(JSON.stringify(row.summary)).not.toMatch(/4444|۴۴۴/);
  });

  // =========================================================================
  // Reads
  // =========================================================================

  describe('reads', () => {
    it('the work list pages variants that still hold unvalued units', async () => {
      const admin = await loginSuperAdmin(ctx);
      const a = await legacyVariant(2);
      const b = await legacyVariant(5);
      await seedVariant(ctx, { stock: 0 }); // valued (empty) — not listed
      const api = costing(ctx, admin.jar);

      const page1 = await api.unvalued('?page=1&limit=1').expect(200);
      expect(page1.body).toMatchObject({
        total: 2,
        page: 1,
        limit: 1,
        totalPages: 2,
      });
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.data[0]).toMatchObject({
        variantId: a.variant.id,
        unvaluedQuantity: 2,
        costStatus: 'unvalued',
      });
      expect(page1.body.data[0]).not.toHaveProperty('recentMovements');

      await api
        .valuation(a.variant.id, { expectedUnvaluedQuantity: 2, unitCost: 1 })
        .expect(201);
      const after = await api.unvalued().expect(200);
      expect(after.body.total).toBe(1);
      expect(after.body.data[0].variantId).toBe(b.variant.id);

      await api.unvalued('?limit=101').expect(400);
    });

    it('the product view lists every variant with exact totals', async () => {
      const admin = await loginSuperAdmin(ctx);
      const product = await createProduct(ctx.dataSource, {
        basePrice: 70_000,
      });
      const v1 = await createVariant(ctx.dataSource, product, {
        stock: 0,
        price: 90_000,
      });
      const v2 = await createVariant(ctx.dataSource, product, { stock: 4 });
      const api = costing(ctx, admin.jar);
      await api
        .receipt(v1.id, { quantity: 200_000, unitCost: '45000000000' })
        .expect(201);
      await api.receipt(v2.id, { quantity: 1, unitCost: 3_000 }).expect(201);

      const res = await api.product(product.id).expect(200);
      expect(res.body.data).toMatchObject({
        productId: product.id,
        productTitle: product.title,
        productCode: product.productCode,
        totals: {
          stock: 200_005,
          unvaluedQuantity: 4,
          // 200 000 × 45 000 000 000 = 9 000 000 000 000 000 + 3 000 — beyond 2^53, exact.
          inventoryCostValue: '9000000000003000',
        },
      });
      const variants = res.body.data.variants as Array<Record<string, unknown>>;
      expect(variants.map((v) => v.variantId).sort()).toEqual(
        [v1.id, v2.id].sort(),
      );
      const first = variants.find((v) => v.variantId === v1.id)!;
      expect(first).toMatchObject({
        sellingPrice: '90000',
        lastPurchaseUnitCost: '45000000000',
        inventoryCostValue: '9000000000000000',
        averageUnitCost: '45000000000',
      });
      expect(first).not.toHaveProperty('recentMovements');

      await api.product(999_999).expect(404);
    });

    it('the variant view carries the latest 20 movements, newest first, with cost evidence', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variant = await seedVariant(ctx, { stock: 0 });
      const api = costing(ctx, admin.jar);
      for (let i = 1; i <= 22; i++) {
        await api
          .receipt(variant.id, {
            quantity: 1,
            unitCost: i,
            ...(i === 22 ? { supplierReference: 'REF-22' } : {}),
          })
          .expect(201);
      }
      const res = await api.variant(variant.id).expect(200);
      const movements = res.body.data.recentMovements;
      expect(movements).toHaveLength(20);
      expect(movements[0]).toEqual({
        id: expect.any(Number),
        reason: 'stock_receipt',
        delta: 1,
        balanceAfter: 22,
        unitCost: '22',
        costDelta: '22',
        inventoryValueAfter: '253',
        unvaluedQuantityAfter: 0,
        supplierReference: 'REF-22',
        reasonText: null,
        orderId: null,
        actorDisplaySnapshot: expect.any(String),
        createdAt: expect.any(String),
      });
      expect(movements[19].unitCost).toBe('3');
      await api.variant(999_999).expect(404);
    });
  });

  // =========================================================================
  // Remembered purchase price
  // =========================================================================

  describe('PUT purchase-price', () => {
    it('sets and clears lastPurchaseUnitCost without touching value or stock', async () => {
      const admin = await loginSuperAdmin(ctx);
      const { variant } = await legacyVariant(3);
      const api = costing(ctx, admin.jar);

      const set = await api
        .purchasePrice(variant.id, { unitCost: '65000' })
        .expect(200);
      expect(set.body.data).toEqual({
        variantId: variant.id,
        lastPurchaseUnitCost: '65000',
      });
      expect(await poolOf(ctx.dataSource, variant.id)).toEqual({
        stock: 3,
        unvaluedQuantity: 3,
        inventoryCostValue: '0',
        lastPurchaseUnitCost: '65000',
        costStatus: 'unvalued',
      });
      expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);

      const cleared = await api
        .purchasePrice(variant.id, { unitCost: null })
        .expect(200);
      expect(cleared.body.data.lastPurchaseUnitCost).toBeNull();

      const rows = await auditRowsFor(
        ctx.dataSource,
        'inventory.purchase_cost.changed',
      );
      expect(rows.map((r) => r.summary)).toEqual([
        { hadPurchasePrice: false, hasPurchasePrice: true, changed: true },
        { hadPurchasePrice: true, hasPurchasePrice: false, changed: true },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/65000/);
    });

    it.each([
      [{}, 'PURCHASE_COST_REQUIRED'],
      [{ unitCost: '1.5' }, 'PURCHASE_COST_INVALID'],
      [{ unitCost: -3 }, 'PURCHASE_COST_OUT_OF_RANGE'],
    ])('refuses %j with %s', async (body, code) => {
      const admin = await loginSuperAdmin(ctx);
      const { variant } = await legacyVariant(3);
      const res = await costing(ctx, admin.jar)
        .purchasePrice(variant.id, body)
        .expect(400);
      expect(res.body.error).toBe(code);
    });

    it('404s an unknown variant', async () => {
      const admin = await loginSuperAdmin(ctx);
      await costing(ctx, admin.jar)
        .purchasePrice(999_999, { unitCost: 1 })
        .expect(404);
    });
  });
});
