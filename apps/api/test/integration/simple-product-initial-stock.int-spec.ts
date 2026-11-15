import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { InventoryService } from 'src/modules/inventory/inventory.service';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { resetDb } from './setup/test-db';
import {
  createBranch,
  createCategory,
  createUser,
  seedRoles,
} from './setup/seed-helpers';
import { fixtureIdempotencyKey, uniqueSuffix } from './setup/fixture-ids';

/**
 * ============================================================================
 * A SIMPLE PRODUCT, STOCKED AND SELLABLE FROM ONE SAVE.
 *
 * THE WORKFLOW THIS REPLACES. Creating a product that has no options used to
 * take five steps: create → save → reopen → find the default variant → adjust
 * stock. The default variant was always born at zero and nothing in the create
 * request could say otherwise.
 *
 * WHAT MUST NOT BE TRUE OF THE FIX. The obvious shortcut — writing
 * `stock: 10` onto the variant INSERT — would create units with NO LEDGER
 * EVIDENCE: the physical count would say ten and `stock_movements` would say
 * nothing ever arrived, so every later reconciliation would be off by the
 * opening balance. Several tests below exist only to prove that did not
 * happen: the movement is real, it is exactly one, it carries the actor, and
 * a failure anywhere rolls the whole thing back.
 *
 * The quantity is GLOBAL. Two branches carrying the product draw down one
 * number; branch visibility decides WHERE a product may be sold, never HOW
 * MANY each place has.
 * ============================================================================
 */
