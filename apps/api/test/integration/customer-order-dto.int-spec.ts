import { randomUUID } from 'node:crypto';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { createProductWithVariant, createUser } from './setup/seed-helpers';

/**
 * ===========================================================================
 * `GET /me/orders` AND `GET /me/orders/:id` ARE A BOUNDED PROJECTION
 * ===========================================================================
 *
 * Both routes used to serialize the raw `Order` / `OrderItems` entities, so
 * every column the table has ever grown was part of the customer contract the
 * moment its migration ran. Migration 0011 added a fulfilment RETRY QUEUE to
 * `orders`, `fulfillmentLastError` included — a raw internal failure string
 * written by the recovery worker — and it went straight out to the customer,
 * along with staff attribution (`cashierUserId`, `cashierDisplaySnapshot`) and
 * branch attribution (`branchId`, `branchNameSnapshot`).
 *
 * WHAT THESE CASES ARE REALLY GUARDING is not the current field list but the
 * DEFAULT-DENY property: the mapping is an allow-list built by a pure function
 * (`toCustomerOrderView`), so a column added by a future migration cannot show
 * up in a customer response unless somebody names it. A delete-list would pass
 * these tests today and leak on the next migration.
 *
 * Every assertion goes through the REAL HTTP surface, and the leaky fields are
 * asserted absent BY NAME rather than by counting keys — a key count passes
 * just as happily when the shape changes for the wrong reason. The order is
 * seeded with a NON-NULL `fulfillmentLastError` carrying a unique sentinel
 * first, so the exclusion is actually being exercised instead of vacuously
 * true against a NULL column.
 */
