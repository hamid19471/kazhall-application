import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AffectedBasketLine } from './inventory.types';
import { InventoryService } from './inventory.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface SweepResult {
  batches: number;
  releasedReservations: number;
  affectedBasketLines: AffectedBasketLine[];
  prunedCartTombstones: number;
}

/**
 * Background expiry worker.
 *
 * IT IS AN OPTIMISATION ONLY. Correctness comes from R5: every availability
 * computation and every consuming operation lazily expires due reservations
 * inside its own transaction, so an inventory number is never wrong just
 * because this worker is stopped, crashed, or behind.
 *
 * What the worker buys us is that a customer who is *not* touching the system
 * still frees their stock on time, and that the reservation table does not grow
 * an unbounded tail of long-dead ACTIVE rows.
 *
 * SAFETY PROPERTIES
 *  - Bounded: at most `batchSize * maxBatchesPerRun` rows per run.
 *  - Retry-safe: every state change is the guarded conditional UPDATE of R3, so
 *    re-running a sweep that half-completed cannot double release anything.
 *  - Multi-instance safe: candidates are taken with `FOR UPDATE SKIP LOCKED`
 *    (see InventoryService.expireDueReservations), so N instances sweeping at
 *    the same time partition the work instead of blocking or duplicating.
 *  - Never touches physical stock: releasing a hold changes `basketReserved`,
 *    never `product_variants.stock`. No stock movement is written here.
 *
 * `@nestjs/schedule` is deliberately NOT used -- adding a dependency is out of
 * scope for this workstream -- so the timer is a plain unref'd setInterval.
 */