describe('simple product initial stock (int)', () => {
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

  async function superAdminJar(): Promise<CookieJar> {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return authenticate(ctx, username, password, 'admin');
  }

  async function roleWith(
    admin: CookieJar,
    permissions: string[],
  ): Promise<number> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const response = await withCookies(ctx, admin)
      .post('/admin/access/roles')
      .send({ name: `role_${suffix}`, titleFa: 'نقش آزمایشی', permissions });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  async function staffHolding(
    admin: CookieJar,
    permissions: string[],
  ): Promise<CookieJar> {
    const roleId = await roleWith(admin, permissions);
    const created = await createUser(ctx.dataSource, { roles: [] });
    const assign = await withCookies(ctx, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [roleId] });
    expect(assign.status).toBe(200);
    return authenticate(ctx, created.username, created.password, 'admin');
  }

  /**
   * The purchase price (integer Rial per unit) every positive opening quantity
   * must carry since docs/PURCHASE-COST-ACCOUNTING.md §6. Sent explicitly by
   * each case that opens stock, never defaulted by the helper.
   */
  const UNIT_COST = 1_200_000;

  interface CreateOptions {
    initialStock?: number;
    purchasePrice?: number | string;
    variants?: unknown[];
    visibleOnSite?: boolean;
    branchVisibility?: 'none' | 'all' | 'selected';
    branchIds?: number[];
  }

  async function createSimple(
    jar: CookieJar,
    code: string,
    options: CreateOptions = {},
  ) {
    const category = await createCategory(ctx.dataSource);
    const { initialStock, variants, ...visibility } = options;
    return withCookies(ctx, jar)
      .post('/products')
      .send({
        title: `کالای ساده ${code}`,
        description: 'یک کالای بدون گونه',
        basePrice: 2_500_000,
        categoryIds: [category.id],
        productCode: code,
        ...(initialStock !== undefined ? { initialStock } : {}),
        ...(variants !== undefined ? { variants } : {}),
        ...visibility,
      });
  }

  const variantsOf = async (productId: number) =>
    await ctx.dataSource.query(
      `SELECT "id", "sku", "variantCode", "stock", "isDefault", "isActive"
         FROM "product_variants" WHERE "productId" = $1 ORDER BY "id"`,
      [productId],
    );

  const movementsOf = async (variantId: number) =>
    await ctx.dataSource.query(
      `SELECT "id", "delta", "balanceAfter", "reason", "reasonText",
              "actorUserId", "actorDisplaySnapshot", "branchId", "orderId"
         FROM "stock_movements" WHERE "variantId" = $1 ORDER BY "id"`,
      [variantId],
    );

  // =========================================================================
  // 1. One save produces a stocked, sellable product
  // =========================================================================

  describe('creating with an opening quantity', () => {
    it('creates exactly one default variant holding the stock', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0001', {
        initialStock: 10,
        purchasePrice: UNIT_COST,
      });
      expect([200, 201]).toContain(response.status);
      const productId = Number(response.body.data.id);

      const variants = await variantsOf(productId);
      expect(variants).toHaveLength(1);
      expect(variants[0].isDefault).toBe(true);
      expect(variants[0].isActive).toBe(true);
      expect(variants[0].stock).toBe(10);
      // Its SKU and variant code are generated, not demanded from the caller.
      expect(variants[0].sku).toMatch(/^DEFAULT-P\d+/);
      expect(variants[0].variantCode).toMatch(/^KZ-P-SIMP0001-/);
    });

    /**
     * THE LEDGER EVIDENCE. Units that exist without a movement are units the
     * ledger cannot account for, and every later reconciliation inherits the
     * discrepancy.
     */
    it('writes exactly one initial_stock movement, with delta and balance', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0002', {
        initialStock: 10,
        purchasePrice: UNIT_COST,
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const movements = await movementsOf(variant.id);
      expect(movements).toHaveLength(1);
      expect(movements[0].reason).toBe('initial_stock');
      expect(movements[0].delta).toBe(10);
      expect(movements[0].balanceAfter).toBe(10);
      // Not an order, not a branch act.
      expect(movements[0].orderId).toBeNull();
      expect(movements[0].branchId).toBeNull();
      // No human sentence: nobody typed one, the act is the explanation.
      expect(movements[0].reasonText).toBeNull();

      // ...and the units arrived VALUED at the stated purchase price.
      const [evidence] = await ctx.dataSource.query(
        `SELECT "unitCost"::text AS "unitCost", "costDelta"::text AS "costDelta"
           FROM "stock_movements" WHERE "id" = $1`,
        [movements[0].id],
      );
      expect(evidence).toEqual({
        unitCost: String(UNIT_COST),
        costDelta: String(10 * UNIT_COST),
      });
      const [pool] = await ctx.dataSource.query(
        `SELECT "unvaluedQuantity", "inventoryCostValue"::text AS value
           FROM "product_variants" WHERE "id" = $1`,
        [variant.id],
      );
      expect(pool).toEqual({
        unvaluedQuantity: 0,
        value: String(10 * UNIT_COST),
      });
    });

    it('records who created it', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0003', {
        initialStock: 4,
        purchasePrice: UNIT_COST,
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);
      const [movement] = await movementsOf(variant.id);

      expect(movement.actorUserId).toEqual(expect.any(Number));
      expect(typeof movement.actorDisplaySnapshot).toBe('string');
      expect(movement.actorDisplaySnapshot!.length).toBeGreaterThan(0);
    });

    /**
     * Zero is not "a movement of zero". `delta` is documented as never zero,
     * and a row saying nothing happened is worse than no row.
     */
    it('creates NO movement at all for initialStock 0', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0004', {
        initialStock: 0,
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      expect(variant.stock).toBe(0);
      expect(await movementsOf(variant.id)).toEqual([]);
    });

    it('omitting initialStock behaves exactly like zero', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0005');
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      expect(variant.stock).toBe(0);
      expect(await movementsOf(variant.id)).toEqual([]);
    });
  });

  // =========================================================================
  // 2. Refusals
  // =========================================================================

  describe('refusals', () => {
    it.each([
      ['negative', -1],
      ['fractional', 1.5],
      ['excessive', 9_999_999_999],
    ])('refuses a %s quantity with 400', async (_label, value) => {
      const jar = await superAdminJar();
      const response = await createSimple(
        jar,
        `KZ-P-BAD${uniqueSuffix().slice(0, 4).toUpperCase()}`,
        {
          initialStock: value,
        },
      );
      expect(response.status).toBe(400);
    });

    /**
     * With explicit variants there is no single quantity to mean — each one
     * already carries its own `stock` — so guessing would put units on the
     * wrong SKU.
     */
    it('refuses initialStock alongside explicit variants', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0006', {
        initialStock: 5,
        variants: [
          {
            price: 1_000_000,
            stock: 1,
            purchasePrice: UNIT_COST,
            sku: `SKU-${uniqueSuffix()}`,
            variantCode: 'KZ-P-SIMP0006-V1',
            attributeValueIds: [],
          },
        ],
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INITIAL_STOCK_WITH_VARIANTS');
      expect(response.body.details.field).toBe('initialStock');
      // Persian, because FormError renders it verbatim.
      expect(response.body.message).toMatch(/[؀-ۿ]/);
    });

    it('nothing is written when the request is refused', async () => {
      const jar = await superAdminJar();
      await createSimple(jar, 'KZ-P-SIMP0007', {
        initialStock: 5,
        variants: [
          {
            price: 1_000_000,
            stock: 1,
            purchasePrice: UNIT_COST,
            sku: `SKU-${uniqueSuffix()}`,
            variantCode: 'KZ-P-SIMP0007-V1',
            attributeValueIds: [],
          },
        ],
      });
      const products = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "products" WHERE "productCode" = 'KZ-P-SIMP0007'`,
      );
      expect(products[0].n).toBe(0);
    });
  });

  // =========================================================================
  // 3. Authorization — enforced in the service, not just the route
  // =========================================================================

  describe('authorization', () => {
    /*
     * Opening stock now carries a purchase cost, and cost is super_admin-only
     * BY ROLE (docs/PURCHASE-COST-ACCOUNTING.md §8, owner decision B-2): no
     * delegable permission grants it. So a delegated admin — even one holding
     * products.create AND inventory.adjust — cannot open stock at all: without
     * a price the quantity is refused for want of one, and with a price the
     * price itself is refused. Zero stock still works for them.
     */
    const COST_FREE_EDITOR = [
      'admin.access',
      'products.read',
      'products.create',
    ];
    const DELEGATED_STOCKER = [...COST_FREE_EDITOR, 'inventory.adjust'];

    const productCount = async (code: string): Promise<number> => {
      const rows = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "products" WHERE "productCode" = $1`,
        [code],
      );
      return rows[0].n;
    };

    it('refuses a delegated admin (products.create + inventory.adjust) a positive quantity without a price: 400 INITIAL_STOCK_REQUIRES_PURCHASE_COST', async () => {
      const admin = await superAdminJar();
      const stocker = await staffHolding(admin, DELEGATED_STOCKER);

      const response = await createSimple(stocker, 'KZ-P-SIMP0008', {
        initialStock: 3,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INITIAL_STOCK_REQUIRES_PURCHASE_COST');
      expect(await productCount('KZ-P-SIMP0008')).toBe(0);
    });

    it('refuses a delegated admin (products.create + inventory.adjust) a positive quantity WITH a price: 403 PURCHASE_COST_FORBIDDEN', async () => {
      const admin = await superAdminJar();
      const stocker = await staffHolding(admin, DELEGATED_STOCKER);

      const response = await createSimple(stocker, 'KZ-P-SIMP0010', {
        initialStock: 7,
        purchasePrice: UNIT_COST,
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PURCHASE_COST_FORBIDDEN');
      expect(await productCount('KZ-P-SIMP0010')).toBe(0);
      const movements = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "stock_movements" WHERE "reason" = 'initial_stock'`,
      );
      expect(movements[0].n).toBe(0);
    });

    it('refuses that delegated admin a purchase price even with zero stock', async () => {
      const admin = await superAdminJar();
      const stocker = await staffHolding(admin, DELEGATED_STOCKER);

      const response = await createSimple(stocker, 'KZ-P-SIMP0023', {
        initialStock: 0,
        purchasePrice: UNIT_COST,
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PURCHASE_COST_FORBIDDEN');
      expect(await productCount('KZ-P-SIMP0023')).toBe(0);
    });

    it.each([
      ['products.create only', COST_FREE_EDITOR, 'KZ-P-SIMP0009'],
      [
        'products.create + inventory.adjust',
        DELEGATED_STOCKER,
        'KZ-P-SIMP0024',
      ],
    ])(
      'still lets a delegated admin (%s) create with zero stock',
      async (_label, permissions, code) => {
        const admin = await superAdminJar();
        const editor = await staffHolding(admin, permissions);

        const response = await createSimple(editor, code, {
          initialStock: 0,
        });
        expect([200, 201]).toContain(response.status);

        const [variant] = await variantsOf(Number(response.body.data.id));
        expect(variant.stock).toBe(0);
        expect(await movementsOf(variant.id)).toEqual([]);
      },
    );

    it('super_admin opens stock with a purchase price', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0011', {
        initialStock: 12,
        purchasePrice: UNIT_COST,
      });
      expect([200, 201]).toContain(response.status);

      const [variant] = await variantsOf(Number(response.body.data.id));
      expect(variant.stock).toBe(12);
      expect(await movementsOf(variant.id)).toHaveLength(1);
    });

    it('super_admin must still state the price: 400 INITIAL_STOCK_REQUIRES_PURCHASE_COST without one', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0025', {
        initialStock: 12,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INITIAL_STOCK_REQUIRES_PURCHASE_COST');
      expect(await productCount('KZ-P-SIMP0025')).toBe(0);
    });
  });

  // =========================================================================
  // 4. Atomicity
  // =========================================================================

  /**
   * The movement is written inside the create transaction, so a failure there
   * must take the product, its variant, its categories and its visibility with
   * it. Otherwise a product could exist holding stock the ledger cannot
   * account for — the exact condition this design exists to prevent.
   */
  it('rolls back the product, variant and attachments if the movement fails', async () => {
    const jar = await superAdminJar();
    const inventory = ctx.app.get(InventoryService);
    const original = inventory.recordInitialStock.bind(inventory);
    (
      inventory as unknown as { recordInitialStock: unknown }
    ).recordInitialStock = () =>
      Promise.reject(new Error('injected: ledger write failed'));

    let response;
    try {
      response = await createSimple(jar, 'KZ-P-SIMP0012', {
        initialStock: 9,
        purchasePrice: UNIT_COST,
      });
    } finally {
      (
        inventory as unknown as { recordInitialStock: unknown }
      ).recordInitialStock = original;
    }

    expect(response.status).toBeGreaterThanOrEqual(500);

    for (const [table, where] of [
      ['products', `"productCode" = 'KZ-P-SIMP0012'`],
      ['product_variants', `"variantCode" LIKE 'KZ-P-SIMP0012-%'`],
    ] as const) {
      const rows = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`,
      );
      expect(rows[0].n).toBe(0);
    }
    const movements = await ctx.dataSource.query(
      `SELECT count(*)::int AS n FROM "stock_movements" WHERE "reason" = 'initial_stock'`,
    );
    expect(movements[0].n).toBe(0);
  });

  // =========================================================================
  // 5. Immediately sellable
  // =========================================================================

  describe('immediately sellable after one save', () => {
    it('the storefront reports it in stock straight away', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0013', {
        initialStock: 10,
        purchasePrice: UNIT_COST,
        visibleOnSite: true,
        branchVisibility: 'all',
      });
      const productId = Number(response.body.data.id);

      /*
       * NO REOPEN, NO ADJUST. The very next storefront read already sees the
       * stock — which is the whole point of the change, and the step the old
       * five-step workflow forced an operator to take by hand.
       *
       * Asserted on the LIST card (`inStock`) and on the DETAIL document's
       * variant availability, because those are the two places a customer's
       * browser actually learns whether it can buy.
       */
      const list = await withCookies(ctx, jar)
        .get('/products')
        .query({ inStockOnly: 'true', limit: 100 });
      expect(list.status).toBe(200);
      expect(
        (list.body.data as Array<{ id: number; inStock: boolean }>)
          .filter((p) => Number(p.id) === productId)
          .map((p) => p.inStock),
      ).toEqual([true]);

      const detail = await withCookies(ctx, jar).get(`/products/${productId}`);
      expect(detail.status).toBe(200);
      const variants = detail.body.data.variants as Array<{
        availability?: { inStock: boolean };
      }>;
      expect(variants).toHaveLength(1);
      expect(variants[0].availability?.inStock).toBe(true);
    });

    it('a selected POS branch can sell it with no variant-selection step', async () => {
      const jar = await superAdminJar();
      const branch = await createBranch(ctx.dataSource);
      const response = await createSimple(jar, 'KZ-P-SIMP0014', {
        initialStock: 10,
        purchasePrice: UNIT_COST,
        visibleOnSite: true,
        branchVisibility: 'selected',
        branchIds: [branch.id],
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const { username, password } = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const cashier = await authenticate(ctx, username, password, 'pos');

      // It is on the till grid.
      const catalog = await withCookies(ctx, cashier)
        .get('/inventory/catalog')
        .query({ limit: 100 });
      expect(catalog.status).toBe(200);
      expect(
        (catalog.body.data as Array<{ id: number }>).map((p) => Number(p.id)),
      ).toContain(productId);

      // And it sells, addressed by the default variant id.
      const sale = await withCookies(ctx, cashier)
        .post('/orders/pos')
        .set('Idempotency-Key', fixtureIdempotencyKey('simp14'))
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 1 }],
        });
      expect([200, 201]).toContain(sale.status);

      const after = await variantsOf(productId);
      expect(after[0].stock).toBe(9);

      // The sale is its own ledger row; the opening balance is untouched.
      const movements = await movementsOf(variant.id);
      expect(movements.map((m) => m.reason)).toEqual([
        'initial_stock',
        'pos_sale',
      ]);
      expect(movements[1].delta).toBe(-1);
      expect(movements[1].balanceAfter).toBe(9);
    });

    it('a non-selected branch can neither see nor sell it', async () => {
      const jar = await superAdminJar();
      const selected = await createBranch(ctx.dataSource);
      const other = await createBranch(ctx.dataSource);
      const response = await createSimple(jar, 'KZ-P-SIMP0015', {
        initialStock: 10,
        purchasePrice: UNIT_COST,
        visibleOnSite: true,
        branchVisibility: 'selected',
        branchIds: [selected.id],
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const { username, password } = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: other.id,
      });
      const cashier = await authenticate(ctx, username, password, 'pos');

      const catalog = await withCookies(ctx, cashier)
        .get('/inventory/catalog')
        .query({ limit: 100 });
      expect(
        (catalog.body.data as Array<{ id: number }>).map((p) => Number(p.id)),
      ).not.toContain(productId);

      const sale = await withCookies(ctx, cashier)
        .post('/orders/pos')
        .set('Idempotency-Key', fixtureIdempotencyKey('simp15'))
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 1 }],
        });
      expect(sale.status).toBe(409);
      expect(sale.body.error).toBe('PRODUCT_NOT_AVAILABLE_IN_BRANCH');

      // Nothing moved.
      expect((await variantsOf(productId))[0].stock).toBe(10);
    });

    /**
     * The quantity is one global number. Two branches both carrying the
     * product draw it down together — this is the assertion that the opening
     * quantity was not misread as "ten per branch".
     */
    it('two branches share ONE quantity, not one each', async () => {
      const jar = await superAdminJar();
      const first = await createBranch(ctx.dataSource);
      const second = await createBranch(ctx.dataSource);
      const response = await createSimple(jar, 'KZ-P-SIMP0016', {
        initialStock: 2,
        purchasePrice: UNIT_COST,
        branchVisibility: 'selected',
        branchIds: [first.id, second.id],
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      for (const [index, branch] of [first, second].entries()) {
        const { username, password } = await createUser(ctx.dataSource, {
          roles: [UserRoleEnum.sale],
          branchId: branch.id,
        });
        const cashier = await authenticate(ctx, username, password, 'pos');
        const sale = await withCookies(ctx, cashier)
          .post('/orders/pos')
          .set('Idempotency-Key', fixtureIdempotencyKey(`simp16-${index}`))
          .send({
            paymentMethod: PaymentMethodEnum.CASH,
            items: [{ productVariantId: variant.id, quantity: 1 }],
          });
        expect([200, 201]).toContain(sale.status);
      }

      // 2 - 1 - 1 = 0, not 2 - 1 = 1 twice.
      expect((await variantsOf(productId))[0].stock).toBe(0);
    });
  });

  // =========================================================================
  // 6. The default variant is an ordinary variant to the inventory rules
  // =========================================================================

  describe('inventory invariants hold for the default variant', () => {
    it('concurrent sales of the final unit cannot drive stock negative', async () => {
      const jar = await superAdminJar();
      const branch = await createBranch(ctx.dataSource);
      const response = await createSimple(jar, 'KZ-P-SIMP0017', {
        initialStock: 1,
        purchasePrice: UNIT_COST,
        branchVisibility: 'all',
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const cashiers: CookieJar[] = [];
      for (let i = 0; i < 4; i++) {
        const { username, password } = await createUser(ctx.dataSource, {
          roles: [UserRoleEnum.sale],
          branchId: branch.id,
        });
        cashiers.push(await authenticate(ctx, username, password, 'pos'));
      }

      const results = await Promise.all(
        cashiers.map((cashier, index) =>
          withCookies(ctx, cashier)
            .post('/orders/pos')
            .set('Idempotency-Key', fixtureIdempotencyKey(`simp17-${index}`))
            .send({
              paymentMethod: PaymentMethodEnum.CASH,
              items: [{ productVariantId: variant.id, quantity: 1 }],
            }),
        ),
      );

      const sold = results.filter((r) => r.status === 200 || r.status === 201);
      expect(sold).toHaveLength(1);

      const after = await variantsOf(productId);
      expect(after[0].stock).toBe(0);
      expect(after[0].stock).toBeGreaterThanOrEqual(0);
    });

    it('a basket reservation holds units of the default variant', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0018', {
        initialStock: 3,
        purchasePrice: UNIT_COST,
        visibleOnSite: true,
        branchVisibility: 'all',
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const { username, password } = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const shopper = await authenticate(ctx, username, password, 'storefront');

      const added = await withCookies(ctx, shopper)
        .post('/cart')
        .send({ productId, variantId: variant.id, quantity: 2 });
      expect([200, 201]).toContain(added.status);

      const reserved = await ctx.dataSource.query(
        `SELECT COALESCE(sum("quantity"), 0)::int AS held
           FROM "stock_reservations"
          WHERE "variantId" = $1 AND "status" = 'active'`,
        [variant.id],
      );
      expect(reserved[0].held).toBe(2);
      // Physical stock is untouched by a hold.
      expect((await variantsOf(productId))[0].stock).toBe(3);
    });

    it('a POS sale displaces a basket hold on the default variant', async () => {
      const jar = await superAdminJar();
      const branch = await createBranch(ctx.dataSource);
      const response = await createSimple(jar, 'KZ-P-SIMP0019', {
        initialStock: 1,
        purchasePrice: UNIT_COST,
        visibleOnSite: true,
        branchVisibility: 'all',
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const shopperUser = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const shopper = await authenticate(
        ctx,
        shopperUser.username,
        shopperUser.password,
        'storefront',
      );
      await withCookies(ctx, shopper)
        .post('/cart')
        .send({ productId, variantId: variant.id, quantity: 1 })
        .expect((r) => expect([200, 201]).toContain(r.status));

      const cashierUser = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: branch.id,
      });
      const cashier = await authenticate(
        ctx,
        cashierUser.username,
        cashierUser.password,
        'pos',
      );

      // The till wins the last unit: a customer holding it in a basket has not
      // paid, and somebody is standing at the counter.
      const sale = await withCookies(ctx, cashier)
        .post('/orders/pos')
        .set('Idempotency-Key', fixtureIdempotencyKey('simp19'))
        .send({
          paymentMethod: PaymentMethodEnum.CASH,
          items: [{ productVariantId: variant.id, quantity: 1 }],
        });
      expect([200, 201]).toContain(sale.status);
      expect((await variantsOf(productId))[0].stock).toBe(0);
    });
  });

  // =========================================================================
  // 7. Stock cannot be changed by editing the product
  // =========================================================================

  describe('PATCH cannot move stock', () => {
    it('refuses initialStock on PATCH', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0020', {
        initialStock: 5,
        purchasePrice: UNIT_COST,
      });
      const productId = Number(response.body.data.id);

      const patched = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ initialStock: 99 });
      expect(patched.status).toBe(400);

      expect((await variantsOf(productId))[0].stock).toBe(5);
    });

    it('refuses purchasePrice on PATCH, leaving the valuation untouched', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0026', {
        initialStock: 5,
        purchasePrice: UNIT_COST,
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const patched = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ purchasePrice: 1 });
      expect(patched.status).toBe(400);

      const [pool] = await ctx.dataSource.query(
        `SELECT "stock", "inventoryCostValue"::text AS value
           FROM "product_variants" WHERE "id" = $1`,
        [variant.id],
      );
      expect(pool).toEqual({ stock: 5, value: String(5 * UNIT_COST) });
      expect(await movementsOf(variant.id)).toHaveLength(1);
    });

    it('an ordinary edit leaves stock and the ledger untouched', async () => {
      const jar = await superAdminJar();
      const response = await createSimple(jar, 'KZ-P-SIMP0021', {
        initialStock: 5,
        purchasePrice: UNIT_COST,
      });
      const productId = Number(response.body.data.id);
      const [variant] = await variantsOf(productId);

      const patched = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ title: 'نام تازه', basePrice: 3_000_000 });
      expect(patched.status).toBe(200);

      expect((await variantsOf(productId))[0].stock).toBe(5);
      expect(await movementsOf(variant.id)).toHaveLength(1);
    });
  });

  // =========================================================================
  // 8. Receipts
  // =========================================================================

  it('a receipt carries the product and default-variant code snapshots', async () => {
    const jar = await superAdminJar();
    const branch = await createBranch(ctx.dataSource);
    const response = await createSimple(jar, 'KZ-P-SIMP0022', {
      initialStock: 5,
      purchasePrice: UNIT_COST,
      branchVisibility: 'all',
    });
    const productId = Number(response.body.data.id);
    const [variant] = await variantsOf(productId);

    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const cashier = await authenticate(ctx, username, password, 'pos');

    const sale = await withCookies(ctx, cashier)
      .post('/orders/pos')
      .set('Idempotency-Key', fixtureIdempotencyKey('simp22'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect([200, 201]).toContain(sale.status);

    const lines = await ctx.dataSource.query(
      `SELECT "productCodeSnapshot", "variantCodeSnapshot"
         FROM "order_items" WHERE "variantId" = $1`,
      [variant.id],
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].productCodeSnapshot).toBe('KZ-P-SIMP0022');
    expect(lines[0].variantCodeSnapshot).toBe(variant.variantCode);
  });
});
