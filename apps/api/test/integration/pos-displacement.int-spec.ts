import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';
import { InsufficientStockError } from 'src/modules/inventory/inventory.types';
import { CartItemStatus } from 'src/modules/cart/entities/cart-item.entity';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  cartRows,
  createInventoryHarness,
  makeBranch,
  makeCatalog,
  makePosOrder,
  makeUser,
  movementRows,
  physicalStock,
  reservationRows,
} from './support/inventory.harness';

const CASHIER = {
  actorUserId: 0,
  actorDisplaySnapshot: 'Cashier Sara',
  branchId: 1,
};

/**
 * Acceptance tests 15-18 -- the POS priority path.
 *
 * POS may displace BASKET reservations. It may never touch ORDER allocations.
 * It takes free stock first, displaces only the minimum necessary, and the
 * whole thing is one transaction (R6).
 */
describe('POS displacement (15-18)', () => {
  let h: InventoryHarness;
  let cashierId: number;
  let shopperA: number;
  let shopperB: number;
  let catalog: Catalog;
  let branchId: number;

  beforeEach(async () => {
    h = await createInventoryHarness();
    branchId = await makeBranch(h.dataSource, `Store ${Date.now()}`);
    cashierId = await makeUser(h.dataSource, `cashier-${Date.now()}`);
    shopperA = await makeUser(h.dataSource, `alice-${Date.now()}`);
    shopperB = await makeUser(h.dataSource, `bob-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);
    CASHIER.actorUserId = cashierId;
    CASHIER.branchId = branchId;
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // 15
  // ==========================================================================
  it('15 - a POS sale served by free stock changes no basket at all', async () => {
    // 10 on the shelf, 3 held by a customer => 7 free.
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 3,
      },
      shopperA,
    );
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 5 },
    ]);

    const result = await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 5 }],
        orderId,
        ...CASHIER,
      }),
    );

    // Baseline rule 2: no basket was touched because none needed to be.
    expect(result.affectedBasketLines).toEqual([]);
    expect(result.consumed).toEqual([
      {
        variantId: catalog.variantId,
        quantityConsumed: 5,
        balanceAfter: 5,
        fromFreeStock: 5,
        fromDisplacedBaskets: 0,
      },
    ]);

    // R2: balanceAfter is the COMMITTED value from `UPDATE ... RETURNING`.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(5);
    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toEqual([
      expect.objectContaining({
        delta: -5,
        balanceAfter: 5,
        reason: 'pos_sale',
        orderId,
      }),
    ]);

    // The customer's hold survived, untouched and unexplained.
    const rows = await cartRows(h.dataSource, shopperA);
    expect(rows).toEqual([
      expect.objectContaining({
        id: line.id,
        quantity: 3,
        status: CartItemStatus.ACTIVE,
        lastChangeReason: null,
      }),
    ]);
  });

  // ==========================================================================
  // 16
  // ==========================================================================
  it('16 - a POS sale needing reserved stock revokes only the minimum necessary quantity', async () => {
    // 10 on the shelf. Alice holds 4, Bob holds 4 => 2 free.
    const aliceLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      shopperA,
    );
    const bobLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      shopperB,
    );
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 5 },
    ]);

    // Sell 5: 2 from free stock, 3 must come out of baskets.
    const result = await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 5 }],
        orderId,
        ...CASHIER,
      }),
    );

    expect(result.consumed[0]).toMatchObject({
      quantityConsumed: 5,
      fromFreeStock: 2,
      fromDisplacedBaskets: 3,
      balanceAfter: 5,
    });

    // Displacement order is (expiresAt ASC, id ASC): Alice reserved first, so
    // her tranche goes first. Exactly 3 units were taken -- not 4, not 8.
    const totalRevoked = result.affectedBasketLines.reduce(
      (sum, l) => sum + l.revokedQuantity,
      0,
    );
    expect(totalRevoked).toBe(3);
    expect(result.affectedBasketLines[0]).toMatchObject({
      cartItemId: aliceLine.id,
      userId: shopperA,
      revokedQuantity: 3,
      remainingQuantity: 1,
      lineRemoved: false,
      reason: ReservationReleaseReason.SOLD_IN_STORE,
    });

    // Both baskets were updated atomically with the sale.
    const alice = await cartRows(h.dataSource, shopperA);
    expect(alice[0]).toMatchObject({
      quantity: 1,
      status: CartItemStatus.ACTIVE,
      lastChangeReason: ReservationReleaseReason.SOLD_IN_STORE,
      lastChangeQtyDelta: -3,
    });

    const bob = await cartRows(h.dataSource, shopperB);
    expect(bob[0]).toMatchObject({
      id: bobLine.id,
      quantity: 4,
      lastChangeReason: null,
    });

    // Nothing is negative and nothing is double counted.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(5);
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)).toMatchObject({
      physicalStock: 5,
      basketReserved: 5, // Alice 1 + Bob 4
      orderAllocated: 0,
      availableForBasket: 0,
    });
  });

  it('16b - POS never displaces an ORDER allocation and fails loudly instead', async () => {
    // Alice checks out: 6 units become an ORDER allocation. 4 remain free.
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
      shopperA,
    );
    const checkoutOrderId = await makePosOrder(h.dataSource, null);
    await h.dataSource.transaction((m) =>
      h.inventory.convertBasketToOrderAllocation(m, {
        userId: shopperA,
        orderId: checkoutOrderId,
        items: [{ variantId: catalog.variantId, quantity: 6 }],
      }),
    );

    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    // availableForPos EXCLUDES the order allocation: 10 - 6 = 4.
    expect(availability.get(catalog.variantId)).toMatchObject({
      orderAllocated: 6,
      basketReserved: 0,
      availableForPos: 4,
      availableForBasket: 4,
    });

    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 5 },
    ]);
    await expect(
      h.dataSource.transaction((m) =>
        h.inventory.consumeForPosSale(m, {
          items: [{ variantId: catalog.variantId, quantity: 5 }],
          orderId: posOrderId,
          ...CASHIER,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // The whole transaction rolled back: no decrement, no movement, the
    // allocation is untouched.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
    const allocations = (
      await reservationRows(h.dataSource, catalog.variantId)
    ).filter((r) => r.kind === 'order');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ status: 'active', quantity: 6 });
  });

  // ==========================================================================
  // 17
  // ==========================================================================
  it('17 - partial displacement reduces the line; full displacement removes it with a customer-visible reason', async () => {
    // 10 on the shelf, all of it held: Alice 6, Bob 4 => 0 free.
    const aliceLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
      shopperA,
    );
    const bobLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      shopperB,
    );
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 8 },
    ]);

    // Sell 8: Alice's whole line (6) plus 2 of Bob's.
    const result = await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 8 }],
        orderId,
        ...CASHIER,
      }),
    );
    expect(result.consumed[0]).toMatchObject({
      fromFreeStock: 0,
      fromDisplacedBaskets: 8,
      balanceAfter: 2,
    });

    const byCartItem = new Map(
      result.affectedBasketLines.map((l) => [l.cartItemId, l]),
    );
    // FULL displacement -> line removed.
    expect(byCartItem.get(aliceLine.id)).toMatchObject({
      revokedQuantity: 6,
      remainingQuantity: 0,
      lineRemoved: true,
      reason: ReservationReleaseReason.SOLD_IN_STORE,
    });
    // PARTIAL displacement -> quantity reduced, line stays.
    expect(byCartItem.get(bobLine.id)).toMatchObject({
      revokedQuantity: 2,
      remainingQuantity: 2,
      lineRemoved: false,
    });

    const alice = await cartRows(h.dataSource, shopperA);
    expect(alice[0]).toMatchObject({
      status: CartItemStatus.REMOVED,
      quantity: 0,
      lastChangeReason: ReservationReleaseReason.SOLD_IN_STORE,
      lastChangeQtyDelta: -6,
    });

    const bob = await cartRows(h.dataSource, shopperB);
    expect(bob[0]).toMatchObject({
      status: CartItemStatus.ACTIVE,
      quantity: 2,
      lastChangeReason: ReservationReleaseReason.SOLD_IN_STORE,
      lastChangeQtyDelta: -2,
    });

    // The soft-removed line does not block Alice re-adding the product: the
    // unique index is partial on `status='active'`. (Bob frees his hold first
    // so there is stock to re-add -- the point here is the index, not scarcity.)
    await h.cart.remove(bobLine.id, shopperB);
    const readded = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 1,
      },
      shopperA,
    );
    expect(readded.id).not.toBe(aliceLine.id);
    expect(readded.quantity).toBe(1);
  });

  // ==========================================================================
  // 18
  // ==========================================================================
  it('18 - a failed POS transaction restores all previous basket, reservation and stock state', async () => {
    const aliceLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
      shopperA,
    );
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 8 },
    ]);

    const before = {
      stock: await physicalStock(h.dataSource, catalog.variantId),
      reservations: await reservationRows(h.dataSource, catalog.variantId),
      cart: await cartRows(h.dataSource, shopperA),
      movements: await movementRows(h.dataSource, catalog.variantId),
    };
    expect(before.stock).toBe(10);

    // Force a failure AFTER the sale has displaced a basket and decremented
    // stock, exactly as an unrelated bug in the caller's transaction would.
    await expect(
      h.dataSource.transaction(async (m) => {
        const result = await h.inventory.consumeForPosSale(m, {
          items: [{ variantId: catalog.variantId, quantity: 8 }],
          orderId,
          ...CASHIER,
        });
        // Prove the work really happened inside the transaction before we blow
        // it up -- otherwise this test would pass vacuously.
        expect(result.affectedBasketLines).toHaveLength(1);
        expect(await physicalStock(m, catalog.variantId)).toBe(2);
        throw new Error('receipt printer exploded');
      }),
    ).rejects.toThrow('receipt printer exploded');

    // R6: all of it, or none of it.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(
      before.stock,
    );
    expect(await reservationRows(h.dataSource, catalog.variantId)).toEqual(
      before.reservations,
    );
    expect(await cartRows(h.dataSource, shopperA)).toEqual(before.cart);
    expect(await movementRows(h.dataSource, catalog.variantId)).toEqual(
      before.movements,
    );

    // And the customer sees nothing, because nothing happened.
    const view = await h.cart.findAll(shopperA);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      id: aliceLine.id,
      quantity: 6,
      change: null,
    });
  });

  it('18b - a multi-SKU POS sale that runs short on its SECOND line rolls the first line back', async () => {
    const plenty = await makeCatalog(h.dataSource, `PLENTY-${Date.now()}`, 20);
    const scarce = await makeCatalog(h.dataSource, `SCARCE-${Date.now()}`, 1);
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: plenty.variantId, quantity: 5 },
      { variantId: scarce.variantId, quantity: 3 },
    ]);

    await expect(
      h.dataSource.transaction((m) =>
        h.inventory.consumeForPosSale(m, {
          items: [
            { variantId: plenty.variantId, quantity: 5 },
            { variantId: scarce.variantId, quantity: 3 },
          ],
          orderId,
          ...CASHIER,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect(await physicalStock(h.dataSource, plenty.variantId)).toBe(20);
    expect(await physicalStock(h.dataSource, scarce.variantId)).toBe(1);
    expect(await movementRows(h.dataSource)).toHaveLength(0);
  });
});
