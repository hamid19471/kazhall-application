import { BASKET_RESERVATION_TTL_MS } from 'src/modules/inventory/inventory.types';
import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  backdateReservations,
  cartRows,
  createInventoryHarness,
  makeCatalog,
  makeUser,
  movementRows,
  physicalStock,
  reservationRows,
} from './support/inventory.harness';

/**
 * Acceptance tests 11-14 -- the basket reservation lifecycle and the timer
 * rules from docs/ARCHITECTURE.md section 1.
 *
 * Everything here runs against a REAL PostgreSQL from workstream A's
 * disposable-container harness. The rules being proved (partial unique
 * indexes, `FOR UPDATE`, `UPDATE ... RETURNING` affected-row assertions) have
 * no meaning against a mock.
 */
describe('reservation lifecycle (11-14)', () => {
  let h: InventoryHarness;
  let userId: number;
  let catalog: Catalog;

  beforeEach(async () => {
    h = await createInventoryHarness();
    userId = await makeUser(h.dataSource, `shopper-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // 11
  // ==========================================================================
  it('11 - adding to the basket reserves exactly the requested quantity for 4 hours', async () => {
    const before = Date.now();
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 3,
      },
      userId,
    );
    const after = Date.now();

    expect(line.quantity).toBe(3);
    expect(line.reservedQuantity).toBe(3);

    const reservations = await reservationRows(h.dataSource, catalog.variantId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      kind: 'basket',
      status: 'active',
      quantity: 3,
    });

    // 4h TTL, bounded by when the request actually ran.
    const expiry = new Date(reservations[0].expiresAt).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + BASKET_RESERVATION_TTL_MS);
    expect(expiry).toBeLessThanOrEqual(after + BASKET_RESERVATION_TTL_MS);

    // A hold is not a sale: physical stock is untouched.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);

    // availableForBasket = 10 - 3 - 0
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)).toMatchObject({
      physicalStock: 10,
      basketReserved: 3,
      orderAllocated: 0,
      availableForBasket: 7,
      availableForPos: 10,
    });
  });

  it('11b - a reservation is rejected when it exceeds availableForBasket', async () => {
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 8,
      },
      userId,
    );
    await expect(
      h.cart.create(
        {
          productId: catalog.productId,
          variantId: catalog.variantId,
          quantity: 3,
        },
        userId,
      ),
    ).rejects.toThrow(/available 2/);

    // The rejected attempt left nothing behind.
    const reservations = await reservationRows(h.dataSource, catalog.variantId);
    expect(reservations.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  // ==========================================================================
  // 12  -- R4: expiresAt is immutable after insert
  // ==========================================================================
  it('12 - reads and idempotent retries never extend expiry', async () => {
    const created = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 2,
      },
      userId,
    );
    const original = (
      await reservationRows(h.dataSource, catalog.variantId)
    )[0];
    const originalExpiry = new Date(original.expiresAt).toISOString();

    // A handful of reads...
    for (let i = 0; i < 3; i++) {
      const view = await h.cart.findAll(userId);
      expect(view.items).toHaveLength(1);
      expect(new Date(view.items[0].expiresAt!).toISOString()).toBe(
        originalExpiry,
      );
    }

    // ...an availability computation (which runs lazy expiry)...
    await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );

    // ...and a repeated identical quantity request, which is a no-op write.
    await h.cart.updateQuantity(created.id, 2, userId);
    await h.cart.updateQuantity(created.id, 2, userId);

    const after = await reservationRows(h.dataSource, catalog.variantId);
    expect(after).toHaveLength(1);
    expect(new Date(after[0].expiresAt).toISOString()).toBe(originalExpiry);
    expect(after[0].quantity).toBe(2);
  });

  // ==========================================================================
  // 13
  // ==========================================================================
  it('13 - expiry releases the hold exactly once and does NOT raise physical stock', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      userId,
    );
    const stockBefore = await physicalStock(h.dataSource, catalog.variantId);
    expect(stockBefore).toBe(10);

    await backdateReservations(h.dataSource, { cartItemId: line.id });

    // First expiry pass does the work.
    const firstPass = await h.dataSource.transaction((m) =>
      h.inventory.expireDueReservations(m),
    );
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]).toMatchObject({
      cartItemId: line.id,
      revokedQuantity: 4,
      remainingQuantity: 0,
      lineRemoved: true,
      reason: ReservationReleaseReason.RESERVATION_EXPIRED,
    });

    // R3: a second pass finds nothing. Releasing twice is structurally
    // impossible -- the guarded UPDATE only matches `status = 'active'`.
    const secondPass = await h.dataSource.transaction((m) =>
      h.inventory.expireDueReservations(m),
    );
    expect(secondPass).toHaveLength(0);

    const reservations = await reservationRows(h.dataSource, catalog.variantId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      status: 'released',
      releaseReason: ReservationReleaseReason.RESERVATION_EXPIRED,
      quantity: 4,
    });

    // THE POINT OF THIS TEST: releasing a hold changes basketReserved, never
    // product_variants.stock. Physical stock is identical, and no ledger row
    // was written -- nothing physically moved.
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(
      stockBefore,
    );
    expect(await movementRows(h.dataSource, catalog.variantId)).toHaveLength(0);

    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)).toMatchObject({
      physicalStock: 10,
      basketReserved: 0,
      availableForBasket: 10,
    });
  });

  it('13b - lazy expiry (R5) frees stock even when the sweeper never runs', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 10,
      },
      userId,
    );
    await backdateReservations(h.dataSource, { cartItemId: line.id });

    // No sweeper anywhere in this test. The availability computation itself
    // must expire the dead hold inside its own transaction.
    const availability = await h.dataSource.transaction((m) =>
      h.inventory.getAvailability(m, [catalog.variantId]),
    );
    expect(availability.get(catalog.variantId)!.availableForBasket).toBe(10);
  });

  // ==========================================================================
  // 14  -- tranche rules
  // ==========================================================================
  it('14a - a quantity increase creates a NEW tranche with its own TTL and leaves the old one alone', async () => {
    // Anchored to real 'now' so both tranches stay in the future regardless of
    // when the suite runs; fixed calendar dates would silently start expiring.
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 90 * 60 * 1000);

    const cartItemId = await h.dataSource.transaction(async (m) => {
      const rows: Array<{ id: number }> = await m.query(
        `INSERT INTO cart_items ("userId", "productId", "variantId", quantity, status)
         VALUES ($1, $2, $3, 0, 'active') RETURNING id`,
        [userId, catalog.productId, catalog.variantId],
      );
      return Number(rows[0].id);
    });

    await h.dataSource.transaction((m) =>
      h.inventory.reserveForBasket(m, {
        userId,
        cartItemId,
        variantId: catalog.variantId,
        quantity: 2,
        now: t0,
      }),
    );
    const second = await h.dataSource.transaction((m) =>
      h.inventory.reserveForBasket(m, {
        userId,
        cartItemId,
        variantId: catalog.variantId,
        quantity: 3,
        now: t1,
      }),
    );

    expect(second.reservedQuantity).toBe(5);
    expect(second.tranches).toEqual([
      {
        quantity: 2,
        expiresAt: new Date(t0.getTime() + BASKET_RESERVATION_TTL_MS),
      },
      {
        quantity: 3,
        expiresAt: new Date(t1.getTime() + BASKET_RESERVATION_TTL_MS),
      },
    ]);
    // The line's exposed expiry is the EARLIEST tranche -- when it first starts
    // losing units -- not the newest, which would silently look like a renewal.
    expect(second.expiresAt).toEqual(
      new Date(t0.getTime() + BASKET_RESERVATION_TTL_MS),
    );
  });

  it('14b - a quantity decrease releases the NEWEST tranche first, so the survivors are the oldest', async () => {
    // Anchored to real 'now' so both tranches stay in the future regardless of
    // when the suite runs; fixed calendar dates would silently start expiring.
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 90 * 60 * 1000);

    const cartItemId = await h.dataSource.transaction(async (m) => {
      const rows: Array<{ id: number }> = await m.query(
        `INSERT INTO cart_items ("userId", "productId", "variantId", quantity, status)
         VALUES ($1, $2, $3, 0, 'active') RETURNING id`,
        [userId, catalog.productId, catalog.variantId],
      );
      return Number(rows[0].id);
    });

    await h.dataSource.transaction((m) =>
      h.inventory.reserveForBasket(m, {
        userId,
        cartItemId,
        variantId: catalog.variantId,
        quantity: 2,
        now: t0,
      }),
    );
    await h.dataSource.transaction((m) =>
      h.inventory.reserveForBasket(m, {
        userId,
        cartItemId,
        variantId: catalog.variantId,
        quantity: 3,
        now: t1,
      }),
    );

    // 5 -> 3: two units go. Both must come off the NEWER tranche.
    const released = await h.dataSource.transaction((m) =>
      h.inventory.releaseBasketQuantity(m, {
        cartItemId,
        quantity: 2,
        reason: ReservationReleaseReason.QUANTITY_REDUCED,
      }),
    );
    expect(released).toEqual({ releasedQuantity: 2, remainingQuantity: 3 });

    const state = await h.dataSource.transaction((m) =>
      h.inventory.describeBasketLine(m, cartItemId, catalog.variantId),
    );
    expect(state.tranches).toEqual([
      {
        quantity: 2,
        expiresAt: new Date(t0.getTime() + BASKET_RESERVATION_TTL_MS),
      },
      {
        quantity: 1,
        expiresAt: new Date(t1.getTime() + BASKET_RESERVATION_TTL_MS),
      },
    ]);
    // Had we released oldest-first, the earliest expiry would have jumped
    // forward by 90 minutes -- a silent extension of the customer's hold.
    expect(state.expiresAt).toEqual(
      new Date(t0.getTime() + BASKET_RESERVATION_TTL_MS),
    );

    // Reducing past the newest tranche starts eating the older one.
    await h.dataSource.transaction((m) =>
      h.inventory.releaseBasketQuantity(m, {
        cartItemId,
        quantity: 2,
        reason: ReservationReleaseReason.QUANTITY_REDUCED,
      }),
    );
    const after = await h.dataSource.transaction((m) =>
      h.inventory.describeBasketLine(m, cartItemId, catalog.variantId),
    );
    expect(after.tranches).toEqual([
      {
        quantity: 1,
        expiresAt: new Date(t0.getTime() + BASKET_RESERVATION_TTL_MS),
      },
    ]);
  });

  it('14c - the cart API keeps cart_items.quantity equal to the active reserved quantity', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 2,
      },
      userId,
    );
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 3,
      },
      userId,
    );

    let rows = await cartRows(h.dataSource, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5);

    await h.cart.updateQuantity(line.id, 1, userId);
    rows = await cartRows(h.dataSource, userId);
    expect(rows[0].quantity).toBe(1);
    expect(
      (await reservationRows(h.dataSource, catalog.variantId))
        .filter((r) => r.status === 'active')
        .reduce((sum, r) => sum + r.quantity, 0),
    ).toBe(1);

    // Removing a line releases its reservations exactly once.
    await h.cart.remove(line.id, userId);
    expect(await cartRows(h.dataSource, userId)).toHaveLength(0);
    expect(
      (await reservationRows(h.dataSource, catalog.variantId)).filter(
        (r) => r.status === 'active',
      ),
    ).toHaveLength(0);
    expect(await physicalStock(h.dataSource, catalog.variantId)).toBe(10);
  });
});
