/**
 * ===========================================================================
 * A DEACTIVATED VARIANT IS SELLABLE NOWHERE
 * ===========================================================================
 *
 * THE ONE RULE, stated once and enforced once:
 *
 *   Raw physical availability remains visible for inventory management, but
 *   `isActive = false` makes the variant unsellable through both Storefront
 *   and POS.
 *
 * ## What was wrong
 *
 * The POS sale gate compared the request against `snapshot.availableForPos`,
 * which is deliberately RAW -- unclamped and `isActive`-blind, because the
 * same number is what an administrator reconciles shelf stock against. A
 * retired SKU with units in the stockroom therefore reported a positive
 * sellable quantity and `POST /orders/pos` sold it. The POS catalogue omitted
 * it and the till would not offer it, but neither of those is a control: a
 * direct API call, a replayed request or a till holding a page from before the
 * retirement all reached the same gate and passed it.
 *
 * ## Where it is enforced now
 *
 * `InventoryService.assertSellableUnderLock`, called by `recordPosSale`
 * immediately after `lockVariants` and before anything at all is written, and
 * again inside `consumeForPosSale` (the one primitive that moves physical
 * stock) so no future caller can inherit the old behaviour by forgetting.
 *
 * Every assertion here goes through the HTTP boundary, because the claim being
 * tested is about `POST /orders/pos` and not about a service method.
 */
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';

