import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Role } from 'src/modules/auth/entities/role.entity';
import { User } from 'src/modules/user/entities/user.entity';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import { Category } from 'src/modules/categories/entities/category.entity';
import { Product } from 'src/modules/products/entities/product.entity';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { record } from '../support/diagnostics';
import {
  fixtureIdentity,
  fixtureMobile,
  fixtureSku,
  fixtureUsername,
  uniqueSuffix,
  fixtureProductCode,
} from './fixture-ids';

/**
 * Fixture builders for the integration suite.
 *
 * Every helper takes explicit overrides and fills the rest with unique
 * defaults, so a test states only what it actually cares about and two tests in
 * the same file cannot collide on a unique column.
 */

/*
 * FIXTURE IDENTIFIERS COME FROM `setup/fixture-ids.ts`.
 *
 * `uniqueSuffix` used to live here as a module-level counter plus the pid.
 * Jest resets the module registry per TEST FILE, so the counter restarted while
 * the pid did not, and every suite replayed the same sequence; the generated
 * mobile also truncated to 11 characters and collided on a UNIQUE column once
 * the counter passed 999. Both are fixed there, with the reasoning.
 *
 * Re-exported so the existing call sites keep working unchanged.
 */
export {
  fixtureIdempotencyKey,
  fixtureMobile,
  fixtureRoleName,
  fixtureSku,
  fixtureUsername,
  uniqueSuffix,
} from './fixture-ids';

/**
 * Ensures the three built-in roles exist, SAFELY UNDER CONCURRENCY.
 *
 * This used to be find-then-insert:
 *
 *   let role = await repo.findOne({ where: { name } });
 *   role ??= await repo.save(repo.create({ name }));
 *
 * which is a check-then-act race on a UNIQUE column. Two fixtures built at the
 * same moment — `Promise.all([createUser(ds), createUser(ds)])`, or simply two
 * jest workers sharing the run's database — both see no row and both INSERT,
 * and one dies with `duplicate key value violates unique constraint`. The
 * failure surfaces inside `seedRoles`, several frames below whatever test was
 * actually being written, which makes it look like a bug in the code under
 * test.
 *
 * `ON CONFLICT DO NOTHING` moves the decision into PostgreSQL, where it is
 * atomic, and the rows are then read back in one query. No retry, no lock, no
 * serialising of the callers.
 */
export async function seedRoles(ds: DataSource): Promise<Map<string, Role>> {
  const names = Object.values(UserRoleEnum);

  await ds.query(
    `INSERT INTO "roles" ("name")
     SELECT unnest($1::text[])
     ON CONFLICT ("name") DO NOTHING`,
    [names],
  );

  const rows = await ds
    .getRepository(Role)
    .createQueryBuilder('role')
    .where('role.name IN (:...names)', { names })
    .getMany();

  const result = new Map<string, Role>();
  for (const role of rows) result.set(role.name, role);

  for (const name of names) {
    if (!result.has(name)) {
      throw new Error(
        `seedRoles could not establish the built-in role "${name}". ` +
          `The roles table should contain it after the upsert above.`,
      );
    }
  }
  return result;
}

export interface CreateUserOptions {
  username?: string;
  mobile?: string | null;
  /** Plaintext; hashed before insert and returned so the test can log in. */
  password?: string;
  roles?: UserRoleEnum[];
  branchId?: number | null;
}

export interface CreatedUser {
  user: User;
  username: string;
  password: string;
}

