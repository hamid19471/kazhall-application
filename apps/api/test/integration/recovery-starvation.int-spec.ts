import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import {
  FulfilmentRecoveryService,
  RecoveryReport,
} from 'src/modules/payment/fulfilment-recovery.service';
import { PaymentStatusEnum } from 'src/modules/payment/enums/payment-status-enum';
import { PaymentConfig } from 'src/modules/payment/payment.config';

import { closeTestDataSource } from './setup/test-db';
import {
  Catalog,
  InventoryHarness,
  createInventoryHarness,
  fakeConfig,
  makeCatalog,
  makeOnlineOrder,
  makeUser,
  movementRows,
  orderState,
  receiveStock,
} from './support/inventory.harness';

/**
 * ============================================================================
 * FINDING F -- RECOVERY STARVATION
 * ============================================================================
 *
 * The old worker selected its batch with `ORDER BY id ASC LIMIT $batch` over
 * every recoverable order, with no notion of "already tried". Orders that can
 * NEVER be fulfilled hold the lowest ids and therefore fill EVERY batch,
 * forever, so a fulfillable order created afterwards is never reached -- not
 * "reached late", NEVER, because the query is deterministic.
 *
 * The first test below is the proof. It was run against the OLD selection
 * before the fix and FAILED (the later order stayed `awaiting_stock` through
 * every bounded pass); it passes against the due-time queue. The evidence is in
 * the workstream E/F report.
 *
 * NO LIVE GATEWAY IS INVOLVED anywhere in this file: these orders are put into
 * their recorded post-payment states directly, because what is under test is
 * the SCHEDULING of phase 2, not the money. See `paidOrder` below for why that
 * fixture now also writes the settling receipt.
 */
