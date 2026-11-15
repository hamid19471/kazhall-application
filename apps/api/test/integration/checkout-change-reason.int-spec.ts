/**
 * ===========================================================================
 * WHY A BASKET LINE CHANGED — ONE REASON PER CONDITION
 * ===========================================================================
 *
 * THE DEFECT THIS SUITE EXISTS FOR.
 *
 * `CheckoutChangeKind.NOT_SELLABLE` and its message existed, and nothing could
 * produce them. Every other reason a line differs from what the customer last
 * saw leaves a record on the row — a POS sale or an expiry writes
 * `lastChangeReason`, a customer edit moves `quantity`, a re-price moves the
 * locked price. Deactivating a variant moves NONE of them: the hold is not
 * released, the quantity is untouched, the price is untouched.
 *
 * So the one change a customer can do nothing about was the one they were never
 * told about. The basket screen rendered a retired SKU as an ordinary buyable
 * line (with a POSITIVE `availableForBasket`, because that figure is
 * deliberately `isActive`-blind), the quote fingerprint could not see it
 * (`variantId:quantity:unitPrice` only), and checkout refused at the allocation
 * boundary with a bare `409 VARIANT_INACTIVE` and no diff. A line that had ALSO
 * shrunk for some other reason was worse: it was explained as an expired hold,
 * which invites the customer to add the item again — and the inventory gate
 * refuses that too.
 *
 * WHAT IS ASSERTED HERE. That each condition produces its OWN reason, that the
 * retired-SKU reason is derived from current state rather than stored, that it
 * outranks a stale recorded reason, that the authoritative refusal is still
 * `409 VARIANT_INACTIVE`, and that the notice leaks nothing.
 */
import { randomUUID } from 'node:crypto';

import { CheckoutChangeKind } from 'src/common/constants/checkout.messages';
import { CartLineChangeReason } from 'src/modules/cart/entities/cart-item.entity';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  createBranch,
  createOrderLine,
  createProductWithVariant,
  createUser,
} from './setup/seed-helpers';