export async function createUser(
  ds: DataSource,
  options: CreateUserOptions = {},
): Promise<CreatedUser> {
  const roleMap = await seedRoles(ds);

  const username = options.username ?? fixtureUsername();
  const password = options.password ?? 'Passw0rd!test';
  const wanted = options.roles ?? [UserRoleEnum.site];

  const repo = ds.getRepository(User);
  const user = await repo.save(
    repo.create({
      username,
      /*
       * PRODUCTION FORMAT, NOT A TRUNCATED APPROXIMATION.
       *
       * `fixtureMobile()` returns exactly `09` + nine digits, which is what
       * `IRAN_MOBILE = /^09\d{9}$/` accepts and what the column's UNIQUE
       * constraint is checked against. The previous expression built
       * `` `0912${suffix}`.slice(0, 11) ``, which SILENTLY DROPPED characters
       * once the suffix grew — so two different fixtures could produce the same
       * number.
       */
      mobile:
        options.mobile === undefined
          ? fixtureMobile()
          : (options.mobile ?? undefined),
      password: await bcrypt.hash(password, 4), // low cost: tests, not production
      branchId: options.branchId ?? undefined,
      roles: wanted.map((name) => {
        const role = roleMap.get(name);
        if (!role) throw new Error(`Role ${name} was not seeded`);
        return role;
      }),
    }),
  );

  // Inert unless KAZHAL_INT_DIAG_FILE is set. The username and the generated
  // mobile are FIXTURE IDENTIFIERS, not credentials: they are exactly the
  // values a unique-constraint collision would be reported against, and the
  // original report could not say which usernames a failing test had created.
  // The password is never recorded — it is the same constant for every fixture
  // and writing it down would put a working credential in a log file.
  record('fixture:createUser', {
    // Which worker and run produced this identifier, so a collision is
    // traceable rather than merely reported.
    identity: fixtureIdentity(),
    username,
    mobile: user.mobile ?? null,
    userId: user.id,
    roles: wanted,
    branchId: options.branchId ?? null,
  });

  return { user, username, password };
}

export async function createBranch(
  ds: DataSource,
  overrides: Partial<Branch> = {},
): Promise<Branch> {
  const repo = ds.getRepository(Branch);
  return repo.save(
    repo.create({
      name: `branch_${uniqueSuffix()}`,
      address: 'Test address',
      phone: '02100000000',
      ...overrides,
    }),
  );
}

export async function createCategory(
  ds: DataSource,
  title?: string,
): Promise<Category> {
  const repo = ds.getRepository(Category);
  return repo.save(
    repo.create({ title: title ?? `category_${uniqueSuffix()}` }),
  );
}

export interface CreateProductOptions {
  title?: string;
  description?: string;
  /** Integer Rial. */
  basePrice?: number;
  categories?: Category[];
  /** «کد محصول». Defaults to a collision-free generated one. */
  productCode?: string;
  /** Website channel. Fixtures default to TRUE — see `createProduct`. */
  visibleOnSite?: boolean;
  /** Retail channel. Fixtures default to `'all'` — see `createProduct`. */
  branchVisibility?: 'none' | 'all' | 'selected';
}

export async function createProduct(
  ds: DataSource,
  options: CreateProductOptions = {},
): Promise<Product> {
  const repo = ds.getRepository(Product);
  return repo.save(
    repo.create({
      title: options.title ?? `product_${uniqueSuffix()}`,
      description: options.description ?? 'integration fixture',
      /*
       * `productCode` is NOT NULL and globally unique since migration 0031, so
       * a fixture must supply one. It is built from the same collision-free
       * generator as `fixtureSku`, and upper-cased because the CHECK constraint
       * accepts only A-Z 0-9 and hyphens.
       */
      productCode: options.productCode ?? fixtureProductCode(),
      basePrice: options.basePrice ?? 1_000_000,
      categories: options.categories ?? [],
      /*
       * FIXTURES ARE VISIBLE EVERYWHERE BY DEFAULT.
       *
       * The column defaults are hidden/draft, which is the right default for
       * the APPLICATION but the wrong one for a fixture: every pre-existing
       * spec was written against a world where a seeded product was simply
       * sellable, and defaulting these to draft would make hundreds of
       * unrelated assertions fail for a reason that has nothing to do with
       * what they test. A spec that cares about visibility sets it explicitly.
       */
      visibleOnSite: options.visibleOnSite ?? true,
      branchVisibility: options.branchVisibility ?? 'all',
    }),
  );
}

