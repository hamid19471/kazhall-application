import { BadRequestException } from '@nestjs/common';

import { CartMessages } from 'src/common/constants/cart.messages';
import { ProductMessages } from 'src/common/constants/product.messages';
import { CartItemStatus } from 'src/modules/cart/entities/cart-item.entity';
import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';
import { BASKET_RESERVATION_TTL_MS } from 'src/modules/inventory/inventory.types';

import { forceStockForTest } from './setup/seed-helpers';
import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  backdateReservations,
  cartRows,
  createInventoryHarness,
  makeBranch,
  makePosOrder,
  makeProduct,
  makeSimpleCatalog,
  makeUser,
  makeVariant,
  physicalStock,
  reservationRows,
} from './support/inventory.harness';

/**
 * ============================================================================
 * WORKSTREAM D -- the variant-less inventory bypass is closed.
 *
 * THE BUG THESE TESTS PIN DOWN. `CartService.create()` and
 * `updateQuantity()` used to branch on `variantId === null`. On that branch
 * they skipped `lockVariants`, skipped `InventoryService.reserveForBasket`
 * entirely, and just wrote a quantity -- "nothing to reserve, stock is not
 * tracked at product level". A physical product with no `product_variants` row
 * could therefore be added to any number of baskets in any quantity, was in NO
 * availability check, got NO four-hour hold, could not be displaced by a POS
 * sale, and reached checkout with nothing allocated.
 *
 * The fix is the uniform sellable-SKU model: every option-less product has one
 * DEFAULT variant (migration 0012), `cart_items."variantId"` is NOT NULL
 * (migration 0013), and a product-only basket request resolves to the default.
 *
 * Every test below therefore adds by PRODUCT ID ALONE -- the exact request
 * shape that used to take the bypass -- and asserts that it now behaves like
 * any other SKU.
 *
 * Real PostgreSQL throughout: row locks, partial unique indexes and guarded
 * conditional UPDATEs have no meaning against a mock.
 * ============================================================================
 */
