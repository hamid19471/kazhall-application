import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';

import { Address } from 'src/modules/address/entities/address.entity';
import { Role } from 'src/modules/auth/entities/role.entity';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import {
  CartItem,
  CartItemStatus,
} from 'src/modules/cart/entities/cart-item.entity';
import { Category } from 'src/modules/categories/entities/category.entity';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import {
  OrderAction,
  OrderActionType,
} from 'src/modules/orders/entities/order-action.entity';
import { OrderItems } from 'src/modules/orders/entities/order-item.entity';
import { Order } from 'src/modules/orders/entities/order.entity';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderReconciliationState } from 'src/modules/orders/enums/reconciliation-state.enum';
import {
  PaymentAction,
  PaymentActionType,
} from 'src/modules/payment/entities/payment-action.entity';
import { Payment } from 'src/modules/payment/entities/payment.entity';
import {
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from 'src/modules/payment/enums/payment-status-enum';
import { ProductAttributeValue } from 'src/modules/products/entities/product-attribute-value.entity';
import { ProductAttribute } from 'src/modules/products/entities/product-attribute.entity';
import { ProductBranchVisibility } from 'src/modules/products/entities/product-branch-visibility.entity';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { Product } from 'src/modules/products/entities/product.entity';
import { User } from 'src/modules/user/entities/user.entity';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  DEV_PASSWORD,
  SEED_ATTRIBUTES,
  SEED_BRANCHES,
  SEED_BRANCH_MAIN,
  SEED_BRANCH_SECONDARY,
  SEED_CATEGORIES,
  SEED_PRODUCTS,
  SEED_USERS,
  type SeedProductSpec,
} from './dev-seed.data';
import { SeedClock } from './dev-seed.time';

/**
 * The development / review seeder.
 *
 * WHAT MAKES IT SAFE TO RE-RUN. Every object is addressed by a NATURAL KEY —
 * role name, branch name, username, category title, attribute name, SKU,
 * order number — and the seeder asks the database for that key before it
 * writes. Nothing is keyed on an auto-increment id and nothing is keyed on a
 * timestamp, so a second run finds everything and creates nothing.
 *
 * WHAT IT DELIBERATELY DOES NOT RE-DO. Two classes of row are created once and
 * then left alone for the rest of the database's life:
 *
 *  - `product_variants.stock` is written only when the variant is CREATED.
 *    Re-running must not reset stock, because seeded sales have since drawn it
 *    down and `stock_movements.balanceAfter` records those draws. Resetting the
 *    column would leave the ledger describing a history that no longer adds up.
 *  - An order whose `orderNumber` already exists is skipped WHOLE — items,
 *    payment and stock consumption included. Re-running a sale would consume
 *    stock a second time for a sale that only happened once.
 *
 * WHAT IT DOES RE-DO. Catalogue FACTS — price, active/default flags,
 * `productCode`, `variantCode` and the two channel-visibility columns with
 * their branch rows — are rewritten on every run, because `dev-seed.data.ts` is
 * their source of truth and a re-run is how a corrected data file reaches an
 * already-seeded database. The business codes are hand-written literals there
 * and the code generator is NEVER called: `nextval` advances per call, so a
 * generated code would differ between runs and break the match-by-natural-key
 * that makes the seeder idempotent.
 *
 * WHAT IT NEVER DOES. It never writes a plaintext password to a column, never
 * fabricates an OTP or weakens the OTP path, never contacts a payment gateway,
 * and never bypasses a constraint or a trigger. Stock is moved exclusively
 * through the real `InventoryService`, so basket reservations, POS
 * displacement, order allocation and the append-only movement ledger all behave
 * exactly as they do in the application.
 */
export interface DevSeedCounts {
  roles: number;
  branches: number;
  users: number;
  categories: number;
  attributes: number;
  attributeValues: number;
  products: number;
  variants: number;
  /** `product_branch_visibility` rows — present only for `selected` products. */
  branchVisibilityRows: number;
  addresses: number;
  cartItems: number;
  reservations: number;
  orders: number;
  orderItems: number;
  payments: number;
  paymentActions: number;
  orderActions: number;
  stockMovements: number;
}

export interface DevSeedReport {
  counts: DevSeedCounts;
  created: Record<string, number>;
  notes: string[];
}