describe('customer order projection (GET /me/orders)', () => {
  let app: TestApp;

  interface Shopper {
    userId: number;
    jar: CookieJar;
    addressId: number;
  }

  const KEY = () => `cod-${randomUUID()}`;

  /**
   * Internal columns that must never appear ANYWHERE in the response, at any
   * depth. Each name is safe to forbid recursively: none of them is also the
   * name of an allowed field on a nested object.
   */
  const FORBIDDEN_ANYWHERE = [
    // --- migration 0011 fulfilment retry / recovery bookkeeping -----------
    'fulfillmentLastError',
    'fulfillmentAttempts',
    'fulfillmentLastAttemptAt',
    'fulfillmentNextAttemptAt',
    // --- staff and branch attribution --------------------------------------
    'cashierUserId',
    'cashierDisplaySnapshot',
    'cashierUser',
    'branchId',
    'branchNameSnapshot',
    'branch',
    // --- internal FKs -------------------------------------------------------
    'customerId',
    'customer',
    'userId',
    'user',
    // --- the legacy, un-zoned money timestamp (migration 0009) -------------
    'paid_at',
    // --- snake_case entity columns replaced by camelCase view fields -------
    'total_price',
    'unit_price',
    'discount_code',
    'created_at',
    'updated_at',
    // --- migration-0015 snapshot provenance, not a fact about delivery -----
    'backfilled',
    // --- operator reconciliation bookkeeping (migration 0018) --------------
    'reconciliationState',
    'reconciliationResolvedAt',
    // --- payment reconciliation ledger (no payment relation is loaded) -----
    'payments',
    'requires_reconciliation',
    'reconciliation_reason',
    'reconciled_at',
    'track_id',
    'ref_number',
    'gateway_amount',
    'gateway_amount_raw',
    'reverify_attempts',
    'last_reverified_at',
    'next_reverify_at',
    // --- live catalogue rows (the snapshots are the record) ----------------
    'basePrice',
    'stock',
  ];

  /**
   * Forbidden ON THE ORDER OBJECT ITSELF but legal deeper down: `addressId` and
   * `address` are both real fields of `addressSnapshot`, so they cannot be
   * banned recursively.
   */
  const FORBIDDEN_ON_ORDER = ['addressId', 'address'];

  /** Forbidden on a line item. `product`/`variant` are the live catalogue rows. */
  const FORBIDDEN_ON_ITEM = ['orderId', 'product', 'variant', 'order'];

  const ALLOWED_ON_ORDER = [
    'id',
    'orderNumber',
    'channel',
    'status',
    'fulfillmentState',
    // Migration 0018. A DERIVED, two-word, customer-safe reading of the manual
    // reconciliation case: `under_review`, `refund_in_progress`, or null. The
    // columns it is derived from (`reconciliationState`,
    // `reconciliationResolvedAt`) are operator bookkeeping and are asserted
    // absent below.
    'reviewState',
    'paymentMethod',
    'soldAt',
    'paidAt',
    'voidedAt',
    'refundedAt',
    'subtotal',
    'totalPrice',
    'discountCode',
    'addressSnapshot',
    'items',
  ];

  const ALLOWED_ON_ITEM = [
    'id',
    'productId',
    'variantId',
    'productTitleSnapshot',
    'variantSkuSnapshot',
    'attributesSnapshot',
    'quantity',
    'unitPrice',
    'totalPrice',
  ];

  /** Every object key in a parsed JSON tree, at any depth. */
  function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const entry of value) collectKeys(entry, into);
      return into;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        into.add(key);
        collectKeys(nested, into);
      }
    }
    return into;
  }

  /** The whole set of shape assertions, applied to one order object. */
  function assertBoundedOrder(order: Record<string, unknown>): void {
    for (const field of FORBIDDEN_ANYWHERE) {
      expect(order).not.toHaveProperty(field);
    }
    for (const field of FORBIDDEN_ON_ORDER) {
      expect(order).not.toHaveProperty(field);
    }
    expect(Object.keys(order).sort()).toEqual([...ALLOWED_ON_ORDER].sort());

    const items = order.items as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const field of [...FORBIDDEN_ANYWHERE, ...FORBIDDEN_ON_ITEM]) {
        expect(item).not.toHaveProperty(field);
      }
      expect(Object.keys(item).sort()).toEqual([...ALLOWED_ON_ITEM].sort());
    }

    // Belt and braces: nothing forbidden survives ANYWHERE in the subtree,
    // including inside `addressSnapshot` and inside every line item.
    const keys = collectKeys(order);
    for (const field of FORBIDDEN_ANYWHERE) {
      expect([...keys]).not.toContain(field);
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
  });

  async function makeShopper(): Promise<Shopper> {
    const { user, username, password } = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    const jar = await authenticate(app, username, password);

    const created = await withCookies(app, jar).post('/me/addresses').send({
      province: 'Tehran',
      city: 'Tehran',
      address: 'Somewhere 12',
      postal_code: '1234567890',
      reciver_mobile: '09120000000',
    });
    expect([200, 201]).toContain(created.status);

    return { userId: user.id, jar, addressId: Number(created.body.data.id) };
  }

  /** Basket -> quote -> order, i.e. exactly how a real order comes to exist. */
  async function placeOrder(
    shopper: Shopper,
    productId: number,
    variantId: number,
    quantity: number,
  ): Promise<number> {
    const added = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId, variantId, quantity });
    expect([200, 201]).toContain(added.status);

    const quote = await withCookies(app, shopper.jar).post('/orders/quote');
    expect(quote.status).toBe(200);

    const placed = await withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', KEY())
      .send({
        address: shopper.addressId,
        quoteToken: quote.body.data.quote.token,
      });
    expect(placed.status).toBe(201);
    return Number(placed.body.data.id);
  }

  /**
   * Stamps the order with every internal field a customer must not see.
   *
   * WITHOUT THIS the exclusion assertions are vacuous: a freshly placed online
   * order has `fulfillmentLastError = NULL`, `fulfillmentAttempts = 0` and no
   * branch/cashier attribution at all, so "the field is absent" would pass on
   * an unprojected entity too.
   */
  async function stampInternalState(
    orderId: number,
    sentinel: string,
  ): Promise<void> {
    await app.dataSource.query(
      `UPDATE orders
          SET "fulfillmentLastError" = $2,
              "fulfillmentAttempts" = 4,
              "fulfillmentLastAttemptAt" = now(),
              "fulfillmentNextAttemptAt" = now() + interval '5 minutes',
              "fulfillmentState" = 'awaiting_stock',
              "cashierDisplaySnapshot" = 'Sensitive Staff Name',
              "branchNameSnapshot" = 'Sensitive Branch Name',
              paid_at = now()
        WHERE id = $1`,
      [orderId, sentinel],
    );
  }

  // =========================================================================
  // Detail
  // =========================================================================

  it('GET /me/orders/:id returns only customer-facing fields, and never the fulfilment retry state', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      { title: 'Snapshot Widget', basePrice: 900_000 },
      { stock: 10, price: 250_000, sku: 'SNAP-WIDGET-1' },
    );
    const orderId = await placeOrder(shopper, product.id, variant.id, 3);

    const sentinel =
      'LEAK-SENTINEL: relation "stock_reservations" row 812 deadlocked';
    await stampInternalState(orderId, sentinel);

    const response = await withCookies(app, shopper.jar).get(
      `/me/orders/${orderId}`,
    );
    expect(response.status).toBe(200);

    const order = response.body.data as Record<string, unknown>;
    assertBoundedOrder(order);

    // The raw internal error TEXT is nowhere in the serialized response, not
    // just absent under that key name.
    expect(JSON.stringify(response.body)).not.toContain('LEAK-SENTINEL');
    expect(JSON.stringify(response.body)).not.toContain('Sensitive Staff Name');
    expect(JSON.stringify(response.body)).not.toContain(
      'Sensitive Branch Name',
    );

    // ---- and the ALLOWED fields are present and correct --------------------
    expect(order.id).toBe(orderId);
    expect(order.orderNumber).toEqual(expect.stringContaining('WEB-'));
    expect(order.channel).toBe(OrderChannel.ONLINE);
    expect(order.status).toBe(OrderStatusEnum.PENDING);
    // The fulfilment STATE is exposed; the reason the last attempt failed is not.
    expect(order.fulfillmentState).toBe(FulfillmentStateEnum.AWAITING_STOCK);
    expect(order.paymentMethod).toBe(PaymentMethodEnum.ONLINE_GATEWAY);
    expect(typeof order.soldAt).toBe('string');
    expect(order.paidAt).toBeNull();
    expect(order.voidedAt).toBeNull();
    expect(order.refundedAt).toBeNull();
    expect(order.subtotal).toBe(750_000);
    expect(order.totalPrice).toBe(750_000);
    expect(order.discountCode).toBeNull();

    // The frozen delivery address, and only its delivery-relevant fields.
    expect(order.addressSnapshot).toEqual({
      addressId: shopper.addressId,
      province: 'Tehran',
      city: 'Tehran',
      address: 'Somewhere 12',
      postalCode: '1234567890',
      receiverMobile: '09120000000',
      capturedAt: expect.any(String),
    });

    const items = order.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: expect.any(Number),
      productId: product.id,
      variantId: variant.id,
      productTitleSnapshot: 'Snapshot Widget',
      variantSkuSnapshot: 'SNAP-WIDGET-1',
      attributesSnapshot: null,
      quantity: 3,
      unitPrice: 250_000,
      totalPrice: 750_000,
    });
  });

  // =========================================================================
  // List
  // =========================================================================

  it('GET /me/orders paginates the same bounded rows, still under `data.data`', async () => {
    const shopper = await makeShopper();
    const first = await createProductWithVariant(
      app.dataSource,
      { title: 'List Widget A' },
      { stock: 10, price: 100_000 },
    );
    const second = await createProductWithVariant(
      app.dataSource,
      { title: 'List Widget B' },
      { stock: 10, price: 300_000 },
    );

    const olderId = await placeOrder(
      shopper,
      first.product.id,
      first.variant.id,
      1,
    );
    const newerId = await placeOrder(
      shopper,
      second.product.id,
      second.variant.id,
      2,
    );

    const sentinel = 'LEAK-SENTINEL-LIST: ECONNRESET talking to the gateway';
    await stampInternalState(olderId, sentinel);
    await stampInternalState(newerId, sentinel);

    const response = await withCookies(app, shopper.jar).get('/me/orders');
    expect(response.status).toBe(200);

    /**
     * THE DOUBLE NESTING IS STILL REAL, and it is verified here rather than
     * trusted from the doc comment. The handler returns `{ data: <page> }`, the
     * page is itself a plain object with its own `data`, and
     * `ResponseFormatInterceptor` SPREADS a plain object — so the rows sit at
     * `body.data.data` and the envelope's own keys sit beside `data`.
     */
    expect(response.body.success).toBe(true);
    expect(typeof response.body.timeStamp).toBe('string');
    const page = response.body.data as Record<string, unknown>;
    expect(Object.keys(page).sort()).toEqual([
      'data',
      'limit',
      'page',
      'total',
      'totalPages',
    ]);
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    /**
     * TEN, NOT TWENTY. The handler reads `query.limit ?? 20`, but `PaginationDto`
     * declares `limit: number = 10`, so the ValidationPipe has already
     * substituted 10 by the time the handler runs and the `?? 20` fallback is
     * unreachable. The effective default page size of `GET /me/orders` is
     * therefore 10. Asserted so the real number is recorded somewhere.
     */
    expect(page.limit).toBe(10);
    expect(page.totalPages).toBe(1);

    const rows = page.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // Newest first, per `order: { id: 'DESC' }`.
    expect(rows[0].id).toBe(newerId);
    expect(rows[1].id).toBe(olderId);

    for (const row of rows) assertBoundedOrder(row);

    expect(JSON.stringify(response.body)).not.toContain('LEAK-SENTINEL-LIST');
    expect(JSON.stringify(response.body)).not.toContain('Sensitive Staff Name');

    // Money and line items are the ones actually charged.
    expect(rows[0].subtotal).toBe(600_000);
    expect((rows[0].items as unknown[]).length).toBe(1);
    expect(rows[1].subtotal).toBe(100_000);

    // `limit` is echoed from the query, so a client can trust its own paging.
    const paged = await withCookies(app, shopper.jar).get(
      '/me/orders?page=2&limit=1',
    );
    expect(paged.status).toBe(200);
    expect(paged.body.data.page).toBe(2);
    expect(paged.body.data.limit).toBe(1);
    expect(paged.body.data.total).toBe(2);
    expect(paged.body.data.totalPages).toBe(2);
    expect(paged.body.data.data).toHaveLength(1);
    expect(paged.body.data.data[0].id).toBe(olderId);
  });

  // =========================================================================
  // The snapshots are the point
  // =========================================================================

  it('a later price change or rename does not rewrite a placed order', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      { title: 'Original Title', basePrice: 500_000 },
      { stock: 10, price: 400_000, sku: 'ORIGINAL-SKU' },
    );
    const orderId = await placeOrder(shopper, product.id, variant.id, 2);

    const before = await withCookies(app, shopper.jar).get(
      `/me/orders/${orderId}`,
    );
    expect(before.body.data.items[0].unitPrice).toBe(400_000);
    expect(before.body.data.subtotal).toBe(800_000);

    /**
     * Re-price and rename the LIVE catalogue rows, exactly as a merchandiser
     * would. `order_items.*Snapshot` and `order_items.unit_price` are immutable
     * historical facts and must not move with them — which is only true if the
     * projection reads the snapshot columns and never the (still loadable)
     * `product` / `variant` relations.
     */
    await app.dataSource.query(
      `UPDATE product_variants SET price = $2, sku = $3 WHERE id = $1`,
      [variant.id, 999_000, 'RENAMED-SKU'],
    );
    await app.dataSource.query(
      `UPDATE products SET title = $2, "basePrice" = $3 WHERE id = $1`,
      [product.id, 'Renamed Title', 1_500_000],
    );

    const after = await withCookies(app, shopper.jar).get(
      `/me/orders/${orderId}`,
    );
    expect(after.status).toBe(200);
    const item = after.body.data.items[0];
    expect(item.unitPrice).toBe(400_000);
    expect(item.totalPrice).toBe(800_000);
    expect(item.productTitleSnapshot).toBe('Original Title');
    expect(item.variantSkuSnapshot).toBe('ORIGINAL-SKU');
    expect(after.body.data.subtotal).toBe(800_000);
    expect(after.body.data.totalPrice).toBe(800_000);

    // Nothing from the live catalogue leaked in alongside the snapshot.
    expect(JSON.stringify(after.body)).not.toContain('Renamed Title');
    expect(JSON.stringify(after.body)).not.toContain('RENAMED-SKU');

    // Same in the list projection.
    const list = await withCookies(app, shopper.jar).get('/me/orders');
    expect(list.body.data.data[0].items[0].unitPrice).toBe(400_000);
    expect(list.body.data.data[0].items[0].productTitleSnapshot).toBe(
      'Original Title',
    );
  });

  // =========================================================================
  // Ownership
  // =========================================================================

  it("another customer's order still answers 404, not 403, and never appears in their list", async () => {
    const victim = await makeShopper();
    const attacker = await makeShopper();

    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      {},
      { stock: 10, price: 100_000 },
    );
    const orderId = await placeOrder(victim, product.id, variant.id, 1);
    await stampInternalState(orderId, 'LEAK-SENTINEL-FOREIGN');

    /**
     * 404 AND NOT 403. A 403 would confirm the id exists, and `orders.id` is a
     * plain sequence — so a customer could walk it one integer at a time and
     * learn how many orders the shop takes. The controller comment says so; it
     * is asserted here so the projection work cannot have quietly changed it.
     */
    const foreign = await withCookies(app, attacker.jar).get(
      `/me/orders/${orderId}`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.success).toBe(false);
    expect(foreign.body.statusCode).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-SENTINEL');

    // Indistinguishable from an id that never existed.
    const missing = await withCookies(app, attacker.jar).get(
      '/me/orders/999999',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe(foreign.body.message);

    const list = await withCookies(app, attacker.jar).get('/me/orders');
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(0);
    expect(list.body.data.data).toEqual([]);
  });
});