describe('basket change reasons', () => {
  let app: TestApp;

  interface Shopper {
    userId: number;
    jar: CookieJar;
    addressId: number;
  }

  const KEY = () => `chg-${randomUUID()}`;

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

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

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

  async function stocked(quantity: number, price = 500_000) {
    return createProductWithVariant(
      app.dataSource,
      {},
      { stock: quantity, price },
    );
  }

  async function addToBasket(
    shopper: Shopper,
    productId: number,
    variantId: number,
    quantity: number,
  ): Promise<number> {
    const response = await withCookies(app, shopper.jar)
      .post('/cart')
      .send({ productId, variantId, quantity });
    expect([200, 201]).toContain(response.status);
    return Number(response.body.data.id);
  }

  const deactivate = (variantId: number) =>
    app.dataSource.query(
      `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
      [variantId],
    );

  const reactivate = (variantId: number) =>
    app.dataSource.query(
      `UPDATE product_variants SET "isActive" = true WHERE id = $1`,
      [variantId],
    );

  /** `GET /cart` exactly as the storefront reads it. */
  async function readCart(shopper: Shopper) {
    const response = await withCookies(app, shopper.jar).get('/cart');
    expect(response.status).toBe(200);
    return response.body as {
      data: Array<{
        id: number;
        quantity: number;
        availableForBasket: number | null;
        change: {
          reason: string;
          message: string;
          at: string | null;
          quantityDelta: number | null;
        } | null;
      }>;
      notices: Array<{ id: number; change: { reason: string } | null }>;
    };
  }

  async function quote(shopper: Shopper) {
    return withCookies(app, shopper.jar).post('/orders/quote');
  }

  function checkout(shopper: Shopper, quoteToken: string, key = KEY()) {
    return withCookies(app, shopper.jar)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ address: shopper.addressId, quoteToken });
  }

  /** A real POS sale, which is what makes displacement a POS displacement. */
  async function posConsume(variantId: number, quantity: number) {
    const inventory = app.app.get(InventoryService);
    const branch = await createBranch(app.dataSource);
    const cashier = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
      branchId: branch.id,
    });
    const [order] = await app.dataSource.query(
      `INSERT INTO orders (channel, status, "branchId", "cashierUserId", subtotal, total_price, "soldAt")
       VALUES ('pos', 'paid', $1, $2, 0, 0, now()) RETURNING id`,
      [branch.id, cashier.user.id],
    );
    // The sale's line: consumeForPosSale allocates COGS to the order's
    // pending lines and requires they cover exactly the consumed quantity.
    await createOrderLine(
      app.dataSource,
      Number(order.id),
      variantId,
      quantity,
    );
    await app.dataSource.transaction((manager) =>
      inventory.consumeForPosSale(manager, {
        items: [{ variantId, quantity }],
        orderId: Number(order.id),
        actorUserId: cashier.user.id,
        actorDisplaySnapshot: 'Cashier',
        branchId: branch.id,
      }),
    );
  }

  /** Age every hold on the line past its expiry, then let lazy expiry run. */
  async function expireHolds(variantId: number) {
    await app.dataSource.query(
      `UPDATE stock_reservations
          SET "expiresAt" = now() - interval '1 minute'
        WHERE "variantId" = $1 AND kind = 'basket' AND status = 'active'`,
      [variantId],
    );
    const inventory = app.app.get(InventoryService);
    await app.dataSource.transaction((manager) =>
      inventory.expireDueReservations(manager, { variantIds: [variantId] }),
    );
  }

  const lineReason = (
    cart: Awaited<ReturnType<typeof readCart>>,
    cartItemId: number,
  ) => cart.data.find((line) => line.id === cartItemId)?.change?.reason ?? null;

  // =========================================================================
  // 1. Deactivated while the customer is looking at their basket
  // =========================================================================

  it('reports NOT_SELLABLE on GET /cart when the variant is deactivated', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(5);
    const lineId = await addToBasket(shopper, product.id, variant.id, 2);

    // Before: an ordinary line, nothing to explain.
    const before = await readCart(shopper);
    expect(lineReason(before, lineId)).toBeNull();
    expect(before.data[0].availableForBasket).toBe(3);

    await deactivate(variant.id);

    const after = await readCart(shopper);
    const line = after.data.find((row) => row.id === lineId)!;
    expect(line.change?.reason).toBe(CartLineChangeReason.NOT_SELLABLE);
    /*
     * The line is STILL THERE with its units still held. Deactivation releases
     * nothing, so reporting a quantity change — or removing the row — would
     * describe something that did not happen.
     */
    expect(line.quantity).toBe(2);
    expect(line.change?.at).toBeNull();
    expect(line.change?.quantityDelta).toBeNull();
    /*
     * And it can no longer be added to. `availableForBasket` is the SELLABILITY
     * figure here, so it is 0 even though three units are physically free —
     * otherwise the quantity stepper invites an increase the server refuses.
     */
    expect(line.availableForBasket).toBe(0);
  });

  it('derives the reason from CURRENT state rather than storing it', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(4);
    const lineId = await addToBasket(shopper, product.id, variant.id, 1);
    await deactivate(variant.id);

    expect(lineReason(await readCart(shopper), lineId)).toBe(
      CartLineChangeReason.NOT_SELLABLE,
    );

    /*
     * NOTHING WAS WRITTEN. Every other reason lives in
     * `cart_items.lastChangeReason`; this one must not, because it would
     * survive reactivation as a lie about a line that is perfectly buyable
     * again. If this assertion ever fails, some path has started persisting it.
     */
    const [row] = await app.dataSource.query(
      `SELECT "lastChangeReason", "lastChangeAt", "lastChangeQtyDelta", status
         FROM cart_items WHERE id = $1`,
      [lineId],
    );
    expect(row.lastChangeReason).toBeNull();
    expect(row.lastChangeAt).toBeNull();
    expect(row.lastChangeQtyDelta).toBeNull();
    expect(row.status).toBe('active');

    // Reactivating clears the notice on the very next read, with no write.
    await reactivate(variant.id);
    expect(lineReason(await readCart(shopper), lineId)).toBeNull();
  });

  it('survives a page reload: the reason is server-authoritative, not shown-once', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(3);
    const lineId = await addToBasket(shopper, product.id, variant.id, 1);
    await deactivate(variant.id);

    /*
     * A soft-removed line's stored notice is CLEARED by `GET /cart` once it has
     * been shown, which is right for a one-off event. A retired SKU is not an
     * event — it is a standing condition — so every reload must still report
     * it. Three reads, same answer.
     */
    for (const attempt of [1, 2, 3]) {
      expect(lineReason(await readCart(shopper), lineId)).toBe(
        CartLineChangeReason.NOT_SELLABLE,
      );
      expect(attempt).toBeGreaterThan(0);
    }
  });

  it('leaks no stock, reservation, staff, branch or other-customer detail', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(9);
    await addToBasket(shopper, product.id, variant.id, 1);

    // Another customer holds units of the same SKU, and a till sold some.
    const other = await makeShopper();
    await addToBasket(other, product.id, variant.id, 2);
    await posConsume(variant.id, 1);
    await deactivate(variant.id);

    const cart = await readCart(shopper);
    const change = cart.data[0].change!;
    expect(change.reason).toBe(CartLineChangeReason.NOT_SELLABLE);

    const serialised = JSON.stringify(change);
    for (const forbidden of [
      'cashier',
      'branch',
      'Cashier',
      'reservation',
      'userId',
      'stock',
      'physical',
      String(other.userId),
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    // The message says what to do, and does not invite a retry that the
    // inventory gate would refuse.
    expect(change.message).toContain('no longer available for sale');
    expect(change.message).not.toMatch(/try again|back in stock/i);
  });

  // =========================================================================
  // 2. Deactivated after the quote, before checkout
  // =========================================================================

  it('names NOT_SELLABLE in the quote notices when the variant is already retired', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(5);
    await addToBasket(shopper, product.id, variant.id, 2);
    await deactivate(variant.id);

    const response = await quote(shopper);
    expect(response.status).toBe(200);
    const notices = response.body.data.notices as Array<{
      kind: string;
      variantId: number | null;
      previousQuantity: number | null;
      currentQuantity: number | null;
    }>;
    const notice = notices.find((item) => item.variantId === variant.id)!;
    expect(notice.kind).toBe(CheckoutChangeKind.NOT_SELLABLE);
    // Quantities UNCHANGED: nothing was taken away.
    expect(notice.previousQuantity).toBe(2);
    expect(notice.currentQuantity).toBe(2);
  });

  it('still refuses the checkout with 409 VARIANT_INACTIVE, leaving no order', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(5);
    await addToBasket(shopper, product.id, variant.id, 2);

    // The quote is taken while the SKU is still sellable...
    const quoted = await quote(shopper);
    expect(quoted.status).toBe(200);
    const token = quoted.body.data.quote.token as string;

    // ...and the administrator retires it before the customer confirms.
    await deactivate(variant.id);

    const placed = await checkout(shopper, token);
    /*
     * THE AUTHORITATIVE REFUSAL IS UNCHANGED, and that is deliberate. The
     * deactivation does not move the quote fingerprint (it is
     * `variantId:quantity:unitPrice` plus totals), so this is not a stale
     * quote; it is a basket that may not be sold. The classification work in
     * this suite explains the condition to the customer — it does not take
     * over the refusal.
     */
    expect(placed.status).toBe(409);
    expect(placed.body.error ?? placed.body.details?.code).toBe(
      'VARIANT_INACTIVE',
    );

    const [{ orders }] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS orders FROM orders WHERE channel = 'online'`,
    );
    expect(Number(orders)).toBe(0);

    // The hold is intact — the refusal rolled everything back — and the cart
    // still explains why.
    const cart = await readCart(shopper);
    expect(cart.data[0].quantity).toBe(2);
    expect(cart.data[0].change?.reason).toBe(CartLineChangeReason.NOT_SELLABLE);
  });

  // =========================================================================
  // 3. The other reasons keep their own meaning
  // =========================================================================

  it('an expired reservation is still reservation_expired', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(4);
    const lineId = await addToBasket(shopper, product.id, variant.id, 2);

    await expireHolds(variant.id);

    const cart = await readCart(shopper);
    // Fully expired, so the line is soft-removed and arrives in `notices`.
    const notice = cart.notices.find((row) => row.id === lineId)!;
    expect(notice.change?.reason).toBe(
      ReservationReleaseReason.RESERVATION_EXPIRED,
    );
    expect(notice.change?.reason).not.toBe(CartLineChangeReason.NOT_SELLABLE);
  });

  it('a POS displacement is still sold_in_store', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(3);
    const lineId = await addToBasket(shopper, product.id, variant.id, 3);

    // The till takes two of the three units the customer was holding.
    await posConsume(variant.id, 2);

    const cart = await readCart(shopper);
    const line = cart.data.find((row) => row.id === lineId)!;
    expect(line.change?.reason).toBe(ReservationReleaseReason.SOLD_IN_STORE);
    expect(line.quantity).toBe(1);
    expect(line.change?.quantityDelta).toBe(-2);
  });

  it('a quantity the CUSTOMER reduced still produces no notice at all', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(5);
    const lineId = await addToBasket(shopper, product.id, variant.id, 3);

    const reduced = await withCookies(app, shopper.jar)
      .patch(`/cart/${lineId}`)
      .send({ quantity: 1 });
    expect(reduced.status).toBe(200);

    /*
     * `quantity_reduced` keeps its meaning by keeping its silence: the customer
     * asked for this, so a notice would be noise. Asserted here because the new
     * derived reason must not have made every line noisy.
     */
    const cart = await readCart(shopper);
    expect(lineReason(cart, lineId)).toBeNull();
    expect(cart.notices).toHaveLength(0);
  });

  // =========================================================================
  // 4. Precedence, and what reactivation does NOT do
  // =========================================================================

  it('NOT_SELLABLE outranks a stale sold_in_store on the same line', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(3);
    const lineId = await addToBasket(shopper, product.id, variant.id, 3);

    await posConsume(variant.id, 2); // records sold_in_store, leaves 1 held
    await deactivate(variant.id);

    /*
     * BOTH are true. "Two units were sold in store" explains how the line
     * shrank and invites the customer to re-add them — which
     * `assertSellableUnderLock` refuses. "This can no longer be sold" is the
     * only reason that tells them what to do with the unit still in the basket,
     * so it wins. The precedence is pinned here so it cannot drift silently.
     */
    const cart = await readCart(shopper);
    const line = cart.data.find((row) => row.id === lineId)!;
    expect(line.change?.reason).toBe(CartLineChangeReason.NOT_SELLABLE);
    expect(line.quantity).toBe(1);

    // The record of what happened is untouched underneath — nothing was
    // rewritten, so reactivation restores the true story.
    const [row] = await app.dataSource.query(
      `SELECT "lastChangeReason" FROM cart_items WHERE id = $1`,
      [lineId],
    );
    expect(row.lastChangeReason).toBe(ReservationReleaseReason.SOLD_IN_STORE);

    await reactivate(variant.id);
    const restored = await readCart(shopper);
    expect(restored.data.find((r) => r.id === lineId)!.change?.reason).toBe(
      ReservationReleaseReason.SOLD_IN_STORE,
    );
  });

  it('reactivation does not restore an expired reservation', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(4);
    const lineId = await addToBasket(shopper, product.id, variant.id, 2);

    await deactivate(variant.id);
    await expireHolds(variant.id);
    await reactivate(variant.id);

    /*
     * The hold is GONE and reactivating the SKU does not bring it back: the
     * units went back to stock and may already be held by somebody else. The
     * customer is told their hold expired — which is true — and must add the
     * item again.
     */
    const cart = await readCart(shopper);
    expect(cart.data.find((row) => row.id === lineId)).toBeUndefined();
    const notice = cart.notices.find((row) => row.id === lineId)!;
    expect(notice.change?.reason).toBe(
      ReservationReleaseReason.RESERVATION_EXPIRED,
    );

    const [held] = await app.dataSource.query(
      `SELECT COUNT(*)::int AS live FROM stock_reservations
        WHERE "cartItemId" = $1 AND status = 'active'`,
      [lineId],
    );
    expect(Number(held.live)).toBe(0);
  });

  it('a deleted variant follows the existing safe fallback, not NOT_SELLABLE', async () => {
    const shopper = await makeShopper();
    const { product, variant } = await stocked(3);
    const lineId = await addToBasket(shopper, product.id, variant.id, 1);

    /*
     * A line whose variant row has gone entirely is the pre-existing
     * historically-invalid case, and it keeps its pre-existing contract:
     * `variant: null`, no fabricated reason. Deriving NOT_SELLABLE from a
     * MISSING row would explain a data-integrity problem as a business
     * decision.
     */
    await app.dataSource.query(
      `DELETE FROM stock_reservations WHERE "variantId" = $1`,
      [variant.id],
    );
    await app.dataSource.query(`DELETE FROM product_variants WHERE id = $1`, [
      variant.id,
    ]);

    const cart = await readCart(shopper);
    const line = cart.data.find((row) => row.id === lineId);
    if (line !== undefined) {
      expect(line.change?.reason).not.toBe(CartLineChangeReason.NOT_SELLABLE);
    }
    expect(product.id).toBeGreaterThan(0);
  });
});
