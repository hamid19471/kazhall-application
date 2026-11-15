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
  makePosOrder,
  makeUser,
  movementRows,
  physicalStock,
  reservationRows,
} from './support/inventory.harness';

/**
 * Acceptance test 19 -- invariants under GENUINE concurrency.
 *
 * Every "concurrent" step below runs in its own transaction on its own pooled
 * connection via `Promise.all`. Sequential calls would prove nothing: the whole
 * question is what happens when two transactions are open at the same instant.
 *
 * The invariants asserted after every scenario:
 *
 *   I1  physical stock is never negative
 *   I2  physical stock only ever moves by the sum of the ledger deltas
 *   I3  no reservation is ever released twice (each row has exactly one
 *       terminal status and one releasedAt)
 *   I4  SUM(active basket reservations for a line) == cart_items.quantity
 *   I5  basketReserved + orderAllocated never exceeds physical stock
 */
describe('concurrency invariants (19)', () => {
  let h: InventoryHarness;
  let branchId: number;
  let cashierId: number;
  let catalog: Catalog;

  beforeEach(async () => {
    h = await createInventoryHarness();
    branchId = await makeBranch(h.dataSource, `Store ${Date.now()}`);
    cashierId = await makeUser(h.dataSource, `cashier-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 20);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  async function assertInvariants(variantId: number): Promise<void> {
    // I1
    const stock = await physicalStock(h.dataSource, variantId);
    expect(stock).toBeGreaterThanOrEqual(0);

    // I2
    const movements = await movementRows(h.dataSource, variantId);
    const netDelta = movements.reduce((sum, m) => sum + m.delta, 0);
    const startingStock = 20;
    expect(stock).toBe(startingStock + netDelta);
    // Every ledger row's balanceAfter is a real committed balance, so the last
    // one must equal the current stock.
    if (movements.length > 0) {
      expect(movements[movements.length - 1].balanceAfter).toBe(stock);
    }

    // I3 -- one terminal status per row; a double release would need two.
    const doubleReleased: Array<{ count: string }> = await h.dataSource.query(
      `SELECT COUNT(*) AS count
         FROM stock_reservations
        WHERE status <> 'active' AND ("releasedAt" IS NULL OR "releaseReason" IS NULL)`,
    );
    expect(Number(doubleReleased[0].count)).toBe(0);

    // I4
    const mismatched: Array<{ count: string }> = await h.dataSource.query(
      `SELECT COUNT(*) AS count
         FROM cart_items c
        WHERE c.status = 'active'
          AND c."variantId" IS NOT NULL
          AND c.quantity <> (
            SELECT COALESCE(SUM(r.quantity), 0)
              FROM stock_reservations r
             WHERE r."cartItemId" = c.id
               AND r.kind = 'basket'
               AND r.status = 'active'
               AND r."expiresAt" > now()
          )`,
    );
    expect(Number(mismatched[0].count)).toBe(0);

    // I5
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [variantId]),
    );
    const snapshot = availability.get(variantId)!;
    expect(
      snapshot.basketReserved + snapshot.orderAllocated,
    ).toBeLessThanOrEqual(snapshot.physicalStock);
    expect(snapshot.availableForBasket).toBeGreaterThanOrEqual(0);
  }

  it('19a - concurrent basket additions never over-reserve the shelf', async () => {
    // 20 units. Ten shoppers all try to grab 3 at the same instant => demand 30.
    const shoppers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        makeUser(h.dataSource, `rush-${Date.now()}-${i}`),
      ),
    );

    const outcomes = await Promise.allSettled(
      shoppers.map((userId) =>
        h.cart.create(
          {
            productId: catalog.productId,
            variantId: catalog.variantId,
            quantity: 3,
          },
          userId,
        ),
      ),
    );

    const succeeded = outcomes.filter((o) => o.status === 'fulfilled').length;
    // 20 / 3 = 6 whole reservations; the rest must be refused.
    expect(succeeded).toBe(6);
    expect(succeeded * 3).toBeLessThanOrEqual(20);

    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)!.basketReserved).toBe(18);
    await assertInvariants(catalog.variantId);
  });

  it('19b - concurrent basket addition + expiry sweep + POS sale preserve every invariant', async () => {
    const shopperIds = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        makeUser(h.dataSource, `mix-${Date.now()}-${i}`),
      ),
    );

    // Four existing holds; two of them are already due so the sweeper has real
    // work to do at exactly the moment the POS sale wants their units.
    const existing = await Promise.all(
      shopperIds.slice(0, 4).map((userId) =>
        h.cart.create(
          {
            productId: catalog.productId,
            variantId: catalog.variantId,
            quantity: 3,
          },
          userId,
        ),
      ),
    );
    await backdateReservations(h.dataSource, { cartItemId: existing[0].id });
    await backdateReservations(h.dataSource, { cartItemId: existing[1].id });

    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 12 },
    ]);

    // Everything below starts at once, on separate connections.
    const results = await Promise.allSettled([
      // two brand-new baskets
      h.cart.create(
        {
          productId: catalog.productId,
          variantId: catalog.variantId,
          quantity: 2,
        },
        shopperIds[4],
      ),
      h.cart.create(
        {
          productId: catalog.productId,
          variantId: catalog.variantId,
          quantity: 2,
        },
        shopperIds[5],
      ),
      // the expiry sweeper
      h.sweeper.runOnce(),
      // a POS sale big enough to need displacement
      h.dataSource.transaction((m) =>
        h.inventory.consumeForPosSale(m, {
          items: [{ variantId: catalog.variantId, quantity: 12 }],
          orderId: posOrderId,
          actorUserId: cashierId,
          actorDisplaySnapshot: 'Cashier Sara',
          branchId,
        }),
      ),
      // one shopper reducing their line
      h.cart.updateQuantity(existing[2].id, 1, shopperIds[2]),
      // one shopper removing their line entirely
      h.cart.remove(existing[3].id, shopperIds[3]),
      // a concurrent read, which is also a lazy-expiry point
      h.cart.findAll(shopperIds[0]),
    ]);

    // Some of these legitimately lose their race (a basket add can find the
    // stock gone). What must NEVER happen is a corrupted invariant.
    for (const r of results) {
      if (r.status === 'rejected') {
        const message = String(
          (r.reason as { message?: string })?.message ?? r.reason,
        );
        expect(message).toMatch(/stock|basket|not found|retry/i);
      }
    }

    await assertInvariants(catalog.variantId);

    // Whatever else happened, the POS sale either committed in full or not at
    // all -- there is no partial sale.
    const posMovements = (
      await movementRows(h.dataSource, catalog.variantId)
    ).filter((m) => m.orderId === posOrderId);
    expect([0, 1]).toContain(posMovements.length);
    if (posMovements.length === 1) {
      expect(posMovements[0].delta).toBe(-12);
    }
  });

  it('19c - two concurrent POS sales for the same scarce variant cannot both win', async () => {
    const scarce = await makeCatalog(h.dataSource, `SCARCE-${Date.now()}`, 5);
    const orderA = await makePosOrder(h.dataSource, branchId, [
      { variantId: scarce.variantId, quantity: 4 },
    ]);
    const orderB = await makePosOrder(h.dataSource, branchId, [
      { variantId: scarce.variantId, quantity: 4 },
    ]);

    const sale = (orderId: number) =>
      h.dataSource.transaction((m) =>
        h.inventory.consumeForPosSale(m, {
          items: [{ variantId: scarce.variantId, quantity: 4 }],
          orderId,
          actorUserId: cashierId,
          actorDisplaySnapshot: 'Cashier Sara',
          branchId,
        }),
      );

    const [a, b] = await Promise.allSettled([sale(orderA), sale(orderB)]);
    const winners = [a, b].filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);

    const loser = [a, b].find((r) => r.status === 'rejected');
    expect(loser!.reason).toBeInstanceOf(InsufficientStockError);

    // 5 - 4 = 1, never -3.
    expect(await physicalStock(h.dataSource, scarce.variantId)).toBe(1);
    expect(await movementRows(h.dataSource, scarce.variantId)).toHaveLength(1);
  });

  it('19d - a multi-SKU POS sale and a multi-SKU checkout on the same variants do not deadlock', async () => {
    // R1: both paths lock ascending by variantId, so the classic ABBA deadlock
    // is impossible. Without lockVariants this test wedges until Postgres kills
    // one side with a deadlock error.
    const skuA = await makeCatalog(h.dataSource, `A-${Date.now()}`, 30);
    const skuB = await makeCatalog(h.dataSource, `B-${Date.now()}`, 30);
    const shopper = await makeUser(h.dataSource, `dl-${Date.now()}`);

    await h.cart.create(
      { productId: skuA.productId, variantId: skuA.variantId, quantity: 2 },
      shopper,
    );
    await h.cart.create(
      { productId: skuB.productId, variantId: skuB.variantId, quantity: 2 },
      shopper,
    );

    const checkoutOrderId = await makePosOrder(h.dataSource, null);
    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: skuA.variantId, quantity: 5 },
      { variantId: skuB.variantId, quantity: 5 },
    ]);

    // Note the DELIBERATELY OPPOSITE item ordering in the two calls -- the
    // service is what has to normalise it, not the caller.
    const outcomes = await Promise.allSettled([
      h.dataSource.transaction((m) =>
        h.inventory.convertBasketToOrderAllocation(m, {
          userId: shopper,
          orderId: checkoutOrderId,
          items: [
            { variantId: skuB.variantId, quantity: 2 },
            { variantId: skuA.variantId, quantity: 2 },
          ],
        }),
      ),
      h.dataSource.transaction((m) =>
        h.inventory.consumeForPosSale(m, {
          items: [
            { variantId: skuA.variantId, quantity: 5 },
            { variantId: skuB.variantId, quantity: 5 },
          ],
          orderId: posOrderId,
          actorUserId: cashierId,
          actorDisplaySnapshot: 'Cashier Sara',
          branchId,
        }),
      ),
    ]);

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(String(outcome.reason)).not.toMatch(/deadlock/i);
      }
    }
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);

    expect(await physicalStock(h.dataSource, skuA.variantId)).toBe(25);
    expect(await physicalStock(h.dataSource, skuB.variantId)).toBe(25);
  });

  it('19e - two concurrent expiry sweeps release each reservation exactly once', async () => {
    const shoppers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        makeUser(h.dataSource, `exp-${Date.now()}-${i}`),
      ),
    );
    const lines: number[] = [];
    for (const userId of shoppers) {
      const line = await h.cart.create(
        {
          productId: catalog.productId,
          variantId: catalog.variantId,
          quantity: 2,
        },
        userId,
      );
      lines.push(line.id);
    }
    // Backdate only AFTER every line exists. Backdating as we go would let the
    // next `create`'s own lazy expiry (R5) reap the earlier lines before the
    // sweeps ever run -- correct behaviour, but it would leave this test with
    // nothing to sweep.
    for (const id of lines) {
      await backdateReservations(h.dataSource, { cartItemId: id });
    }

    // Two "app instances" sweeping at the same instant. `FOR UPDATE SKIP
    // LOCKED` partitions the rows; the guarded UPDATE of R3 catches anything
    // that slips through.
    const [runA, runB] = await Promise.all([
      h.dataSource.transaction((m) => h.inventory.expireDueReservations(m)),
      h.dataSource.transaction((m) => h.inventory.expireDueReservations(m)),
    ]);

    const totalRevoked = [...runA, ...runB].reduce(
      (sum, l) => sum + l.revokedQuantity,
      0,
    );
    // Five lines of 2 units. Released ONCE in total across both sweeps, not
    // twice, and not partially.
    expect(totalRevoked).toBe(10);

    const reservations = await reservationRows(h.dataSource, catalog.variantId);
    expect(reservations).toHaveLength(5);
    expect(reservations.every((r) => r.status === 'released')).toBe(true);

    // Physical stock never moved -- expiry releases holds, not goods.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(20);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);

    const rows = await cartRows(h.dataSource);
    expect(rows.every((r) => r.status === 'removed' && r.quantity === 0)).toBe(
      true,
    );
  });
});