export interface CreateVariantOptions {
  sku?: string;
  /** «کد گونه». Defaults to one derived from the parent's product code. */
  variantCode?: string;
  /** Integer Rial. */
  price?: number;
  stock?: number;
}

export async function createVariant(
  ds: DataSource,
  product: Product,
  options: CreateVariantOptions = {},
): Promise<ProductVariant> {
  const repo = ds.getRepository(ProductVariant);
  return repo.save(
    repo.create({
      product,
      sku: options.sku ?? fixtureSku(),
      // Derived from the parent so the relationship rule holds by construction.
      variantCode:
        options.variantCode ??
        `${product.productCode}-V${uniqueSuffix().replace(/_/g, '')}`,
      price: options.price ?? 1_000_000,
      stock: options.stock ?? 10,
    }),
  );
}

/** Product + one variant in a single call — the common catalogue fixture. */
export async function createProductWithVariant(
  ds: DataSource,
  productOptions: CreateProductOptions = {},
  variantOptions: CreateVariantOptions = {},
): Promise<{ product: Product; variant: ProductVariant }> {
  const product = await createProduct(ds, productOptions);
  const variant = await createVariant(ds, product, variantOptions);
  return { product, variant };
}

/**
 * Writes one PENDING `order_items` line on an existing order, priced at the
 * variant's current selling price, with product id and title read from the
 * variant.
 *
 * `InventoryService.consumeForPosSale` allocates COGS to the order's pending
 * lines of each variant it consumes and refuses
 * (COST_ALLOCATION_INVARIANT_VIOLATION) when they do not add up exactly to the
 * consumed quantity. A test that drives that primitive directly (as
 * `OrdersService.recordPosSale` would) writes the sale's lines with this first.
 */
export async function createOrderLine(
  ds: DataSource | EntityManager,
  orderId: number,
  variantId: number,
  quantity: number,
): Promise<number> {
  const rows: Array<{ id: number }> = await ds.query(
    `INSERT INTO order_items ("orderId", "productId", "variantId", quantity,
                              unit_price, total_price, "productTitleSnapshot")
     SELECT $1, v."productId", v.id, $3::int, v.price, v.price * $3::int, p.title
       FROM product_variants v
       JOIN products p ON p.id = v."productId"
      WHERE v.id = $2
     RETURNING id`,
    [orderId, variantId, quantity],
  );
  if (rows.length !== 1) {
    throw new Error(`createOrderLine: variant ${variantId} not found`);
  }
  return Number(rows[0].id);
}

/**
 * TEST-ONLY: force a variant's physical stock to `stock`, as if it had been
 * counted in by hand, with every unit UNVALUED (unknown cost, never zero).
 *
 * Migration 0037's `trg_product_variants_pool_guard` refuses any raw UPDATE of
 * `stock` that does not come from `InventoryService.writePool`. Tests that
 * simulate an out-of-band stock change use this instead of a bare UPDATE, so
 * the guard stays strict for everything else. No movement is written — that is
 * exactly the out-of-band change these tests are simulating.
 */
export async function forceStockForTest(
  ds: DataSource | EntityManager,
  variantId: number,
  stock: number,
): Promise<void> {
  const run = async (m: EntityManager) => {
    await m.query(`SELECT set_config('kazhal.valuation_writer', 'on', true)`);
    await m.query(
      `UPDATE product_variants
          SET stock = $2, "unvaluedQuantity" = $2, "inventoryCostValue" = 0
        WHERE id = $1`,
      [variantId, stock],
    );
    await m.query(`SELECT set_config('kazhal.valuation_writer', 'off', true)`);
  };
  if (ds instanceof DataSource) {
    await ds.transaction(run);
  } else {
    await run(ds);
  }
}
