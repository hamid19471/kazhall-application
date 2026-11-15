/**
 * ============================================================================
 * `stock_movements.reasonText` — the human explanation on the ledger row.
 * ============================================================================
 *
 * Migration 0024 added a nullable free-text column beside the machine `reason`
 * enum. These cases assert the whole contract, and they assert it BY QUERYING
 * THE TABLE, not by reading the endpoint back to itself: the point of the
 * column is that the sentence is in the ledger, so a test that only checked
 * the JSON would pass just as happily against the old behaviour of stuffing it
 * into `admin_audit_log` and reading it out again.
 *
 * WHAT IS BEING PROVED
 *
 *   1. an administrative adjustment's reason reaches `reasonText`;
 *   2. `GET /admin/inventory/movements` (and the variant detail) return it;
 *   3. the `admin_audit_log` row and the `stock_movements` row agree about
 *      WHO, WHICH VARIANT and HOW MUCH — two records of one act that
 *      contradict each other are worse than one record;
 *   4. a rolled-back adjustment leaves NEITHER record;
 *   5. a REFUSED adjustment (whitespace-only reason; negative result) leaves
 *      neither record either — and the whitespace case matters because
 *      `@MinLength(4)` on an untrimmed string happily accepts four spaces;
 *   6. the system paths are untouched: a POS sale still writes exactly one
 *      movement with the right signed delta and committed `balanceAfter`, and
 *      a NULL `reasonText`, because no human authored a sentence for it.
 *
 * The POS harness is used because this file needs BOTH surfaces — a till
 * session to ring up a sale and an admin session to adjust and to read the
 * ledger — and it is the harness that boots the module graph carrying both.
 */
import { DataSource } from 'typeorm';

import { InventoryService } from 'src/modules/inventory/inventory.service';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  ReservationKind,
  ReservationStatus,
} from 'src/modules/inventory/entities/stock-reservation.entity';

import { getTestDataSource, resetDb } from './setup/test-db';
import { createPosTestApp, TestApp, withCookies } from './support/pos.harness';
import {
  as,
  loginCashier,
  loginSuperAdmin,
  seedBranch,
  seedVariant,
  stockOf,
} from './support/pos.fixtures';

// ---------------------------------------------------------------------------
// Direct-from-the-table readers. Nothing here goes through the API, on
// purpose: these are the assertions the API could otherwise fake.
// ---------------------------------------------------------------------------

interface MovementRow {
  id: number;
  variantId: number;
  delta: number;
  balanceAfter: number;
  reason: StockMovementReason;
  reasonText: string | null;
  actorUserId: number | null;
  actorDisplaySnapshot: string | null;
  orderId: number | null;
  branchId: number | null;
}

async function movementsOf(
  ds: DataSource,
  variantId: number,
): Promise<MovementRow[]> {
  return ds.query(
    `SELECT id, "variantId", delta, "balanceAfter", reason, "reasonText",
            "actorUserId", "actorDisplaySnapshot", "orderId", "branchId"
       FROM stock_movements
      WHERE "variantId" = $1
      ORDER BY id ASC`,
    [variantId],
  );
}

interface AuditRow {
  actorUserId: number | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: {
    mode?: string;
    value?: number;
    previousStock?: number;
    balanceAfter?: number;
    reason?: string;
  } | null;
}

async function stockAudits(ds: DataSource): Promise<AuditRow[]> {
  return ds.query(
    `SELECT "actorUserId", "action", "targetType", "targetId", "summary"
       FROM admin_audit_log
      WHERE "action" = 'stock.adjusted'
      ORDER BY id ASC`,
  );
}

/** Every audit row, whatever its action — for the "nothing at all" assertions. */
async function countAllAudits(ds: DataSource): Promise<number> {
  const [row]: Array<{ count: string }> = await ds.query(
    `SELECT COUNT(*)::text AS count FROM admin_audit_log`,
  );
  return Number(row.count);
}

