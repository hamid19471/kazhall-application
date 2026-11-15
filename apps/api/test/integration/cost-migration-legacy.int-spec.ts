import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';

import {
  scratchDatabaseName,
  testDataSourceOptions,
  testDbConfig,
} from './setup/test-db';

/**
 * ============================================================================
 * MIGRATION 0037 ON DATA THAT PREDATES IT (docs/PURCHASE-COST-ACCOUNTING.md §10)
 *
 * Staged exactly like `variant-backfill-migration.int-spec.ts`: a throwaway
 * database is migrated up to 0036 only, a legacy world is planted with raw SQL
 * (no cost columns exist yet), and only then is 0037 applied.
 *
 * WHAT MUST HOLD: stock is preserved; units whose cost nobody recorded become
 * UNVALUED (never valued at zero); lines whose goods left are `unknown`, lines
 * still waiting are `pending`; existing reversals become `legacy` adjustment
 * rows with the revenue they reversed and NULL where nothing was recorded; the
 * migration refuses negative stock; and `down()` works on legacy data but
 * refuses once real cost evidence exists.
 * ============================================================================
 */

interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
type PgClientCtor = new (config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}) => PgClientLike;
const PgClient = Client as unknown as PgClientCtor;

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'src', 'migrations');
const BEFORE = 1757000000036;
const UNDER_TEST = 1757000000037;
const NAME_0037 = 'PurchaseCostAccounting1757000000037';

function migrationFilesUpTo(upTo: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => Number(f.split('-')[0]) <= upTo)
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
}

async function recreate(db: string): Promise<void> {
  const config = testDbConfig();
  const admin = new PgClient({ ...config, user: config.username });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
}

async function drop(db: string): Promise<void> {
  const config = testDbConfig();
  const admin = new PgClient({ ...config, user: config.username });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.end();
}

async function openAt(db: string, upTo: number): Promise<DataSource> {
  const ds = new DataSource({
    ...testDataSourceOptions(),
    database: db,
    migrations: migrationFilesUpTo(upTo),
  } as never);
  await ds.initialize();
  return ds;
}

async function one<T = Record<string, unknown>>(
  ds: DataSource,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await ds.query(sql, params);
  return rows[0];
}

