/**
 * ===========================================================================
 * `orders."orderNumber"` IS `character varying(40)` — migration 0026
 * ===========================================================================
 *
 * WHAT WENT WRONG. Migration 0003 created the column as unbounded `character
 * varying`; `Order.orderNumber` has always been declared `varchar(40)`.
 * Nothing failed, because the generator's longest possible output is 23
 * characters — so the disagreement was invisible in behaviour and permanent in
 * `typeorm schema:log`, which proposed the same ALTER on every run. A
 * schema-log that is never empty is a schema-log nobody reads.
 *
 * This file asserts three separate things, because they can fail
 * independently:
 *
 *   1. THE SCHEMA. After migrations, the column really is `varchar(40)`, its
 *      UNIQUE constraint is still there, and the database rejects an over-long
 *      value instead of storing it.
 *   2. THE GUARD. On a database that ALREADY holds an over-long order number,
 *      `up()` refuses with a sentence an operator can act on, applies nothing,
 *      and truncates nothing. This is the case the main harness database can
 *      never exercise, because it is clean by construction — and it is the one
 *      that decides whether a real deployment fails safely.
 *   3. THE ROUND TRIP. `down()` widens back and `up()` re-applies, with the
 *      unique constraint intact at every step.
 *
 * The generator's own bound is asserted too: a value it produces must fit, and
 * it must refuse rather than let the database reject it inside the transaction
 * that has already taken the customer's money.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';
import { DataSource } from 'typeorm';

import {
  getTestDataSource,
  resetDb,
  scratchDatabaseName,
  testDataSourceOptions,
  testDbConfig,
} from './setup/test-db';
import { createPosTestApp, TestApp } from './support/pos.harness';
import {
  as,
  loginCashier,
  seedBranch,
  seedVariant,
} from './support/pos.fixtures';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import {
  ORDER_NUMBER_MAX_LENGTH,
  buildOrderNumber,
} from 'src/modules/orders/order-number';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'src', 'migrations');
/** The last migration BEFORE the one under test. */
const BEFORE_TIMESTAMP = 1757000000025;
/** The one under test. */
const HEAD_TIMESTAMP = 1757000000026;
const HEAD_NAME = 'OrderNumberLength1757000000026';

function migrationFilesUpTo(upTo: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => Number(f.split('-')[0]) <= upTo)
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
}

interface ColumnShape {
  data_type: string;
  character_maximum_length: number | null;
}

async function orderNumberColumn(ds: DataSource): Promise<ColumnShape> {
  const rows = await ds.query<ColumnShape[]>(
    `SELECT data_type, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name = 'orderNumber'`,
  );
  return rows[0];
}

