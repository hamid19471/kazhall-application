/**
 * ============================================================================
 * COGS IS RECOGNISED AT STOCK CONSUMPTION, ONCE, EXACTLY
 * (docs/PURCHASE-COST-ACCOUNTING.md §3, §4, §6, §7).
 *
 * Every Rial figure below is derived by hand from the contract's one rounding
 * rule — `allocate(value, units, take) = take == units ? value :
 * floor(value × take / units)` — and asserted as exact text, never as a
 * JavaScript number and never with a tolerance.
 * ============================================================================
 */
import { EntityManager } from 'typeorm';

import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';

import {
  closeTestDataSource,
  getTestDataSource,
  resetDb,
} from './setup/test-db';
import { createProductWithVariant, fixtureSku } from './setup/seed-helpers';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
} from './support/pos.fixtures';
import {
  InventoryHarness,
  createInventoryHarness,
  makeCatalog,
  makeOnlineOrder,
  makeUser,
} from './support/inventory.harness';

// ---------------------------------------------------------------------------
// shared probes (plain SQL, work on any DataSource)
// ---------------------------------------------------------------------------

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> };

interface Pool {
  stock: number;
  unvaluedQuantity: number;
  inventoryCostValue: string;
}

async function poolOf(ds: Queryable, variantId: number): Promise<Pool> {
  const [row] = await ds.query(
    `SELECT stock, "unvaluedQuantity", "inventoryCostValue"::text AS v
       FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return {
    stock: Number(row.stock),
    unvaluedQuantity: Number(row.unvaluedQuantity),
    inventoryCostValue: row.v,
  };
}

interface Line {
  id: number;
  variantId: number | null;
  quantity: number;
  costStatus: string;
  cogsTotal: string | null;
  costKnownQuantity: number | null;
  costUnknownQuantity: number | null;
  costAllocatedAt: Date | null;
}

async function linesOf(ds: Queryable, orderId: number): Promise<Line[]> {
  const rows = await ds.query(
    `SELECT id, "variantId", quantity, "costStatus", "cogsTotal"::text AS "cogsTotal",
            "costKnownQuantity", "costUnknownQuantity", "costAllocatedAt"
       FROM order_items WHERE "orderId" = $1 ORDER BY id`,
    [orderId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    id: Number(r.id),
    variantId: r.variantId === null ? null : Number(r.variantId),
    quantity: Number(r.quantity),
    costKnownQuantity:
      r.costKnownQuantity === null ? null : Number(r.costKnownQuantity),
    costUnknownQuantity:
      r.costUnknownQuantity === null ? null : Number(r.costUnknownQuantity),
  })) as Line[];
}

interface Movement {
  id: number;
  orderId: number | null;
  reason: string;
  delta: number;
  balanceAfter: number;
  unitCost: string | null;
  costDelta: string | null;
  inventoryValueAfter: string | null;
  unvaluedQuantityDelta: number | null;
  unvaluedQuantityAfter: number | null;
}

async function movementsOf(
  ds: Queryable,
  variantId: number,
): Promise<Movement[]> {
  const rows = await ds.query(
    `SELECT id, "orderId", reason::text AS reason, delta, "balanceAfter",
            "unitCost"::text AS "unitCost", "costDelta"::text AS "costDelta",
            "inventoryValueAfter"::text AS "inventoryValueAfter",
            "unvaluedQuantityDelta", "unvaluedQuantityAfter"
       FROM stock_movements WHERE "variantId" = $1 ORDER BY id`,
    [variantId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    id: Number(r.id),
    orderId: r.orderId === null ? null : Number(r.orderId),
    delta: Number(r.delta),
    balanceAfter: Number(r.balanceAfter),
    unvaluedQuantityDelta:
      r.unvaluedQuantityDelta === null ? null : Number(r.unvaluedQuantityDelta),
    unvaluedQuantityAfter:
      r.unvaluedQuantityAfter === null ? null : Number(r.unvaluedQuantityAfter),
  })) as Movement[];
}

async function count(ds: Queryable, sql: string, params: unknown[] = []) {
  const [row] = await ds.query(sql, params);
  return Number(row.n);
}

/** Resolves to the SQLSTATE the statement failed with, or null if it succeeded. */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
}

// ===========================================================================
// POS — through HTTP
// ===========================================================================

describe('COGS allocation — POS (int)', () => {
  let ctx: TestApp;
  let inventory: InventoryService;

  beforeAll(async () => {
    await getTestDataSource();
    ctx = await createPosTestApp();
    inventory = ctx.app.get(InventoryService, { strict: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
  });

  /** A variant born with ZERO stock (so nothing is unvalued), priced for sale. */
  async function emptyVariant(price = 1_000_000): Promise<number> {
    const { variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock: 0, price },
    );
    return variant.id;
  }

  /** A variant whose `stock` units are UNVALUED legacy units (pool guard INSERT path). */
  async function legacyVariant(stock: number, price = 1_000_000) {
    const { variant } = await createProductWithVariant(
      ctx.dataSource,
      {},
      { stock, price },
    );
    return variant.id;
  }

  async function receive(
    variantId: number,
    quantity: number,
    unitCost: bigint,
  ): Promise<void> {
    await ctx.dataSource.transaction((m: EntityManager) =>
      inventory.receiveValued(m, {
        variantId,
        quantity,
        unitCost,
        reason: StockMovementReason.STOCK_RECEIPT,
        reasonText: null,
        supplierReference: 'test-supplier',
        actorUserId: null,
        actorDisplaySnapshot: null,
        now: new Date(),
      }),
    );
  }

  async function till() {
    const branch = await seedBranch(ctx);
    return loginCashier(ctx, branch);
  }

  function sale(
    cashier: Awaited<ReturnType<typeof till>>,
    items: Array<{ productVariantId: number; quantity: number }>,
    key?: string,
  ) {
    const req = as(ctx, cashier).post('/orders/pos');
    if (key) req.set('Idempotency-Key', key);
    return req.send({ paymentMethod: PaymentMethodEnum.CASH, items });
  }

  // -------------------------------------------------------------------------

  it('a POS sale of a valued product writes a known line, exact COGS and a pos_sale movement of −COGS', async () => {
    const cashier = await till();
    const variantId = await emptyVariant();
    await receive(variantId, 4, 12_345n); // pool 4 / 49 380

    const before = Date.now();
    const res = await sale(cashier, [
      { productVariantId: variantId, quantity: 3 },
    ]);
    expect(res.status).toBe(201);
    const orderId = Number(res.body.data.id);

    const [line] = await linesOf(ctx.dataSource, orderId);
    // allocate(49 380, 4, 3) = floor(148 140 / 4) = 37 035
    expect(line).toMatchObject({
      costStatus: 'known',
      cogsTotal: '37035',
      costKnownQuantity: 3,
      costUnknownQuantity: 0,
    });
    expect(line.costAllocatedAt).toBeInstanceOf(Date);
    expect(line.costAllocatedAt!.getTime()).toBeGreaterThanOrEqual(
      before - 5_000,
    );

    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 1,
      unvaluedQuantity: 0,
      inventoryCostValue: '12345',
    });

    const sales = (await movementsOf(ctx.dataSource, variantId)).filter(
      (m) => m.reason === 'pos_sale',
    );
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      orderId,
      delta: -3,
      balanceAfter: 1,
      unitCost: null,
      costDelta: '-37035',
      inventoryValueAfter: '12345',
      unvaluedQuantityDelta: 0,
      unvaluedQuantityAfter: 0,
    });
  });

  it('reproduces the contract §3.1 worked example exactly (moving average across two receipts)', async () => {
    const cashier = await till();
    const variantId = await emptyVariant();
    await receive(variantId, 3, 10_000n);
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 3,
      unvaluedQuantity: 0,
      inventoryCostValue: '30000',
    });
    await receive(variantId, 2, 13_001n);
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 5,
      unvaluedQuantity: 0,
      inventoryCostValue: '56002',
    });

    const expected: Array<[number, string, Pool]> = [
      [
        2,
        '22400',
        { stock: 3, unvaluedQuantity: 0, inventoryCostValue: '33602' },
      ],
      [
        1,
        '11200',
        { stock: 2, unvaluedQuantity: 0, inventoryCostValue: '22402' },
      ],
      [2, '22402', { stock: 0, unvaluedQuantity: 0, inventoryCostValue: '0' }],
    ];
    let total = 0n;
    for (const [quantity, cogs, pool] of expected) {
      const res = await sale(cashier, [
        { productVariantId: variantId, quantity },
      ]);
      expect(res.status).toBe(201);
      const [line] = await linesOf(ctx.dataSource, Number(res.body.data.id));
      expect(line).toMatchObject({
        costStatus: 'known',
        cogsTotal: cogs,
        costKnownQuantity: quantity,
        costUnknownQuantity: 0,
      });
      expect(await poolOf(ctx.dataSource, variantId)).toEqual(pool);
      total += BigInt(line.cogsTotal!);
    }
    // Σ cogs = Σ receipts — no Rial created or lost.
    expect(total).toBe(56_002n);

    const ledger = await movementsOf(ctx.dataSource, variantId);
    expect(
      ledger.map((m) => [
        m.reason,
        m.delta,
        m.costDelta,
        m.inventoryValueAfter,
      ]),
    ).toEqual([
      ['stock_receipt', 3, '30000', '30000'],
      ['stock_receipt', 2, '26002', '56002'],
      ['pos_sale', -2, '-22400', '33602'],
      ['pos_sale', -1, '-11200', '22402'],
      ['pos_sale', -2, '-22402', '0'],
    ]);
  });

  it('selling every remaining unit consumes the entire remaining value (the floor remainder is never lost)', async () => {
    const cashier = await till();
    const variantId = await emptyVariant();
    await receive(variantId, 3, 1n); // 3 Rial over 3 units
    await receive(variantId, 4, 2n); // + 8 → 7 units / 11 Rial

    const a = await sale(cashier, [
      { productVariantId: variantId, quantity: 2 },
    ]);
    // floor(11 × 2 / 7) = 3
    expect(
      (await linesOf(ctx.dataSource, Number(a.body.data.id)))[0].cogsTotal,
    ).toBe('3');
    const b = await sale(cashier, [
      { productVariantId: variantId, quantity: 5 },
    ]);
    // the whole remainder: 11 − 3 = 8
    expect(
      (await linesOf(ctx.dataSource, Number(b.body.data.id)))[0].cogsTotal,
    ).toBe('8');
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 0,
      unvaluedQuantity: 0,
      inventoryCostValue: '0',
    });
  });

  it('a mixed pool gives up its unknown-cost units first: the line is unknown with a known part', async () => {
    const cashier = await till();
    const variantId = await legacyVariant(2); // 2 unvalued legacy units
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 2,
      unvaluedQuantity: 2,
      inventoryCostValue: '0',
    });
    await receive(variantId, 3, 1_000n); // pool 5 units, 2 unvalued, 3 000

    const first = await sale(cashier, [
      { productVariantId: variantId, quantity: 3 },
    ]);
    expect(first.status).toBe(201);
    const [line] = await linesOf(ctx.dataSource, Number(first.body.data.id));
    // u = min(3, 2) = 2, k = 1, cogs = allocate(3 000, 3, 1) = 1 000
    expect(line).toMatchObject({
      costStatus: 'unknown',
      cogsTotal: '1000',
      costKnownQuantity: 1,
      costUnknownQuantity: 2,
    });
    expect(line.costAllocatedAt).toBeInstanceOf(Date);
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 2,
      unvaluedQuantity: 0,
      inventoryCostValue: '2000',
    });
    const last = (await movementsOf(ctx.dataSource, variantId)).at(-1)!;
    expect(last).toMatchObject({
      reason: 'pos_sale',
      delta: -3,
      costDelta: '-1000',
      inventoryValueAfter: '2000',
      unvaluedQuantityDelta: -2,
      unvaluedQuantityAfter: 0,
    });

    // Now fully valued: the next sale is 'known'.
    const second = await sale(cashier, [
      { productVariantId: variantId, quantity: 1 },
    ]);
    expect(
      (await linesOf(ctx.dataSource, Number(second.body.data.id)))[0],
    ).toMatchObject({
      costStatus: 'known',
      cogsTotal: '1000',
      costKnownQuantity: 1,
      costUnknownQuantity: 0,
    });
  });

  it('a sale drawn only from unvalued units is unknown with a zero known part, never valued at 0', async () => {
    const cashier = await till();
    const variantId = await legacyVariant(3);
    await receive(variantId, 1, 9_999n);
    const res = await sale(cashier, [
      { productVariantId: variantId, quantity: 2 },
    ]);
    expect(
      (await linesOf(ctx.dataSource, Number(res.body.data.id)))[0],
    ).toMatchObject({
      costStatus: 'unknown',
      cogsTotal: '0',
      costKnownQuantity: 0,
      costUnknownQuantity: 2,
    });
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 2,
      unvaluedQuantity: 1,
      inventoryCostValue: '9999',
    });
  });

  it('two concurrent POS sales of the final unit: exactly one wins, COGS allocated once, pool {0,0,0}', async () => {
    const a = await till();
    const b = await till();
    const variantId = await emptyVariant();
    await receive(variantId, 1, 70_007n);

    const results = await Promise.all([
      sale(a, [{ productVariantId: variantId, quantity: 1 }]),
      sale(b, [{ productVariantId: variantId, quantity: 1 }]),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);

    expect(
      await count(ctx.dataSource, `SELECT count(*)::int AS n FROM orders`),
    ).toBe(1);
    expect(
      await count(
        ctx.dataSource,
        `SELECT count(*)::int AS n FROM order_items WHERE "costStatus" <> 'pending'`,
      ),
    ).toBe(1);
    const [cogs] = await ctx.dataSource.query(
      `SELECT "cogsTotal"::text AS c FROM order_items`,
    );
    expect(cogs.c).toBe('70007');
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 0,
      unvaluedQuantity: 0,
      inventoryCostValue: '0',
    });
    const sales = (await movementsOf(ctx.dataSource, variantId)).filter(
      (m) => m.reason === 'pos_sale',
    );
    expect(sales).toHaveLength(1);
    expect(sales[0].costDelta).toBe('-70007');
  });

  it('five concurrent sales racing for three units: three win, Σ COGS equals the pool', async () => {
    const cashiers = await Promise.all([
      till(),
      till(),
      till(),
      till(),
      till(),
    ]);
    const variantId = await emptyVariant();
    await receive(variantId, 1, 10_000n);
    await receive(variantId, 2, 10_001n); // 3 units / 30 002

    const results = await Promise.all(
      cashiers.map((c) =>
        sale(c, [{ productVariantId: variantId, quantity: 1 }]),
      ),
    );
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status !== 201);
    expect(won).toHaveLength(3);
    expect(lost.map((r) => r.status)).toEqual([409, 409]);

    const rows: Array<{ c: string }> = await ctx.dataSource.query(
      `SELECT oi."cogsTotal"::text AS c
         FROM order_items oi
         JOIN stock_movements m ON m."orderId" = oi."orderId" AND m.reason = 'pos_sale'
        ORDER BY m.id`,
    );
    // Serialised on the row lock (movement ids follow lock order): floor(30 002/3) = 10 000, then 20 002/2 = 10 001, then 10 001.
    expect(rows.map((r) => r.c)).toEqual(['10000', '10001', '10001']);
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 0,
      unvaluedQuantity: 0,
      inventoryCostValue: '0',
    });
    expect(
      (await movementsOf(ctx.dataSource, variantId)).filter(
        (m) => m.reason === 'pos_sale',
      ),
    ).toHaveLength(3);
  });

  it('a multi-line sale whose second line fails rolls back stock, pool, order, lines and movements together', async () => {
    const cashier = await till();
    const first = await emptyVariant();
    const second = await emptyVariant();
    await receive(first, 5, 3_000n);
    await receive(second, 2, 4_000n);
    const poolsBefore = [
      await poolOf(ctx.dataSource, first),
      await poolOf(ctx.dataSource, second),
    ];
    const movementsBefore = await count(
      ctx.dataSource,
      `SELECT count(*)::int AS n FROM stock_movements`,
    );

    const res = await sale(cashier, [
      { productVariantId: first, quantity: 2 },
      { productVariantId: second, quantity: 3 },
    ]);
    expect(res.status).toBe(409);

    expect([
      await poolOf(ctx.dataSource, first),
      await poolOf(ctx.dataSource, second),
    ]).toEqual(poolsBefore);
    expect(
      await count(ctx.dataSource, `SELECT count(*)::int AS n FROM orders`),
    ).toBe(0);
    expect(
      await count(ctx.dataSource, `SELECT count(*)::int AS n FROM order_items`),
    ).toBe(0);
    expect(
      await count(
        ctx.dataSource,
        `SELECT count(*)::int AS n FROM stock_movements`,
      ),
    ).toBe(movementsBefore);
  });

  it('an idempotent POS retry is one order, one allocation, an identical response, and one decrement', async () => {
    const cashier = await till();
    const variantId = await emptyVariant();
    await receive(variantId, 5, 20_000n);
    const key = 'cogs-retry-key-0001';

    const one = await sale(
      cashier,
      [{ productVariantId: variantId, quantity: 2 }],
      key,
    );
    const two = await sale(
      cashier,
      [{ productVariantId: variantId, quantity: 2 }],
      key,
    );
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body.data).toEqual(one.body.data);

    expect(
      await count(ctx.dataSource, `SELECT count(*)::int AS n FROM orders`),
    ).toBe(1);
    const lines = await linesOf(ctx.dataSource, Number(one.body.data.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ costStatus: 'known', cogsTotal: '40000' });
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 3,
      unvaluedQuantity: 0,
      inventoryCostValue: '60000',
    });
    expect(
      (await movementsOf(ctx.dataSource, variantId)).filter(
        (m) => m.reason === 'pos_sale',
      ),
    ).toHaveLength(1);
  });

  it("a later receipt at a different price never changes an earlier sale's cogsTotal", async () => {
    const cashier = await till();
    const variantId = await emptyVariant();
    await receive(variantId, 2, 5_000n);
    const res = await sale(cashier, [
      { productVariantId: variantId, quantity: 1 },
    ]);
    const orderId = Number(res.body.data.id);
    const [before] = await linesOf(ctx.dataSource, orderId);
    expect(before.cogsTotal).toBe('5000');

    await receive(variantId, 3, 9_000n); // pool 4 / 32 000
    const [after] = await linesOf(ctx.dataSource, orderId);
    expect(after).toEqual(before);

    const next = await sale(cashier, [
      { productVariantId: variantId, quantity: 2 },
    ]);
    // allocate(32 000, 4, 2) = 16 000 — the NEW average only affects new sales.
    expect(
      (await linesOf(ctx.dataSource, Number(next.body.data.id)))[0].cogsTotal,
    ).toBe('16000');
    expect((await linesOf(ctx.dataSource, orderId))[0]).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // the database refuses what the service must never write
  // -------------------------------------------------------------------------

  describe('database guards', () => {
    it('the immutability trigger refuses a change to an allocated line (23514)', async () => {
      const cashier = await till();
      const variantId = await emptyVariant();
      await receive(variantId, 2, 1_111n);
      const res = await sale(cashier, [
        { productVariantId: variantId, quantity: 1 },
      ]);
      const [line] = await linesOf(ctx.dataSource, Number(res.body.data.id));

      for (const sql of [
        `UPDATE order_items SET "cogsTotal" = 1 WHERE id = $1`,
        `UPDATE order_items SET "cogsTotal" = NULL, "costStatus" = 'pending',
                "costKnownQuantity" = NULL, "costUnknownQuantity" = NULL,
                "costAllocatedAt" = NULL WHERE id = $1`,
        `UPDATE order_items SET "costAllocatedAt" = now() - interval '1 day' WHERE id = $1`,
        `UPDATE order_items SET quantity = 2 WHERE id = $1`,
      ]) {
        expect(await sqlState(() => ctx.dataSource.query(sql, [line.id]))).toBe(
          '23514',
        );
      }
      expect(
        (await linesOf(ctx.dataSource, Number(res.body.data.id)))[0],
      ).toEqual(line);
    });

    it('the pool guard refuses a raw stock or value UPDATE outside the valuation writer (23514)', async () => {
      const variantId = await emptyVariant();
      await receive(variantId, 3, 100n);
      const before = await poolOf(ctx.dataSource, variantId);

      expect(
        await sqlState(() =>
          ctx.dataSource.query(
            `UPDATE product_variants SET stock = stock + 1 WHERE id = $1`,
            [variantId],
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlState(() =>
          ctx.dataSource.query(
            `UPDATE product_variants SET "inventoryCostValue" = "inventoryCostValue" + 1 WHERE id = $1`,
            [variantId],
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlState(() =>
          ctx.dataSource.query(
            `UPDATE product_variants SET "unvaluedQuantity" = 1 WHERE id = $1`,
            [variantId],
          ),
        ),
      ).toBe('23514');
      expect(await poolOf(ctx.dataSource, variantId)).toEqual(before);
    });

    it.each<[string, string, string[]]>([
      [
        'a negative value',
        `"inventoryCostValue" = -1`,
        ['ck_variant_inventory_value_non_negative'],
      ],
      [
        'unvalued above stock',
        `"unvaluedQuantity" = stock + 1`,
        [
          'ck_variant_unvalued_quantity_range',
          'ck_variant_empty_pool_has_no_value',
        ],
      ],
      [
        'negative stock',
        `stock = -1, "unvaluedQuantity" = 0, "inventoryCostValue" = 0`,
        ['ck_variant_stock_non_negative', 'ck_variant_unvalued_quantity_range'],
      ],
      [
        'value on an empty valued pool',
        `"unvaluedQuantity" = stock`,
        ['ck_variant_empty_pool_has_no_value'],
      ],
    ])(
      'the CHECK constraints refuse %s even with the writer flag set',
      async (_label, assignment, constraints) => {
        const variantId = await emptyVariant();
        await receive(variantId, 3, 100n);
        const before = await poolOf(ctx.dataSource, variantId);

        let caught: { code?: string; constraint?: string } | null = null;
        try {
          await ctx.dataSource.transaction(async (m) => {
            await m.query(
              `SELECT set_config('kazhal.valuation_writer', 'on', true)`,
            );
            await m.query(
              `UPDATE product_variants SET ${assignment} WHERE id = $1`,
              [variantId],
            );
          });
        } catch (err) {
          caught = err as { code?: string; constraint?: string };
        }
        expect(caught?.code).toBe('23514');
        expect(constraints).toContain(caught?.constraint);
        expect(await poolOf(ctx.dataSource, variantId)).toEqual(before);
      },
    );
  });

  // -------------------------------------------------------------------------
  // the legacy adjust endpoint
  // -------------------------------------------------------------------------

  describe('POST /admin/inventory/variants/:id/adjust', () => {
    it('a negative adjust removes a proportional cost on the manual_adjustment movement and books no COGS', async () => {
      const cashier = await till();
      const admin = await loginSuperAdmin(ctx);
      const variantId = await emptyVariant();
      await receive(variantId, 3, 10_000n);
      await receive(variantId, 2, 13_001n); // 5 / 56 002
      const saleRes = await sale(cashier, [
        { productVariantId: variantId, quantity: 1 },
      ]);
      // allocate(56 002, 5, 1) = 11 200 → pool 4 / 44 802
      const [saleLine] = await linesOf(
        ctx.dataSource,
        Number(saleRes.body.data.id),
      );
      expect(saleLine.cogsTotal).toBe('11200');
      const allocatedBefore = await count(
        ctx.dataSource,
        `SELECT count(*)::int AS n FROM order_items WHERE "costAllocatedAt" IS NOT NULL`,
      );

      const res = await as(ctx, admin)
        .post(`/admin/inventory/variants/${variantId}/adjust`)
        .send({ mode: 'delta', value: -3, reason: 'damaged in storage' });
      expect(res.status).toBe(200);

      // allocate(44 802, 4, 3) = floor(134 406 / 4) = 33 601 → pool 1 / 11 201
      expect(await poolOf(ctx.dataSource, variantId)).toEqual({
        stock: 1,
        unvaluedQuantity: 0,
        inventoryCostValue: '11201',
      });
      const adj = (await movementsOf(ctx.dataSource, variantId)).at(-1)!;
      expect(adj).toMatchObject({
        reason: 'manual_adjustment',
        orderId: null,
        delta: -3,
        balanceAfter: 1,
        unitCost: null,
        costDelta: '-33601',
        inventoryValueAfter: '11201',
        unvaluedQuantityDelta: 0,
        unvaluedQuantityAfter: 0,
      });
      // No order line gained or changed a cost.
      expect(
        await count(
          ctx.dataSource,
          `SELECT count(*)::int AS n FROM order_items WHERE "costAllocatedAt" IS NOT NULL`,
        ),
      ).toBe(allocatedBefore);
      expect(
        (await linesOf(ctx.dataSource, Number(saleRes.body.data.id)))[0],
      ).toEqual(saleLine);
    });

    it('a negative adjust on a mixed pool removes unvalued units first', async () => {
      const admin = await loginSuperAdmin(ctx);
      const variantId = await legacyVariant(2);
      await receive(variantId, 2, 500n); // 4 units, 2 unvalued, 1 000
      const res = await as(ctx, admin)
        .post(`/admin/inventory/variants/${variantId}/adjust`)
        .send({ mode: 'set', value: 1, reason: 'stock count' });
      expect(res.status).toBe(200);
      // take 3: u = 2, k = 1, cost = allocate(1 000, 2, 1) = 500
      expect(await poolOf(ctx.dataSource, variantId)).toEqual({
        stock: 1,
        unvaluedQuantity: 0,
        inventoryCostValue: '500',
      });
      expect(
        (await movementsOf(ctx.dataSource, variantId)).at(-1),
      ).toMatchObject({
        reason: 'manual_adjustment',
        delta: -3,
        costDelta: '-500',
        unvaluedQuantityDelta: -2,
        unvaluedQuantityAfter: 0,
      });
    });

    it.each([
      ['delta', 1],
      ['set', 10],
    ])(
      'a positive adjust (%s %p) is 409 STOCK_INCREASE_REQUIRES_RECEIPT and changes nothing',
      async (mode, value) => {
        const admin = await loginSuperAdmin(ctx);
        const variantId = await emptyVariant();
        await receive(variantId, 3, 700n);
        const before = await poolOf(ctx.dataSource, variantId);
        const movements = (await movementsOf(ctx.dataSource, variantId)).length;

        const res = await as(ctx, admin)
          .post(`/admin/inventory/variants/${variantId}/adjust`)
          .send({ mode, value, reason: 'found more units' });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('STOCK_INCREASE_REQUIRES_RECEIPT');
        expect(await poolOf(ctx.dataSource, variantId)).toEqual(before);
        expect(await movementsOf(ctx.dataSource, variantId)).toHaveLength(
          movements,
        );
      },
    );
  });

  it('for a variant created after 0037, Σ stock_movements.costDelta = inventoryCostValue after a series of operations', async () => {
    const cashier = await till();
    const admin = await loginSuperAdmin(ctx);
    const variantId = await emptyVariant();

    const assertLedgerMatchesPool = async () => {
      const [row] = await ctx.dataSource.query(
        `SELECT COALESCE(SUM("costDelta"), 0)::text AS s,
                COALESCE(SUM(delta), 0)::int AS q,
                count(*) FILTER (WHERE "costDelta" IS NULL)::int AS missing
           FROM stock_movements WHERE "variantId" = $1`,
        [variantId],
      );
      const pool = await poolOf(ctx.dataSource, variantId);
      expect(row.missing).toBe(0);
      expect(row.s).toBe(pool.inventoryCostValue);
      expect(row.q).toBe(pool.stock);
    };

    await receive(variantId, 7, 3_333n);
    await assertLedgerMatchesPool();
    const s1 = await sale(cashier, [
      { productVariantId: variantId, quantity: 3 },
    ]);
    expect(s1.status).toBe(201);
    await assertLedgerMatchesPool();
    await receive(variantId, 5, 4_999n);
    await assertLedgerMatchesPool();
    expect(
      (
        await as(ctx, admin)
          .post(`/admin/inventory/variants/${variantId}/adjust`)
          .send({ mode: 'delta', value: -2, reason: 'broken units' })
      ).status,
    ).toBe(200);
    await assertLedgerMatchesPool();
    const s2 = await sale(cashier, [
      { productVariantId: variantId, quantity: 4 },
    ]);
    expect(s2.status).toBe(201);
    await assertLedgerMatchesPool();

    // A void restores the EXACT cost the sale took, not the current average.
    const [s1Line] = await linesOf(ctx.dataSource, Number(s1.body.data.id));
    const valueBeforeVoid = BigInt(
      (await poolOf(ctx.dataSource, variantId)).inventoryCostValue,
    );
    const voided = await as(ctx, admin)
      .post(`/orders/${Number(s1.body.data.id)}/void`)
      .send({ reason: 'customer changed mind' });
    expect(voided.status).toBe(200);
    expect(
      BigInt((await poolOf(ctx.dataSource, variantId)).inventoryCostValue),
    ).toBe(valueBeforeVoid + BigInt(s1Line.cogsTotal!));
    await assertLedgerMatchesPool();

    // Sell out completely: the value must reach exactly 0.
    const remaining = (await poolOf(ctx.dataSource, variantId)).stock;
    const s3 = await sale(cashier, [
      { productVariantId: variantId, quantity: remaining },
    ]);
    expect(s3.status).toBe(201);
    expect(await poolOf(ctx.dataSource, variantId)).toEqual({
      stock: 0,
      unvaluedQuantity: 0,
      inventoryCostValue: '0',
    });
    await assertLedgerMatchesPool();
  });
});

// ===========================================================================
// Web — payment then fulfilment (service level, as payment-fulfilment.int-spec)
// ===========================================================================

describe('COGS allocation — online fulfilment (int)', () => {
  let h: InventoryHarness;
  let shopper: number;
  let productId: number;
  let variantId: number;

  async function receive(quantity: number, unitCost: bigint) {
    await h.dataSource.transaction((m) =>
      h.inventory.receiveValued(m, {
        variantId,
        quantity,
        unitCost,
        reason: StockMovementReason.STOCK_RECEIPT,
        reasonText: null,
        supplierReference: null,
        actorUserId: null,
        actorDisplaySnapshot: null,
        now: new Date(),
      }),
    );
  }

  async function paidOrderReadyToFulfil(quantity: number): Promise<{
    orderId: number;
    trackId: string;
  }> {
    await h.cart.create({ productId, variantId, quantity }, shopper);
    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      { productId, variantId, quantity },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.convertBasketToOrderAllocation(m, {
        userId: shopper,
        orderId,
        items: [{ variantId, quantity }],
      }),
    );
    const started = await h.payment.Start(orderId, shopper);
    return { orderId, trackId: started.trackId };
  }

  beforeEach(async () => {
    h = await createInventoryHarness(); // resets the database
    shopper = await makeUser(h.dataSource, `cogs-shopper-${Date.now()}`);
    const catalog = await makeCatalog(h.dataSource, fixtureSku(), 0);
    productId = catalog.productId;
    variantId = catalog.variantId;
    await receive(4, 25_001n); // 4 / 100 004
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  const expectAllocatedOnce = async (orderId: number) => {
    const [line] = await linesOf(h.dataSource, orderId);
    // allocate(100 004, 4, 3) = floor(300 012 / 4) = 75 003
    expect(line).toMatchObject({
      costStatus: 'known',
      cogsTotal: '75003',
      costKnownQuantity: 3,
      costUnknownQuantity: 0,
    });
    expect(line.costAllocatedAt).toBeInstanceOf(Date);
    expect(await poolOf(h.dataSource, variantId)).toEqual({
      stock: 1,
      unvaluedQuantity: 0,
      inventoryCostValue: '25001',
    });
    const fulfilments = (await movementsOf(h.dataSource, variantId)).filter(
      (m) => m.reason === 'online_fulfillment',
    );
    expect(fulfilments).toHaveLength(1);
    expect(fulfilments[0]).toMatchObject({
      orderId,
      delta: -3,
      costDelta: '-75003',
      inventoryValueAfter: '25001',
      unvaluedQuantityAfter: 0,
    });
  };

  it('a web line stays pending through checkout and payment start, then is costed at fulfilment', async () => {
    const { orderId, trackId } = await paidOrderReadyToFulfil(3);
    const [pending] = await linesOf(h.dataSource, orderId);
    expect(pending).toMatchObject({
      costStatus: 'pending',
      cogsTotal: null,
      costKnownQuantity: null,
      costUnknownQuantity: null,
      costAllocatedAt: null,
    });
    await h.payment.Verify(trackId);
    await expectAllocatedOnce(orderId);
  });

  it('verifying twice and driving fulfilment again allocates COGS exactly once', async () => {
    const { orderId, trackId } = await paidOrderReadyToFulfil(3);
    const first = await h.payment.Verify(trackId);
    expect(first).toMatchObject({
      success: true,
      orderStatus: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    const second = await h.payment.Verify(trackId);
    expect(second).toMatchObject({ success: true, alreadyProcessed: true });
    await h.fulfilment.drive(orderId);
    await Promise.all([
      h.fulfilment.drive(orderId),
      h.fulfilment.drive(orderId),
    ]);
    await expectAllocatedOnce(orderId);
  });

  it('two concurrent recovery passes after an interrupted phase 2 allocate COGS exactly once', async () => {
    const { orderId, trackId } = await paidOrderReadyToFulfil(3);
    const kill = jest
      .spyOn(h.fulfilment, 'drive')
      .mockRejectedValueOnce(new Error('SIGKILL between phases'));
    await expect(h.payment.Verify(trackId)).resolves.toMatchObject({
      fulfillmentState: FulfillmentStateEnum.PENDING,
    });
    kill.mockRestore();
    expect((await linesOf(h.dataSource, orderId))[0].costStatus).toBe(
      'pending',
    );

    await Promise.all([
      h.recovery.recover(),
      (
        Object.create(
          Object.getPrototypeOf(h.recovery) as object,
          Object.getOwnPropertyDescriptors(h.recovery),
        ) as typeof h.recovery
      ).recover(),
    ]);
    await h.recovery.recover();
    await expectAllocatedOnce(orderId);
  });
});