describe('simple (option-less) products participate in inventory', () => {
  let h: InventoryHarness;
  let shopper: number;
  let simple: Catalog;

  beforeEach(async () => {
    h = await createInventoryHarness();
    shopper = await makeUser(h.dataSource, `simple-shopper-${Date.now()}`);
    // 5 counted units on one DEFAULT variant -- the shape both
    // `ProductsService.create()` and 0012's backfill produce.
    simple = await makeSimpleCatalog(h.dataSource, `SIMPLE-${Date.now()}`, 5);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // A real reservation, with a real timer
  // ==========================================================================
  it('adding a simple product by productId alone takes a REAL 4-hour reservation', async () => {
    const before = Date.now();
    const line = await h.cart.create(
      // No `variantId`. This is the request that used to bypass everything.
      { productId: simple.productId, quantity: 3 },
      shopper,
    );
    const after = Date.now();

    // It resolved to the default variant rather than storing a NULL.
    expect(line.variant).not.toBeNull();
    expect(line.variant!.id).toBe(simple.variantId);
    expect(line.quantity).toBe(3);
    expect(line.reservedQuantity).toBe(3);

    // A reservation row genuinely exists, with the owner-confirmed 4h TTL.
    const reservations = await reservationRows(h.dataSource, simple.variantId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      kind: 'basket',
      status: 'active',
      quantity: 3,
      cartItemId: line.id,
      orderId: null,
    });
    const expiresAt = new Date(reservations[0].expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + BASKET_RESERVATION_TTL_MS,
    );
    expect(expiresAt).toBeLessThanOrEqual(after + BASKET_RESERVATION_TTL_MS);

    // Availability really dropped: the hold is visible to everyone else.
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [simple.variantId]),
    );
    expect(availability.get(simple.variantId)).toMatchObject({
      physicalStock: 5,
      basketReserved: 3,
      orderAllocated: 0,
      availableForBasket: 2,
      availableForPos: 5,
    });

    // Holding is not selling.
    expect(await physicalStock(h.dataSource, simple.variantId)).toBe(5);
  });

  // ==========================================================================
  // The bypass itself
  // ==========================================================================
  it('a simple product can no longer be over-added beyond its stock', async () => {
    await h.cart.create({ productId: simple.productId, quantity: 5 }, shopper);

    // Under the bypass this simply wrote quantity = 6 and nobody objected.
    await expect(
      h.cart.create({ productId: simple.productId, quantity: 1 }, shopper),
    ).rejects.toBeInstanceOf(BadRequestException);

    // A single oversized request is refused for the same reason.
    const other = await makeUser(h.dataSource, `greedy-${Date.now()}`);
    await expect(
      h.cart.create({ productId: simple.productId, quantity: 99 }, other),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing partial was written by either refusal.
    const rows = await cartRows(h.dataSource);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 5, userId: shopper });
    const reservations = await reservationRows(h.dataSource, simple.variantId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(5);
  });

  it('an absolute quantity update on a simple product is also stock-checked', async () => {
    const line = await h.cart.create(
      { productId: simple.productId, quantity: 2 },
      shopper,
    );

    await expect(
      h.cart.updateQuantity(line.id, 9, shopper),
    ).rejects.toBeInstanceOf(BadRequestException);

    const updated = await h.cart.updateQuantity(line.id, 4, shopper);
    expect(updated!.reservedQuantity).toBe(4);
    // The invariant `cart_items.quantity === SUM(active reservations)` now
    // holds for simple products too; it used to be vacuous for them.
    const rows = await cartRows(h.dataSource, shopper);
    expect(rows[0].quantity).toBe(4);
  });

  // ==========================================================================
  // POS displacement now reaches simple products
  // ==========================================================================
  it('a POS sale DISPLACES a simple product basket line', async () => {
    const branchId = await makeBranch(h.dataSource, `Store ${Date.now()}`);
    const cashier = await makeUser(h.dataSource, `cashier-${Date.now()}`);

    const line = await h.cart.create(
      { productId: simple.productId, quantity: 4 },
      shopper,
    );
    // 5 on the shelf, 4 held => only 1 is free. The counter needs 3.
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: simple.variantId, quantity: 3 },
    ]);
    const result = await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: simple.variantId, quantity: 3 }],
        orderId,
        actorUserId: cashier,
        actorDisplaySnapshot: 'Cashier Sara',
        branchId,
      }),
    );

    // Under the bypass there was no reservation to displace, so the shop
    // assistant could not have sold these units at all without going negative.
    expect(result.consumed[0]).toMatchObject({
      variantId: simple.variantId,
      quantityConsumed: 3,
      balanceAfter: 2,
      fromFreeStock: 1,
      fromDisplacedBaskets: 2,
    });
    expect(result.affectedBasketLines).toEqual([
      expect.objectContaining({
        cartItemId: line.id,
        userId: shopper,
        variantId: simple.variantId,
        revokedQuantity: 2,
        remainingQuantity: 2,
        lineRemoved: false,
        reason: ReservationReleaseReason.SOLD_IN_STORE,
      }),
    ]);

    // The customer keeps the units that survived, and is TOLD about the rest.
    const rows = await cartRows(h.dataSource, shopper);
    expect(rows[0]).toMatchObject({
      quantity: 2,
      status: CartItemStatus.ACTIVE,
      lastChangeReason: ReservationReleaseReason.SOLD_IN_STORE,
      lastChangeQtyDelta: -2,
    });

    const view = await h.cart.findAll(shopper);
    expect(view.notices).toHaveLength(1);
    expect(view.notices[0].change).toMatchObject({
      reason: ReservationReleaseReason.SOLD_IN_STORE,
      quantityDelta: -2,
    });
    // PRIVACY: what happened, never who. No cashier, no branch.
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('Cashier Sara');
    expect(serialised).not.toContain('branch');
  });

  // ==========================================================================
  // The timer applies to simple products too
  // ==========================================================================
  it("a simple product's hold expires at 4 hours like any other", async () => {
    const line = await h.cart.create(
      { productId: simple.productId, quantity: 5 },
      shopper,
    );
    expect(line.expiresAt).not.toBeNull();

    await backdateReservations(h.dataSource, { cartItemId: line.id });

    const expired = await h.dataSource.transaction((m) =>
      h.inventory.expireDueReservations(m),
    );
    expect(expired).toEqual([
      expect.objectContaining({
        cartItemId: line.id,
        revokedQuantity: 5,
        remainingQuantity: 0,
        lineRemoved: true,
        reason: ReservationReleaseReason.RESERVATION_EXPIRED,
      }),
    ]);

    // Expiry releases the HOLD, never physical stock.
    expect(await physicalStock(h.dataSource, simple.variantId)).toBe(5);
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [simple.variantId]),
    );
    expect(availability.get(simple.variantId)!.availableForBasket).toBe(5);
  });

  // ==========================================================================
  // Refusals -- there must be no remaining way in without a SKU
  // ==========================================================================
  it('a product whose only variant was deactivated cannot be added to a basket', async () => {
    await h.dataSource.query(
      `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
      [simple.variantId],
    );

    await expect(
      h.cart.create({ productId: simple.productId, quantity: 1 }, shopper),
    ).rejects.toThrow(CartMessages.PRODUCT_NOT_SELLABLE);

    // Naming the retired variant explicitly is refused too, and with the
    // reason that is actually true.
    await expect(
      h.cart.create(
        {
          productId: simple.productId,
          variantId: simple.variantId,
          quantity: 1,
        },
        shopper,
      ),
    ).rejects.toThrow(ProductMessages.VARIANT_INACTIVE);

    expect(await cartRows(h.dataSource)).toHaveLength(0);
    expect(await reservationRows(h.dataSource)).toHaveLength(0);
  });

  it('a product sold BY OPTION still requires the customer to choose', async () => {
    const productId = await makeProduct(h.dataSource, 'T-shirt');
    await makeVariant(h.dataSource, productId, `RED-${Date.now()}`, 5);
    await makeVariant(h.dataSource, productId, `BLUE-${Date.now()}`, 5);

    // No default variant exists, so there is nothing to pick on the customer's
    // behalf -- guessing a colour would be worse than refusing.
    await expect(
      h.cart.create({ productId, quantity: 1 }, shopper),
    ).rejects.toThrow(CartMessages.VARIANT_REQUIRED_FOR_PRODUCT);
  });

  it('a variant belonging to a DIFFERENT product is still rejected', async () => {
    const other = await makeSimpleCatalog(
      h.dataSource,
      `OTHER-${Date.now()}`,
      5,
    );

    await expect(
      h.cart.create(
        {
          productId: simple.productId,
          variantId: other.variantId,
          quantity: 1,
        },
        shopper,
      ),
    ).rejects.toThrow(CartMessages.VARIANT_NOT_PART_OF_PRODUCT);
  });

  it('a 0-stock default variant is refused at the basket, not silently accepted', async () => {
    const empty = await makeSimpleCatalog(
      h.dataSource,
      `EMPTY-${Date.now()}`,
      0,
    );

    // This is the state migration 0012 leaves a backfilled product in: a live,
    // visible SKU with an honest count of zero.
    await expect(
      h.cart.create({ productId: empty.productId, quantity: 1 }, shopper),
    ).rejects.toThrow(/available 0/);
  });

  // ==========================================================================
  // What a customer with a PRE-EXISTING variant-less line actually sees.
  // ==========================================================================
  it('explains a line that migration 0013 soft-removed, exactly once', async () => {
    // The row shape migration 0013 leaves behind: repointed at the default
    // variant, soft-removed, quantity 0, carrying the reason. It has no
    // reservation, deliberately -- the default variant has no counted stock,
    // so a hold would be a hold on units that do not exist.
    const migrated = await makeSimpleCatalog(
      h.dataSource,
      `MIGRATED-${Date.now()}`,
      0,
    );
    const [row] = await h.dataSource.query<Array<{ id: number }>>(
      `INSERT INTO cart_items
         ("userId","productId","variantId","quantity","status",
          "lastChangeReason","lastChangeAt","lastChangeQtyDelta")
       VALUES ($1, $2, $3, 0, 'removed', 'stock_not_counted', now(), -3)
       RETURNING id`,
      [shopper, migrated.productId, migrated.variantId],
    );

    const first = await h.cart.findAll(shopper);
    // Not in `items` -- the line is gone. But it is explained.
    expect(first.items).toHaveLength(0);
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toMatchObject({
      id: Number(row.id),
      status: CartItemStatus.REMOVED,
      productId: migrated.productId,
      quantity: 0,
      reservedQuantity: 0,
    });
    expect(first.notices[0].change).toMatchObject({
      reason: 'stock_not_counted',
      quantityDelta: -3,
    });
    expect(first.notices[0].change!.message).toMatch(/no counted stock/i);

    // Shown ONCE. The tombstone stays (so the partial unique index still lets
    // the customer re-add the product) but the notice is spent.
    const second = await h.cart.findAll(shopper);
    expect(second.notices).toHaveLength(0);
    expect(second.items).toHaveLength(0);
    expect(await cartRows(h.dataSource, shopper)).toHaveLength(1);

    // And re-adding works the moment somebody counts the stock.
    await forceStockForTest(h.dataSource, migrated.variantId, 4);
    const readded = await h.cart.create(
      { productId: migrated.productId, quantity: 2 },
      shopper,
    );
    expect(readded.reservedQuantity).toBe(2);
  });
});