async function uniqueConstraintNames(ds: DataSource): Promise<string[]> {
  const rows = await ds.query<Array<{ conname: string }>>(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_class t     ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'orders'
        AND c.contype = 'u'
        AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid = t.oid AND a.attname = 'orderNumber')
            ]::smallint[]
      ORDER BY c.conname`,
  );
  return rows.map((r) => r.conname);
}

// ===========================================================================
// 1. The migrated schema, and what it refuses
// ===========================================================================

describe('orders."orderNumber" length (int)', () => {
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

  it('is character varying(40) after every migration has run', async () => {
    const column = await orderNumberColumn(ctx.dataSource);

    expect(column.data_type).toBe('character varying');
    // The whole point: NOT null, which is what "unbounded varchar" reports.
    expect(column.character_maximum_length).toBe(ORDER_NUMBER_MAX_LENGTH);
  });

  it('still carries exactly one UNIQUE constraint on the column', async () => {
    // Altering a column's type rebuilds its dependent indexes. A migration
    // that dropped and recreated the constraint by hand could leave zero (a
    // window in which duplicate receipt numbers are insertable) or two.
    expect(await uniqueConstraintNames(ctx.dataSource)).toEqual([
      'uq_orders_order_number',
    ]);
  });

  it('refuses a value longer than the column instead of storing it', async () => {
    const tooLong = 'X'.repeat(ORDER_NUMBER_MAX_LENGTH + 1);

    await expect(
      ctx.dataSource.query(
        `INSERT INTO orders (channel, status, "fulfillmentState", subtotal, total_price, "orderNumber")
         VALUES ('pos', 'paid', 'fulfilled', 0, 0, $1)`,
        [tooLong],
      ),
      // 22001 string_data_right_truncation. Before 0026 this INSERT succeeded.
    ).rejects.toThrow(/value too long/i);
  });

  it('still rejects a DUPLICATE order number, at the new type', async () => {
    const value = 'POS-20261011-000001';
    await ctx.dataSource.query(
      `INSERT INTO orders (channel, status, "fulfillmentState", subtotal, total_price, "orderNumber")
       VALUES ('pos', 'paid', 'fulfilled', 0, 0, $1)`,
      [value],
    );
    await expect(
      ctx.dataSource.query(
        `INSERT INTO orders (channel, status, "fulfillmentState", subtotal, total_price, "orderNumber")
         VALUES ('pos', 'paid', 'fulfilled', 0, 0, $1)`,
        [value],
      ),
    ).rejects.toThrow(/uq_orders_order_number|duplicate key/i);
  });

  // =======================================================================
  // The generator
  // =======================================================================

  it('generates a real POS sale number that fits, through the real endpoint', async () => {
    const branch = await seedBranch(ctx, 'NumberLength');
    const cashier = await loginCashier(ctx, branch, {
      username: 'len_cashier',
    });
    const variant = await seedVariant(ctx, { price: 1_000_000, stock: 2 });

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    const orderNumber: string = sale.body.data.orderNumber;
    expect(orderNumber).toMatch(/^POS-\d{8}-\d{6,}$/);
    expect(orderNumber.length).toBeLessThanOrEqual(ORDER_NUMBER_MAX_LENGTH);
  });

  it('cannot produce a number that overflows the column, at any id it can be given', () => {
    /*
     * THE BOUND, ARGUED RATHER THAN ASSUMED.
     *
     * The format is 13 fixed characters (3 prefix + 2 separators + 8 date
     * stamp) plus the id, zero-padded to a floor of 6. So the only way to
     * exceed 40 is an id whose decimal form is longer than 27 characters — and
     * `orders.id` is a `SERIAL`, whose maximum is 2 147 483 647: ten digits,
     * 23 characters. The boundary values below pin every step of that
     * argument, so a change to the prefix, the separators, the date stamp or
     * the padding floor breaks a test rather than a receipt.
     *
     * The runtime guard inside `buildOrderNumber` is therefore UNREACHABLE
     * through this signature, and that is the intended state: it exists so
     * that a future change to the format fails here, in a function, rather
     * than at COMMIT inside the transaction that has already decremented stock
     * and taken the customer's money — where it would surface as a 500
     * carrying a raw PostgreSQL error string.
     */
    const at = new Date('2026-10-11T09:00:00.000Z');

    const cases: Array<[number, number]> = [
      [1, 19], // padded to the 6-digit floor
      [999_999, 19], // the last id the padding covers
      [1_000_000, 20], // one character of natural growth
      [2_147_483_647, 23], // int4 maximum — the widest a SERIAL can reach
      [Number.MAX_SAFE_INTEGER, 29], // 16 digits: still 11 short of the cap
    ];

    for (const [id, expectedLength] of cases) {
      const value = buildOrderNumber(OrderChannel.POS, id, at, 'Asia/Tehran');
      expect(value.length).toBe(expectedLength);
      expect(value.length).toBeLessThanOrEqual(ORDER_NUMBER_MAX_LENGTH);
    }

    expect(
      buildOrderNumber(OrderChannel.ONLINE, 41, at, 'Asia/Tehran'),
    ).toMatch(/^WEB-\d{8}-000041$/);
  });
});

// ===========================================================================
// 2 + 3. The guard, and the up/down/up round trip, on a scratch database
// ===========================================================================

describe('migration 0026 on a database that already has an over-long order number', () => {
  const DB_NAME = scratchDatabaseName('order_number_length');

  function openAt(upTo: number): DataSource {
    return new DataSource({
      ...testDataSourceOptions(),
      database: DB_NAME,
      migrations: migrationFilesUpTo(upTo),
    } as never);
  }

  async function recreateDatabase(): Promise<void> {
    const config = testDbConfig();
    const admin = new PgClient({ ...config, user: config.username });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
  }

  async function dropDatabase(): Promise<void> {
    const config = testDbConfig();
    const cleaner = new PgClient({ ...config, user: config.username });
    await cleaner.connect();
    await cleaner.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await cleaner.end();
  }

  it('refuses, applies nothing, and leaves the row untouched', async () => {
    await recreateDatabase();

    // Build the schema as it was BEFORE 0026: unbounded varchar.
    const before = openAt(BEFORE_TIMESTAMP);
    await before.initialize();
    await before.runMigrations({ transaction: 'all' });

    const column = await orderNumberColumn(before);
    expect(column.character_maximum_length).toBeNull(); // unbounded, as 0003 left it

    // A value only a hand-written insert could produce: 45 characters.
    const overLong = `POS-20261011-${'9'.repeat(32)}`;
    expect(overLong.length).toBe(45);
    await before.query(
      `INSERT INTO orders (channel, status, "fulfillmentState", subtotal, total_price, "orderNumber")
       VALUES ('pos', 'paid', 'fulfilled', 0, 0, $1)`,
      [overLong],
    );
    await before.destroy();

    // Now try to apply 0026.
    const head = openAt(HEAD_TIMESTAMP);
    await head.initialize();
    let thrown: Error | null = null;
    try {
      await head.runMigrations({ transaction: 'all' });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).not.toBeNull();
    const message = thrown!.message;
    // An operator must be able to act on this without reading the migration.
    expect(message).toContain('REFUSING TO ALTER');
    expect(message).toContain('orderNumber');
    expect(message).toContain('45'); // the longest value actually found
    expect(message).toContain('40'); // the target
    expect(message).toContain('SELECT id'); // the query that finds the rows

    // NOTHING was applied...
    const applied = await head.query<Array<{ name: string }>>(
      `SELECT name FROM migrations WHERE name = $1`,
      [HEAD_NAME],
    );
    expect(applied).toHaveLength(0);

    // ...the column is still unbounded...
    expect((await orderNumberColumn(head)).character_maximum_length).toBeNull();

    // ...and above all the receipt number was NOT truncated.
    const rows = await head.query<Array<{ orderNumber: string }>>(
      `SELECT "orderNumber" FROM orders`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].orderNumber).toBe(overLong);

    await head.destroy();
    await dropDatabase();
  });

  it('applies, reverts and re-applies cleanly once the data fits', async () => {
    await recreateDatabase();

    const head = openAt(HEAD_TIMESTAMP);
    await head.initialize();

    // up
    await head.runMigrations({ transaction: 'all' });
    expect((await orderNumberColumn(head)).character_maximum_length).toBe(
      ORDER_NUMBER_MAX_LENGTH,
    );
    expect(await uniqueConstraintNames(head)).toEqual([
      'uq_orders_order_number',
    ]);

    // A row that fits survives every step below untouched.
    await head.query(
      `INSERT INTO orders (channel, status, "fulfillmentState", subtotal, total_price, "orderNumber")
       VALUES ('pos', 'paid', 'fulfilled', 0, 0, 'POS-20261011-000007')`,
    );

    // down — widens back to what 0003 created.
    await head.undoLastMigration({ transaction: 'all' });
    expect((await orderNumberColumn(head)).character_maximum_length).toBeNull();
    expect(await uniqueConstraintNames(head)).toEqual([
      'uq_orders_order_number',
    ]);

    // up again — the round trip that `smoke.int-spec.ts` performs for the
    // whole chain, asserted here for this migration specifically so a failure
    // names the migration rather than the chain.
    await head.runMigrations({ transaction: 'all' });
    expect((await orderNumberColumn(head)).character_maximum_length).toBe(
      ORDER_NUMBER_MAX_LENGTH,
    );
    expect(await uniqueConstraintNames(head)).toEqual([
      'uq_orders_order_number',
    ]);

    const rows = await head.query<Array<{ orderNumber: string }>>(
      `SELECT "orderNumber" FROM orders`,
    );
    expect(rows.map((r) => r.orderNumber)).toEqual(['POS-20261011-000007']);

    await head.destroy();
    await dropDatabase();
  });
});
