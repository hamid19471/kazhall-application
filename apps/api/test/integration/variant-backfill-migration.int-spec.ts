import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import {
  scratchDatabaseName,
  testDataSourceOptions,
  testDbConfig,
} from './setup/test-db';

/**
 * ============================================================================
 * MIGRATIONS 0012 + 0013 -- the backfill, on data that predates them.
 *
 * These two migrations are the compatibility half of closing the variant-less
 * inventory bypass, and the only honest way to test them is against rows that
 * existed BEFORE they ran. So this suite works on its own throwaway database
 * and applies the migrations in two stages: everything up to 0011, then the
 * old world is planted, then 0012 and 0013.
 *
 * WHY STAGED RATHER THAN "apply all, then undo the last two": the migration
 * list grows, and other workstreams add migrations after 0013. Counting back
 * from the head would silently start reverting somebody else's migration
 * instead of ours. Selecting migration FILES by timestamp is stable no matter
 * what lands after us.
 *
 * WHAT IS BEING PINNED DOWN, and why each one is dangerous to get wrong:
 *
 *   STOCK 0        The backfill must NOT invent an opening count. Nobody ever
 *                  counted a variant-less product -- there was no stock column
 *                  that applied to it -- so any non-zero number here would be
 *                  fabricated stock that a POS sale would later fail to find.
 *
 *   PRICE COPIED   `products."basePrice"` and `product_variants."price"` are
 *                  both bigint INTEGER RIAL, so the value is copied verbatim.
 *                  A scaled or reinterpreted price would mis-charge every
 *                  customer of that product.
 *
 *   CART LINE      A pre-existing variant-less basket line had no reservation
 *                  and cannot honestly be given one against a 0-stock SKU. It
 *                  is repointed and soft-removed WITH A REASON, so the customer
 *                  is told -- rather than the line silently becoming unbuyable
 *                  or silently becoming free stock.
 *
 *   NOT NULL       `cart_items."variantId"` becomes NOT NULL, so the bypass
 *                  cannot be re-created by any future code path.
 * ============================================================================
 */

/**
 * `@types/pg` is not installed, so `pg`'s exports are implicitly `any`. Narrow
 * the small surface used here rather than scattering eslint-disable comments.
 * (Mirrors the shim in smoke.int-spec.ts.)
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

/**
 * Per-run, and carrying the harness's `kazhal_int_` prefix.
 *
 * A fixed name would let two concurrent suites drop each other's database (this
 * spec opens with `DROP DATABASE IF EXISTS`), and — in external mode, where the
 * server outlives the run — a leaked database with an unrecognised name is one
 * nobody can safely clean up. The prefix is what marks a database as this
 * harness's own.
 */
const DB_NAME = scratchDatabaseName('variant_backfill');
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'src', 'migrations');

/** The last migration BEFORE the two under test. */
const BEFORE_TIMESTAMP = 1757000000011;
/** The last of the two under test. */
const HEAD_TIMESTAMP = 1757000000013;

/** Migration files whose leading timestamp is <= `upTo`. */
function migrationFilesUpTo(upTo: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => Number(f.split('-')[0]) <= upTo)
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
}

async function openAt(upTo: number): Promise<DataSource> {
  const ds = new DataSource({
    ...testDataSourceOptions(),
    database: DB_NAME,
    migrations: migrationFilesUpTo(upTo),
  } as never);
  await ds.initialize();
  return ds;
}

interface VariantRow {
  id: number;
  sku: string;
  stock: number;
  price: string | null;
  isActive: boolean;
  isDefault: boolean;
}

interface CartRow {
  id: number;
  variantId: number | null;
  quantity: number;
  status: string;
  lastChangeReason: string | null;
  lastChangeQtyDelta: number | null;
}