interface Ctx {
  em: EntityManager;
  inventory: InventoryService;
  clock: SeedClock;
  realNow: Date;
  created: Record<string, number>;
  notes: string[];
  branchIds: Map<string, number>;
  userIds: Map<string, number>;
  categoryIds: Map<string, number>;
  /** `"attr::value"` -> id */
  attrValueIds: Map<string, number>;
  /** SKU -> { variantId, productId, price } */
  variants: Map<
    string,
    { variantId: number; productId: number; price: number }
  >;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Writes a real SQL NULL into a column whose entity property is typed `number`.
 *
 * `users.branchId`, `products.basePrice` and `product_variants.price` are all
 * `nullable: true` columns declared as plain `number` on their entities, so the
 * type says a value is always present where the schema says it need not be.
 * That mismatch is pre-existing and not this seeder's to fix; the cast is
 * confined to this one helper so it is reviewable in a single place rather than
 * sprinkled through the file.
 */
const nullableNumber = (value: number | null): number =>
  value as unknown as number;

export class DevSeedService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly timeZone: string,
  ) {}

  async seed(): Promise<DevSeedReport> {
    const realNow = new Date();
    const ctx: Ctx = {
      em: this.dataSource.manager,
      inventory: new InventoryService(),
      clock: new SeedClock(realNow, this.timeZone),
      realNow,
      created: {},
      notes: [],
      branchIds: new Map(),
      userIds: new Map(),
      categoryIds: new Map(),
      attrValueIds: new Map(),
      variants: new Map(),
    };

    /*
     * Catalogue and identity go in one transaction: they are pure upserts and
     * either all of them are present or the run failed.
     */
    await this.dataSource.transaction(async (em) => {
      const scoped: Ctx = { ...ctx, em };
      await this.seedRoles(scoped);
      await this.seedBranches(scoped);
      await this.seedUsers(scoped);
      await this.seedCategories(scoped);
      await this.seedAttributes(scoped);
      await this.seedProducts(scoped);
      await this.seedAddresses(scoped);
    });

    /*
     * Movement-bearing work runs one unit at a time, each in its OWN
     * transaction. InventoryService documents that it never opens a transaction
     * and must be handed the caller's manager; giving each sale its own keeps
     * the lock order it declares (orders -> variants -> reservations ->
     * cart_items) scoped to a single sale, exactly as the live code does, and
     * stops one impossible line from rolling back an otherwise good dataset.
     */
    await this.seedOrders(ctx);
    await this.seedCartsAndReservations(ctx);
    await this.seedDisplacementSale(ctx);

    return {
      counts: await this.countAll(this.dataSource.manager),
      created: ctx.created,
      notes: ctx.notes,
    };
  }

  // =========================================================================
  // Identity
  // =========================================================================

  private bump(ctx: Ctx, key: string): void {
    ctx.created[key] = (ctx.created[key] ?? 0) + 1;
  }

  private async seedRoles(ctx: Ctx): Promise<void> {
    for (const name of Object.values(UserRoleEnum)) {
      const result = await ctx.em
        .createQueryBuilder()
        .insert()
        .into(Role)
        .values({ name })
        .orIgnore() // ON CONFLICT DO NOTHING against UQ roles.name
        .execute();
      if (Array.isArray(result.raw) && result.raw.length > 0) {
        this.bump(ctx, 'roles');
      }
    }
  }

  private async seedBranches(ctx: Ctx): Promise<void> {
    const repo = ctx.em.getRepository(Branch);
    for (const spec of SEED_BRANCHES) {
      let branch = await repo.findOne({ where: { name: spec.name } });
      if (!branch) {
        branch = await repo.save(repo.create(spec));
        this.bump(ctx, 'branches');
      } else if (
        branch.address !== spec.address ||
        branch.phone !== spec.phone
      ) {
        branch.address = spec.address;
        branch.phone = spec.phone;
        branch = await repo.save(branch);
      }
      ctx.branchIds.set(spec.name, branch.id);
    }
  }

  /**
   * Passwords are hashed with `bcrypt.hash(password, 10)` — the identical call
   * `UserService.create` makes, so a review account is indistinguishable from a
   * real one to the login path. The plaintext exists only as a constant in
   * `dev-seed.data.ts` and in the report this command prints.
   *
   * The hash is refreshed on every run on purpose: a reviewer who has changed a
   * password locally gets the documented one back, which is the whole point of
   * a disposable review dataset. `passwordChangedAt` is left alone so the
   * refresh does not invalidate a session mid-review.
   */
  private async seedUsers(ctx: Ctx): Promise<void> {
    const repo = ctx.em.getRepository(User);
    const roles = await ctx.em.getRepository(Role).find();
    const roleByName = new Map(roles.map((r) => [r.name, r]));

    for (const spec of SEED_USERS) {
      const role = roleByName.get(spec.role);
      if (!role)
        throw new Error(`Role ${spec.role} missing — seed roles first`);

      const existing = await repo.findOne({
        where: { username: spec.username },
        relations: { roles: true },
      });

      const branchId = spec.branch
        ? (ctx.branchIds.get(spec.branch) ?? null)
        : null;
      const row = existing ?? repo.create({ username: spec.username });

      row.mobile = spec.mobile;
      row.password = await bcrypt.hash(DEV_PASSWORD, 10);
      row.branchId = nullableNumber(branchId);
      row.roles = [role];
      row.deactivatedAt = spec.deactivated
        ? (existing?.deactivatedAt ?? ctx.realNow)
        : null;

      const saved = await repo.save(row);
      if (!existing) this.bump(ctx, 'users');
      ctx.userIds.set(spec.username, saved.id);
    }
  }

  // =========================================================================
  // Catalogue
  // =========================================================================

  private async seedCategories(ctx: Ctx): Promise<void> {
    const repo = ctx.em.getRepository(Category);
    for (const title of SEED_CATEGORIES) {
      let row = await repo.findOne({ where: { title } });
      if (!row) {
        row = await repo.save(repo.create({ title }));
        this.bump(ctx, 'categories');
      }
      ctx.categoryIds.set(title, row.id);
    }
  }

  private async seedAttributes(ctx: Ctx): Promise<void> {
    const attrRepo = ctx.em.getRepository(ProductAttribute);
    const valRepo = ctx.em.getRepository(ProductAttributeValue);

    for (const spec of SEED_ATTRIBUTES) {
      let attr = await attrRepo.findOne({ where: { name: spec.name } });
      if (!attr) {
        attr = await attrRepo.save(attrRepo.create({ name: spec.name }));
        this.bump(ctx, 'attributes');
      }
      for (const value of spec.values) {
        let row = await valRepo.findOne({
          where: { value, attribute: { id: attr.id } },
          relations: { attribute: true },
        });
        if (!row) {
          row = await valRepo.save(valRepo.create({ value, attribute: attr }));
          this.bump(ctx, 'attributeValues');
        }
        ctx.attrValueIds.set(`${spec.name}::${value}`, row.id);
      }
    }
  }

  private async seedProducts(ctx: Ctx): Promise<void> {
    const productRepo = ctx.em.getRepository(Product);
    const variantRepo = ctx.em.getRepository(ProductVariant);

    for (const spec of SEED_PRODUCTS) {
      const existingProduct = await productRepo.findOne({
        where: { title: spec.title },
        relations: { categories: true },
      });

      const categories = spec.categories.map((title) => {
        const id = ctx.categoryIds.get(title);
        if (!id)
          throw new Error(`Category "${title}" missing for ${spec.title}`);
        return { id } as Category;
      });

      const branchIds = this.resolveVisibilityBranches(ctx, spec);

      const productRow =
        existingProduct ?? productRepo.create({ title: spec.title });
      productRow.description = spec.description;
      productRow.basePrice = nullableNumber(spec.basePrice);
      productRow.categories = categories;

      /*
       * `productCode` and the two visibility columns are CATALOGUE FACTS, and a
       * re-run corrects them — exactly like `price`, `isActive` and `isDefault`
       * above, and unlike `stock` below. The distinction is not stylistic: a
       * catalogue fact is a statement this file makes about what the product IS,
       * so the file is its source of truth and the database should be brought
       * back into line with it. `stock` is a statement about what has PHYSICALLY
       * happened since, and the seeded sales and the `stock_movements` ledger
       * have moved it on; rewriting that would make the ledger describe a
       * history that no longer adds up.
       *
       * Codes are hand-written literals in `dev-seed.data.ts` and the code
       * GENERATOR is never called here — `nextval` advances per call, so a
       * generated code would differ between run 1 and run 2 and the second run
       * could not recognise the row the first one wrote.
       */
      productRow.productCode = spec.productCode;
      productRow.visibleOnSite = spec.visibleOnSite;
      productRow.branchVisibility = spec.branchVisibility;

      const product = await productRepo.save(productRow);
      if (!existingProduct) this.bump(ctx, 'products');

      await this.writeBranchVisibility(ctx, product.id, branchIds);

      for (const v of spec.variants) {
        const existingVariant = await variantRepo.findOne({
          where: { sku: v.sku },
          relations: { product: true },
        });

        const attributeValues = v.attrs.map(([name, value]) => {
          const id = ctx.attrValueIds.get(`${name}::${value}`);
          if (!id) throw new Error(`Attribute value ${name}::${value} missing`);
          return { id } as ProductAttributeValue;
        });

        const variantRow =
          existingVariant ?? variantRepo.create({ sku: v.sku });

        // Price, flags and the code are catalogue facts; a re-run corrects them.
        variantRow.variantCode = v.variantCode;
        variantRow.price = nullableNumber(v.price);
        variantRow.isActive = v.isActive;
        variantRow.isDefault = v.isDefault;
        variantRow.product = product;
        variantRow.attributeValues = attributeValues;

        // `stock` is a PHYSICAL fact, written only when the variant is first
        // created. Seeded sales have since drawn it down and
        // `stock_movements.balanceAfter` records those draws; resetting the
        // column on a re-run would leave the ledger describing a history that
        // no longer adds up.
        if (!existingVariant) variantRow.stock = v.stock;

        const variant = await variantRepo.save(variantRow);
        if (!existingVariant) this.bump(ctx, 'variants');

        ctx.variants.set(v.sku, {
          variantId: variant.id,
          productId: product.id,
          price: v.price ?? spec.basePrice ?? 0,
        });
      }
    }

    ctx.notes.push(
      'product_branch_visibility is rewritten (delete-then-insert) for every ' +
        'seeded product on every run, so the "created" column counts those ' +
        're-inserts — the resulting row SET and COUNT are identical each time.',
    );
  }

  /**
   * Turn `branchNames` into branch ids, and refuse a spec the trigger would
   * refuse anyway.
   *
   * NAMES, not ids, because ids are assigned by the database and are not stable
   * across a reset — the same reason every other collection in `dev-seed.data`
   * carries a natural key. `ctx.branchIds` was filled by `seedBranches`, which
   * runs earlier in the same transaction.
   *
   * The two impossible combinations are caught HERE as well as by the
   * deferrable constraint trigger. The trigger's refusal arrives at COMMIT and
   * names a product ID; this one arrives immediately and names the product the
   * author was looking at, which is the difference between "the seed data is
   * wrong, here" and "the transaction failed, somewhere".
   */
  private resolveVisibilityBranches(ctx: Ctx, spec: SeedProductSpec): number[] {
    const names = spec.branchNames ?? [];

    if (spec.branchVisibility !== 'selected') {
      if (names.length > 0) {
        throw new Error(
          `"${spec.title}" (${spec.productCode}) lists branches but its ` +
            `branchVisibility is "${spec.branchVisibility}". Branch rows may ` +
            `exist only under "selected"; the constraint trigger would refuse ` +
            `this at COMMIT.`,
        );
      }
      return [];
    }

    if (names.length === 0) {
      throw new Error(
        `"${spec.title}" (${spec.productCode}) has branchVisibility ` +
          `"selected" with no branchNames. "Selected branches: none" is ` +
          `indistinguishable from "none" and the constraint trigger refuses it.`,
      );
    }

    return names.map((name) => {
      const id = ctx.branchIds.get(name);
      if (!id) {
        throw new Error(
          `"${spec.title}" (${spec.productCode}) selects branch "${name}", ` +
            `which is not in SEED_BRANCHES.`,
        );
      }
      return id;
    });
  }

  /**
   * Rewrite one product's branch selection: DELETE every row, then INSERT the
   * wanted set.
   *
   * DELETE-THEN-INSERT RATHER THAN A DIFF, deliberately. The table is a pure
   * set of (productId, branchId) pairs with no state of its own worth
   * preserving — `createdAt` is audit colour — so a diff would be more code
   * that can disagree with the data file in more ways, to reach the identical
   * end state. Re-running therefore produces the same rows and the same count,
   * which is what makes the second run a no-op to an observer.
   *
   * The DELETE runs for EVERY product, including `none` and `all` ones: that is
   * how a product whose mode was narrowed or widened between runs loses rows it
   * must no longer have, rather than leaving orphaned selections that would
   * reappear if the mode were ever switched back.
   *
   * ORDER DOES NOT MATTER HERE. The product row (carrying the mode) and these
   * rows are written in the SAME transaction, and the consistency trigger is
   * DEFERRABLE INITIALLY DEFERRED — it fires at COMMIT, by which point the mode
   * and the rows agree. Writing them in two transactions would be checked
   * twice, and the intermediate state is invalid whichever order is chosen.
   */
  private async writeBranchVisibility(
    ctx: Ctx,
    productId: number,
    branchIds: number[],
  ): Promise<void> {
    const repo = ctx.em.getRepository(ProductBranchVisibility);

    await repo.delete({ productId });

    if (branchIds.length === 0) return;

    await repo.insert(branchIds.map((branchId) => ({ productId, branchId })));
    ctx.created.branchVisibilityRows =
      (ctx.created.branchVisibilityRows ?? 0) + branchIds.length;
  }

  // =========================================================================
  // Addresses
  // =========================================================================

  /**
   * `addresses` has `province`, `city`, `address`, `postal_code` and
   * `reciver_mobile` (the column's spelling is the schema's, not a typo here).
   * There is NO recipient-name column and NO default-address flag, so the
   * recipient's name is carried inside the free-text `address` line — which is
   * where a courier would read it anyway — and "default" cannot be expressed.
   * Natural key: (userId, postal_code).
   */
  private async seedAddresses(ctx: Ctx): Promise<void> {
    const repo = ctx.em.getRepository(Address);

    const rows: Array<{
      username: string;
      province: string;
      city: string;
      address: string;
      postal_code: string;
      reciver_mobile: string;
    }> = [
      {
        username: 'dev_customer1',
        province: 'کردستان',
        city: 'سنندج',
        address:
          'گیرنده: سارا احمدی — سنندج، خیابان فردوسی، کوچه گلستان، پلاک ۱۸، واحد ۳',
        postal_code: '6613785412',
        reciver_mobile: '09000000006',
      },
      {
        username: 'dev_customer1',
        province: 'تهران',
        city: 'تهران',
        address:
          'گیرنده: سارا احمدی — تهران، ونک، خیابان ملاصدرا، پلاک ۹۲، طبقه ۴',
        postal_code: '1991834561',
        reciver_mobile: '09000000006',
      },
      {
        username: 'dev_customer2',
        province: 'آذربایجان شرقی',
        city: 'تبریز',
        address:
          'گیرنده: رضا مرادی — تبریز، بلوار استاد شهریار، کوچه بهار، پلاک ۵',
        postal_code: '5157913571',
        reciver_mobile: '09000000007',
      },
      {
        username: 'dev_customer2',
        province: 'کردستان',
        city: 'مریوان',
        address:
          'گیرنده: رضا مرادی — مریوان، خیابان جمهوری، روبه‌روی بانک ملی، پلاک ۳۱',
        postal_code: '6671943218',
        reciver_mobile: '09000000007',
      },
    ];

    for (const row of rows) {
      const userId = ctx.userIds.get(row.username);
      if (!userId) throw new Error(`User ${row.username} missing`);
      const existing = await repo.findOne({
        where: { userId, postal_code: row.postal_code },
      });
      if (existing) continue;
      await repo.save(
        repo.create({
          userId,
          province: row.province,
          city: row.city,
          address: row.address,
          postal_code: row.postal_code,
          reciver_mobile: row.reciver_mobile,
        }),
      );
      this.bump(ctx, 'addresses');
    }
  }

  // =========================================================================
  // Counts
  // =========================================================================

  async countAll(em: EntityManager): Promise<DevSeedCounts> {
    const one = async (table: string): Promise<number> => {
      const rows: Array<{ count: string }> = await em.query(
        `SELECT COUNT(*)::text AS count FROM "${table}"`,
      );
      return Number(rows[0]?.count ?? 0);
    };
    return {
      roles: await one('roles'),
      branches: await one('branches'),
      users: await one('users'),
      categories: await one('categories'),
      attributes: await one('product_attribute'),
      attributeValues: await one('product_attribute_value'),
      products: await one('products'),
      variants: await one('product_variants'),
      branchVisibilityRows: await one('product_branch_visibility'),
      addresses: await one('addresses'),
      cartItems: await one('cart_items'),
      reservations: await one('stock_reservations'),
      orders: await one('orders'),
      orderItems: await one('order_items'),
      payments: await one('payment'),
      paymentActions: await one('payment_actions'),
      orderActions: await one('order_actions'),
      stockMovements: await one('stock_movements'),
    };
  }

  // =========================================================================
  // Orders, payments and the reconciliation queue
  // =========================================================================

  private displayName(username: string): string {
    const spec = SEED_USERS.find((u) => u.username === username);
    return spec ? `${spec.displayName} (${username})` : username;
  }

  private async findOrder(
    em: EntityManager,
    orderNumber: string,
  ): Promise<Order | null> {
    return em.getRepository(Order).findOne({ where: { orderNumber } });
  }

  /**
   * Writes one order and everything that hangs off it, in one transaction.
   *
   * Returns `null` when the order number is already present — the caller must
   * treat that as "already seeded" and do nothing else for that sale, because
   * the stock it consumed was consumed on the first run.
   */
  private async createOrder(
    ctx: Ctx,
    spec: SeedOrderSpec,
  ): Promise<number | null> {
    if (await this.findOrder(ctx.em, spec.orderNumber)) return null;

    return this.dataSource.transaction(async (em) => {
      // Re-check inside the transaction: the caller's check was outside it.
      if (await this.findOrder(em, spec.orderNumber)) return null;

      const lines = spec.lines.map((line) => {
        const variant = ctx.variants.get(line.sku);
        if (!variant) throw new Error(`Unknown SKU in order spec: ${line.sku}`);
        return {
          ...line,
          ...variant,
          lineTotal: variant.price * line.quantity,
        };
      });
      const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);

      const cashierId = spec.cashierUsername
        ? (ctx.userIds.get(spec.cashierUsername) ?? null)
        : null;
      const branchId = spec.branchName
        ? (ctx.branchIds.get(spec.branchName) ?? null)
        : null;
      const customerId = spec.customerUsername
        ? (ctx.userIds.get(spec.customerUsername) ?? null)
        : null;

      let addressId: number | null = null;
      let addressSnapshot: Record<string, unknown> | null = null;
      if (spec.addressPostalCode && customerId) {
        const addr = await em.getRepository(Address).findOne({
          where: { userId: customerId, postal_code: spec.addressPostalCode },
        });
        if (addr) {
          addressId = addr.id;
          addressSnapshot = {
            addressId: addr.id,
            province: addr.province,
            city: addr.city,
            address: addr.address,
            postalCode: addr.postal_code,
            receiverMobile: addr.reciver_mobile,
            capturedAt: spec.soldAt.toISOString(),
          };
        }
      }

      const orderRepo = em.getRepository(Order);
      /*
       * `paidAt` is deliberately NOT set here. The `trg_orders_stamp_money_
       * event_times` trigger stamps it from `soldAt` on an INSERT that lands in
       * `paid`, which is exactly the backdating this dataset wants — and going
       * through the trigger proves the trigger works rather than side-stepping
       * it.
       */
      const order = await orderRepo.save(
        orderRepo.create({
          orderNumber: spec.orderNumber,
          channel: spec.channel,
          status: spec.status,
          fulfillmentState: spec.fulfillmentState,
          paymentMethod: spec.paymentMethod,
          soldAt: spec.soldAt,
          cashierUserId: cashierId,
          cashierDisplaySnapshot: spec.cashierUsername
            ? this.displayName(spec.cashierUsername)
            : null,
          branchId,
          branchNameSnapshot: spec.branchName ?? null,
          userId: customerId,
          addressId,
          addressSnapshot: addressSnapshot as never,
          subtotal,
          total_price: subtotal,
          reconciliationState: spec.reconciliationState ?? null,
          reconciliationResolvedAt: spec.reconciliationResolvedAt ?? null,
        }),
      );
      this.bump(ctx, 'orders');

      const itemRepo = em.getRepository(OrderItems);
      for (const line of lines) {
        const variantRow = await em.getRepository(ProductVariant).findOne({
          where: { id: line.variantId },
          relations: { attributeValues: { attribute: true }, product: true },
        });
        const attributesSnapshot: Record<string, string> = {};
        for (const av of variantRow?.attributeValues ?? []) {
          if (av.attribute?.name)
            attributesSnapshot[av.attribute.name] = av.value;
        }
        await itemRepo.save(
          itemRepo.create({
            orderId: order.id,
            productId: line.productId,
            variantId: line.variantId,
            productTitleSnapshot:
              variantRow?.product?.title ?? 'Unknown product',
            variantSkuSnapshot: line.sku,
            attributesSnapshot,
            quantity: line.quantity,
            unit_price: line.price,
            total_price: line.lineTotal,
          }),
        );
        this.bump(ctx, 'orderItems');
      }

      // ---- stock, through the real service and nothing else --------------
      if (spec.consume === 'pos') {
        if (cashierId === null || branchId === null) {
          throw new Error(
            `${spec.orderNumber}: a POS sale needs a cashier and a branch`,
          );
        }
        await ctx.inventory.consumeForPosSale(em, {
          items: lines.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
          })),
          orderId: order.id,
          actorUserId: cashierId,
          actorDisplaySnapshot: this.displayName(spec.cashierUsername!),
          branchId,
          now: spec.soldAt,
        });
      } else if (spec.consume === 'online') {
        await ctx.inventory.consumeForOnlineFulfilment(em, {
          orderId: order.id,
          actorUserId: null,
          now: spec.soldAt,
        });
      }

      // ---- payments ------------------------------------------------------
      const paymentRepo = em.getRepository(Payment);
      const paymentIds: number[] = [];
      for (const p of spec.payments) {
        const saved = await paymentRepo.save(
          paymentRepo.create({
            orderId: order.id,
            amount: p.amount ?? subtotal,
            gateway_amount: p.gatewayAmount ?? null,
            gateway_amount_raw: p.gatewayAmountRaw ?? null,
            track_id: p.trackId ?? null,
            ref_number: p.refNumber ?? null,
            status: p.status,
            paid_at: p.paidAt ?? null,
            requires_reconciliation: p.requiresReconciliation ?? false,
            reconciliation_reason: p.reconciliationReason ?? null,
            reconciled_at: p.reconciledAt ?? null,
          }),
        );
        paymentIds.push(saved.id);
        this.bump(ctx, 'payments');
      }

      // ---- operator decisions, append-only -------------------------------
      const actionRepo = em.getRepository(PaymentAction);
      for (const a of spec.paymentActions ?? []) {
        const actorId = ctx.userIds.get(a.actorUsername) ?? null;
        await actionRepo.save(
          actionRepo.create({
            orderId: order.id,
            paymentId: paymentIds[a.paymentIndex ?? 0] ?? null,
            action: a.action,
            actorUserId: actorId,
            actorDisplaySnapshot: this.displayName(a.actorUsername),
            reason: a.reason,
            fromReconciliationState: a.fromState ?? null,
            toReconciliationState: a.toState ?? null,
            fromOrderStatus: a.fromOrderStatus ?? null,
            toOrderStatus: a.toOrderStatus ?? null,
            externalReference: a.externalReference ?? null,
            amount: a.amount ?? null,
            createdAt: a.at,
          }),
        );
        this.bump(ctx, 'paymentActions');
      }

      // ---- reversal, preserving seller attribution -----------------------
      if (spec.reversal) {
        const actorId = ctx.userIds.get(spec.reversal.actorUsername);
        if (!actorId)
          throw new Error(
            `Reversal actor ${spec.reversal.actorUsername} missing`,
          );

        await ctx.inventory.restoreForOrder(em, {
          orderId: order.id,
          reason:
            spec.reversal.type === 'void'
              ? StockMovementReason.CANCELLATION_RESTORE
              : StockMovementReason.RETURN_RESTORE,
          actorUserId: actorId,
          actorDisplaySnapshot: this.displayName(spec.reversal.actorUsername),
          // Seeded reversals are of paid sales, as the order update below
          // stamps them.
          reverseRevenue: true,
          now: spec.reversal.at,
        });

        const toStatus =
          spec.reversal.type === 'void'
            ? OrderStatusEnum.CANCELED
            : OrderStatusEnum.REFUNDED;

        /*
         * `cashierUserId` is NOT in this update set. The original seller owns
         * the sale forever; who reversed it is recorded in `order_actions`.
         * `refundedAt` is written in the same statement as `status` so the
         * money-event trigger sees a non-null value and leaves the backdate
         * alone instead of stamping now().
         */
        await em
          .getRepository(Order)
          .update(
            { id: order.id },
            spec.reversal.type === 'void'
              ? { status: toStatus, voidedAt: spec.reversal.at }
              : { status: toStatus, refundedAt: spec.reversal.at },
          );

        const orderActionRepo = em.getRepository(OrderAction);
        await orderActionRepo.save(
          orderActionRepo.create({
            orderId: order.id,
            action:
              spec.reversal.type === 'void'
                ? OrderActionType.VOID
                : OrderActionType.RETURN,
            fromStatus: OrderStatusEnum.PAID,
            toStatus,
            actorUserId: actorId,
            actorDisplaySnapshot: this.displayName(spec.reversal.actorUsername),
            reason: spec.reversal.reason,
            createdAt: spec.reversal.at,
          }),
        );
        this.bump(ctx, 'orderActions');

        // The single successful payment becomes the refunded one; a second
        // success row would violate uq_payment_one_success_per_order.
        await em
          .getRepository(Payment)
          .update(
            { orderId: order.id, status: PaymentStatusEnum.SUCCESS },
            { status: PaymentStatusEnum.REFUNDED },
          );
      }

      return order.id;
    });
  }

  /**
   * The order set.
   *
   * Between them these cover both channels and every state the brief asks to
   * review: pending, paid-and-fulfilled, under manual review, awaiting stock,
   * voided, returned, two cashiers, two branches, cash and card, and every
   * reconciliation case the queue can show.
   */
  private async seedOrders(ctx: Ctx): Promise<void> {
    const c = ctx.clock;
    const MAIN = SEED_BRANCH_MAIN;
    const SECOND = SEED_BRANCH_SECONDARY;

    const pos = (
      orderNumber: string,
      soldAt: Date,
      cashier: string,
      branch: string,
      method: PaymentMethodEnum,
      lines: SeedOrderLine[],
      extra: Partial<SeedOrderSpec> = {},
    ): SeedOrderSpec => ({
      orderNumber,
      channel: OrderChannel.POS,
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      paymentMethod: method,
      soldAt,
      cashierUsername: cashier,
      branchName: branch,
      lines,
      consume: 'pos',
      payments: [{ status: PaymentStatusEnum.SUCCESS, paidAt: soldAt }],
      ...extra,
    });

    const specs: SeedOrderSpec[] = [
      pos(
        'POS-SEED-0001',
        c.past(0, 10, 15),
        'dev_cashier1',
        MAIN,
        PaymentMethodEnum.CASH,
        [
          { sku: 'KZ-CKS-030-STD', quantity: 1 },
          { sku: 'KZ-CKS-032-1L-SLV', quantity: 2 },
        ],
      ),
      pos(
        'POS-SEED-0002',
        c.past(0, 14, 40),
        'dev_cashier2',
        MAIN,
        PaymentMethodEnum.CARD_TERMINAL,
        [{ sku: 'KZ-BKP-010-50L-BLK', quantity: 1 }],
      ),
      pos(
        'POS-SEED-0003',
        c.past(1, 11, 20),
        'dev_cashier1',
        MAIN,
        PaymentMethodEnum.CASH,
        [
          { sku: 'KZ-LGT-041-STD', quantity: 1 },
          { sku: 'KZ-FSH-082-2T', quantity: 1 },
        ],
      ),
      // Sold by cashier 1, VOIDED by cashier 2 — attribution must not move.
      pos(
        'POS-SEED-0004',
        c.past(1, 16, 5),
        'dev_cashier1',
        MAIN,
        PaymentMethodEnum.CARD_TERMINAL,
        [{ sku: 'KZ-SHO-061-PAIR', quantity: 1 }],
        {
          reversal: {
            type: 'void',
            actorUsername: 'dev_cashier2',
            at: c.past(1, 17, 0),
            reason: 'ابطال فروش — مشتری پیش از تحویل انصراف داد.',
          },
        },
      ),
      // Sold by cashier 1, RETURNED by cashier 2 two days later.
      pos(
        'POS-SEED-0005',
        c.past(3, 12, 30),
        'dev_cashier1',
        MAIN,
        PaymentMethodEnum.CASH,
        [{ sku: 'KZ-APP-051-M-GRY', quantity: 1 }],
        {
          reversal: {
            type: 'return',
            actorUsername: 'dev_cashier2',
            at: c.past(2, 10, 0),
            reason: 'مرجوعی — سایز نامناسب بود.',
          },
        },
      ),
      pos(
        'POS-SEED-0006',
        c.past(10, 13, 10),
        'dev_cashier_marivan',
        SECOND,
        PaymentMethodEnum.CARD_TERMINAL,
        [{ sku: 'KZ-FSH-081-4000', quantity: 1 }],
      ),
      pos(
        'POS-SEED-0007',
        c.past(40, 9, 45),
        'dev_cashier1',
        MAIN,
        PaymentMethodEnum.CASH,
        [{ sku: 'KZ-OFR-100-9T', quantity: 1 }],
      ),

      // ---------------------------------------------------------- online
      {
        orderNumber: 'WEB-SEED-0001',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PENDING,
        fulfillmentState: FulfillmentStateEnum.PENDING,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(0, 9, 0),
        customerUsername: 'dev_customer1',
        addressPostalCode: '6613785412',
        lines: [{ sku: 'KZ-CKS-031-6PC', quantity: 1 }],
        consume: 'none',
        payments: [
          { status: PaymentStatusEnum.PENDING, trackId: 'SEEDTRK-0001' },
        ],
      },
      {
        orderNumber: 'WEB-SEED-0002',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(2, 18, 20),
        customerUsername: 'dev_customer1',
        addressPostalCode: '1991834561',
        lines: [{ sku: 'KZ-SLP-021-STD-GRN', quantity: 1 }],
        consume: 'online',
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0002',
            refNumber: 'SEEDREF-0002',
            paidAt: c.past(2, 18, 22),
            gatewayAmount: 38_000_000,
            gatewayAmountRaw: '38000000',
          },
        ],
      },
      // Amount mismatch: the gateway reported less than we asked for.
      {
        orderNumber: 'WEB-SEED-0003',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.PENDING,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(1, 20, 10),
        customerUsername: 'dev_customer2',
        addressPostalCode: '5157913571',
        lines: [{ sku: 'KZ-HNT-090-10X42', quantity: 1 }],
        consume: 'none',
        reconciliationState: OrderReconciliationState.OPEN,
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0003',
            refNumber: 'SEEDREF-0003',
            paidAt: c.past(1, 20, 12),
            gatewayAmount: 167_000_000,
            gatewayAmountRaw: '167000000',
            requiresReconciliation: true,
            reconciliationReason: PaymentReconciliationReason.AMOUNT_MISMATCH,
          },
        ],
      },
      {
        orderNumber: 'WEB-SEED-0004',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(1, 21, 0),
        customerUsername: 'dev_customer1',
        addressPostalCode: '6613785412',
        lines: [{ sku: 'KZ-LGT-042-TAC', quantity: 1 }],
        consume: 'none',
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0004',
            refNumber: 'SEEDREF-0004',
            paidAt: c.past(1, 21, 2),
            gatewayAmount: 24_300_000,
            gatewayAmountRaw: '24300000',
          },
        ],
      },
      // Money confirmed by the gateway but never applied to the order.
      {
        orderNumber: 'WEB-SEED-0005',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PENDING,
        fulfillmentState: FulfillmentStateEnum.PENDING,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(2, 8, 30),
        customerUsername: 'dev_customer2',
        addressPostalCode: '6671943218',
        lines: [{ sku: 'KZ-FSH-080-360', quantity: 1 }],
        consume: 'none',
        reconciliationState: OrderReconciliationState.OPEN,
        payments: [
          {
            status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
            trackId: 'SEEDTRK-0005',
            refNumber: 'SEEDREF-0005',
            paidAt: c.past(2, 8, 35),
            requiresReconciliation: true,
            reconciliationReason:
              PaymentReconciliationReason.LATE_CONFIRMATION_UNAPPLIED,
          },
        ],
      },
      {
        orderNumber: 'WEB-SEED-0006',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        // A refund is owed, so no goods will ever move: NOT_REQUIRED keeps the
        // order out of FulfilmentRecoveryService's retry set instead of
        // leaving it to be re-driven forever for stock it must never consume.
        fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(4, 15, 0),
        customerUsername: 'dev_customer1',
        addressPostalCode: '1991834561',
        lines: [{ sku: 'KZ-MNT-070-12PT', quantity: 1 }],
        consume: 'none',
        reconciliationState: OrderReconciliationState.REFUND_REQUIRED,
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0006',
            refNumber: 'SEEDREF-0006',
            paidAt: c.past(4, 15, 3),
            requiresReconciliation: true,
            reconciliationReason: PaymentReconciliationReason.ORDER_NOT_PAYABLE,
          },
        ],
        paymentActions: [
          {
            action: PaymentActionType.MARK_REFUND_REQUIRED,
            actorUsername: 'dev_superadmin',
            reason: 'کالا موجود نیست و تأمین نمی‌شود؛ بازگشت وجه لازم است.',
            toState: OrderReconciliationState.REFUND_REQUIRED,
            at: c.past(4, 16, 0),
          },
        ],
      },
      {
        orderNumber: 'WEB-SEED-0007',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        // Refund already confirmed externally; nothing will ship.
        fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(6, 11, 0),
        customerUsername: 'dev_customer2',
        addressPostalCode: '5157913571',
        lines: [{ sku: 'KZ-OFR-101-12V', quantity: 1 }],
        consume: 'none',
        reconciliationState: OrderReconciliationState.REFUND_CONFIRMED,
        reconciliationResolvedAt: c.past(5, 12, 0),
        payments: [
          {
            status: PaymentStatusEnum.REFUNDED,
            trackId: 'SEEDTRK-0007',
            refNumber: 'SEEDREF-0007',
            paidAt: c.past(6, 11, 4),
            requiresReconciliation: true,
            reconciliationReason: PaymentReconciliationReason.ORDER_NOT_PAYABLE,
            reconciledAt: c.past(5, 12, 0),
          },
        ],
        paymentActions: [
          {
            action: PaymentActionType.MARK_REFUND_REQUIRED,
            actorUsername: 'dev_superadmin',
            reason: 'سفارش قابل تأمین نبود؛ بازگشت وجه ثبت شد.',
            toState: OrderReconciliationState.REFUND_REQUIRED,
            at: c.past(6, 12, 0),
          },
          {
            action: PaymentActionType.CONFIRM_EXTERNAL_REFUND,
            actorUsername: 'dev_superadmin',
            reason: 'بازگشت وجه در درگاه بانکی انجام و تأیید شد.',
            fromState: OrderReconciliationState.REFUND_REQUIRED,
            toState: OrderReconciliationState.REFUND_CONFIRMED,
            externalReference: 'SEED-BANK-REFUND-0007',
            amount: 61_000_000,
            at: c.past(5, 12, 0),
          },
        ],
      },
      {
        orderNumber: 'WEB-SEED-0008',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(5, 17, 45),
        customerUsername: 'dev_customer1',
        addressPostalCode: '6613785412',
        lines: [{ sku: 'KZ-BKP-010-70L-BLK', quantity: 1 }],
        consume: 'none',
        reconciliationState: OrderReconciliationState.BACKORDERED,
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0008',
            refNumber: 'SEEDREF-0008',
            paidAt: c.past(5, 17, 48),
            gatewayAmount: 104_000_000,
            gatewayAmountRaw: '104000000',
          },
        ],
        paymentActions: [
          {
            action: PaymentActionType.MARK_BACKORDER,
            actorUsername: 'dev_superadmin',
            reason: 'کالا در محموله بعدی تأمین می‌شود؛ سفارش باز می‌ماند.',
            toState: OrderReconciliationState.BACKORDERED,
            at: c.past(5, 18, 30),
          },
        ],
      },
      {
        orderNumber: 'WEB-SEED-0009',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(8, 10, 20),
        customerUsername: 'dev_customer2',
        addressPostalCode: '6671943218',
        lines: [{ sku: 'KZ-HNT-091-L-OLV', quantity: 1 }],
        consume: 'online',
        reconciliationState: OrderReconciliationState.RESOLVED,
        reconciliationResolvedAt: c.past(8, 12, 0),
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0009',
            refNumber: 'SEEDREF-0009',
            paidAt: c.past(8, 10, 23),
            gatewayAmount: 46_000_000,
            gatewayAmountRaw: '46000000',
          },
        ],
        paymentActions: [
          {
            action: PaymentActionType.RESOLVE_NO_ACTION,
            actorUsername: 'dev_superadmin',
            reason:
              'اختلاف موقتی درگاه بود؛ سفارش تأمین شد و اقدام مالی لازم نیست.',
            toState: OrderReconciliationState.RESOLVED,
            at: c.past(8, 12, 0),
          },
        ],
      },
      // Duplicate confirmation: a second gateway callback for one order. The
      // partial unique index allows only one success, so the duplicate lands
      // as confirmed-but-unapplied rather than a second success.
      {
        orderNumber: 'WEB-SEED-0010',
        channel: OrderChannel.ONLINE,
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
        paymentMethod: PaymentMethodEnum.ONLINE_GATEWAY,
        soldAt: c.past(3, 19, 30),
        customerUsername: 'dev_customer1',
        addressPostalCode: '1991834561',
        lines: [{ sku: 'KZ-APP-052-40', quantity: 1 }],
        consume: 'online',
        reconciliationState: OrderReconciliationState.OPEN,
        payments: [
          {
            status: PaymentStatusEnum.SUCCESS,
            trackId: 'SEEDTRK-0010',
            refNumber: 'SEEDREF-0010',
            paidAt: c.past(3, 19, 32),
            gatewayAmount: 12_500_000,
            gatewayAmountRaw: '12500000',
          },
          {
            status: PaymentStatusEnum.CONFIRMED_UNAPPLIED,
            trackId: 'SEEDTRK-0011',
            refNumber: 'SEEDREF-0011',
            paidAt: c.past(3, 19, 33),
            requiresReconciliation: true,
            reconciliationReason:
              PaymentReconciliationReason.DUPLICATE_CONFIRMED,
          },
        ],
      },
    ];

    for (const spec of specs) {
      const id = await this.createOrder(ctx, spec);
      if (id === null)
        ctx.notes.push(`order ${spec.orderNumber} already present — skipped`);
    }
  }

  // =========================================================================
  // Carts and four-hour basket reservations
  // =========================================================================

  /**
   * Creates one active cart line and its holds THROUGH `InventoryService`.
   *
   * Nothing here writes `stock_reservations` directly. Inserting reservation
   * rows by hand is exactly how a dataset ends up showing a UI state that the
   * real system can never produce — a hold that does not reduce availability,
   * or a cart line whose reservation does not add up to its quantity. Going
   * through the service means the rows are whatever the running application
   * would have written.
   *
   * Idempotent on the partial unique index `uq_cart_items_active_line`
   * (userId, productId, variantId) WHERE status = 'active'.
   */
  private async ensureCartLine(
    ctx: Ctx,
    username: string,
    sku: string,
    tranches: Array<{ quantity: number; ttlMs?: number; now?: Date }>,
  ): Promise<void> {
    const userId = ctx.userIds.get(username);
    const variant = ctx.variants.get(sku);
    if (!userId || !variant)
      throw new Error(`cart line ${username}/${sku}: missing user or SKU`);

    const quantity = tranches.reduce((sum, t) => sum + t.quantity, 0);

    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(CartItem);
      /*
       * Matched on (user, variant) with NO status filter, on purpose.
       *
       * The two most interesting lines in this dataset do not stay `active`:
       * one is displaced by a counter sale and one has its hold expire, and
       * the application flips both to `removed`. Filtering on `active` here
       * would make the seeder fail to recognise its own rows on the next run
       * and try to reserve stock for them a second time — which is precisely
       * how run 2 first failed. What the line's status became afterwards is
       * the application's business, not the seeder's.
       */
      const existing = await repo.findOne({
        where: { userId, variantId: variant.variantId },
      });
      if (existing) return;

      const line = await repo.save(
        repo.create({
          userId,
          productId: variant.productId,
          variantId: variant.variantId,
          quantity,
          status: CartItemStatus.ACTIVE,
        }),
      );
      this.bump(ctx, 'cartItems');

      for (const t of tranches) {
        await ctx.inventory.reserveForBasket(em, {
          userId,
          cartItemId: line.id,
          variantId: variant.variantId,
          quantity: t.quantity,
          ttlMs: t.ttlMs,
          now: t.now ?? ctx.realNow,
        });
        this.bump(ctx, 'reservations');
      }
    });
  }

  private async seedCartsAndReservations(ctx: Ctx): Promise<void> {
    const FOUR_HOURS = 4 * HOUR_MS;

    // A plain, healthy hold at the full four-hour TTL.
    await this.ensureCartLine(ctx, 'dev_customer1', 'KZ-TNT-001-2P-GRN', [
      { quantity: 2 },
    ]);

    // TWO TRANCHES. A quantity increase inserts a second reservation with its
    // own TTL rather than extending the first, so this line is one cart row
    // backed by two independently-expiring holds.
    await this.ensureCartLine(ctx, 'dev_customer1', 'KZ-CKS-030-STD', [
      { quantity: 1, now: new Date(ctx.realNow.getTime() - 90 * 60 * 1000) },
      { quantity: 1 },
    ]);

    // NEAR EXPIRY: roughly twelve minutes left on the clock.
    await this.ensureCartLine(ctx, 'dev_customer1', 'KZ-SLP-020-M-NVY', [
      { quantity: 1, ttlMs: 12 * 60 * 1000 },
    ]);

    // The line POS-SEED-0008 will partially displace. Two units held against
    // a variant that only has two in stock.
    await this.ensureCartLine(ctx, 'dev_customer1', 'KZ-LGT-040-400L-RED', [
      { quantity: 2 },
    ]);

    /*
     * ALREADY EXPIRED. Reserved five hours ago on a four-hour TTL, so the hold
     * lapsed an hour before this seed ran. The sweep below is the same call
     * the application makes lazily on every cart read, and it is what turns
     * the lapsed hold into a `reservation_expired` notice on the cart line.
     */
    await this.ensureCartLine(ctx, 'dev_customer1', 'KZ-FSH-082-2T', [
      {
        quantity: 1,
        now: new Date(ctx.realNow.getTime() - 5 * HOUR_MS),
        ttlMs: FOUR_HOURS,
      },
    ]);

    const expiredVariant = ctx.variants.get('KZ-FSH-082-2T');
    if (expiredVariant) {
      await this.dataSource.transaction(async (em) => {
        await ctx.inventory.expireDueReservations(em, {
          variantIds: [expiredVariant.variantId],
          now: ctx.realNow,
        });
      });
    }

    // A second customer, so cart isolation is reviewable.
    await this.ensureCartLine(ctx, 'dev_customer2', 'KZ-APP-050-M-BLK', [
      { quantity: 1 },
    ]);
  }

  /**
   * The displacement sale, run LAST because it needs a basket hold to displace.
   *
   * `KZ-LGT-040-400L-RED` has two in stock and customer 1 is holding both, so
   * `availableForBasket` is 0 while `availableForPos` is still 2 — the POS may
   * take stock an ecommerce basket is holding, but never stock allocated to a
   * paid order. Selling one over the counter therefore has to revoke one unit
   * of the basket hold, which leaves the cart line at quantity 1 with a
   * `sold_in_store` notice. That state is produced by the real service, not
   * written by hand.
   */
  private async seedDisplacementSale(ctx: Ctx): Promise<void> {
    await this.createOrder(ctx, {
      orderNumber: 'POS-SEED-0008',
      channel: OrderChannel.POS,
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
      paymentMethod: PaymentMethodEnum.CASH,
      soldAt: ctx.realNow,
      cashierUsername: 'dev_cashier1',
      branchName: SEED_BRANCH_MAIN,
      lines: [{ sku: 'KZ-LGT-040-400L-RED', quantity: 1 }],
      consume: 'pos',
      payments: [{ status: PaymentStatusEnum.SUCCESS, paidAt: ctx.realNow }],
    });
  }
}

