/**
 * ============================================================================
 * RENAMING «کد محصول» CASCADES TO EVERY «کد گونه» — atomically.
 *
 * THE DEFECT THIS PINS. `PATCH /products/:id` used to accept a new product code
 * and leave the children alone:
 *
 *     product  KZ-P-000010  ->  KZ-P-000020
 *     variant  KZ-P-000010-V000025   (unchanged — now an orphan prefix)
 *
 * so the invariant the whole code module states was false for every renamed
 * product. The service now rewrites the children in the same transaction, and
 * migration 0033 makes the broken pair impossible to commit from ANY path.
 *
 * Every case here runs against a real disposable PostgreSQL, because every
 * claim being made is a claim about transactions, locks and constraints.
 * ============================================================================
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';

import {
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { resetDb } from './setup/test-db';
import {
  createBranch,
  createProduct,
  createProductWithVariant,
  createUser,
  createVariant,
  seedRoles,
} from './setup/seed-helpers';
import { fixtureIdempotencyKey } from './setup/fixture-ids';

interface CodeRow {
  productCode: string;
  variantId: number;
  variantCode: string;
}

describe('product code rename cascade (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    ctx.redis.flush();
  });

  async function superAdminJar() {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return authenticate(ctx, username, password, 'admin');
  }

  async function codesOf(productId: number): Promise<CodeRow[]> {
    return await ctx.dataSource.query(
      `SELECT p."productCode", v."id" AS "variantId", v."variantCode"
         FROM "products" p
         JOIN "product_variants" v ON v."productId" = p."id"
        WHERE p."id" = $1
        ORDER BY v."id" ASC`,
      [productId],
    );
  }

  /** A product with three variants whose suffixes are deliberately varied. */
  async function productWithThreeVariants(productCode: string) {
    const product = await createProduct(ctx.dataSource, { productCode });
    const suffixes = ['V000025', 'V000026', 'RED-XL'];
    for (const suffix of suffixes) {
      await createVariant(ctx.dataSource, product, {
        variantCode: `${productCode}-${suffix}`,
      });
    }
    return { product, suffixes };
  }

  // =========================================================================
  // The contract
  // =========================================================================

  it('rewrites every variant prefix and preserves every suffix exactly', async () => {
    const jar = await superAdminJar();
    const { product, suffixes } = await productWithThreeVariants('KZ-P-000010');

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: 'KZ-P-000020' })
      .expect(200);

    const after = await codesOf(product.id);
    expect(after.map((r) => r.productCode)).toEqual([
      'KZ-P-000020',
      'KZ-P-000020',
      'KZ-P-000020',
    ]);
    expect(after.map((r) => r.variantCode)).toEqual([
      'KZ-P-000020-V000025',
      'KZ-P-000020-V000026',
      'KZ-P-000020-RED-XL',
    ]);

    /*
     * THE SUFFIX IS THE POINT. `RED-XL` contains its own hyphens, so a naive
     * split-on-hyphen would have truncated it; the rewrite is by offset.
     * Nothing was regenerated and no sequence value was consumed.
     */
    expect(
      after.map((r) => r.variantCode.slice('KZ-P-000020-'.length)),
    ).toEqual(suffixes);
  });

  it('leaves a product with no variants alone', async () => {
    const jar = await superAdminJar();
    const product = await createProduct(ctx.dataSource, {
      productCode: 'KZ-P-EMPTY1',
    });

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: 'KZ-P-EMPTY2' })
      .expect(200);

    const [row] = await ctx.dataSource.query(
      `SELECT "productCode" FROM "products" WHERE "id" = $1`,
      [product.id],
    );
    expect(row.productCode).toBe('KZ-P-EMPTY2');
  });

  it('normalises the submitted code before cascading', async () => {
    const jar = await superAdminJar();
    const { product } = await productWithThreeVariants('KZ-P-000030');

    // lower case, Persian digits and surrounding whitespace
    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: '  kz-p-۰۰۰۰۴۰  ' })
      .expect(200);

    const after = await codesOf(product.id);
    expect(after[0].productCode).toBe('KZ-P-000040');
    // The children are built from the CANONICAL parent, never the raw input.
    for (const row of after) {
      expect(row.variantCode.startsWith('KZ-P-000040-')).toBe(true);
    }
  });

  // =========================================================================
  // History is immune
  // =========================================================================

  it('leaves historical order snapshots untouched', async () => {
    const jar = await superAdminJar();
    const branch = await createBranch(ctx.dataSource);
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      { productCode: 'KZ-P-HIST01' },
      { stock: 5, price: 1_000_000, variantCode: 'KZ-P-HIST01-V000001' },
    );

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const cashier = await authenticate(ctx, username, password, 'pos');

    await withCookies(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', fixtureIdempotencyKey('cascade'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      })
      .expect(201);

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: 'KZ-P-HIST99' })
      .expect(200);

    // The catalogue moved...
    const after = await codesOf(product.id);
    expect(after[0].variantCode).toBe('KZ-P-HIST99-V000001');

    // ...and the receipt did not. This is what makes the rename safe at all.
    const [line] = await ctx.dataSource.query(
      `SELECT "productCodeSnapshot", "variantCodeSnapshot" FROM "order_items"`,
    );
    expect(line.productCodeSnapshot).toBe('KZ-P-HIST01');
    expect(line.variantCodeSnapshot).toBe('KZ-P-HIST01-V000001');
  });

  // =========================================================================
  // Atomicity
  // =========================================================================

  it('rolls the WHOLE rename back when the target product code is taken', async () => {
    const jar = await superAdminJar();
    const { product } = await productWithThreeVariants('KZ-P-000050');
    await createProduct(ctx.dataSource, { productCode: 'KZ-P-TAKEN1' });

    const before = await codesOf(product.id);

    const res = await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: 'KZ-P-TAKEN1' })
      .expect(409);

    expect(res.body.error).toBe('PRODUCT_CODE_TAKEN');
    expect(res.body.details.field).toBe('productCode');
    expect(res.body.details.productCode).toBe('KZ-P-TAKEN1');

    // NOTHING moved: not the product, and not one of the three variants.
    expect(await codesOf(product.id)).toEqual(before);
  });

  it('rolls back even when the title in the same request was valid', async () => {
    const jar = await superAdminJar();
    const { product } = await productWithThreeVariants('KZ-P-000060');
    await createProduct(ctx.dataSource, { productCode: 'KZ-P-TAKEN2' });
    const before = await codesOf(product.id);

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ title: 'یک عنوان کاملاً معتبر', productCode: 'KZ-P-TAKEN2' })
      .expect(409);

    expect(await codesOf(product.id)).toEqual(before);
    const [row] = await ctx.dataSource.query(
      `SELECT "title" FROM "products" WHERE "id" = $1`,
      [product.id],
    );
    // The valid half of the request is rolled back with the invalid half.
    expect(row.title).not.toBe('یک عنوان کاملاً معتبر');
  });

  // =========================================================================
  // Concurrency
  // =========================================================================

  it('lets exactly one of two concurrent renames onto the SAME code win', async () => {
    const jar = await superAdminJar();
    const a = await productWithThreeVariants('KZ-P-RACE0A');
    const b = await productWithThreeVariants('KZ-P-RACE0B');

    // Two in-flight requests => two independent transactions competing for one
    // product code. No shared JS state can hide a lost update here.
    const [first, second] = await Promise.all([
      withCookies(ctx, jar)
        .patch(`/products/${a.product.id}`)
        .send({ productCode: 'KZ-P-RACEWIN' }),
      withCookies(ctx, jar)
        .patch(`/products/${b.product.id}`)
        .send({ productCode: 'KZ-P-RACEWIN' }),
    ]);

    const statuses = [first.status, second.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    // Exactly one product carries the contested code...
    const [{ count }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS count FROM "products" WHERE "productCode" = $1`,
      ['KZ-P-RACEWIN'],
    );
    expect(count).toBe('1');

    // ...and NEITHER product is left half-migrated: every variant code in the
    // database still begins with its own parent's code.
    const [{ mismatches }] = await ctx.dataSource.query(
      `SELECT count(*)::text AS mismatches
         FROM "product_variants" v
         JOIN "products" p ON p."id" = v."productId"
        WHERE v."variantCode" NOT LIKE p."productCode" || '-%'`,
    );
    expect(mismatches).toBe('0');
  });

  it('serialises two concurrent renames of the SAME product without partial state', async () => {
    const jar = await superAdminJar();
    const { product } = await productWithThreeVariants('KZ-P-SERIAL0');

    const [first, second] = await Promise.all([
      withCookies(ctx, jar)
        .patch(`/products/${product.id}`)
        .send({ productCode: 'KZ-P-SERIAL1' }),
      withCookies(ctx, jar)
        .patch(`/products/${product.id}`)
        .send({ productCode: 'KZ-P-SERIAL2' }),
    ]);

    // Both are legal in isolation, so both may succeed — the row lock decides
    // the order. What must never happen is a mixed final state.
    expect([200, 409]).toContain(first.status);
    expect([200, 409]).toContain(second.status);

    const after = await codesOf(product.id);
    const parent = after[0].productCode;
    expect(['KZ-P-SERIAL1', 'KZ-P-SERIAL2']).toContain(parent);
    for (const row of after) {
      expect(row.variantCode.startsWith(`${parent}-`)).toBe(true);
    }
    // Suffixes survived whichever rename landed last.
    expect(after.map((r) => r.variantCode.slice(parent.length + 1))).toEqual([
      'V000025',
      'V000026',
      'RED-XL',
    ]);
  });

  // =========================================================================
  // The database refuses what the service would never write
  // =========================================================================

  it('cannot commit a mismatched parent/variant pair through direct SQL', async () => {
    const { product, variant } = await createProductWithVariant(
      ctx.dataSource,
      { productCode: 'KZ-P-DIRECT1' },
      { variantCode: 'KZ-P-DIRECT1-V000001' },
    );

    // 1. A variant code that does not belong to its parent.
    await expect(
      ctx.dataSource.query(
        `UPDATE "product_variants" SET "variantCode" = $2 WHERE "id" = $1`,
        [variant.id, 'TOTALLY-UNRELATED-V1'],
      ),
    ).rejects.toThrow();

    // 2. THE ORIGINAL BUG: moving the parent and leaving the children behind.
    await expect(
      ctx.dataSource.query(
        `UPDATE "products" SET "productCode" = $2 WHERE "id" = $1`,
        [product.id, 'KZ-P-DIRECT9'],
      ),
    ).rejects.toThrow();

    // 3. Inserting a child with an unrelated code.
    await expect(
      ctx.dataSource.query(
        `INSERT INTO "product_variants"
           ("price","stock","sku","productId","isActive","isDefault","variantCode")
         VALUES (1, 1, $1, $2, true, false, $3)`,
        ['SKU-DIRECT-X', product.id, 'NOPE-V1'],
      ),
    ).rejects.toThrow();

    // 4. ...but parent AND children together in ONE transaction is legal. This
    //    is why the trigger is DEFERRABLE: the correct operation must remain
    //    possible, or the constraint gets dropped instead of obeyed.
    await ctx.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE "products" SET "productCode" = $2 WHERE "id" = $1`,
        [product.id, 'KZ-P-DIRECT9'],
      );
      await manager.query(
        `UPDATE "product_variants" SET "variantCode" = $2 WHERE "id" = $1`,
        [variant.id, 'KZ-P-DIRECT9-V000001'],
      );
    });

    const after = await codesOf(product.id);
    expect(after[0].productCode).toBe('KZ-P-DIRECT9');
    expect(after[0].variantCode).toBe('KZ-P-DIRECT9-V000001');
  });

  // =========================================================================
  // Everything else is unaffected
  // =========================================================================

  it('leaves codes alone for ordinary title, price and visibility edits', async () => {
    const jar = await superAdminJar();
    const branch = await createBranch(ctx.dataSource);
    const { product } = await productWithThreeVariants('KZ-P-QUIET01');
    const before = await codesOf(product.id);

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ title: 'عنوان تازه', basePrice: 4_200_000 })
      .expect(200);

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({
        visibleOnSite: true,
        branchVisibility: 'selected',
        branchIds: [branch.id],
      })
      .expect(200);

    expect(await codesOf(product.id)).toEqual(before);

    // ...and the edits themselves landed.
    const [row] = await ctx.dataSource.query(
      `SELECT "title", "visibleOnSite", "branchVisibility"::text AS mode
         FROM "products" WHERE "id" = $1`,
      [product.id],
    );
    expect(row.title).toBe('عنوان تازه');
    expect(row.visibleOnSite).toBe(true);
    expect(row.mode).toBe('selected');
  });

  it('records one audit entry naming both codes and every affected variant', async () => {
    const jar = await superAdminJar();
    const { product } = await productWithThreeVariants('KZ-P-AUDIT01');

    await withCookies(ctx, jar)
      .patch(`/products/${product.id}`)
      .send({ productCode: 'KZ-P-AUDIT02' })
      .expect(200);

    const [entry] = await ctx.dataSource.query(
      `SELECT "summary" FROM "admin_audit_log"
        WHERE "action" = 'product.code_changed'
        ORDER BY "id" DESC LIMIT 1`,
    );

    expect(entry.summary.before.productCode).toBe('KZ-P-AUDIT01');
    expect(entry.summary.after.productCode).toBe('KZ-P-AUDIT02');
    expect(entry.summary.variants).toHaveLength(3);
    expect(entry.summary.variants[0].before).toBe('KZ-P-AUDIT01-V000025');
    expect(entry.summary.variants[0].after).toBe('KZ-P-AUDIT02-V000025');
    expect(typeof entry.summary.variants[0].variantId).toBe('number');

    /*
     * The codes must NOT be redacted. `product.code_changed` exists to record
     * which code became which, and the credential heuristic in `redact()`
     * matches `code` as a substring — so this asserts the narrow exact-match
     * exemption is working rather than assuming it.
     */
    expect(JSON.stringify(entry.summary)).not.toContain('[redacted]');
  });
});