describe('migrations 0012/0013 backfill variant-less data', () => {
  let ds: DataSource;

  /** Product with no variants and a real basePrice. */
  let bareProductId: number;
  /** Product with no variants and a NULL basePrice. */
  let pricelessProductId: number;
  /** Product that already had a real variant -- must be left alone. */
  let optionProductId: number;
  let optionVariantId: number;
  let userId: number;
  let activeCartId: number;
  let orphanCartId: number;

  beforeAll(async () => {
    const config = testDbConfig();
    const admin = new PgClient({ ...config, user: config.username });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();

    // ---- stage 1: the schema as it was before this workstream ----------
    const before = await openAt(BEFORE_TIMESTAMP);
    await before.runMigrations({ transaction: 'all' });

    // `isDefault` does not exist yet and `cart_items."variantId"` is still
    // nullable, so these inserts are exactly what production data looks like.
    [{ id: bareProductId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "products" ("title","description","basePrice")
       VALUES ('Uncounted kettle','sold with no SKU at all', 4500000) RETURNING id`,
    );
    [{ id: pricelessProductId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "products" ("title","description","basePrice")
       VALUES ('No price either','also had no variant', NULL) RETURNING id`,
    );
    [{ id: optionProductId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "products" ("title","description","basePrice")
       VALUES ('T-shirt','sold by colour', 1000000) RETURNING id`,
    );
    [{ id: optionVariantId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "product_variants" ("price","stock","sku","productId","isActive")
       VALUES (1200000, 6, 'TSHIRT-RED', $1, true) RETURNING id`,
      [optionProductId],
    );

    [{ id: userId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "users" ("username","mobile","password")
       VALUES ('legacy-shopper','09120000001','x') RETURNING id`,
    );

    // The line the bypass allowed: 3 units, no variant, and -- crucially --
    // no reservation anywhere.
    [{ id: activeCartId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "cart_items" ("userId","productId","variantId","quantity","status")
       VALUES ($1, $2, NULL, 3, 'active') RETURNING id`,
      [userId, bareProductId],
    );
    // A variant-less line on a product that DOES have options. The shipped
    // `resolveTarget` could never create this; 0013 has nothing honest to
    // point it at.
    [{ id: orphanCartId }] = await before.query<Array<{ id: number }>>(
      `INSERT INTO "cart_items" ("userId","productId","variantId","quantity","status")
       VALUES ($1, $2, NULL, 2, 'active') RETURNING id`,
      [userId, optionProductId],
    );

    await before.destroy();

    // ---- stage 2: the two migrations under test ------------------------
    ds = await openAt(HEAD_TIMESTAMP);
    const applied = await ds.runMigrations({ transaction: 'all' });
    expect(applied.map((m) => m.name)).toEqual([
      'ProductDefaultVariant1757000000012',
      'CartItemsRequireVariant1757000000013',
    ]);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    const config = testDbConfig();
    const admin = new PgClient({ ...config, user: config.username });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  });

  const variantsOf = (productId: number) =>
    ds.query<VariantRow[]>(
      `SELECT "id","sku","stock","price","isActive","isDefault"
         FROM "product_variants" WHERE "productId" = $1 ORDER BY "id"`,
      [productId],
    );

  const cartRow = async (id: number): Promise<CartRow | undefined> => {
    const rows = await ds.query<CartRow[]>(
      `SELECT "id","variantId","quantity","status"::text AS status,
              "lastChangeReason","lastChangeQtyDelta"
         FROM "cart_items" WHERE "id" = $1`,
      [id],
    );
    return rows[0];
  };

  // ==========================================================================
  it('gives a variant-less product exactly one default variant at STOCK 0', async () => {
    const variants = await variantsOf(bareProductId);

    expect(variants).toHaveLength(1);
    expect(variants[0].isDefault).toBe(true);
    expect(variants[0].isActive).toBe(true);
    // THE POINT: zero is the only honest value. Nobody counted this product.
    expect(variants[0].stock).toBe(0);
    // Deterministic, collision-free, derived from the product id.
    expect(variants[0].sku).toBe(`DEFAULT-P${bareProductId}`);
  });

  it("copies products.basePrice into the default variant's price verbatim", async () => {
    const [variant] = await variantsOf(bareProductId);
    // Same money unit on both sides (bigint integer Rial), so no conversion.
    expect(Number(variant.price)).toBe(4_500_000);

    const [priceless] = await variantsOf(pricelessProductId);
    // A NULL basePrice is not a price; it becomes 0, the same value the
    // application uses for a variant created without one.
    expect(Number(priceless.price)).toBe(0);
  });

  it('leaves a product that already had variants completely alone', async () => {
    const variants = await variantsOf(optionProductId);
    expect(variants).toHaveLength(1);
    expect(variants[0].id).toBe(optionVariantId);
    // No default: this product is sold BY OPTION, and inventing a default
    // would silently decide which colour "add to basket" means.
    expect(variants[0].isDefault).toBe(false);
    expect(variants[0].stock).toBe(6);
  });

  // ==========================================================================
  it('repoints a variant-less basket line and TELLS the customer it lost its stock', async () => {
    const [defaultVariant] = await variantsOf(bareProductId);
    const line = await cartRow(activeCartId);

    expect(line).toBeDefined();
    expect(line!.variantId).toBe(defaultVariant.id);
    // Soft-removed, not deleted and not left dangling: the row survives so the
    // next `GET /cart` can explain what happened, exactly once.
    expect(line!.status).toBe('removed');
    expect(line!.quantity).toBe(0);
    expect(line!.lastChangeReason).toBe('stock_not_counted');
    expect(line!.lastChangeQtyDelta).toBe(-3);
  });

  it('does NOT fabricate a reservation for the repointed line', async () => {
    const [{ n }] = await ds.query<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM "stock_reservations"`,
    );
    // The default variant has 0 stock. A reservation here would be a hold on
    // units that do not exist, and a POS sale would then be unable to sell
    // stock the shop actually has.
    expect(Number(n)).toBe(0);
  });

  it('drops a variant-less line whose product has no default to point at', async () => {
    // It named nothing sellable, and picking one of the product's real options
    // would put a colour the customer never chose into their basket.
    await expect(cartRow(orphanCartId)).resolves.toBeUndefined();
  });

  // ==========================================================================
  it('makes cart_items.variantId NOT NULL, so the bypass cannot come back', async () => {
    const [column] = await ds.query<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'cart_items' AND column_name = 'variantId'`,
    );
    expect(column.is_nullable).toBe('NO');

    await expect(
      ds.query(
        `INSERT INTO "cart_items" ("userId","productId","variantId","quantity","status")
         VALUES ($1, $2, NULL, 1, 'active')`,
        [userId, bareProductId],
      ),
    ).rejects.toThrow(/null value in column "variantId"/);
  });

  it('creates the one-default-per-product partial unique index', async () => {
    const [index] = await ds.query<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'uq_variant_one_default_per_product'`,
    );
    expect(index).toBeDefined();
    expect(index.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(index.indexdef).toMatch(/WHERE \(?"?isDefault"?/);
  });

  // ==========================================================================
  it('reverts cleanly: down() restores the nullable column and the old cart line', async () => {
    // Reverting the two migrations under test -- and only those two, because
    // this DataSource was opened with the migration files up to 0013 only.
    await ds.undoLastMigration();
    await ds.undoLastMigration();

    const [column] = await ds.query<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'cart_items' AND column_name = 'variantId'`,
    );
    expect(column.is_nullable).toBe('YES');

    // The marker reason is how down() finds exactly the rows up() changed.
    const line = await cartRow(activeCartId);
    expect(line).toMatchObject({
      variantId: null,
      quantity: 3,
      status: 'active',
      lastChangeReason: null,
    });

    // The backfilled defaults only existed because of 0012, so they go --
    // TSHIRT-RED, which did not, survives.
    const remaining = await ds.query<Array<{ sku: string }>>(
      `SELECT "sku" FROM "product_variants" ORDER BY "id"`,
    );
    expect(remaining.map((r) => r.sku)).toEqual(['TSHIRT-RED']);

    const [hasColumn] = await ds.query<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'product_variants' AND column_name = 'isDefault'`,
    );
    expect(Number(hasColumn.n)).toBe(0);

    // And straight back up again, on the same data.
    const reapplied = await ds.runMigrations({ transaction: 'all' });
    expect(reapplied).toHaveLength(2);
    const [again] = await variantsOf(bareProductId);
    expect(again.isDefault).toBe(true);
    expect(again.stock).toBe(0);
    expect(Number(again.price)).toBe(4_500_000);
  });
});