import { getTestDataSource, resetDb } from './setup/test-db';
import {
  createPosTestApp,
  posEmitted,
  resetPosEmitted,
  TestApp,
} from './support/pos.harness';
import {
  as,
  countMovements,
  countOrders,
  loginCashier,
  loginSuperAdmin,
  posKey,
  seedBranch,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';
import { ReservationKind } from 'src/modules/inventory/entities/stock-reservation.entity';

describe('POS sale — a deactivated variant is sellable nowhere (int)', () => {
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
    resetPosEmitted();
  });

  /** Retire a SKU the way an administrator does: one committed row update. */
  const deactivate = (variantId: number) =>
    ctx.dataSource.query(
      `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
      [variantId],
    );

  const reactivate = (variantId: number) =>
    ctx.dataSource.query(
      `UPDATE product_variants SET "isActive" = true WHERE id = $1`,
      [variantId],
    );

  const activeReservations = async (variantId: number): Promise<number> => {
    const [row]: Array<{ count: string }> = await ctx.dataSource.query(
      `SELECT COUNT(*)::text AS count
         FROM stock_reservations
        WHERE "variantId" = $1 AND status = 'active'`,
      [variantId],
    );
    return Number(row.count);
  };

  /** A live basket hold on `variantId`, planted directly so no sell path is used. */
  const plantBasketHold = async (
    variantId: number,
    userId: number,
    quantity: number,
  ): Promise<void> => {
    await ctx.dataSource.query(
      `INSERT INTO stock_reservations
         ("variantId", kind, status, quantity, "userId", "cartItemId", "orderId",
          "expiresAt", "createdAt")
       VALUES ($1, $2, 'active', $3, $4, NULL, NULL, now() + interval '4 hours', now())`,
      [variantId, ReservationKind.BASKET, quantity, userId],
    );
  };

  // =========================================================================
  // The refusal itself
  // =========================================================================

  it('refuses a sale of an inactive variant that has positive physical stock', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 9 });
    await deactivate(variant.id);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-stocked'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });

    // 409 and not 400: the request is well formed and would have succeeded
    // before the SKU was retired. Not `INSUFFICIENT_STOCK` either -- there are
    // nine units on the shelf, and telling the cashier otherwise would be a
    // lie about the one thing they can see.
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.details?.code).toBe('VARIANT_INACTIVE');
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(9);
    expect(await countOrders(ctx.dataSource)).toBe(0);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
  });

  it('carries only safe identifying details: variantId, sku, retryable=false', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, {
      price: 400_000,
      stock: 6,
      sku: 'TILL-DEACTIVATED-01',
    });
    await deactivate(variant.id);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-details'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      });

    expect(res.status).toBe(409);
    const details = res.body.details ?? {};
    expect(details.variantId).toBe(variant.id);
    expect(details.sku).toBe('TILL-DEACTIVATED-01');
    // Retrying cannot help; only reactivation can. The till says so instead of
    // offering a retry button that is guaranteed to fail.
    expect(details.retryable).toBe(false);

    /*
     * AND NOTHING ELSE. A refusal must not become a stock-inspection endpoint:
     * these are the fields the caller already had on the line it submitted.
     */
    expect(details.physicalStock).toBeUndefined();
    expect(details.basketReserved).toBeUndefined();
    expect(details.orderAllocated).toBeUndefined();
    expect(details.availableForPos).toBeUndefined();
    expect(details.available).toBeUndefined();
    expect(details.branchId).toBeUndefined();
    expect(details.cashierUserId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('reservation');
  });

  it('refuses an inactive variant that has no reservations at all, and creates none', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 250_000, stock: 4 });
    await deactivate(variant.id);
    expect(await activeReservations(variant.id)).toBe(0);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-noresv'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 4 }],
      });

    expect(res.status).toBe(409);
    expect(await activeReservations(variant.id)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);
  });

  it('does NOT displace another customer’s basket hold when the sale is refused', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { price: 300_000, stock: 3 });
    await plantBasketHold(variant.id, admin.userId, 3);
    await deactivate(variant.id);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-held'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 3 }],
      });

    /*
     * THE ORDER OF THE TWO GATES MATTERS HERE.
     *
     * A POS sale outranks basket holds: for an ACTIVE variant this request
     * would have revoked all three units from that customer's basket. Because
     * the sellability gate runs FIRST -- before lazy expiry, before
     * availability, before displacement -- the hold is untouched. Refusing
     * after displacing would have cost a customer their reservation for a sale
     * that never happened.
     */
    expect(res.status).toBe(409);
    expect(await activeReservations(variant.id)).toBe(1);
    const [hold]: Array<{ status: string; quantity: number }> =
      await ctx.dataSource.query(
        `SELECT status, quantity FROM stock_reservations WHERE "variantId" = $1`,
        [variant.id],
      );
    expect(hold.status).toBe('active');
    expect(Number(hold.quantity)).toBe(3);
  });

  it('refuses a variant submitted by id alone, with no catalogue read in between', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 120_000, stock: 2 });
    await deactivate(variant.id);

    /*
     * THE DIRECT-CALL CASE. The POS catalogue excludes inactive variants, so
     * the till cannot offer this SKU -- but the sale route accepts a bare
     * variant id and nothing forces a caller to have read the catalogue at
     * all. This is the request a stale till, a script or a curl makes.
     */
    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-direct'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.details?.code).toBe('VARIANT_INACTIVE');
    expect(await countOrders(ctx.dataSource)).toBe(0);
  });

  it('refuses duplicate rows of one inactive SKU as a single refusal', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 90_000, stock: 5 });
    await deactivate(variant.id);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-dupe'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: variant.id, quantity: 1 },
          { productVariantId: variant.id, quantity: 2 },
        ],
      });

    // Duplicate scans are aggregated before any gate runs, so this is one
    // request for 3 units of one variant and one refusal naming it once.
    expect(res.status).toBe(409);
    expect(res.body.details?.variantId).toBe(variant.id);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(5);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(0);
  });

  // =========================================================================
  // Atomicity across a multi-line sale
  // =========================================================================

  it('fails a mixed active/inactive multi-line sale ATOMICALLY', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const good = await seedVariant(ctx, { price: 200_000, stock: 7 });
    const retired = await seedVariant(ctx, { price: 300_000, stock: 7 });
    const alsoGood = await seedVariant(ctx, { price: 100_000, stock: 7 });
    await deactivate(retired.id);

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-mixed'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: good.id, quantity: 2 },
          { productVariantId: retired.id, quantity: 1 },
          { productVariantId: alsoGood.id, quantity: 3 },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.details?.variantId).toBe(retired.id);

    // No order, no line snapshots, no payment row...
    expect(await countOrders(ctx.dataSource)).toBe(0);
    // ...and not one unit moved on ANY line, including the two that were fine.
    expect(await stockOf(ctx.dataSource, good.id)).toBe(7);
    expect(await stockOf(ctx.dataSource, retired.id)).toBe(7);
    expect(await stockOf(ctx.dataSource, alsoGood.id)).toBe(7);
    expect(await countMovements(ctx.dataSource, good.id)).toBe(0);
    expect(await countMovements(ctx.dataSource, retired.id)).toBe(0);
    expect(await countMovements(ctx.dataSource, alsoGood.id)).toBe(0);
  });

  it('emits NO stock, POS-availability or public-availability frame for a refused sale', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const good = await seedVariant(ctx, { price: 200_000, stock: 5 });
    const retired = await seedVariant(ctx, { price: 200_000, stock: 5 });
    await deactivate(retired.id);
    resetPosEmitted();

    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-silent'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [
          { productVariantId: good.id, quantity: 1 },
          { productVariantId: retired.id, quantity: 1 },
        ],
      });

    expect(res.status).toBe(409);
    /*
     * A ROLLED-BACK TRANSACTION ANNOUNCES NOTHING.
     *
     * Every publisher on this path is post-commit by construction: the sale's
     * events are emitted from `createPosOrder` only after
     * `dataSource.transaction` resolves, and it did not. The assertion is that
     * the whole recorder is empty -- not that a particular event is missing --
     * because a frame for a change that never happened would tell every till
     * and every storefront to re-read a sale that does not exist.
     */
    expect(posEmitted()).toEqual([]);
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  it('lets a refused request be retried with the SAME key, and never replays a false success', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 3 });
    await deactivate(variant.id);
    const key = posKey('inactive-idem');
    const body = {
      paymentMethod: PaymentMethodEnum.CASH,
      items: [{ productVariantId: variant.id, quantity: 1 }],
    };

    const first = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', key)
      .send(body);
    expect(first.status).toBe(409);

    // The refusal rolled the whole transaction back INCLUDING the idempotency
    // claim, so the same key is free. It must answer 409 again -- never a
    // stored 201 for a sale that was never recorded.
    const second = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', key)
      .send(body);
    expect(second.status).toBe(409);
    expect(second.body.error ?? second.body.details?.code).toBe(
      'VARIANT_INACTIVE',
    );
    expect(await countOrders(ctx.dataSource)).toBe(0);

    // And once an administrator reactivates the SKU, that same key completes.
    await reactivate(variant.id);
    const third = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', key)
      .send(body);
    expect(third.status).toBe(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(2);
  });

  it('still replays an EARLIER SUCCESS after the variant is deactivated', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 4 });
    const key = posKey('inactive-replay');
    const body = {
      paymentMethod: PaymentMethodEnum.CASH,
      items: [{ productVariantId: variant.id, quantity: 1 }],
    };

    const sold = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', key)
      .send(body);
    expect(sold.status).toBe(201);

    await deactivate(variant.id);

    /*
     * THE RECEIPT IS HISTORY, NOT AN OFFER.
     *
     * The sale was valid when it committed, so a terminal retrying the same
     * key must get the same receipt back rather than a refusal -- otherwise a
     * retirement would turn a completed sale into an apparent failure and
     * invite the cashier to charge the customer twice.
     */
    const replay = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', key)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(sold.body.data.id);
    expect(replay.body.data.orderNumber).toBe(sold.body.data.orderNumber);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(3);
    expect(await countOrders(ctx.dataSource)).toBe(1);
  });

  // =========================================================================
  // The client cannot supply the answer
  // =========================================================================

  it('gives the client no way to assert sellability: the DTO refuses an isActive field', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 3 });
    await deactivate(variant.id);

    /*
     * `forbidNonWhitelisted` is what makes "the server rule does not depend on
     * a client-provided value" a property of the CONTRACT rather than a
     * promise about the implementation: there is no field to send. A till that
     * tried to vouch for the SKU is rejected before any handler runs.
     */
    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-dto'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        isActive: true,
        items: [{ productVariantId: variant.id, quantity: 1, isActive: true }],
      });

    expect(res.status).toBe(400);
    expect(await countOrders(ctx.dataSource)).toBe(0);
  });

  it('refuses a sale from a till holding pre-deactivation data', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 5 });

    // The till reads availability while the SKU is still sellable...
    const before = await as(ctx, cashier).get(
      `/inventory/availability?variantIds=${variant.id}`,
    );
    expect(before.status).toBe(200);
    expect(before.body.data[0].isActive).toBe(true);
    expect(before.body.data[0].availableForPos).toBe(5);

    // ...an administrator retires it while that page stays open...
    await deactivate(variant.id);

    // ...and the sale the till would have allowed is refused by the server.
    const res = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-stale'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.details?.code).toBe('VARIANT_INACTIVE');

    // The till can now see why, from the same endpoint it was already polling.
    const after = await as(ctx, cashier).get(
      `/inventory/availability?variantIds=${variant.id}`,
    );
    expect(after.body.data[0].isActive).toBe(false);
    // The RAW figure is unchanged on purpose: the units are still on the shelf
    // and inventory management still needs to see them.
    expect(after.body.data[0].availableForPos).toBe(5);
  });

  // =========================================================================
  // Lookup stays read-capable, and says it is not sellable
  // =========================================================================

  it('SKU lookup returns the retired variant, marked not sellable, with its true shelf stock', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, {
      price: 700_000,
      stock: 8,
      sku: 'TILL-LOOKUP-RETIRED',
    });
    await deactivate(variant.id);

    const res = await as(ctx, cashier).get(
      '/inventory/lookup?sku=TILL-LOOKUP-RETIRED',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    // The raw snapshot is retained so a cashier holding the box can reconcile
    // shelf stock...
    expect(res.body.data.availability.physicalStock).toBe(8);
    expect(res.body.data.availability.availableForPos).toBe(8);
    // ...and the sellability answer is stated explicitly, so nobody has to
    // reconstruct the rule from the number.
    expect(res.body.data.sellableInStore).toBe(false);
    expect(res.body.data.sellableOnline).toBe(false);
    expect(res.body.data.unsellableReason).toBe('variant_inactive');

    // Selling the id the lookup just returned is still refused.
    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-after-lookup'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: res.body.data.variantId, quantity: 1 }],
      });
    expect(sale.status).toBe(409);
    expect(sale.body.error ?? sale.body.details?.code).toBe('VARIANT_INACTIVE');
  });

  it('distinguishes a retired SKU from an active one that has simply run out', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const empty = await seedVariant(ctx, {
      price: 700_000,
      stock: 0,
      sku: 'TILL-LOOKUP-EMPTY',
    });

    const res = await as(ctx, cashier).get(
      '/inventory/lookup?sku=TILL-LOOKUP-EMPTY',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.sellableInStore).toBe(false);
    // Two different refusals with two different remedies: restock, versus
    // reactivate. `variant_inactive` outranks this one when both are true.
    expect(res.body.data.unsellableReason).toBe('no_units_available');
    expect(empty.id).toBe(res.body.data.variantId);

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('empty-active'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: empty.id, quantity: 1 }],
      });
    expect(sale.status).toBe(409);
    expect(sale.body.error ?? sale.body.details?.code).toBe(
      'INSUFFICIENT_STOCK',
    );
  });

  // =========================================================================
  // Restores put units back without making them sellable
  // =========================================================================

  it('a VOID of an earlier sale restores stock to a now-retired variant, which stays unsellable', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 4 });

    const sold = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('void-then-retire'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 4 }],
      });
    expect(sold.status).toBe(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(0);

    await deactivate(variant.id);

    const voided = await as(ctx, admin)
      .post(`/orders/${sold.body.data.id}/void`)
      .send({ reason: 'integration: void after retirement' });
    expect(voided.status).toBe(200);

    /*
     * THE RESTORE MUST STILL WORK. Retiring a SKU must not trap units in a
     * mistaken sale: the reversal is a stock correction, not a sale, so it is
     * not subject to the sellability gate.
     */
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);

    // And the restored units are sellable nowhere.
    const resale = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('void-then-resell'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(resale.status).toBe(409);
    expect(resale.body.error ?? resale.body.details?.code).toBe(
      'VARIANT_INACTIVE',
    );
  });

  it('a RETURN behaves the same way: units come back, sellability does not', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { price: 250_000, stock: 2 });

    const sold = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('return-then-retire'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      });
    expect(sold.status).toBe(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(0);

    await deactivate(variant.id);

    const returned = await as(ctx, admin)
      .post(`/orders/${sold.body.data.id}/return`)
      .send({ reason: 'integration: customer brought it back' });
    expect(returned.status).toBe(200);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(2);

    const resale = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('return-then-resell'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(resale.status).toBe(409);
  });

  // =========================================================================
  // Reactivation
  // =========================================================================

  it('reactivation restores sellability and leaves historical records untouched', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 5 });

    const before = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('reactivate-before'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(before.status).toBe(201);

    const historyBefore: Array<{
      id: number;
      quantity: number;
      unit_price: string | number;
      variantSkuSnapshot: string | null;
    }> = await ctx.dataSource.query(
      `SELECT id, quantity, unit_price, "variantSkuSnapshot"
         FROM order_items ORDER BY id ASC`,
    );
    const movementsBefore = await countMovements(ctx.dataSource, variant.id);

    await deactivate(variant.id);
    const refused = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('reactivate-during'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(refused.status).toBe(409);

    await reactivate(variant.id);
    const after = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('reactivate-after'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(after.status).toBe(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(3);

    /*
     * THE EARLIER RECEIPT IS UNCHANGED. Deactivation and reactivation are
     * catalogue state, not history: the first sale's line snapshot, price and
     * movement rows are exactly as they were, and the refused attempt in
     * between left nothing behind.
     */
    const historyAfter: typeof historyBefore = await ctx.dataSource.query(
      `SELECT id, quantity, unit_price, "variantSkuSnapshot"
         FROM order_items ORDER BY id ASC`,
    );
    expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(await countMovements(ctx.dataSource, variant.id)).toBe(
      movementsBefore + 1,
    );
    expect(await countOrders(ctx.dataSource)).toBe(2);
  });

  // =========================================================================
  // The race
  // =========================================================================

  it('serialises a deactivation against a concurrent sale: the sale that loses the lock sees the NEW value', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 6 });

    /*
     * THE RACE, MADE DETERMINISTIC.
     *
     * An administrator's deactivation is `UPDATE product_variants SET
     * "isActive" = false WHERE id = $1`, which needs a row-level write lock on
     * exactly the row `lockVariants` takes `FOR UPDATE`. So the two operations
     * cannot interleave: one of them holds the row.
     *
     * Here the deactivation goes first and is held open, so the sale is
     * guaranteed to block. When it is released, the sale acquires the lock and
     * re-reads the row -- and the value it reads is the COMMITTED one, not the
     * one it could have seen before it blocked. That is the property under
     * test: the sale cannot act on a stale `isActive`.
     */
    const runner = ctx.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
      [variant.id],
    );

    const sale = as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('inactive-race'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });

    // Give the sale time to reach `lockVariants` and block there. A sleep is
    // not the assertion — the assertion is the 409 below, which can only
    // happen if the sale read the value this transaction committed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runner.commitTransaction();
    await runner.release();

    const res = await sale;
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.details?.code).toBe('VARIANT_INACTIVE');
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(6);
    expect(await countOrders(ctx.dataSource)).toBe(0);
  });

  it('a sale that commits BEFORE the deactivation is valid, and the next one is refused', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 6 });

    // The other order of the same race: the sale wins the lock. It is a valid
    // sale — the SKU was active when it committed — and the receipt stands.
    const sold = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('race-sale-first'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      });
    expect(sold.status).toBe(201);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);

    await deactivate(variant.id);

    const next = await as(ctx, cashier)
      .post('/orders/pos')
      .set('idempotency-key', posKey('race-sale-second'))
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 1 }],
      });
    expect(next.status).toBe(409);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(4);
    expect(await countOrders(ctx.dataSource)).toBe(1);
  });
});
