import { CartItemStatus } from 'src/modules/cart/entities/cart-item.entity';
import { ProductAttributeValue } from 'src/modules/products/entities/product-attribute-value.entity';
import { ProductAttribute } from 'src/modules/products/entities/product-attribute.entity';
import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  backdateReservations,
  createInventoryHarness,
  makeBranch,
  makeCatalog,
  makePosOrder,
  makeUser,
} from './support/inventory.harness';

/**
 * Acceptance tests 20 and 21.
 *
 * 20 -- R7 says realtime frames are advisory. A customer who was disconnected
 *       when a POS sale took their units must still learn about it from the
 *       next basket read, which re-derives everything from the database.
 *
 * 21 -- and that explanation must never leak store operations: not the staff
 *       member who rang up the sale, not the branch, not another customer.
 */
describe('basket recovery and privacy (20, 21)', () => {
  let h: InventoryHarness;
  let branchId: number;
  let cashierId: number;
  let alice: number;
  let bob: number;
  let catalog: Catalog;

  beforeEach(async () => {
    h = await createInventoryHarness();
    branchId = await makeBranch(h.dataSource, `Karaj Store ${Date.now()}`);
    cashierId = await makeUser(h.dataSource, `sara.cashier.${Date.now()}`);
    alice = await makeUser(h.dataSource, `alice-${Date.now()}`);
    bob = await makeUser(h.dataSource, `bob-${Date.now()}`);
    catalog = await makeCatalog(h.dataSource, `SKU-${Date.now()}`, 10);

    /*
     * Give the variant a real attribute value.
     *
     * The basket projects `variant.attributeValues` so a customer can see WHICH
     * colour or size they chose. Without a value here that array would always
     * be empty, and the closed whitelist below — the strongest assertion in
     * this file — would never see the nested keys it is supposed to be
     * policing.
     */
    const attribute = await h.dataSource.getRepository(ProductAttribute).save({
      name: 'رنگ',
      values: [{ value: 'مشکی' }],
    } as ProductAttribute);
    const [attributeValue] = await h.dataSource
      .getRepository(ProductAttributeValue)
      .find({ where: { attribute: { id: attribute.id } } });
    await h.dataSource.query(
      `INSERT INTO variant_product_attribute_value ("productVariantsId", "productAttributeValueId") VALUES ($1, $2)`,
      [catalog.variantId, attributeValue.id],
    );
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // 20
  // ==========================================================================
  it('20 - a disconnected customer sees the correction on the next basket fetch', async () => {
    const aliceLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
      alice,
    );
    await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      bob,
    );

    // Alice's client goes away here. It receives no websocket frame at all.
    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 8 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 8 }],
        orderId: posOrderId,
        actorUserId: cashierId,
        actorDisplaySnapshot: 'Sara Ahmadi',
        branchId,
      }),
    );

    // Alice reconnects and refetches. The correction is right there.
    const view = await h.cart.findAll(alice);

    expect(view.items).toHaveLength(0); // her line lost every unit
    expect(view.notices).toHaveLength(1);
    expect(view.notices[0]).toMatchObject({
      id: aliceLine.id,
      status: CartItemStatus.REMOVED,
      quantity: 0,
      change: {
        reason: ReservationReleaseReason.SOLD_IN_STORE,
        quantityDelta: -6,
      },
    });
    expect(view.notices[0].change!.message).toMatch(
      /sold in one of our stores/i,
    );

    // Shown ONCE: a second fetch no longer repeats the removed line.
    const second = await h.cart.findAll(alice);
    expect(second.items).toHaveLength(0);
    expect(second.notices).toHaveLength(0);

    // Bob was reduced, not removed. His line stays, with the reason attached
    // and a server-authoritative quantity and expiry.
    const bobView = await h.cart.findAll(bob);
    expect(bobView.items).toHaveLength(1);
    expect(bobView.items[0]).toMatchObject({
      quantity: 2,
      reservedQuantity: 2,
      change: {
        reason: ReservationReleaseReason.SOLD_IN_STORE,
        quantityDelta: -2,
      },
    });
    expect(bobView.items[0].expiresAt).toBeInstanceOf(Date);
  });

  it('20b - the basket read lazily expires a dead hold and reports the truth', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 5,
      },
      alice,
    );
    await backdateReservations(h.dataSource, { cartItemId: line.id });

    // No sweeper, no POS sale, no realtime frame -- just the read.
    const view = await h.cart.findAll(alice);
    expect(view.items).toHaveLength(0);
    expect(view.notices).toHaveLength(1);
    expect(view.notices[0].change).toMatchObject({
      reason: ReservationReleaseReason.RESERVATION_EXPIRED,
      quantityDelta: -5,
    });
    expect(view.notices[0].change!.message).toMatch(/4-hour hold/i);
  });

  it('20c - the read is server-authoritative: quantities and expiry come from the database', async () => {
    const line = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 3,
      },
      alice,
    );

    const posOrderId = await makePosOrder(h.dataSource, branchId, [
      { variantId: catalog.variantId, quantity: 9 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 9 }],
        orderId: posOrderId,
        actorUserId: cashierId,
        actorDisplaySnapshot: 'Sara Ahmadi',
        branchId,
      }),
    );

    const view = await h.cart.findAll(alice);
    expect(view.items[0]).toMatchObject({
      id: line.id,
      quantity: 1,
      reservedQuantity: 1,
      availableForBasket: 0, // 1 physical left, 1 reserved by Alice
    });
    // The tranche breakdown matches the surviving reservation exactly.
    expect(view.items[0].tranches).toEqual([
      { quantity: 1, expiresAt: expect.any(Date) },
    ]);
    expect(view.items[0].expiresAt).toEqual(
      view.items[0].tranches[0].expiresAt,
    );
  });

  // ==========================================================================
  // 21
  // ==========================================================================
  it('21 - no customer learns whose basket was affected or which staff member displaced it', async () => {
    const staffName = 'Sara Ahmadi';
    const branchName = `Karaj Store ${Date.now()}`;
    const staffBranchId = await makeBranch(h.dataSource, branchName);

    const aliceLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 6,
      },
      alice,
    );
    const bobLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 4,
      },
      bob,
    );

    const posOrderId = await makePosOrder(h.dataSource, staffBranchId, [
      { variantId: catalog.variantId, quantity: 8 },
    ]);
    await h.dataSource.transaction((m) =>
      h.inventory.consumeForPosSale(m, {
        items: [{ variantId: catalog.variantId, quantity: 8 }],
        orderId: posOrderId,
        actorUserId: cashierId,
        actorDisplaySnapshot: staffName,
        branchId: staffBranchId,
      }),
    );

    // The store-side facts ARE recorded -- just not in the customer's response.
    const ledger: Array<{ actorDisplaySnapshot: string; branchId: number }> =
      await h.dataSource.query(
        `SELECT "actorDisplaySnapshot", "branchId" FROM stock_movements WHERE "orderId" = $1`,
        [posOrderId],
      );
    expect(ledger[0]).toMatchObject({
      actorDisplaySnapshot: staffName,
      branchId: staffBranchId,
    });

    for (const [userId, ownLineId, otherLineId, otherUserId] of [
      [alice, aliceLine.id, bobLine.id, bob],
      [bob, bobLine.id, aliceLine.id, alice],
    ] as const) {
      const view = await h.cart.findAll(userId);
      const serialised = JSON.stringify(view);

      // The customer IS told what happened and why.
      expect(serialised).toContain(ReservationReleaseReason.SOLD_IN_STORE);

      // Staff identity -- name, or anything named after one -- must not appear.
      expect(serialised).not.toContain(staffName);
      expect(serialised).not.toMatch(/cashier/i);
      expect(serialised).not.toMatch(/actor/i);

      // Branch identity must not appear.
      expect(serialised).not.toContain(branchName);
      expect(serialised).not.toMatch(/branch/i);

      // Nothing about the other customer: not their id, not their line.
      expect(serialised).not.toMatch(
        new RegExp(`"userId"\\s*:\\s*${otherUserId}`),
      );
      const lineIds = [...view.items, ...view.notices].map((l) => l.id);
      expect(lineIds).not.toContain(otherLineId);
      expect(lineIds.every((id) => id === ownLineId)).toBe(true);

      // The strongest form of this check: the response's key set is a closed
      // WHITELIST. A future change that starts leaking staff or branch data
      // fails here, even if it invents a key name this test never imagined.
      const keys = new Set<string>();
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            keys.add(k);
            walk(v);
          }
        }
      };
      walk(view);
      expect([...keys].sort()).toEqual(
        [
          'at',
          // Catalogue facts about the customer's OWN chosen variant — the same
          // data the public product endpoint serves. Nothing here describes
          // another customer, a staff member or a branch.
          'attribute',
          'attributeValues',
          'name',
          'value',
          'availableForBasket',
          'change',
          'expiresAt',
          'id',
          'items',
          'message',
          'notices',
          'price',
          'productId',
          'productImages',
          'productTitle',
          'quantity',
          'quantityDelta',
          'reason',
          'reservedQuantity',
          'sku',
          'status',
          'tranches',
          'variant',
        ].sort(),
      );
    }
  });

  it('21b - one customer cannot read or mutate another customer basket line', async () => {
    const aliceLine = await h.cart.create(
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity: 2,
      },
      alice,
    );

    await expect(h.cart.updateQuantity(aliceLine.id, 1, bob)).rejects.toThrow(
      /not found in cart/i,
    );
    await expect(h.cart.remove(aliceLine.id, bob)).rejects.toThrow(
      /not found in cart/i,
    );

    const bobView = await h.cart.findAll(bob);
    expect(bobView.items).toHaveLength(0);
    expect(bobView.notices).toHaveLength(0);

    // Alice's line is untouched by the attempts.
    const aliceView = await h.cart.findAll(alice);
    expect(aliceView.items[0]).toMatchObject({ id: aliceLine.id, quantity: 2 });
  });
});