describe('stock_movements.reasonText (int)', () => {
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
  });

  const adjustUrl = (variantId: number) =>
    `/admin/inventory/variants/${variantId}/adjust`;

  // =========================================================================
  // 1. The sentence reaches the ledger row itself
  // =========================================================================

  it('persists the administrator’s reason on the movement row', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 40 });
    const reason =
      'annual stock count 2026-09-11, shelf 4B: 12 found, 40 recorded';

    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'set', value: 12, reason })
      .expect(200);

    const movements = await movementsOf(ctx.dataSource, variant.id);
    expect(movements).toHaveLength(1);

    const [movement] = movements;
    // The free text is there...
    expect(movement.reasonText).toBe(reason);
    // ...and the MACHINE reason is untouched beside it. The new column is
    // additive; anything that branches on `reason` keeps working.
    expect(movement.reason).toBe(StockMovementReason.MANUAL_ADJUSTMENT);
    // ...and so is every other column the ledger already guaranteed.
    expect(movement.delta).toBe(-28);
    expect(movement.balanceAfter).toBe(12);
    expect(movement.actorUserId).toBe(admin.userId);
    expect(movement.actorDisplaySnapshot).toBe(admin.username);
    expect(movement.orderId).toBeNull();
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(12);
  });

  it('trims the stored sentence rather than keeping the operator’s padding', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 5 });

    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'delta', value: -2, reason: '   damaged beyond repair   ' })
      .expect(200);

    const [movement] = await movementsOf(ctx.dataSource, variant.id);
    expect(movement.reasonText).toBe('damaged beyond repair');
  });

  // =========================================================================
  // 2. ...and the admin ledger API hands it back
  // =========================================================================

  it('returns reasonText from the movement-history endpoint and the variant detail', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 3 });
    const reason = 'damaged in transit, two units written off';

    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'delta', value: -2, reason })
      .expect(200);

    const list = await withCookies(ctx, admin.jar)
      .get(`/admin/inventory/movements?variantId=${variant.id}`)
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toEqual(
      expect.objectContaining({
        variantId: variant.id,
        delta: -2,
        balanceAfter: 1,
        reason: StockMovementReason.MANUAL_ADJUSTMENT,
        reasonText: reason,
      }),
    );

    // The single-variant screen reads from the same mapper, so it carries the
    // field too — a reader should not have to change screens to see "why".
    const detail = await withCookies(ctx, admin.jar)
      .get(`/admin/inventory/variants/${variant.id}`)
      .expect(200);

    expect(detail.body.data.recentMovements[0].reasonText).toBe(reason);
  });

  // =========================================================================
  // 3. Two records of ONE act, agreeing with each other
  // =========================================================================

  it('records the same actor, variant and delta in admin_audit_log and in stock_movements', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 10 });
    const reason = 'supplier credit note 88134 applied to the shelf count';

    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'delta', value: -4, reason })
      .expect(200);

    const movements = await movementsOf(ctx.dataSource, variant.id);
    const audits = await stockAudits(ctx.dataSource);
    expect(movements).toHaveLength(1);
    expect(audits).toHaveLength(1);

    const [movement] = movements;
    const [audit] = audits;

    // SAME ACTOR.
    expect(audit.actorUserId).toBe(admin.userId);
    expect(movement.actorUserId).toBe(audit.actorUserId);

    // SAME VARIANT. `admin_audit_log.targetId` is a varchar, so the comparison
    // is made deliberately rather than by a loose `==`.
    expect(audit.targetType).toBe('variant');
    expect(Number(audit.targetId)).toBe(variant.id);
    expect(movement.variantId).toBe(variant.id);

    // SAME DELTA. The audit row states it as before/after, the ledger as a
    // signed change; they must describe the same movement of stock.
    expect(audit.summary?.previousStock).toBe(10);
    expect(audit.summary?.balanceAfter).toBe(6);
    expect(
      (audit.summary?.balanceAfter ?? 0) - (audit.summary?.previousStock ?? 0),
    ).toBe(movement.delta);
    expect(movement.delta).toBe(-4);

    // ...and both carry the same sentence, which is the whole point of doing
    // it twice: the audit copy is the administrative record, the ledger copy
    // is the one written inside the adjustment's own transaction.
    expect(audit.summary?.reason).toBe(reason);
    expect(movement.reasonText).toBe(reason);
  });

  // =========================================================================
  // 4. A rolled-back adjustment leaves nothing behind
  // =========================================================================

  /**
   * WHY THIS CASE DRIVES THE SERVICE DIRECTLY INSTEAD OF THE ROUTE.
   *
   * The property under test is "the movement row lives and dies with the
   * adjustment's transaction". Over HTTP there is no way to make the write
   * succeed and the commit fail on demand — every refusal the route can
   * produce happens BEFORE the insert (case 5 covers those), so a route-level
   * test would prove the earlier guard, not the transactional one. Opening the
   * transaction here and throwing after `adjustStock` returns reproduces
   * exactly the shape of a late failure, against the real database.
   *
   * It also demonstrates the asymmetry the controller documents: the audit row
   * is written only AFTER a successful commit, so an adjustment that never
   * committed leaves no audit record either.
   */
  it('leaves neither a movement nor an audit row when the adjustment is rolled back', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 10 });
    const inventory = ctx.app.get(InventoryService, { strict: false });

    const boom = new Error('simulated late failure after the ledger write');
    await expect(
      ctx.dataSource.transaction(async (manager) => {
        const result = await inventory.adjustStock(manager, {
          variantId: variant.id,
          mode: 'set',
          value: 3,
          actorUserId: admin.userId,
          actorDisplaySnapshot: admin.username,
          reason: 'this sentence must not survive the rollback',
        });
        // The write really did happen inside the transaction...
        expect(result.balanceAfter).toBe(3);
        const inFlight: Array<{ count: string }> = await manager.query(
          `SELECT COUNT(*)::text AS count FROM stock_movements WHERE "variantId" = $1`,
          [variant.id],
        );
        expect(Number(inFlight[0].count)).toBe(1);
        throw boom;
      }),
    ).rejects.toBe(boom);

    // ...and none of it survived.
    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);
    expect(await countAllAudits(ctx.dataSource)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(10);
  });

  // =========================================================================
  // 5. A REFUSED adjustment leaves nothing behind either
  // =========================================================================

  it('refuses a whitespace-only reason with 400 and writes no record at all', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 10 });

    // Four spaces. This is exactly what an untrimmed `@MinLength(4)` lets
    // through, and it would have become the permanent explanation for a stock
    // correction.
    const res = await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'set', value: 4, reason: '    ' })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toMatch(/reason/i);

    // An empty string and a too-short-after-trim sentence are the same refusal.
    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'set', value: 4, reason: '' })
      .expect(400);
    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({ mode: 'set', value: 4, reason: '  ok  ' })
      .expect(400);

    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);
    expect(await countAllAudits(ctx.dataSource)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(10);
  });

  it('refuses an adjustment that would go negative and writes no record at all', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 2 });

    await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({
        mode: 'delta',
        value: -5,
        reason: 'shrinkage discovered on aisle 3',
      })
      .expect(400);

    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);
    expect(await countAllAudits(ctx.dataSource)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(2);
  });

  it('refuses a below-reserved adjustment (409) and writes no record at all', async () => {
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { stock: 10 });
    await ctx.dataSource.query(
      `INSERT INTO "stock_reservations"
         ("variantId","kind","status","quantity","expiresAt")
       VALUES ($1,$2,$3,$4,$5)`,
      [
        variant.id,
        ReservationKind.ORDER,
        ReservationStatus.ACTIVE,
        6,
        new Date(Date.now() + 3_600_000),
      ],
    );

    const res = await withCookies(ctx, admin.jar)
      .post(adjustUrl(variant.id))
      .send({
        mode: 'set',
        value: 2,
        reason: 'count says two are on the shelf',
      })
      .expect(409);
    expect(res.body.error).toBe('STOCK_BELOW_RESERVED');

    expect(await movementsOf(ctx.dataSource, variant.id)).toHaveLength(0);
    expect(await countAllAudits(ctx.dataSource)).toBe(0);
    expect(await stockOf(ctx.dataSource, variant.id)).toBe(10);
  });

  // =========================================================================
  // 6. The system paths are unchanged
  // =========================================================================

  it('still writes a POS sale movement correctly, with a NULL reasonText', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 9 });

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 4 }],
      })
      .expect(201);

    const movements = await movementsOf(ctx.dataSource, variant.id);
    expect(movements).toHaveLength(1);

    const [movement] = movements;
    expect(movement.reason).toBe(StockMovementReason.POS_SALE);
    expect(movement.delta).toBe(-4);
    expect(movement.balanceAfter).toBe(5);
    expect(movement.orderId).toBe(sale.body.data.id);
    expect(movement.actorUserId).toBe(cashier.userId);
    expect(movement.branchId).toBe(branch.id);

    // NULL, not ''. Nobody wrote a sentence for a sale, and a generated one
    // would be indistinguishable from an operator's own words.
    expect(movement.reasonText).toBeNull();

    expect(await stockOf(ctx.dataSource, variant.id)).toBe(5);
  });

  it('writes NULL reasonText for the restore a void puts back on the shelf', async () => {
    const branch = await seedBranch(ctx);
    const cashier = await loginCashier(ctx, branch);
    const admin = await loginSuperAdmin(ctx);
    const variant = await seedVariant(ctx, { price: 500_000, stock: 6 });

    const sale = await as(ctx, cashier)
      .post('/orders/pos')
      .send({
        paymentMethod: PaymentMethodEnum.CASH,
        items: [{ productVariantId: variant.id, quantity: 2 }],
      })
      .expect(201);

    await withCookies(ctx, admin.jar)
      .post(`/orders/${sale.body.data.id}/void`)
      .send({ reason: 'rung up on the wrong terminal' })
      .expect(200);

    const movements = await movementsOf(ctx.dataSource, variant.id);
    expect(movements).toHaveLength(2);

    const [sold, restored] = movements;
    expect(sold.delta).toBe(-2);
    expect(restored.delta).toBe(2);
    expect(restored.balanceAfter).toBe(6);
    expect(restored.reason).toBe(StockMovementReason.CANCELLATION_RESTORE);
    // The void carries its own free-text reason on the ORDER action record.
    // It is not an inventory correction, so it does not become a ledger
    // sentence: a reader of the ledger sees a restore caused by an order, and
    // follows `orderId` for the story.
    expect(restored.reasonText).toBeNull();
  });
});
