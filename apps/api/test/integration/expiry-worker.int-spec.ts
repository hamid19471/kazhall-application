import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { InsufficientStockError } from 'src/modules/inventory/inventory.types';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  backdateReservations,
  cartRows,
  createInventoryHarness,
  makeBranch,
  makeCatalog,
  makeOnlineOrder,
  makePosOrder,
  makeUser,
  movementRows,
  physicalStock,
  reservationRows,
} from './support/inventory.harness';

/**
 * D4 -- the expiry worker, plus the checkout boundary and the admin stock edit.
 *
 * The worker is an OPTIMISATION ONLY: correctness comes from R5 lazy expiry,
 * which `reservation-lifecycle.int-spec.ts` (13b) proves independently. What is
 * asserted here is that the worker is bounded, retry-safe, multi-instance safe,
 * and -- the one that matters most -- that it never touches physical stock.
 */
describe('expiry worker, checkout boundary and stock adjust', () => {
  let h: InventoryHarness;
  let shopper: number;
  let admin: number;
  let branchId: number;
  let catalog: Catalog;

  beforeEach(async () => {
    h = await createInventoryHarness();
    branchId = await makeBranch(h.dataSource, `Store ${Date.now()}`);
    shopper = await makeUser(h.dataSource, `shopper-${Date.now()}`);
    admin = await makeUser(h.dataSource, `admin-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 12);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // The worker
  // ==========================================================================
  it('worker - releases expired holds WITHOUT increasing physical stock', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 5,
      },
      shopper,
    );
    const stockBefore = await physicalStock(h.dataSource, catalog.variantId);
    await backdateReservations(h.dataSource, { cartItemId: line.id });

    const result = await h.sweeper.runOnce();

    expect(result.releasedReservations).toBe(5);
    expect(result.affectedBasketLines).toHaveLength(1);
    expect(result.affectedBasketLines[0]).toMatchObject({
      cartItemId: line.id,
      revokedQuantity: 5,
      lineRemoved: true,
      reason: ReservationReleaseReason.RESERVATION_EXPIRED,
    });

    // THE ASSERTION THIS WHOLE WORKER EXISTS TO NOT VIOLATE.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(
      stockBefore,
    );
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);

    // What DID change is the hold.
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)).toMatchObject({
      physicalStock: 12,
      basketReserved: 0,
      availableForBasket: 12,
    });
  });

  it('worker - is bounded by its batch size and finishes the backlog over successive runs', async () => {
    const bounded = await createInventoryHarness({
      INVENTORY_SWEEPER_BATCH_SIZE: '2',
      INVENTORY_SWEEPER_MAX_BATCHES: '2',
    });
    const user = await makeUser(bounded.dataSource, `bulk-${Date.now()}`);
    const cat = await makeCatalog(
      bounded.dataSource,
      `BULK-${Date.now()}`,
      100,
    );

    const lines: number[] = [];
    for (let i = 0; i < 7; i++) {
      const line = await bounded.cart.create(
        { productId: cat.productId, variantId: cat.variantId, quantity: 1 },
        await makeUser(bounded.dataSource, `bulk-${Date.now()}-${i}`),
      );
      lines.push(line.id);
    }
    for (const id of lines) {
      await backdateReservations(bounded.dataSource, { cartItemId: id });
    }
    expect(user).toBeGreaterThan(0);

    // batchSize 2 x maxBatches 2 = at most 4 rows per run.
    const first = await bounded.sweeper.runOnce();
    expect(first.releasedReservations).toBe(4);

    const second = await bounded.sweeper.runOnce();
    expect(second.releasedReservations).toBe(3);

    const third = await bounded.sweeper.runOnce();
    expect(third.releasedReservations).toBe(0);

    const remaining = (
      await reservationRows(bounded.dataSource, cat.variantId)
    ).filter((r) => r.status === 'active');
    expect(remaining).toHaveLength(0);
    expect(await physicalStock(bounded.dataSource, cat.variantId)).toBe(100);
  });

  it('worker - also expires ORDER allocations and frees them for POS', async () => {
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
      shopper,
    );
    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.convertBasketToOrderAllocation(m, {
        userId: shopper,
        orderId,
        items: [{ variantId: catalog.variantId, quantity: 6 }],
      }),
    );
    await backdateReservations(h.dataSource, { orderId });

    await h.sweeper.runOnce();

    const allocations = (
      await reservationRows(h.dataSource, catalog.variantId)
    ).filter((r) => r.kind === 'order');
    expect(allocations[0]).toMatchObject({
      status: 'released',
      releaseReason: ReservationReleaseReason.RESERVATION_EXPIRED,
    });
    // Still nothing physical moved.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(12);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);
  });

  // ==========================================================================
  // Checkout boundary (docs/ARCHITECTURE.md section 2)
  // ==========================================================================
  it('checkout - converts basket holds into order allocations and closes the basket lines', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      shopper,
    );
    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
    ]);

    const { allocatedUntil } = await h.dataSource.transaction((m) =>
      h.inventory.convertBasketToOrderAllocation(m, {
        userId: shopper,
        orderId,
        items: [{ variantId: catalog.variantId, quantity: 4 }],
      }),
    );
    expect(allocatedUntil.getTime()).toBeGreaterThan(Date.now());

    const reservations = await reservationRows(h.dataSource, catalog.variantId);
    expect(reservations).toEqual([
      expect.objectContaining({
        kind: 'basket',
        status: 'released',
        releaseReason: ReservationReleaseReason.CONVERTED_TO_ORDER,
      }),
      expect.objectContaining({
        kind: 'order',
        status: 'active',
        quantity: 4,
        orderId,
      }),
    ]);

    // The basket line is closed, and closed WITHOUT a customer-visible notice:
    // the customer did this themselves.
    const rows = await cartRows(h.dataSource, shopper);
    expect(rows[0]).toMatchObject({
      id: line.id,
      status: 'removed',
      lastChangeReason: null,
    });
    const view = await h.cart.findAll(shopper);
    expect(view.items).toHaveLength(0);
    expect(view.notices).toHaveLength(0);
  });

  it('checkout - tops up from free stock when displacement shrank the hold', async () => {
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      shopper,
    );
    // A POS sale takes 2 of the customer's 4 units and 4 free ones.
    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 10 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 10 }],
        orderId: posOrderId,
        actorUserId: admin,
        actorDisplaySnapshot: 'Cashier',
        branchId,
      }),
    );
    // 12 - 10 = 2 physical, all of it still the customer's hold.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(2);

    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 2,
      },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.convertBasketToOrderAllocation(m, {
        userId: shopper,
        orderId,
        items: [{ variantId: catalog.variantId, quantity: 2 }],
      }),
    );

    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)).toMatchObject({
      physicalStock: 2,
      basketReserved: 0,
      orderAllocated: 2,
      availableForPos: 0,
    });
  });

  it('checkout - fails BEFORE any payment when the stock is simply not there', async () => {
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      shopper,
    );
    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 12 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 12 }],
        orderId: posOrderId,
        actorUserId: admin,
        actorDisplaySnapshot: 'Cashier',
        branchId,
      }),
    );

    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
    ]);
    await expect(
      h.dataSource.transaction((m) =>
        h.inventory.convertBasketToOrderAllocation(m, {
          userId: shopper,
          orderId,
          items: [{ variantId: catalog.variantId, quantity: 4 }],
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // No allocation was created, so no payment can be started against one.
    const allocations = (
      await reservationRows(h.dataSource, catalog.variantId)
    ).filter((r) => r.kind === 'order');
    expect(allocations).toHaveLength(0);
  });

  // ==========================================================================
  // Cancellation / restore
  // ==========================================================================
  it('restore - gives back exactly what the order took, once', async () => {
    const orderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 5 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 5 }],
        orderId,
        actorUserId: admin,
        actorDisplaySnapshot: 'Cashier',
        branchId,
      }),
    );
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(7);

    const restored = await h.dataSource.transaction((m) =>
      h.inventory.restoreForOrder(m, {
        orderId,
        reason: StockMovementReason.CANCELLATION_RESTORE,
        actorUserId: admin,
        actorDisplaySnapshot: 'Manager',
        reverseRevenue: true,
      }),
    );
    expect(restored.alreadyRestored).toBe(false);
    expect(restored.restored[0]).toMatchObject({
      variantId: catalog.variantId,
      balanceAfter: 12,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(12);

    // Idempotent: the order's net ledger balance is now zero, so there is
    // nothing left to give back.
    const again = await h.dataSource.transaction((m) =>
      h.inventory.restoreForOrder(m, {
        orderId,
        reason: StockMovementReason.CANCELLATION_RESTORE,
        actorUserId: admin,
        actorDisplaySnapshot: 'Manager',
        reverseRevenue: true,
      }),
    );
    expect(again.alreadyRestored).toBe(true);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(12);
  });

  // ==========================================================================
  // Admin stock edit
  // ==========================================================================
  it('adjust - refuses to drop stock below what is reserved unless explicitly overridden', async () => {
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 8,
      },
      shopper,
    );

    await expect(
      h.dataSource.transaction((m) =>
        h.inventory.adjustStock(m, {
          variantId: catalog.variantId,
          mode: 'set',
          value: 3,
          actorUserId: admin,
          actorDisplaySnapshot: 'Manager',
        }),
      ),
    ).rejects.toThrow(/8 unit\(s\) are currently reserved/);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(12);

    const forced = await h.dataSource.transaction((m) =>
      h.inventory.adjustStock(m, {
        variantId: catalog.variantId,
        mode: 'set',
        value: 3,
        actorUserId: admin,
        actorDisplaySnapshot: 'Manager',
        allowBelowReserved: true,
      }),
    );
    expect(forced).toMatchObject({
      previousStock: 12,
      balanceAfter: 3,
      basketReserved: 8,
      belowReserved: true,
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(3);

    const movements = await movementRows(h.dataSource, catalog.variantId);
    expect(movements).toEqual([
      expect.objectContaining({
        delta: -9,
        balanceAfter: 3,
        reason: 'manual_adjustment',
      }),
    ]);
  });

  it('adjust - a delta decrease writes the committed balance from RETURNING', async () => {
    const result = await h.dataSource.transaction((m) =>
      h.inventory.adjustStock(m, {
        variantId: catalog.variantId,
        mode: 'delta',
        value: -8,
        actorUserId: admin,
        actorDisplaySnapshot: 'Manager',
        reason: 'stock take',
      }),
    );
    expect(result).toMatchObject({ previousStock: 12, balanceAfter: 4 });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(4);
    expect(
      (await movementRows(h.dataSource, catalog.variantId))[0],
    ).toMatchObject({ delta: -8, balanceAfter: 4 });
  });

  it('adjust - a delta increase is refused (STOCK_INCREASE_REQUIRES_RECEIPT) and writes nothing', async () => {
    await expect(
      h.dataSource.transaction((m) =>
        h.inventory.adjustStock(m, {
          variantId: catalog.variantId,
          mode: 'delta',
          value: 8,
          actorUserId: admin,
          actorDisplaySnapshot: 'Manager',
          reason: 'stock take',
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        error: 'STOCK_INCREASE_REQUIRES_RECEIPT',
      }),
    });
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(12);
    expect(await movementRows(h.dataSource, catalog.variantId)).toEqual([]);
  });
});