@Injectable()
export class ReservationSweeperService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ReservationSweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The pass currently in flight, so shutdown can await it. */
  private inFlight: Promise<unknown> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventoryService: InventoryService,
    private readonly configService: ConfigService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  private num(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  get enabled(): boolean {
    const raw = this.configService.get<string>('INVENTORY_SWEEPER_ENABLED');
    if (raw !== undefined) return raw === 'true' || raw === '1';
    // Off under test: the suite drives `runOnce()` deterministically instead of
    // racing a timer.
    return process.env.NODE_ENV !== 'test';
  }

  get intervalMs(): number {
    return this.num('INVENTORY_SWEEPER_INTERVAL_MS', 60_000);
  }

  get batchSize(): number {
    return this.num('INVENTORY_SWEEPER_BATCH_SIZE', 200);
  }

  get maxBatchesPerRun(): number {
    return this.num('INVENTORY_SWEEPER_MAX_BATCHES', 10);
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      this.inFlight = this.runOnce().catch((error) =>
        this.logger.error(
          `reservation sweep failed: ${(error as Error).message}`,
        ),
      );
    }, this.intervalMs);
    // Never hold the event loop open because of the sweeper.
    this.timer.unref?.();
  }

  /**
   * Stops the timer AND WAITS FOR THE PASS THAT IS ALREADY RUNNING.
   *
   * Clearing the interval alone was not enough. A pass that started a
   * millisecond before shutdown keeps querying a DataSource that is being
   * destroyed, and can still be holding a transaction — and therefore locks —
   * after `app.close()` has resolved. In the integration suite that is a lock
   * surviving into the NEXT spec file, where nothing owns it and nothing can
   * explain it.
   *
   * Awaiting the in-flight promise is what makes "the application is closed"
   * mean "nothing of it is still touching the database". The pass is already
   * bounded (one batch loop, no network call inside a transaction), so this
   * cannot hang shutdown indefinitely.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pass = this.inFlight;
    this.inFlight = null;
    if (pass) await pass;
  }

  /**
   * One bounded sweep. Safe to call manually (admin endpoint / test suite) even
   * while the timer is also running -- the second caller simply returns an
   * empty result rather than piling transactions on top of each other.
   */
  async runOnce(now: Date = new Date()): Promise<SweepResult> {
    const empty: SweepResult = {
      batches: 0,
      releasedReservations: 0,
      affectedBasketLines: [],
      prunedCartTombstones: 0,
    };
    if (this.running) return empty;
    this.running = true;

    const result: SweepResult = { ...empty, affectedBasketLines: [] };
    /**
     * Every variant this sweep expired, both kinds. See the `expiredVariantIds`
     * collector on `expireDueReservations` for why the return value cannot
     * answer this.
     */
    const expiredVariantIds: number[] = [];
    try {
      for (let batch = 0; batch < this.maxBatchesPerRun; batch++) {
        // Each batch is its own transaction: a failure late in the sweep never
        // discards the batches that already committed.
        const before = expiredVariantIds.length;
        const affected = await this.dataSource.transaction((manager) =>
          this.inventoryService.expireDueReservations(manager, {
            limit: this.batchSize,
            now,
            expiredVariantIds,
          }),
        );
        result.batches += 1;
        result.affectedBasketLines.push(...affected);
        /*
         * PROGRESS IS MEASURED IN RESERVATIONS EXPIRED, not in basket lines
         * affected.
         *
         * This used to break on `affected.length === 0`, which is what an
         * all-ORDER batch legitimately returns — so a run that met a batch of
         * expiring order allocations stopped sweeping while basket holds
         * behind them were still due.
         */
        if (expiredVariantIds.length === before) break;
      }

      result.releasedReservations = result.affectedBasketLines.reduce(
        (sum, line) => sum + line.revokedQuantity,
        0,
      );
      result.prunedCartTombstones = await this.pruneAcknowledgedTombstones();
    } finally {
      this.running = false;
    }

    // Every batch above committed in its own transaction, and the loop is over,
    // so this is unambiguously post-commit for all of them.
    await this.publishExpiries(result.affectedBasketLines);

    /*
     * Variants whose ORDER allocation lapsed — i.e. every expired variant that
     * was not accounted for by a basket line.
     *
     * `allocation`, so it reaches the till as well: an unpaid order's
     * allocation is subtracted from `availableForPos`, so releasing it really
     * does give the counter units back. A basket hold never does, which is why
     * the two are published under different reasons.
     */
    const basketVariantIds = new Set(
      result.affectedBasketLines.map((line) => line.variantId),
    );
    const allocationOnly = [...new Set(expiredVariantIds)].filter(
      (variantId) => !basketVariantIds.has(variantId),
    );
    if (allocationOnly.length > 0) {
      await this.realtimeGateway.publishAvailabilityInvalidation(
        allocationOnly,
        'allocation',
      );
    }
    return result;
  }

  /**
   * Announce that expired holds have freed a variant.
   *
   * ## What actually changed, and what is broadcast
   *
   * An expiry does NOT move physical stock -- it releases a hold, so
   * `basketReserved` falls and `availableForBasket` rises while
   * `product_variants.stock` is untouched. `availability:invalidated` says
   * only "this variant changed, re-read it", which is precisely the right
   * strength of claim: the numbers that moved are ones only the server can
   * compute, and every client's reaction is to call the endpoint that computes
   * them.
   *
   * THE FRAME CARRIES NO STATE, so there is no `inStock` to derive here. This
   * paragraph used to explain how that field was read from committed physical
   * stock and `isActive`; it is gone, along with the four other places that
   * derived it differently. Sellability is answered in one place now
   * (`deriveAvailability`) and enforced in one place
   * (`InventoryService.assertSellableUnderLock`): raw physical availability
   * remains visible for inventory management, but `isActive = false` makes the
   * variant unsellable through both Storefront and POS.
   *
   * ## Why `emitToUser` is NOT used here
   *
   * `AffectedBasketLine` carries `userId` and `cartItemId`, so a per-customer
   * notice would be easy and would also be a new privacy surface for a
   * background worker to maintain. It is not needed: the owning customer holds
   * that variant in their basket, so the global availability frame already
   * reaches them, and their client answers it with `GET /cart` -- which is the
   * only thing that can tell them the line was reduced and why. The narrower
   * event would carry no information the authoritative read does not.
   *
   * ## Why one frame per VARIANT, not per line
   *
   * Ten customers losing holds on the same SKU is one fact about that SKU.
   * De-duplicating here keeps a large sweep from broadcasting hundreds of
   * identical frames to every connected socket in the shop.
   *
   * A failure is logged and swallowed: the releases are committed, realtime is
   * advisory, and this is a background worker whose failure must not look like
   * a failed sweep.
   */
  private async publishExpiries(lines: AffectedBasketLine[]): Promise<void> {
    const variantIds = [...new Set(lines.map((line) => line.variantId))];
    if (variantIds.length === 0) return;
    /*
     * `reservation`, not `stock`: an expiry releases a HOLD and moves no
     * physical units, so it changes what the storefront may sell and changes
     * nothing the till may sell. The publisher routes on that distinction, so
     * no till is woken to re-read a number that did not move.
     *
     * The variant re-read that used to live here is gone with the boolean it
     * fed — the frame no longer carries state, so there is nothing to read.
     */
    await this.realtimeGateway.publishAvailabilityInvalidation(
      variantIds,
      'reservation',
    );
  }

  /**
   * Housekeeping: a soft-removed basket line whose explanation the customer has
   * already been shown (`lastChangeReason IS NULL`) carries no information any
   * more. The partial unique index only covers active rows, so these tombstones
   * block nothing -- they are simply deleted once they are old enough that no
   * in-flight basket read can still be about to display them.
   */
  private async pruneAcknowledgedTombstones(): Promise<number> {
    const ttlMs = this.num('CART_TOMBSTONE_TTL_MS', 24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - ttlMs);
    const raw: unknown = await this.dataSource.query(
      `DELETE FROM cart_items
        WHERE status = 'removed'
          AND "lastChangeReason" IS NULL
          AND ("lastChangeAt" IS NULL OR "lastChangeAt" < $1)`,
      [cutoff],
    );
    if (Array.isArray(raw) && raw.length === 2) return Number(raw[1] ?? 0);
    return 0;
  }
}