// ===========================================================================
// Spec shapes
// ===========================================================================

export interface SeedOrderLine {
  sku: string;
  quantity: number;
}

export interface SeedPaymentSpec {
  status: PaymentStatusEnum;
  /** Integer Rial. Defaults to the order subtotal when omitted. */
  amount?: number;
  gatewayAmount?: number | null;
  gatewayAmountRaw?: string | null;
  trackId?: string | null;
  refNumber?: string | null;
  paidAt?: Date | null;
  requiresReconciliation?: boolean;
  reconciliationReason?: PaymentReconciliationReason | null;
  reconciledAt?: Date | null;
}

export interface SeedPaymentActionSpec {
  action: PaymentActionType;
  actorUsername: string;
  reason: string;
  at: Date;
  paymentIndex?: number;
  fromState?: OrderReconciliationState | null;
  toState?: OrderReconciliationState | null;
  fromOrderStatus?: string | null;
  toOrderStatus?: string | null;
  externalReference?: string | null;
  amount?: number | null;
}

export interface SeedOrderSpec {
  orderNumber: string;
  channel: OrderChannel;
  status: OrderStatusEnum;
  fulfillmentState: FulfillmentStateEnum;
  paymentMethod: PaymentMethodEnum | null;
  soldAt: Date;
  cashierUsername?: string | null;
  branchName?: string | null;
  customerUsername?: string | null;
  addressPostalCode?: string | null;
  lines: SeedOrderLine[];
  /** Which real InventoryService path moves the stock, if any. */
  consume: 'pos' | 'online' | 'none';
  payments: SeedPaymentSpec[];
  paymentActions?: SeedPaymentActionSpec[];
  reconciliationState?: OrderReconciliationState | null;
  reconciliationResolvedAt?: Date | null;
  reversal?: {
    type: 'void' | 'return';
    actorUsername: string;
    at: Date;
    reason: string;
  };
}