async function columnExists(
  ds: DataSource,
  table: string,
  column: string,
): Promise<boolean> {
  const row = await one<{ n: number }>(
    ds,
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return row.n === 1;
}

async function tableExists(ds: DataSource, table: string): Promise<boolean> {
  const row = await one<{ t: string | null }>(
    ds,
    `SELECT to_regclass($1)::text AS t`,
    [`public.${table}`],
  );
  return row.t !== null;
}

// ---------------------------------------------------------------------------
// the legacy world, planted at schema 0036
// ---------------------------------------------------------------------------

interface Fixture {
  stocked: number; // variant, stock 7
  empty: number; // variant, stock 0
  other: number; // variant, stock 3
  posOrder: number;
  posLineStocked: number;
  posLineProductless: number;
  awaitingOrder: number;
  awaitingLine: number;
  pendingOrder: number;
  pendingLine: number;
  voidedPaidOrder: number;
  voidedPaidLines: number[];
  voidedUnpaidOrder: number;
  refundedOrder: number;
  refundedLine: number;
  refundedNoDateOrder: number;
  refundedNoDateLine: number;
  voidedAt: Date;
  refundedAt: Date;
}

const STOCK_BEFORE: Record<'stocked' | 'empty' | 'other', number> = {
  stocked: 7,
  empty: 0,
  other: 3,
};

async function plantLegacyWorld(ds: DataSource): Promise<Fixture> {
  const id = async (sql: string, params: unknown[] = []) =>
    Number((await one<{ id: number }>(ds, sql, params)).id);

  const user = await id(
    `INSERT INTO users (username, mobile, password)
     VALUES ('legacy-cost-shopper', '09120000077', 'x') RETURNING id`,
  );
  const branch = await id(
    `INSERT INTO branches (name) VALUES ('Legacy store') RETURNING id`,
  );
  const product = await id(
    `INSERT INTO products (title, description, "basePrice", "productCode",
                           "visibleOnSite", "branchVisibility")
     VALUES ('Legacy kettle', 'pre-0037', 1000000, 'KZ-LEGACY-1', true, 'all')
     RETURNING id`,
  );
  const variant = (sku: string, stock: number, suffix: string) =>
    id(
      `INSERT INTO product_variants (price, stock, sku, "productId", "isActive",
                                     "isDefault", "variantCode")
       SELECT 1000000, $1, $2, $3, true, false, p."productCode" || $4
         FROM products p WHERE p.id = $3
       RETURNING id`,
      [stock, sku, product, suffix],
    );
  const stocked = await variant('LEG-STOCKED', STOCK_BEFORE.stocked, '-A');
  const empty = await variant('LEG-EMPTY', STOCK_BEFORE.empty, '-B');
  const other = await variant('LEG-OTHER', STOCK_BEFORE.other, '-C');

  const order = (
    channel: 'pos' | 'online',
    status: string,
    fulfillmentState: string,
    total: number,
    extra: {
      paidAt?: Date | null;
      voidedAt?: Date | null;
      refundedAt?: Date | null;
      branchId?: number | null;
      userId?: number | null;
    } = {},
  ) =>
    id(
      `INSERT INTO orders (channel, status, "fulfillmentState", total_price,
                           "branchId", "userId", "paidAt", "voidedAt", "refundedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        channel,
        status,
        fulfillmentState,
        total,
        extra.branchId ?? null,
        extra.userId ?? null,
        extra.paidAt ?? null,
        extra.voidedAt ?? null,
        extra.refundedAt ?? null,
      ],
    );
  const line = (
    orderId: number,
    variantId: number | null,
    quantity: number,
    unitPrice: number,
    productId: number | null = product,
  ) =>
    id(
      `INSERT INTO order_items ("orderId", "productId", "variantId", quantity,
                                unit_price, total_price, "productTitleSnapshot")
       VALUES ($1, $2, $3, $4, $5, $6, 'legacy snapshot') RETURNING id`,
      [
        orderId,
        productId,
        variantId,
        quantity,
        unitPrice,
        unitPrice * quantity,
      ],
    );
  const movement = (
    variantId: number,
    delta: number,
    balanceAfter: number,
    reason: string,
    orderId: number | null,
  ) =>
    ds.query(
      `INSERT INTO stock_movements ("variantId", delta, "balanceAfter", reason, "orderId")
       VALUES ($1, $2, $3, $4, $5)`,
      [variantId, delta, balanceAfter, reason, orderId],
    );

  const paidAt = new Date('2026-03-01T08:00:00Z');
  const voidedAt = new Date('2026-03-02T09:30:00Z');
  const refundedAt = new Date('2026-03-03T10:45:00Z');

  // A consumed POS sale: one variant line + a product-less legacy line.
  const posOrder = await order('pos', 'paid', 'fulfilled', 2_500_000, {
    paidAt,
    branchId: branch,
  });
  const posLineStocked = await line(posOrder, stocked, 2, 1_000_000);
  const posLineProductless = await line(posOrder, null, 1, 500_000, null);
  await movement(stocked, -2, STOCK_BEFORE.stocked, 'pos_sale', posOrder);

  // A paid web order still awaiting stock: lines, NO movement.
  const awaitingOrder = await order(
    'online',
    'paid',
    'awaiting_stock',
    3_000_000,
    {
      paidAt,
      userId: user,
    },
  );
  const awaitingLine = await line(awaitingOrder, other, 3, 1_000_000);

  // A pending (unpaid) web order.
  const pendingOrder = await order(
    'online',
    'pending',
    'not_required',
    1_000_000,
    {
      userId: user,
    },
  );
  const pendingLine = await line(pendingOrder, other, 1, 1_000_000);

  // Voided AFTER payment (consumed, then restored).
  const voidedPaidOrder = await order(
    'pos',
    'canceled',
    'fulfilled',
    1_700_000,
    {
      paidAt,
      voidedAt,
      branchId: branch,
    },
  );
  const voidedPaidLines = [
    await line(voidedPaidOrder, stocked, 1, 1_000_000),
    await line(voidedPaidOrder, other, 1, 700_000),
  ];
  await movement(stocked, -1, 6, 'pos_sale', voidedPaidOrder);
  await movement(other, -1, 2, 'pos_sale', voidedPaidOrder);
  await movement(stocked, 1, 7, 'cancellation_restore', voidedPaidOrder);
  await movement(other, 1, 3, 'cancellation_restore', voidedPaidOrder);

  // Voided BEFORE payment: no revenue was ever recognised, so no legacy row.
  const voidedUnpaidOrder = await order(
    'online',
    'canceled',
    'not_required',
    1_000_000,
    {
      voidedAt,
      userId: user,
    },
  );
  await line(voidedUnpaidOrder, other, 1, 1_000_000);

  // Refunded, with and without a recovered refund date.
  const refundedOrder = await order(
    'online',
    'refunded',
    'fulfilled',
    2_000_000,
    {
      paidAt,
      refundedAt,
      userId: user,
    },
  );
  const refundedLine = await line(refundedOrder, stocked, 2, 1_000_000);
  await movement(stocked, -2, 5, 'online_fulfillment', refundedOrder);
  await movement(stocked, 2, 7, 'return_restore', refundedOrder);

  const refundedNoDateOrder = await order(
    'online',
    'refunded',
    'fulfilled',
    900_000,
    {
      paidAt,
      refundedAt: null,
      userId: user,
    },
  );
  const refundedNoDateLine = await line(refundedNoDateOrder, other, 1, 900_000);
  await movement(other, -1, 2, 'online_fulfillment', refundedNoDateOrder);
  await movement(other, 1, 3, 'return_restore', refundedNoDateOrder);

  return {
    stocked,
    empty,
    other,
    posOrder,
    posLineStocked,
    posLineProductless,
    awaitingOrder,
    awaitingLine,
    pendingOrder,
    pendingLine,
    voidedPaidOrder,
    voidedPaidLines,
    voidedUnpaidOrder,
    refundedOrder,
    refundedLine,
    refundedNoDateOrder,
    refundedNoDateLine,
    voidedAt,
    refundedAt,
  };
}

// ---------------------------------------------------------------------------
// assertions on the migrated world
// ---------------------------------------------------------------------------

async function assertBackfill(ds: DataSource, f: Fixture): Promise<void> {
  const variants = await ds.query(
    `SELECT id, stock, "unvaluedQuantity", "inventoryCostValue"::text AS value,
            "lastPurchaseUnitCost"::text AS last, "costStatus"
       FROM product_variants ORDER BY id`,
  );
  const byId = new Map(
    (variants as Array<{ id: number }>).map((v) => [Number(v.id), v]),
  );

  expect(byId.get(f.stocked)).toEqual({
    id: f.stocked,
    stock: 7,
    unvaluedQuantity: 7,
    value: '0',
    last: null,
    costStatus: 'unvalued',
  });
  expect(byId.get(f.other)).toEqual({
    id: f.other,
    stock: 3,
    unvaluedQuantity: 3,
    value: '0',
    last: null,
    costStatus: 'unvalued',
  });
  expect(byId.get(f.empty)).toEqual({
    id: f.empty,
    stock: 0,
    unvaluedQuantity: 0,
    value: '0',
    last: null,
    costStatus: 'valued',
  });

  const lines = await ds.query(
    `SELECT id, "costStatus", "cogsTotal", "costKnownQuantity",
            "costUnknownQuantity", "costAllocatedAt"
       FROM order_items ORDER BY id`,
  );
  const line = (id: number) => lines.find((l) => Number(l.id) === id)!;
  const NULL_SPLIT = {
    cogsTotal: null,
    costKnownQuantity: null,
    costUnknownQuantity: null,
    costAllocatedAt: null,
  };
  for (const id of [
    f.posLineStocked,
    f.posLineProductless,
    ...f.voidedPaidLines,
    f.refundedLine,
    f.refundedNoDateLine,
  ]) {
    expect({ id, ...line(id) }).toEqual({
      id,
      costStatus: 'unknown',
      ...NULL_SPLIT,
    });
  }
  for (const id of [f.awaitingLine, f.pendingLine]) {
    expect({ id, ...line(id) }).toEqual({
      id,
      costStatus: 'pending',
      ...NULL_SPLIT,
    });
  }

  const adjustments = await ds.query(
    `SELECT "orderId", "orderItemId", kind, scope, "revenueQuantity",
            "revenueReversed"::text AS "revenueReversed",
            "restockedKnownQuantity", "restockedUnknownQuantity",
            "cogsReversed", "eventAt", "actorUserId", "stockMovementId"
       FROM order_item_adjustments ORDER BY "orderItemId"`,
  );
  const legacy = (
    orderId: number,
    orderItemId: number,
    kind: string,
    quantity: number,
    revenue: string,
    eventAt: Date | null,
  ) => ({
    orderId,
    orderItemId,
    kind,
    scope: 'legacy',
    revenueQuantity: quantity,
    revenueReversed: revenue,
    restockedKnownQuantity: null,
    restockedUnknownQuantity: null,
    cogsReversed: null,
    eventAt,
    actorUserId: null,
    stockMovementId: null,
  });
  expect(adjustments).toEqual([
    legacy(
      f.voidedPaidOrder,
      f.voidedPaidLines[0],
      'void',
      1,
      '1000000',
      f.voidedAt,
    ),
    legacy(
      f.voidedPaidOrder,
      f.voidedPaidLines[1],
      'void',
      1,
      '700000',
      f.voidedAt,
    ),
    legacy(
      f.refundedOrder,
      f.refundedLine,
      'return_refund',
      2,
      '2000000',
      f.refundedAt,
    ),
    legacy(
      f.refundedNoDateOrder,
      f.refundedNoDateLine,
      'return_refund',
      1,
      '900000',
      null,
    ),
  ]);

  // NOTHING WAS BACKFILLED WITH A COST — not even zero.
  const evidence = await one<Record<string, number>>(
    ds,
    `SELECT
       (SELECT count(*)::int FROM stock_movements
         WHERE "costDelta" IS NOT NULL OR "unitCost" IS NOT NULL
            OR "inventoryValueAfter" IS NOT NULL OR "unvaluedQuantityAfter" IS NOT NULL
            OR "unvaluedQuantityDelta" IS NOT NULL) AS movements,
       (SELECT count(*)::int FROM stock_movements) AS "allMovements",
       (SELECT count(*)::int FROM order_items WHERE "cogsTotal" IS NOT NULL) AS lines,
       (SELECT count(*)::int FROM order_item_adjustments WHERE "cogsReversed" IS NOT NULL) AS reversals,
       (SELECT count(*)::int FROM product_variants
         WHERE "inventoryCostValue" <> 0 OR "lastPurchaseUnitCost" IS NOT NULL) AS variants`,
  );
  expect(evidence).toEqual({
    movements: 0,
    allMovements: 9,
    lines: 0,
    reversals: 0,
    variants: 0,
  });
}

// ===========================================================================

describe('migration 0037 on a legacy (0036) database', () => {
  const DB = scratchDatabaseName('cost_legacy');
  let ds: DataSource;
  let fixture: Fixture;

  beforeAll(async () => {
    await recreate(DB);
    const before = await openAt(DB, BEFORE);
    await before.runMigrations({ transaction: 'all' });
    expect(
      await columnExists(before, 'product_variants', 'unvaluedQuantity'),
    ).toBe(false);
    fixture = await plantLegacyWorld(before);
    await before.destroy();

    ds = await openAt(DB, UNDER_TEST);
    const applied = await ds.runMigrations({ transaction: 'all' });
    expect(applied.map((m) => m.name)).toEqual([NAME_0037]);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await drop(DB);
  });

  it('preserves stock and backfills the valuation, line and reversal evidence as facts only', async () => {
    const stocks = await ds.query(
      `SELECT id, stock FROM product_variants ORDER BY id`,
    );
    expect(stocks.map((s) => Number(s.stock))).toEqual([7, 0, 3]);
    await assertBackfill(ds, fixture);
  });

  it('down() succeeds while no cost evidence exists, and up again reproduces the same backfill (up/down/up)', async () => {
    await ds.undoLastMigration({ transaction: 'all' });
    expect(await columnExists(ds, 'product_variants', 'unvaluedQuantity')).toBe(
      false,
    );
    expect(await columnExists(ds, 'order_items', 'costStatus')).toBe(false);
    expect(await columnExists(ds, 'stock_movements', 'costDelta')).toBe(false);
    expect(await tableExists(ds, 'order_item_adjustments')).toBe(false);
    const stocks = await ds.query(
      `SELECT stock FROM product_variants ORDER BY id`,
    );
    expect(stocks.map((s) => Number(s.stock))).toEqual([7, 0, 3]);
    // The pool guard went with it: a raw stock update is ordinary again.
    await ds.query(`UPDATE product_variants SET stock = stock WHERE id = $1`, [
      fixture.stocked,
    ]);

    const reapplied = await ds.runMigrations({ transaction: 'all' });
    expect(reapplied.map((m) => m.name)).toEqual([NAME_0037]);
    await assertBackfill(ds, fixture);
  });

  it('down() REFUSES once a valued receipt exists, and leaves the schema and the evidence intact', async () => {
    const inventory = new InventoryService();
    await ds.transaction((m) =>
      inventory.receiveValued(m, {
        variantId: fixture.empty,
        quantity: 2,
        unitCost: 4_321n,
        reason: StockMovementReason.STOCK_RECEIPT,
        reasonText: null,
        supplierReference: null,
        actorUserId: null,
        actorDisplaySnapshot: null,
        now: new Date(),
      }),
    );
    expect(
      await one(
        ds,
        `SELECT stock, "inventoryCostValue"::text AS v, "costStatus"
           FROM product_variants WHERE id = $1`,
        [fixture.empty],
      ),
    ).toEqual({ stock: 2, v: '8642', costStatus: 'valued' });

    await expect(ds.undoLastMigration({ transaction: 'all' })).rejects.toThrow(
      /Refusing to revert PurchaseCostAccounting1757000000037: cost evidence exists/,
    );

    const applied = await ds.query(
      `SELECT name FROM migrations WHERE name = $1`,
      [NAME_0037],
    );
    expect(applied).toHaveLength(1);
    expect(
      await columnExists(ds, 'product_variants', 'inventoryCostValue'),
    ).toBe(true);
    expect(await tableExists(ds, 'order_item_adjustments')).toBe(true);
    expect(
      await one(
        ds,
        `SELECT count(*)::int AS n FROM stock_movements WHERE "costDelta" IS NOT NULL`,
      ),
    ).toEqual({ n: 1 });
  });
});

describe('migration 0037 refuses negative stock', () => {
  const DB = scratchDatabaseName('cost_negative');
  let ds: DataSource | null = null;

  beforeAll(async () => {
    await recreate(DB);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await drop(DB);
  });

  it('throws before changing anything when a variant has stock < 0', async () => {
    const before = await openAt(DB, BEFORE);
    await before.runMigrations({ transaction: 'all' });
    const [{ id: productId }] = await before.query(
      `INSERT INTO products (title, description, "basePrice", "productCode",
                             "visibleOnSite", "branchVisibility")
       VALUES ('Oversold', 'x', 1, 'KZ-NEG-1', true, 'all') RETURNING id`,
    );
    await before.query(
      `INSERT INTO product_variants (price, stock, sku, "productId", "isActive",
                                     "isDefault", "variantCode")
       VALUES (1, -2, 'NEG-1', $1, true, false, 'KZ-NEG-1-A')`,
      [productId],
    );
    await before.destroy();

    ds = await openAt(DB, UNDER_TEST);
    await expect(ds.runMigrations({ transaction: 'all' })).rejects.toThrow(
      /1 variant\(s\) have negative physical stock/,
    );
    expect(
      await ds.query(`SELECT name FROM migrations WHERE name = $1`, [
        NAME_0037,
      ]),
    ).toHaveLength(0);
    expect(await columnExists(ds, 'product_variants', 'unvaluedQuantity')).toBe(
      false,
    );
    expect(await tableExists(ds, 'order_item_adjustments')).toBe(false);
    expect(
      await one(ds, `SELECT stock FROM product_variants WHERE sku = 'NEG-1'`),
    ).toEqual({ stock: -2 });
  });
});