describe('fulfilment recovery starvation (finding F)', () => {
  const BATCH = 3;

  let h: InventoryHarness;
  let shopper: number;
  /** Stock 0 and no allocation: fulfilment can never succeed. */
  let doomedCatalog: Catalog;
  /** Plenty of free stock: fulfilment succeeds the moment it is attempted. */
  let goodCatalog: Catalog;

  function recoveryWith(
    values: Record<string, string> = {},
  ): FulfilmentRecoveryService {
    return new FulfilmentRecoveryService(
      h.dataSource,
      h.fulfilment,
      new PaymentConfig(
        fakeConfig({ FULFILMENT_RECOVERY_ENABLED: 'false', ...values }),
      ),
      // The harness's own recorder, so anything this worker publishes lands
      // where `emittedEvents(h.realtime)` can see it.
      h.realtime,
    );
  }

  /**
   * A paid order whose phase 2 is still outstanding.
   *
   * IT NOW CARRIES THE SETTLING RECEIPT THAT MADE IT PAID (finding 1).
   *
   * This fixture used to flip `orders.status` to `paid` and write NO `payment`
   * row at all, which is a state phase 1 cannot produce: `runPhase1` sets the
   * order PAID and the receipt `success` in ONE transaction, so a paid order
   * always has a settling receipt. `FulfilmentService.claim()` now requires one
   * before it will consume stock, so the old fixture described an order the
   * system deliberately refuses to fulfil -- and these tests are about the
   * SCHEDULING of phase 2, not about authorization.
   *
   * The receipt is written the way the current settle decision writes one:
   * `gateway_amount` equal to `amount` (present, valid and EQUAL) and no
   * reconciliation reason. This is STRONGER than the old fixture, not weaker:
   * the scheduling tests now run against a row set production can actually
   * reach, so a fulfilment they observe is a fulfilment that was authorized.
   * The authorization rule itself is proved in
   * `fulfilment-authorization-legacy-receipt.int-spec.ts`.
   */
  async function paidOrder(
    catalog: Catalog,
    fulfillmentState: FulfillmentStateEnum,
    quantity = 1,
  ): Promise<number> {
    const orderId = await makeOnlineOrder(h.dataSource, shopper, [
      {
        productId: catalog.productId,
        variantId: catalog.variantId,
        quantity,
      },
    ]);
    await h.dataSource.query(
      `UPDATE orders
          SET status = $2, paid_at = now(), "fulfillmentState" = $3
        WHERE id = $1`,
      [orderId, OrderStatusEnum.PAID, fulfillmentState],
    );
    const total = 1_000_000 * quantity;
    await h.dataSource.query(
      `INSERT INTO payment ("orderId", amount, gateway_amount, status, track_id,
                            paid_at, requires_reconciliation, reconciliation_reason,
                            created_at, updated_at)
       VALUES ($1, $2, $2, $3, $4, now(), false, NULL, now(), now())`,
      [orderId, total, PaymentStatusEnum.SUCCESS, `starve-track-${orderId}`],
    );
    return orderId;
  }

  async function retryBookkeeping(orderId: number): Promise<{
    attempts: number;
    lastAttemptAt: Date | null;
    nextAttemptAt: Date | null;
  }> {
    const rows: Array<{
      attempts: number;
      last: Date | null;
      next: Date | null;
    }> = await h.dataSource.query(
      `SELECT "fulfillmentAttempts" AS attempts,
              "fulfillmentLastAttemptAt" AS last,
              "fulfillmentNextAttemptAt" AS next
         FROM orders WHERE id = $1`,
      [orderId],
    );
    return {
      attempts: Number(rows[0].attempts),
      lastAttemptAt: rows[0].last,
      nextAttemptAt: rows[0].next,
    };
  }

  beforeEach(async () => {
    h = await createInventoryHarness();
    shopper = await makeUser(h.dataSource, `starve-${Date.now()}`);
    doomedCatalog = await makeCatalog(h.dataSource, `DOOM-${Date.now()}`, 0);
    goodCatalog = await makeCatalog(h.dataSource, `GOOD-${Date.now()}`, 10);
  });

  afterAll(async () => {
    await closeTestDataSource();
  });

  // ==========================================================================
  // The starvation proof
  // ==========================================================================
  it('F1 - a fulfillable order created AFTER a full batch of permanently unfulfillable ones still reaches FULFILLED', async () => {
    const recovery = recoveryWith();

    // MORE doomed orders than fit in one batch, so the old `ORDER BY id ASC`
    // could never get past them.
    const doomed: number[] = [];
    for (let i = 0; i < BATCH + 1; i++) {
      doomed.push(
        await paidOrder(doomedCatalog, FulfillmentStateEnum.AWAITING_STOCK),
      );
    }
    // ...and then the order that must not starve. Created last, so it has the
    // HIGHEST id: under the old selection it was unreachable by construction.
    const fulfillable = await paidOrder(
      goodCatalog,
      FulfillmentStateEnum.PENDING,
    );
    expect(fulfillable).toBeGreaterThan(Math.max(...doomed));

    // A bounded number of bounded passes -- exactly what the timer does.
    const reports: RecoveryReport[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const report = await recovery.recover(BATCH);
      expect(report.scanned).toBeLessThanOrEqual(BATCH);
      reports.push(report);
    }

    // THE POINT.
    expect(await orderState(h.dataSource, fulfillable)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    const movements = await movementRows(h.dataSource, goodCatalog.variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ orderId: fulfillable, delta: -1 });

    // The doomed orders are neither fulfilled nor abandoned: they keep their
    // recorded state and their retry bookkeeping. Deciding what to DO with a
    // paid, unfulfillable order is owner decision D-2 and is still open, so
    // nothing here invents a terminal state or moves money.
    for (const orderId of doomed) {
      expect(await orderState(h.dataSource, orderId)).toEqual({
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      });
    }
    expect(
      await movementRows(h.dataSource, doomedCatalog.variantId),
    ).toHaveLength(0);

    // The queue rotated instead of re-scanning its head: the second pass saw
    // orders the first pass had not.
    expect(reports[1].orderIds).not.toEqual(reports[0].orderIds);
    expect(reports[0].orderIds).toContain(doomed[0]);
    expect(reports[1].orderIds).toContain(fulfillable);
  });

  it('F2 - every lease is observable in the report and schedules the next attempt in the future', async () => {
    const recovery = recoveryWith();
    const doomed = await paidOrder(
      doomedCatalog,
      FulfillmentStateEnum.AWAITING_STOCK,
    );

    const before = await retryBookkeeping(doomed);
    expect(before).toMatchObject({
      attempts: 0,
      lastAttemptAt: null,
      // NULL means "due now" -- that is what makes every pre-existing order and
      // every freshly paid order eligible without a backfill.
      nextAttemptAt: null,
    });

    const first = await recovery.recover(BATCH);
    expect(first).toMatchObject({ scanned: 1, awaitingStock: 1, failed: 0 });
    expect(first.attempts).toEqual([
      { orderId: doomed, attempt: 1, nextAttemptAt: expect.any(Date) },
    ]);
    expect(first.overdue).toEqual([]);

    const after = await retryBookkeeping(doomed);
    expect(after.attempts).toBe(1);
    expect(after.lastAttemptAt).not.toBeNull();
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Not due yet -> the very next pass does not touch it at all. This is the
    // property the old worker lacked, and the whole reason a later order can
    // now be reached.
    const second = await recovery.recover(BATCH);
    expect(second).toMatchObject({ scanned: 0, orderIds: [] });
    expect((await retryBookkeeping(doomed)).attempts).toBe(1);
  });

  it('F3 - retries are capped and escalated, never abandoned', async () => {
    // 1ms base backoff so the order is due again immediately; the alert
    // threshold is 1 so escalation is reached inside the test.
    const recovery = recoveryWith({
      FULFILMENT_RECOVERY_BACKOFF_BASE_MS: '1',
      FULFILMENT_RECOVERY_BACKOFF_MAX_MS: '2',
      FULFILMENT_RECOVERY_ALERT_ATTEMPTS: '1',
    });
    const doomed = await paidOrder(
      doomedCatalog,
      FulfillmentStateEnum.AWAITING_STOCK,
    );

    const first = await recovery.recover(BATCH);
    expect(first.overdue).toEqual([]);

    const second = await recovery.recover(BATCH);
    expect(second.attempts[0]).toMatchObject({ orderId: doomed, attempt: 2 });
    expect(second.overdue).toEqual([doomed]);

    // Escalated, and STILL retried: the order remains in its recorded state and
    // remains a candidate. Giving up would be a financial decision (D-2).
    expect(await orderState(h.dataSource, doomed)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
    });
    const third = await recovery.recover(BATCH);
    expect(third.attempts[0]).toMatchObject({ orderId: doomed, attempt: 3 });

    // ...and the moment the stock comes back, it is fulfilled like any other.
    await receiveStock(h.dataSource, h.inventory, doomedCatalog.variantId, 5);
    const fourth = await recovery.recover(BATCH);
    expect(fourth).toMatchObject({ scanned: 1, fulfilled: 1, failed: 0 });
    expect(await orderState(h.dataSource, doomed)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
  });

  it('F4 - two instances leasing at the same moment never take the same order', async () => {
    const a = recoveryWith();
    // A second, independent service over the same DataSource, so the in-process
    // `running` guard cannot be what makes this pass.
    const b = recoveryWith();

    const orders: number[] = [];
    for (let i = 0; i < 4; i++) {
      orders.push(
        await paidOrder(doomedCatalog, FulfillmentStateEnum.AWAITING_STOCK),
      );
    }

    const [reportA, reportB] = await Promise.all([
      a.recover(BATCH),
      b.recover(BATCH),
    ]);

    const taken = [...reportA.orderIds, ...reportB.orderIds];
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken.length).toBeLessThanOrEqual(orders.length);
    // Whoever leased an order attempted it exactly once.
    for (const orderId of taken) {
      expect((await retryBookkeeping(orderId)).attempts).toBe(1);
    }
  });
});
