import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';

import {
  ReservationKind,
  ReservationReleaseReason,
  ReservationStatus,
} from './entities/stock-reservation.entity';
import { StockMovementReason } from './entities/stock-movement.entity';
import {
  AdjustStockInput,
  AdjustStockResult,
  AffectedBasketLine,
  AvailabilitySnapshot,
  BASKET_RESERVATION_TTL_MS,
  ConsumedVariantResult,
  DEFAULT_ORDER_ALLOCATION_TTL_MS,
  IInventoryService,
  InsufficientStockError,
  InsufficientStockForFulfilmentError,
  PosConsumeItem,
  PosConsumeResult,
  ReserveForBasketResult,
  SkuLookupResult,
} from './inventory.types';
import {
  ConcurrentModificationError,
  VariantInactiveError,
} from './inventory.errors';
import {
  AVAILABILITY_FACTS_SQL,
  deriveAvailability,
} from './availability.projection';
import { InventoryMessages } from './inventory.messages';
import {
  LineCostState,
  ValuationInvariantError,
  ValuationOverflowError,
  ValuationPool,
  consume as consumeFromPool,
  consumeLines,
  receive as receiveIntoPool,
  receiveUnvalued as receiveUnvaluedIntoPool,
  initialise as initialiseInPool,
  restockSplit,
  restore as restoreToPool,
  reverseRevenue,
} from './valuation/valuation';
import { CostingErrorCodes, costingError } from './valuation/costing.errors';
import { OrderItemAdjustmentKind } from '../orders/entities/order-item-adjustment.entity';

/** Default cap on how many due reservations one lazy-expiry pass will touch. */
export const DEFAULT_EXPIRY_BATCH_LIMIT = 200;

/** Cart line lifecycle. Mirrors `cart_items.status` (see cart-item.entity.ts). */
const CART_STATUS_ACTIVE = 'active';
const CART_STATUS_REMOVED = 'removed';

/**
 * Release reasons the *customer themselves* caused. These never leave a
 * customer-visible notice on the basket line -- the customer already knows.
 * Everything else (sold_in_store, reservation_expired) does.
 */
const USER_INITIATED_REASONS: ReadonlySet<ReservationReleaseReason> = new Set([
  ReservationReleaseReason.BASKET_ITEM_REMOVED,
  ReservationReleaseReason.QUANTITY_REDUCED,
  ReservationReleaseReason.CONVERTED_TO_ORDER,
]);

interface VariantLockRow {
  id: number;
  stock: number;
  price: number;
  sku: string;
  /**
   * `product_variants.isActive` as it stood WHEN THE ROW LOCK WAS TAKEN.
   *
   * This is the only value any sell path may trust. Read before the lock it
   * can be stale by the time stock moves, and read from a request body it is
   * whatever the client chose to send. See `assertSellableUnderLock`.
   */
  isActive: boolean;
}

interface ReservationRow {
  id: number;
  variantId: number;
  kind: ReservationKind;
  quantity: number;
  userId: number | null;
  cartItemId: number | null;
  orderId: number | null;
  expiresAt: Date;
}

interface CartLineRow {
  id: number;
  userId: number | null;
  variantId: number | null;
  quantity: number;
  status: string;
}

/** One reservation row that a release/revoke pass actually touched. */
interface TouchedReservation {
  reservationId: number;
  variantId: number;
  cartItemId: number | null;
  userId: number | null;
  quantity: number;
  fullyReleased: boolean;
}

/**
 * ============================================================================
 * InventoryService -- the single writer of physical stock and reservations.
 * ============================================================================
 *
 * Contract: `IInventoryService` in inventory.types.ts (lead-owned).
 *
 * EVERY method takes the caller's EntityManager and NEVER opens its own
 * transaction, so a POS sale can compose displacement + decrement + order
 * creation into one atomic unit (R6).
 *
 * ---------------------------------------------------------------------------
 * GLOBAL LOCK ORDER (deadlock freedom):
 *
 *     orders  ->  product_variants (ASC id)  ->  stock_reservations  ->  cart_items
 *
 * Every write path in this service, in CartService and in the payment
 * fulfilment path acquires locks in that order and never in another. Within
 * `product_variants` the order is ascending id (R1), which is what keeps a
 * multi-SKU POS sale from deadlocking against a multi-SKU checkout.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class InventoryService implements IInventoryService {
  constructor(@Optional() private readonly configService?: ConfigService) {}

  // ==========================================================================
  // Configuration
  // ==========================================================================

  private get basketTtlMs(): number {
    const raw = this.configService?.get<string>('BASKET_RESERVATION_TTL_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : BASKET_RESERVATION_TTL_MS;
  }

  private get orderAllocationTtlMs(): number {
    const raw = this.configService?.get<string>('ORDER_ALLOCATION_TTL_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ORDER_ALLOCATION_TTL_MS;
  }

  // ==========================================================================
  // Low-level SQL helpers
  // ==========================================================================

  /**
   * TypeORM's postgres driver returns `[rows, rowCount]` from an UPDATE/DELETE
   * and a bare rows array from SELECT/INSERT. This normalises the UPDATE shape
   * so every guarded write can assert its affected-row count.
   */
  private async execWrite<T = Record<string, unknown>>(
    manager: EntityManager,
    sql: string,
    params: unknown[],
  ): Promise<{ rows: T[]; affected: number }> {
    const raw: unknown = await manager.query(sql, params);
    if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0])) {
      return { rows: raw[0] as T[], affected: Number(raw[1] ?? 0) };
    }
    const rows = (Array.isArray(raw) ? raw : []) as T[];
    return { rows, affected: rows.length };
  }

  private async select<T = Record<string, unknown>>(
    manager: EntityManager,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    const raw: unknown = await manager.query(sql, params);
    return (Array.isArray(raw) ? raw : []) as T[];
  }

  private static toInt(value: unknown): number {
    if (value === null || value === undefined) return 0;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private static uniqueAscending(ids: number[]): number[] {
    return Array.from(new Set(ids.map((id) => Number(id)))).sort(
      (a, b) => a - b,
    );
  }

  // ==========================================================================
  // R1 -- ordered row locks
  // ==========================================================================

  /**
   * R1. Locks `product_variants` FOR UPDATE in ascending id order.
   *
   *   SELECT id, stock, price, sku FROM product_variants
   *    WHERE id = ANY($1::int[]) ORDER BY id ASC FOR UPDATE
   *
   * Postgres runs ExecLockRows over the already-sorted output, so the rows are
   * locked in ascending id order. Every multi-SKU path (POS sale, checkout,
   * online fulfilment, sweeper batch) funnels through here, which is the only
   * thing preventing a lock-order inversion between them.
   */
  async lockVariants(
    manager: EntityManager,
    variantIds: number[],
  ): Promise<Map<number, VariantLockRow>> {
    const ids = InventoryService.uniqueAscending(variantIds ?? []);
    const result = new Map<number, VariantLockRow>();
    if (ids.length === 0) return result;

    const rows = await this.select<{
      id: number;
      stock: number | string;
      price: number | string | null;
      sku: string;
      isActive: boolean | null;
    }>(
      manager,
      /*
       * `isActive` IS PART OF THE LOCKED ROW, deliberately.
       *
       * The sellability rule has to be decided against the same row version
       * the stock arithmetic is decided against, or the two can disagree: an
       * administrator retiring a SKU issues `UPDATE product_variants SET
       * "isActive" = false WHERE id = ...`, which needs this very row lock.
       * Taking `isActive` here means the sale either holds the lock first (and
       * the deactivation waits, so the sale was valid when it committed) or
       * the deactivation committed first (and this SELECT returns false). It
       * is not possible for both to observe a stale active state.
       *
       * It is READ here and enforced in `assertSellableUnderLock` -- never
       * enforced here, because restore paths (void, return, stock adjustment)
       * legitimately lock and write retired variants.
       */
      `SELECT id, stock, price, sku, "isActive"
         FROM product_variants
        WHERE id = ANY($1::int[])
        ORDER BY id ASC
          FOR UPDATE`,
      [ids],
    );

    for (const row of rows) {
      result.set(Number(row.id), {
        id: Number(row.id),
        stock: InventoryService.toInt(row.stock),
        price: InventoryService.toInt(row.price),
        sku: row.sku,
        isActive: row.isActive === true,
      });
    }

    const missing = ids.filter((id) => !result.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `${InventoryMessages.VARIANT_NOT_FOUND}: ${missing.join(', ')}`,
      );
    }
    return result;
  }

  /**
   * THE SELLABILITY GATE. Refuses every variant whose row-locked `isActive` is
   * false, and does so before the caller has written anything.
   *
   * ## The one rule, everywhere
   *
   * Raw physical availability remains visible for inventory management, but
   * `isActive = false` makes the variant unsellable through both Storefront and
   * POS.
   *
   * ## What this is NOT
   *
   * It is not a replacement for the stock gates. A retired variant is refused
   * here *whatever* its numbers say, and an active variant is still subject to
   * `availableForPos` / `availableForBasket` afterwards. The two are
   * independent: `VariantInactiveError` and `InsufficientStockError` answer
   * different questions and a caller can hit either.
   *
   * ## Why it takes the LOCKED map rather than variant ids
   *
   * So it cannot be called without the lock. The only argument it accepts is
   * the result of `lockVariants`, which means the value it tests was read by a
   * `SELECT ... FOR UPDATE` inside the caller's transaction. A version of this
   * that took ids and ran its own SELECT would be exactly the stale read the
   * rule exists to rule out, and a version that took the client's
   * `isActive` would be no check at all.
   *
   * ## Determinism
   *
   * Ascending variant id, so a mixed basket always names the same offending
   * line no matter what order the cashier scanned them in. The refusal names
   * ONE variant: the till marks that row, the cashier removes it, and a retry
   * surfaces the next one if there is one.
   */
  assertSellableUnderLock(
    locked: ReadonlyMap<number, VariantLockRow>,
    variantIds: readonly number[],
  ): void {
    for (const variantId of InventoryService.uniqueAscending([...variantIds])) {
      const row = locked.get(variantId);
      /*
       * A missing row is NOT this gate's business: `lockVariants` has already
       * thrown NotFoundException for any id it could not resolve, so reaching
       * here with a gap means the caller passed ids it never locked. Skipping
       * is right -- inventing a sellability answer for an unlocked id would be
       * the stale read again.
       */
      if (row === undefined) continue;
      if (row.isActive) continue;
      throw new VariantInactiveError(variantId, row.sku ?? null);
    }
  }

  // ==========================================================================
  // R5 -- lazy expiry
  // ==========================================================================

  /**
   * R5. Releases every ACTIVE reservation whose `expiresAt <= now`, bounded by
   * `limit`, and reduces / soft-removes the basket lines behind them.
   *
   * Called at the start of every availability computation and every consuming
   * operation, inside the caller's transaction, so an expired reservation can
   * never block stock just because the background sweeper has not run yet.
   *
   * Multi-instance safe: candidate rows are taken with `FOR UPDATE SKIP LOCKED`
   * and every state change is the guarded conditional UPDATE of R3.
   *
   * IMPORTANT: expiry releases the *hold*. It never touches
   * `product_variants.stock` -- no stock movement is written here.
   */
  async expireDueReservations(
    manager: EntityManager,
    opts?: {
      variantIds?: number[];
      limit?: number;
      now?: Date;
      /**
       * OPTIONAL COLLECTOR for every variant this pass expired, BASKET AND
       * ORDER kinds alike.
       *
       * The return value cannot serve this purpose: it is
       * `AffectedBasketLine[]`, and an order allocation has no cart line, so
       * `syncAffectedCartLines` skips it and an all-order batch returns `[]`.
       * The visible consequence was that an unpaid order's allocation expiring
       * — which frees units for BOTH channels — announced nothing at all, and
       * an all-order batch also stopped the sweep early by looking like "no
       * work done".
       *
       * An out-parameter rather than a widened return type, so the method's
       * contract and its seven existing callers are untouched.
       */
      expiredVariantIds?: number[];
    },
  ): Promise<AffectedBasketLine[]> {
    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? DEFAULT_EXPIRY_BATCH_LIMIT;
    const scopedVariantIds = opts?.variantIds
      ? InventoryService.uniqueAscending(opts.variantIds)
      : undefined;

    if (scopedVariantIds && scopedVariantIds.length === 0) return [];

    // Step 1 -- discover candidates WITHOUT locking, so we can respect the
    // global lock order (variants before reservations) even in the sweeper
    // path where the caller has not locked anything yet.
    const candidates = await this.select<{ id: number; variantId: number }>(
      manager,
      `SELECT id, "variantId"
         FROM stock_reservations
        WHERE status = $1
          AND "expiresAt" <= $2
          ${scopedVariantIds ? 'AND "variantId" = ANY($4::int[])' : ''}
        ORDER BY "expiresAt" ASC, id ASC
        LIMIT $3`,
      scopedVariantIds
        ? [ReservationStatus.ACTIVE, now, limit, scopedVariantIds]
        : [ReservationStatus.ACTIVE, now, limit],
    );
    if (candidates.length === 0) return [];

    // Step 2 -- take the variant locks first (ascending id, R1). When the
    // caller already scoped us to variants it holds, this is a cheap re-lock.
    if (!scopedVariantIds) {
      await this.lockVariants(
        manager,
        candidates.map((c) => Number(c.variantId)),
      );
    }

    // Step 3 -- now lock the reservation rows themselves.
    const due = await this.select<ReservationRow>(
      manager,
      `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
         FROM stock_reservations
        WHERE id = ANY($1::int[])
          AND status = $2
          AND "expiresAt" <= $3
        ORDER BY "expiresAt" ASC, id ASC
          FOR UPDATE SKIP LOCKED`,
      [candidates.map((c) => Number(c.id)), ReservationStatus.ACTIVE, now],
    );
    if (due.length === 0) return [];

    const touched: TouchedReservation[] = [];
    for (const reservation of due) {
      await this.leaveActive(
        manager,
        Number(reservation.id),
        ReservationStatus.RELEASED,
        ReservationReleaseReason.RESERVATION_EXPIRED,
        now,
      );
      opts?.expiredVariantIds?.push(Number(reservation.variantId));
      touched.push({
        reservationId: Number(reservation.id),
        variantId: Number(reservation.variantId),
        cartItemId:
          reservation.cartItemId === null
            ? null
            : Number(reservation.cartItemId),
        userId: reservation.userId === null ? null : Number(reservation.userId),
        quantity: InventoryService.toInt(reservation.quantity),
        fullyReleased: true,
      });
    }

    return this.syncAffectedCartLines(
      manager,
      touched,
      ReservationReleaseReason.RESERVATION_EXPIRED,
      now,
    );
  }

  // ==========================================================================
  // R3 -- the only way out of ACTIVE
  // ==========================================================================

  /**
   * R3. The ONLY transition out of ACTIVE:
   *
   *   UPDATE stock_reservations
   *      SET status = $2, "releasedAt" = $3, "releaseReason" = $4
   *    WHERE id = $1 AND status = 'active'
   *
   * with affected rows asserted `=== 1`. Because the guard is part of the
   * WHERE clause, a second release of the same row updates 0 rows and raises
   * instead of silently double-crediting the stock back. Double release is
   * therefore structurally impossible, not merely unlikely.
   */
  private async leaveActive(
    manager: EntityManager,
    reservationId: number,
    next: ReservationStatus,
    reason: ReservationReleaseReason,
    now: Date,
  ): Promise<void> {
    const { affected } = await this.execWrite(
      manager,
      `UPDATE stock_reservations
          SET status = $2, "releasedAt" = $3, "releaseReason" = $4
        WHERE id = $1
          AND status = 'active'`,
      [reservationId, next, now, reason],
    );
    if (affected !== 1) {
      throw new ConcurrentModificationError(
        'reservation',
        reservationId,
        affected,
      );
    }
  }

  /**
   * Partial release of a tranche: shrink an ACTIVE row in place, keeping its
   * ORIGINAL `expiresAt` (R4 -- the surviving units never get a fresh timer).
   * Guarded the same way as a full release.
   */
  private async shrinkActive(
    manager: EntityManager,
    reservationId: number,
    releaseQuantity: number,
  ): Promise<void> {
    const { affected } = await this.execWrite(
      manager,
      `UPDATE stock_reservations
          SET quantity = quantity - $2
        WHERE id = $1
          AND status = 'active'
          AND quantity > $2`,
      [reservationId, releaseQuantity],
    );
    if (affected !== 1) {
      throw new ConcurrentModificationError(
        'reservation',
        reservationId,
        affected,
      );
    }
  }

  // ==========================================================================
  // R2c -- the only way physical stock (and its cost) changes
  // ==========================================================================

  /**
   * R2c. Reads the variant's valuation pool UNDER ITS ROW LOCK.
   *
   * `FOR UPDATE` here is a re-acquisition, never a new lock: every caller has
   * already taken this row through `lockVariants` in ascending id order (R1),
   * so this cannot introduce a lock-order inversion. It is repeated so that
   * the value read is guaranteed to be the locked one, whoever calls it.
   *
   * The value is read as TEXT and becomes a `bigint`: an inventory value is a
   * total over up to MAX_STOCK_UNITS units and is never a JavaScript number.
   */
  private async readPool(
    manager: EntityManager,
    variantId: number,
  ): Promise<ValuationPool> {
    const rows = await this.select<{
      stock: number | string;
      unvaluedQuantity: number | string;
      value: string;
    }>(
      manager,
      `SELECT stock, "unvaluedQuantity", "inventoryCostValue"::text AS value
         FROM product_variants
        WHERE id = $1
          FOR UPDATE`,
      [variantId],
    );
    if (rows.length !== 1) {
      throw new NotFoundException(
        `${InventoryMessages.VARIANT_NOT_FOUND}: ${variantId}`,
      );
    }
    return {
      stock: InventoryService.toInt(rows[0].stock),
      unvaluedQuantity: InventoryService.toInt(rows[0].unvaluedQuantity),
      value: BigInt(rows[0].value),
    };
  }

  /**
   * Runs one pure valuation step, turning its two error classes into the
   * contract's HTTP answers: an overflow is the caller's input (400), an
   * invariant breach is ours (500, `COST_ALLOCATION_INVARIANT_VIOLATION`).
   */
  static valuationStep<T>(variantId: number, step: () => T): T {
    try {
      return step();
    } catch (err) {
      if (err instanceof ValuationOverflowError) {
        throw costingError.badRequest(
          CostingErrorCodes.PURCHASE_COST_OUT_OF_RANGE,
          { variantId },
        );
      }
      if (err instanceof ValuationInvariantError) {
        throw costingError.invariant(`variant ${variantId}: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * R2c. THE ONLY WRITER of `stock`, `unvaluedQuantity` and
   * `inventoryCostValue`, and the only writer of stock movements.
   *
   * A compare-and-set against the pool this transaction read under its own row
   * lock, so it cannot lose — if it ever affects anything but one row the pool
   * moved underneath a lock we hold, which is impossible, and the whole
   * transaction aborts rather than writing a cost computed from stale numbers.
   * `stock >= 0` and every other pool invariant is ALSO a CHECK constraint.
   *
   * `trg_product_variants_pool_guard` refuses any other UPDATE of these
   * columns; the transaction-local flag set around this statement is how the
   * database tells this writer apart from a shortcut.
   *
   * The movement carries the cost evidence (docs §6.1) — the signed value
   * change, the value and unvalued count after — derived from the same two
   * pools that were written, so the ledger and the row cannot disagree.
   */
  private async writePool(
    manager: EntityManager,
    variantId: number,
    before: ValuationPool,
    after: ValuationPool,
    movement: {
      reason: StockMovementReason;
      reasonText?: string | null;
      orderId?: number | null;
      actorUserId?: number | null;
      actorDisplaySnapshot?: string | null;
      branchId?: number | null;
      unitCost?: bigint | null;
      supplierReference?: string | null;
      now: Date;
    },
  ): Promise<{ balanceAfter: number; movementId: number | null }> {
    await manager.query(
      `SELECT set_config('kazhal.valuation_writer', 'on', true)`,
    );
    let result: { rows: Array<{ stock: number | string }>; affected: number };
    try {
      result = await this.execWrite<{ stock: number | string }>(
        manager,
        `UPDATE product_variants
            SET stock = $2,
                "unvaluedQuantity" = $3,
                "inventoryCostValue" = $4::bigint
          WHERE id = $1
            AND stock = $5
            AND "unvaluedQuantity" = $6
            AND "inventoryCostValue" = $7::bigint
          RETURNING stock`,
        [
          variantId,
          after.stock,
          after.unvaluedQuantity,
          after.value.toString(),
          before.stock,
          before.unvaluedQuantity,
          before.value.toString(),
        ],
      );
    } finally {
      await manager.query(
        `SELECT set_config('kazhal.valuation_writer', 'off', true)`,
      );
    }
    if (result.affected !== 1 || result.rows.length !== 1) {
      throw costingError.invariant(
        `variant ${variantId}: the valuation pool changed under its row lock`,
      );
    }
    const balanceAfter = InventoryService.toInt(result.rows[0].stock);

    const movementId = await this.writeMovement(manager, {
      variantId,
      delta: after.stock - before.stock,
      balanceAfter,
      reason: movement.reason,
      reasonText: movement.reasonText ?? null,
      orderId: movement.orderId ?? null,
      actorUserId: movement.actorUserId ?? null,
      actorDisplaySnapshot: movement.actorDisplaySnapshot ?? null,
      branchId: movement.branchId ?? null,
      now: movement.now,
      cost: {
        unitCost: movement.unitCost ?? null,
        costDelta: after.value - before.value,
        inventoryValueAfter: after.value,
        unvaluedQuantityDelta: after.unvaluedQuantity - before.unvaluedQuantity,
        unvaluedQuantityAfter: after.unvaluedQuantity,
        supplierReference: movement.supplierReference ?? null,
      },
    });
    return { balanceAfter, movementId };
  }

  /**
   * Writes one ledger row and returns its id. A zero delta is written ONLY for
   * `valuation_initialization` (value moves, quantity does not); for every
   * other reason it is a no-op, exactly as before 0037.
   */
  private async writeMovement(
    manager: EntityManager,
    input: {
      variantId: number;
      delta: number;
      balanceAfter: number;
      reason: StockMovementReason;
      /**
       * The HUMAN explanation (migration 0024). Omit it — or pass null — for
       * every system-generated movement: a POS sale, an online fulfilment and
       * a cancellation/return restore have no author to quote, and inventing a
       * sentence for them would make a generated string indistinguishable from
       * one an operator typed. Only the administrative paths pass a value, and
       * `normaliseReasonText` is what turns it into either real text or NULL.
       */
      reasonText?: string | null;
      orderId?: number | null;
      actorUserId?: number | null;
      actorDisplaySnapshot?: string | null;
      branchId?: number | null;
      now: Date;
      cost: {
        unitCost: bigint | null;
        costDelta: bigint;
        inventoryValueAfter: bigint;
        unvaluedQuantityDelta: number;
        unvaluedQuantityAfter: number;
        supplierReference: string | null;
      };
    },
  ): Promise<number | null> {
    if (
      input.delta === 0 &&
      input.reason !== StockMovementReason.VALUATION_INITIALIZATION
    ) {
      return null; // ledger rows are never zero
    }
    const rows = await this.select<{ id: number }>(
      manager,
      `INSERT INTO stock_movements
         ("variantId", delta, "balanceAfter", reason, "reasonText", "orderId",
          "actorUserId", "actorDisplaySnapshot", "branchId", "createdAt",
          "unitCost", "costDelta", "inventoryValueAfter",
          "unvaluedQuantityDelta", "unvaluedQuantityAfter", "supplierReference")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11::bigint, $12::bigint, $13::bigint, $14, $15, $16)
       RETURNING id`,
      [
        input.variantId,
        input.delta,
        input.balanceAfter,
        input.reason,
        InventoryService.normaliseReasonText(input.reasonText),
        input.orderId ?? null,
        input.actorUserId ?? null,
        input.actorDisplaySnapshot ?? null,
        input.branchId ?? null,
        input.now,
        input.cost.unitCost === null ? null : input.cost.unitCost.toString(),
        input.cost.costDelta.toString(),
        input.cost.inventoryValueAfter.toString(),
        input.cost.unvaluedQuantityDelta,
        input.cost.unvaluedQuantityAfter,
        InventoryService.normaliseReasonText(
          input.cost.supplierReference,
        )?.slice(0, 120) ?? null,
      ],
    );
    return rows.length ? Number(rows[0].id) : null;
  }

  // ==========================================================================
  // COGS -- recognised at the stock-consumption point, once
  // ==========================================================================

  /**
   * Allocates this variant's share of an order's COGS to the order's PENDING
   * lines of that variant, ascending `order_items.id`, and returns the pool
   * that results. docs/PURCHASE-COST-ACCOUNTING.md §4.1.
   *
   * THE ONE COST-ALLOCATION PATH FOR BOTH CHANNELS. `consumeForPosSale` and
   * `consumeForOnlineFulfilment` both call this after `lockVariants`, inside
   * the transaction that decrements the stock, with the pool read under the
   * same lock — so Web and POS cannot cost a unit differently, and two sales
   * racing for the last unit serialise on the row before either reads a cost.
   *
   * EVERY CONSUMED UNIT BELONGS TO A LINE. The pending lines of this variant
   * must add up to exactly the quantity being consumed; anything else means a
   * caller decremented stock the order does not describe, and it is refused
   * rather than leaving COGS attached to nothing.
   *
   * WRITTEN ONCE. Each line UPDATE is guarded `WHERE "costStatus" = 'pending'`
   * and asserted to affect one row, and `trg_order_items_cost_snapshot_immutable`
   * refuses any change after that. A retry that somehow reached here twice
   * would fail, not double-count.
   */
  private async allocateOrderLineCosts(
    manager: EntityManager,
    input: {
      orderId: number;
      variantId: number;
      quantity: number;
      pool: ValuationPool;
      now: Date;
    },
  ): Promise<ValuationPool> {
    const lines = await this.select<{ id: number; quantity: number | string }>(
      manager,
      `SELECT id, quantity
         FROM order_items
        WHERE "orderId" = $1
          AND "variantId" = $2
          AND "costStatus" = 'pending'
        ORDER BY id ASC`,
      [input.orderId, input.variantId],
    );
    const demands = lines.map((l) => ({
      orderItemId: Number(l.id),
      quantity: InventoryService.toInt(l.quantity),
    }));
    const covered = demands.reduce((sum, d) => sum + d.quantity, 0);
    if (covered !== input.quantity) {
      throw costingError.invariant(
        `order ${input.orderId} variant ${input.variantId}: consuming ` +
          `${input.quantity} unit(s) but its pending lines describe ${covered}`,
      );
    }

    const { pool, allocations } = InventoryService.valuationStep(
      input.variantId,
      () => consumeLines(input.pool, demands),
    );

    for (const a of allocations) {
      const { affected } = await this.execWrite(
        manager,
        `UPDATE order_items
            SET "costStatus" = $2,
                "cogsTotal" = $3::bigint,
                "costKnownQuantity" = $4,
                "costUnknownQuantity" = $5,
                "costAllocatedAt" = $6
          WHERE id = $1
            AND "costStatus" = 'pending'`,
        [
          a.orderItemId,
          a.unknownQuantity > 0 ? 'unknown' : 'known',
          a.cogs.toString(),
          a.knownQuantity,
          a.unknownQuantity,
          input.now,
        ],
      );
      if (affected !== 1) {
        throw costingError.invariant(
          `order line ${a.orderItemId}: cost already recognised`,
        );
      }
    }
    return pool;
  }

  /**
   * The one place a free-text reason becomes a ledger value.
   *
   * Trims, then maps "nothing left" to NULL rather than to `''`. Two reasons:
   * `chk_stock_movement_reason_text_not_blank` refuses a blank string at the
   * database level (a 500, which is the wrong way to report a bad input), and
   * an empty string would read as "an explanation was given" to every
   * `IS NOT NULL` check while carrying none.
   *
   * This is NOT the validation. The 400 for a whitespace-only administrative
   * reason is produced by `AdminAdjustStockDto`, at the edge where a refusal
   * can still name the field. This is the last-line normalisation for callers
   * that never passed through that DTO.
   */
  private static normaliseReasonText(
    value: string | null | undefined,
  ): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed.slice(0, 500);
  }

  // ==========================================================================
  // Availability
  // ==========================================================================

  /**
   * Availability WITHOUT the lazy-expiry pass -- for internal use by callers
   * that have already expired the variants in this transaction.
   *
   * Due-but-not-yet-swept reservations are excluded by `"expiresAt" > now`, so
   * a bounded expiry pass that did not reach every row still yields a correct
   * availability number.
   */
  private async computeAvailability(
    manager: EntityManager,
    variantIds: number[],
    now: Date,
  ): Promise<Map<number, AvailabilitySnapshot>> {
    const ids = InventoryService.uniqueAscending(variantIds);
    const out = new Map<number, AvailabilitySnapshot>();
    if (ids.length === 0) return out;

    /*
     * The SQL is shared with `availability.projection.ts` so the public
     * catalogue list cannot drift from this answer — before it was extracted
     * the list was reservation-blind and contradicted the detail page for the
     * same variant in the same second.
     */
    const rows = await this.select<{
      variantId: number;
      productId: number | string;
      isActive: boolean | null;
      physicalStock: number | string;
      basketReserved: number | string;
      orderAllocated: number | string;
    }>(manager, AVAILABILITY_FACTS_SQL, [ids, now]);

    for (const row of rows) {
      const physicalStock = InventoryService.toInt(row.physicalStock);
      const basketReserved = InventoryService.toInt(row.basketReserved);
      const orderAllocated = InventoryService.toInt(row.orderAllocated);
      out.set(Number(row.variantId), {
        variantId: Number(row.variantId),
        productId: Number(row.productId),
        isActive: row.isActive === true,
        physicalStock,
        basketReserved,
        orderAllocated,
        /*
         * RAW, UNCLAMPED, AND NOT `isActive`-AWARE — on purpose.
         *
         * These two numbers are what the reservation, sale and adjustment
         * GATES compare against under a row lock, and those gates are pinned
         * by the concurrency and displacement suites. Clamping here, or
         * zeroing them for a retired variant, would silently change what may
         * be sold. Callers that want the SELLABILITY answer (clamped, and zero
         * for a retired variant) pass this snapshot to `deriveAvailability`.
         *
         * THE `isActive` RULE IS NOT MISSING, IT IS ELSEWHERE. Every sell path
         * calls `assertSellableUnderLock` on the row-locked variant before it
         * compares these numbers, so a retired variant is refused outright
         * rather than quietly reported as having nothing available. Raw
         * physical availability remains visible for inventory management, but
         * `isActive = false` makes the variant unsellable through both
         * Storefront and POS.
         */
        availableForBasket: physicalStock - basketReserved - orderAllocated,
        availableForPos: physicalStock - orderAllocated,
      });
    }

    const missing = ids.filter((id) => !out.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `${InventoryMessages.VARIANT_NOT_FOUND}: ${missing.join(', ')}`,
      );
    }
    return out;
  }

  /** R5 then compute. Public availability always runs lazy expiry first. */
  /**
   * TILL LOOKUP: one SKU -> the sellable unit, its price, and its availability.
   *
   * WHY THIS EXISTS. `product_variants.sku` is globally unique, but nothing
   * exposed it over HTTP. `GET /products` searches `LOWER(p.title) LIKE ...`
   * only (products.service.ts), so a cashier scanning a barcode matched
   * nothing, and every endpoint that carries a stock number was
   * `super_admin` -- so a `sale` cashier could not see stock anywhere at all.
   * A POS till cannot function without both.
   *
   * It is a READ. It resolves what the accepted contracts already define: the
   * SKU, the variant price, and `AvailabilitySnapshot`. It introduces no new
   * pricing, no reservation and no policy.
   *
   * Returns null when the SKU is unknown, so the caller can answer 404 without
   * an exception round trip.
   */
  async lookupBySku(
    manager: EntityManager,
    sku: string,
    branchId: number | null,
  ): Promise<SkuLookupResult | null> {
    /*
     * MATCHES A SKU OR A «کد گونه», both exact.
     *
     * A cashier holding a box reads whichever string is printed on it and
     * should not have to know which field the store calls it. Both columns are
     * uniquely indexed, so "exact match on either" still resolves to at most
     * one row.
     *
     * THE BRANCH GATE IS IN THE WHERE CLAUSE, not applied afterwards. A
     * post-filter would still have loaded the row, and the difference between
     * "no such code" and "not carried here" is precisely what a lookup must
     * not leak: a cashier could otherwise enumerate a neighbouring shop's
     * range one code at a time.
     */
    const rows = await this.select<{
      variantId: number;
      sku: string;
      variantCode: string;
      price: number | string | null;
      isActive: boolean;
      isDefault: boolean;
      productId: number;
      productCode: string;
      title: string;
    }>(
      manager,
      `SELECT v.id AS "variantId",
              v.sku AS sku,
              v."variantCode" AS "variantCode",
              v.price AS price,
              v."isActive" AS "isActive",
              v."isDefault" AS "isDefault",
              p.id AS "productId",
              p."productCode" AS "productCode",
              p.title AS title
         FROM product_variants v
         JOIN products p ON p.id = v."productId"
        WHERE (v.sku = $1 OR v."variantCode" = $1)
          AND (
            $2::int IS NULL
            OR p."branchVisibility" = 'all'
            OR (
              p."branchVisibility" = 'selected'
              AND EXISTS (SELECT 1 FROM product_branch_visibility pbv
                           WHERE pbv."productId" = p.id
                             AND pbv."branchId" = $2)
            )
          )
        LIMIT 1`,
      [sku, branchId],
    );
    const row = rows[0];
    if (!row) return null;

    const availability = await this.getAvailability(manager, [
      Number(row.variantId),
    ]);
    const snapshot = availability.get(Number(row.variantId));
    if (!snapshot) return null;

    /*
     * SELLABILITY IS ANSWERED HERE, NOT LEFT TO THE CALLER.
     *
     * The lookup is READ-CAPABLE for a retired SKU on purpose -- a cashier
     * holding the box needs to identify it, and `availability` still reports
     * the true units on the shelf so shelf stock can be reconciled. But raw
     * `availability.availableForPos` is NOT an authorisation to sell: it is
     * deliberately unclamped and `isActive`-blind, and for a retired variant
     * with units on the shelf it is a positive number that must not be sold.
     *
     * So the lookup states the sellability answer explicitly, through the same
     * `deriveAvailability` every other surface uses, and names WHY when the
     * answer is no. A till that reads these three fields cannot reconstruct
     * the wrong rule; one that reads `availableForPos` alone would.
     */
    const projection = deriveAvailability(snapshot);

    return {
      productId: Number(row.productId),
      productTitle: row.title,
      variantId: Number(row.variantId),
      sku: row.sku,
      variantCode: row.variantCode,
      productCode: row.productCode,
      // INTEGER RIAL, straight from the variant row. Never products.basePrice:
      // the SKU is what is sold and its own price is what is charged.
      unitPrice: InventoryService.toInt(row.price),
      isActive: row.isActive === true,
      isDefault: row.isDefault === true,
      availability: snapshot,
      sellableInStore: projection.sellableInStore,
      sellableOnline: projection.sellableOnline,
      unsellableReason:
        row.isActive !== true
          ? 'variant_inactive'
          : projection.sellableInStore
            ? null
            : 'no_units_available',
    };
  }

  async getAvailability(
    manager: EntityManager,
    variantIds: number[],
  ): Promise<Map<number, AvailabilitySnapshot>> {
    const now = new Date();
    const ids = InventoryService.uniqueAscending(variantIds);
    if (ids.length === 0) return new Map();
    await this.expireDueReservations(manager, { variantIds: ids, now });
    return this.computeAvailability(manager, ids, now);
  }

  // ==========================================================================
  // Basket reservations
  // ==========================================================================

  /**
   * R4. A quantity increase inserts a NEW tranche row with its OWN TTL.
   * Existing tranches keep their original `expiresAt`; nothing this method
   * does can extend an existing hold.
   */
  async reserveForBasket(
    manager: EntityManager,
    input: {
      userId: number;
      cartItemId: number;
      variantId: number;
      quantity: number;
      ttlMs?: number;
      now?: Date;
    },
  ): Promise<ReserveForBasketResult> {
    const now = input.now ?? new Date();
    const quantity = Math.trunc(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException(
        InventoryMessages.QUANTITY_MUST_BE_POSITIVE,
      );
    }

    // Lock order: variant (R1) -> sellability -> lazy expiry (R5) ->
    // availability -> insert.
    const locked = await this.lockVariants(manager, [input.variantId]);
    /*
     * A RETIRED SKU TAKES NO NEW HOLD. Reserving is the first half of a
     * storefront sale, so the sellability rule applies here and not only at
     * checkout -- otherwise a retired variant could still be parked in a
     * basket, shown with a countdown, and hold stock away from the till.
     */
    this.assertSellableUnderLock(locked, [input.variantId]);
    await this.expireDueReservations(manager, {
      variantIds: [input.variantId],
      now,
    });
    const availability = await this.computeAvailability(
      manager,
      [input.variantId],
      now,
    );
    const snapshot = availability.get(input.variantId)!;

    if (quantity > snapshot.availableForBasket) {
      throw new InsufficientStockError(
        input.variantId,
        quantity,
        Math.max(snapshot.availableForBasket, 0),
        locked.get(input.variantId)?.sku,
      );
    }

    const ttlMs = input.ttlMs ?? this.basketTtlMs;
    const expiresAt = new Date(now.getTime() + ttlMs);

    await manager.query(
      `INSERT INTO stock_reservations
         ("variantId", kind, status, quantity, "userId", "cartItemId", "orderId",
          "expiresAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
      [
        input.variantId,
        ReservationKind.BASKET,
        ReservationStatus.ACTIVE,
        quantity,
        input.userId,
        input.cartItemId,
        expiresAt,
        now,
      ],
    );

    return this.describeBasketLine(
      manager,
      input.cartItemId,
      input.variantId,
      now,
    );
  }

  /**
   * Reads the server-authoritative reserved quantity, earliest expiry and the
   * per-tranche breakdown for a basket line. Pure read -- R4: this can never
   * touch `expiresAt`.
   */
  async describeBasketLine(
    manager: EntityManager,
    cartItemId: number,
    variantId: number,
    now: Date = new Date(),
  ): Promise<ReserveForBasketResult> {
    const tranches = await this.select<{
      quantity: number | string;
      expiresAt: Date;
    }>(
      manager,
      `SELECT quantity, "expiresAt"
         FROM stock_reservations
        WHERE "cartItemId" = $1
          AND kind = 'basket'
          AND status = 'active'
          AND "expiresAt" > $2
        ORDER BY "expiresAt" ASC, id ASC`,
      [cartItemId, now],
    );

    const mapped = tranches.map((t) => ({
      quantity: InventoryService.toInt(t.quantity),
      expiresAt: new Date(t.expiresAt),
    }));
    const reservedQuantity = mapped.reduce((sum, t) => sum + t.quantity, 0);

    return {
      cartItemId,
      variantId,
      reservedQuantity,
      // Earliest tranche expiry = the moment the line first starts losing units.
      expiresAt: mapped.length > 0 ? mapped[0].expiresAt : now,
      tranches: mapped,
    };
  }

  /**
   * Releases `quantity` units NEWEST TRANCHE FIRST (`expiresAt DESC, id DESC`),
   * so the units that survive are always the OLDEST ones.
   *
   * Releasing oldest-first would leave the later-expiring tranches behind and
   * silently extend the customer's hold, which R4 forbids.
   */
  async releaseBasketQuantity(
    manager: EntityManager,
    input: {
      cartItemId: number;
      quantity: number;
      reason: ReservationReleaseReason;
      now?: Date;
    },
  ): Promise<{ releasedQuantity: number; remainingQuantity: number }> {
    const now = input.now ?? new Date();
    const want = Math.trunc(input.quantity);
    if (!Number.isFinite(want) || want <= 0) {
      throw new BadRequestException(
        InventoryMessages.QUANTITY_MUST_BE_POSITIVE,
      );
    }

    const active = await this.select<ReservationRow>(
      manager,
      `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
         FROM stock_reservations
        WHERE "cartItemId" = $1
          AND kind = 'basket'
          AND status = 'active'
        ORDER BY "expiresAt" DESC, id DESC
          FOR UPDATE`,
      [input.cartItemId],
    );

    const { touched, released } = await this.takeFromReservations(
      manager,
      active,
      want,
      ReservationStatus.RELEASED,
      input.reason,
      now,
    );

    const lines = await this.syncAffectedCartLines(
      manager,
      touched,
      input.reason,
      now,
    );
    const remainingQuantity =
      lines.length > 0
        ? lines[0].remainingQuantity
        : await this.activeReservedQuantity(manager, input.cartItemId, now);

    return { releasedQuantity: released, remainingQuantity };
  }

  /** Releases every active basket reservation on a line (line delete). */
  async releaseBasketLine(
    manager: EntityManager,
    input: { cartItemId: number; reason: ReservationReleaseReason; now?: Date },
  ): Promise<{ releasedQuantity: number }> {
    const now = input.now ?? new Date();

    const active = await this.select<ReservationRow>(
      manager,
      `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
         FROM stock_reservations
        WHERE "cartItemId" = $1
          AND kind = 'basket'
          AND status = 'active'
        ORDER BY "expiresAt" DESC, id DESC
          FOR UPDATE`,
      [input.cartItemId],
    );
    if (active.length === 0) return { releasedQuantity: 0 };

    const total = active.reduce(
      (sum, r) => sum + InventoryService.toInt(r.quantity),
      0,
    );
    const { touched, released } = await this.takeFromReservations(
      manager,
      active,
      total,
      ReservationStatus.RELEASED,
      input.reason,
      now,
    );
    await this.syncAffectedCartLines(manager, touched, input.reason, now);
    return { releasedQuantity: released };
  }

  /**
   * Consumes up to `want` units from an already-locked, already-ordered list of
   * ACTIVE reservations. Full tranches leave ACTIVE via R3; the boundary
   * tranche is shrunk in place, keeping its original expiry.
   */
  private async takeFromReservations(
    manager: EntityManager,
    reservations: ReservationRow[],
    want: number,
    nextStatus: ReservationStatus,
    reason: ReservationReleaseReason,
    now: Date,
  ): Promise<{ touched: TouchedReservation[]; released: number }> {
    let remaining = want;
    const touched: TouchedReservation[] = [];

    for (const reservation of reservations) {
      if (remaining <= 0) break;
      const rowQuantity = InventoryService.toInt(reservation.quantity);
      if (rowQuantity <= 0) continue;

      const take = Math.min(remaining, rowQuantity);
      if (take === rowQuantity) {
        await this.leaveActive(
          manager,
          Number(reservation.id),
          nextStatus,
          reason,
          now,
        );
      } else {
        await this.shrinkActive(manager, Number(reservation.id), take);
      }

      touched.push({
        reservationId: Number(reservation.id),
        variantId: Number(reservation.variantId),
        cartItemId:
          reservation.cartItemId === null
            ? null
            : Number(reservation.cartItemId),
        userId: reservation.userId === null ? null : Number(reservation.userId),
        quantity: take,
        fullyReleased: take === rowQuantity,
      });
      remaining -= take;
    }

    return { touched, released: want - remaining };
  }

  private async activeReservedQuantity(
    manager: EntityManager,
    cartItemId: number,
    now: Date,
  ): Promise<number> {
    const rows = await this.select<{ total: number | string }>(
      manager,
      `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM stock_reservations
        WHERE "cartItemId" = $1
          AND kind = 'basket'
          AND status = 'active'
          AND "expiresAt" > $2`,
      [cartItemId, now],
    );
    return InventoryService.toInt(rows[0]?.total);
  }

  /**
   * Re-points affected `cart_items` rows at the reserved quantity that actually
   * survived, and records the customer-visible explanation.
   *
   * INVARIANT enforced here: for an ACTIVE cart line that carries a variant,
   * `cart_items.quantity === SUM(active basket reservations for that line)`.
   *
   * Partial displacement reduces the quantity; full displacement soft-removes
   * the line (`status='removed'`) so the partial unique index on active rows
   * lets the customer re-add the product.
   *
   * PRIVACY: the only thing written to the customer-visible row is the reason
   * enum. No staff id, no branch, no other customer.
   */
  private async syncAffectedCartLines(
    manager: EntityManager,
    touched: TouchedReservation[],
    reason: ReservationReleaseReason,
    now: Date,
  ): Promise<AffectedBasketLine[]> {
    const byCartItem = new Map<number, TouchedReservation[]>();
    for (const t of touched) {
      if (t.cartItemId === null) continue; // order allocations have no basket line
      const bucket = byCartItem.get(t.cartItemId);
      if (bucket) bucket.push(t);
      else byCartItem.set(t.cartItemId, [t]);
    }
    if (byCartItem.size === 0) return [];

    const cartItemIds = Array.from(byCartItem.keys()).sort((a, b) => a - b);
    const lines = await this.select<CartLineRow>(
      manager,
      `SELECT id, "userId", "variantId", quantity, status
         FROM cart_items
        WHERE id = ANY($1::int[])
        ORDER BY id ASC
          FOR UPDATE`,
      [cartItemIds],
    );
    const lineById = new Map(lines.map((l) => [Number(l.id), l]));

    const userVisible = !USER_INITIATED_REASONS.has(reason);
    const affected: AffectedBasketLine[] = [];

    for (const cartItemId of cartItemIds) {
      const bucket = byCartItem.get(cartItemId)!;
      const line = lineById.get(cartItemId);
      const revokedQuantity = bucket.reduce((sum, t) => sum + t.quantity, 0);
      const variantId = bucket[0].variantId;
      const userId = bucket[0].userId ?? Number(line?.userId ?? 0);

      const remainingQuantity = await this.activeReservedQuantity(
        manager,
        cartItemId,
        now,
      );
      const lineRemoved = remainingQuantity === 0;

      if (line && line.status === CART_STATUS_ACTIVE) {
        const { affected: rows } = await this.execWrite(
          manager,
          // `lastChangeAt` is timestamptz, so a JS Date round-trips exactly.
          // `updatedAt` is timestamp WITHOUT time zone, where a JS Date would be
          // serialised with the client's UTC offset and then have that offset
          // silently dropped -- so it takes the DATABASE clock instead, exactly
          // as TypeORM's own @UpdateDateColumn default does.
          `UPDATE cart_items
              SET quantity = $2,
                  status = $3,
                  "lastChangeReason" = $4,
                  "lastChangeAt" = $5::timestamptz,
                  "lastChangeQtyDelta" = $6,
                  "updatedAt" = now()
            WHERE id = $1
              AND status = 'active'`,
          [
            cartItemId,
            remainingQuantity,
            lineRemoved ? CART_STATUS_REMOVED : CART_STATUS_ACTIVE,
            userVisible ? reason : null,
            now,
            -revokedQuantity,
          ],
        );
        if (rows !== 1) {
          throw new ConcurrentModificationError('cart_item', cartItemId, rows);
        }
      }

      affected.push({
        cartItemId,
        userId,
        variantId,
        revokedQuantity,
        remainingQuantity,
        lineRemoved,
        reason,
      });
    }

    return affected;
  }

  // ==========================================================================
  // Checkout boundary (docs/ARCHITECTURE.md section 2)
  // ==========================================================================

  /**
   * Converts the user's ACTIVE basket reservations into ORDER allocations bound
   * to `orderId`, with a fresh allocation TTL.
   *
   * Once this transaction commits the units are `order`-allocated and POS can
   * no longer take them (`availableForPos` excludes them). Before the commit
   * they are only `basket`-reserved and POS may displace them: whoever commits
   * first wins.
   *
   * Shortfalls left behind by displacement or expiry are topped up from free
   * stock; when that is impossible the call throws so checkout fails BEFORE any
   * payment is started.
   */
  async convertBasketToOrderAllocation(
    manager: EntityManager,
    input: {
      userId: number;
      orderId: number;
      items: PosConsumeItem[];
      ttlMs?: number;
      now?: Date;
    },
  ): Promise<{ allocatedUntil: Date }> {
    const now = input.now ?? new Date();
    const items = this.normaliseItems(input.items);
    const variantIds = items.map((i) => i.variantId);

    const locked = await this.lockVariants(manager, variantIds); // R1
    /*
     * THE STOREFRONT SALE BOUNDARY. Converting a basket hold into an order
     * allocation is the moment an online sale becomes real, so a variant
     * retired while it sat in the basket is refused here.
     *
     * It is refused even though the hold already exists: the hold was
     * legitimate when it was taken, and the customer keeps it (the throw rolls
     * the checkout back, holds and all). What they cannot do is convert it.
     */
    this.assertSellableUnderLock(locked, variantIds);
    await this.expireDueReservations(manager, { variantIds, now }); // R5

    const ttlMs = input.ttlMs ?? this.orderAllocationTtlMs;
    const allocatedUntil = new Date(now.getTime() + ttlMs);

    for (const item of items) {
      // Release this user's basket holds for the variant, oldest-expiring
      // first, so what is converted is exactly what the customer was holding.
      const held = await this.select<ReservationRow>(
        manager,
        `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
           FROM stock_reservations
          WHERE status = 'active'
            AND kind = 'basket'
            AND "userId" = $1
            AND "variantId" = $2
            AND "expiresAt" > $3
          ORDER BY "expiresAt" ASC, id ASC
            FOR UPDATE`,
        [input.userId, item.variantId, now],
      );

      const { touched } = await this.takeFromReservations(
        manager,
        held,
        item.quantity,
        ReservationStatus.RELEASED,
        ReservationReleaseReason.CONVERTED_TO_ORDER,
        now,
      );
      await this.syncAffectedCartLines(
        manager,
        touched,
        ReservationReleaseReason.CONVERTED_TO_ORDER,
        now,
      );

      // After giving the basket hold back, the full line quantity must be
      // coverable from free stock -- that both re-takes what we just released
      // and tops up any shortfall.
      const availability = await this.computeAvailability(
        manager,
        [item.variantId],
        now,
      );
      const snapshot = availability.get(item.variantId)!;
      if (item.quantity > snapshot.availableForBasket) {
        throw new InsufficientStockError(
          item.variantId,
          item.quantity,
          Math.max(snapshot.availableForBasket, 0),
          locked.get(item.variantId)?.sku,
        );
      }

      await manager.query(
        `INSERT INTO stock_reservations
           ("variantId", kind, status, quantity, "userId", "cartItemId", "orderId",
            "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        [
          item.variantId,
          ReservationKind.ORDER,
          ReservationStatus.ACTIVE,
          item.quantity,
          input.userId,
          input.orderId,
          allocatedUntil,
          now,
        ],
      );
    }

    return { allocatedUntil };
  }

  // ==========================================================================
  // POS priority path
  // ==========================================================================

  /**
   * POS sale. For each variant, in ascending id order:
   *
   *   1. lazy-expire (R5)
   *   2. take from FREE stock first
   *   3. only if still short, revoke the MINIMUM NECESSARY basket reservations
   *      in (expiresAt ASC, id ASC) order
   *   4. decrement physical stock with the R2 conditional UPDATE
   *   5. write the ledger row with the RETURNING balance
   *
   * ORDER allocations are never touched. If `availableForPos` is short the
   * whole call throws InsufficientStockError and the caller's transaction --
   * displacement, basket mutations, decrements and all -- rolls back (R6).
   */
  async consumeForPosSale(
    manager: EntityManager,
    input: {
      items: PosConsumeItem[];
      orderId: number;
      actorUserId: number;
      actorDisplaySnapshot: string;
      branchId: number;
      now?: Date;
    },
  ): Promise<PosConsumeResult> {
    const now = input.now ?? new Date();
    const items = this.normaliseItems(input.items);
    const variantIds = items.map((i) => i.variantId);

    const locked = await this.lockVariants(manager, variantIds); // R1
    /*
     * THE IN-STORE SALE BOUNDARY, and the last line of defence.
     *
     * `OrdersService.recordPosSale` already refuses a retired variant before
     * it writes the order, which is what makes the HTTP failure atomic and
     * receipt-free. This second assertion is not redundant: it sits on the ONE
     * primitive that decrements physical stock and revokes other customers'
     * holds, so any future caller inherits the rule instead of having to
     * remember it. If it ever fires, the caller above it is missing its gate.
     */
    this.assertSellableUnderLock(locked, variantIds);
    await this.expireDueReservations(manager, { variantIds, now }); // R5

    const consumed: ConsumedVariantResult[] = [];
    const affectedBasketLines: AffectedBasketLine[] = [];

    for (const item of items) {
      const availability = await this.computeAvailability(
        manager,
        [item.variantId],
        now,
      );
      const snapshot = availability.get(item.variantId)!;

      // POS may take free stock + basket-reserved stock, never order-allocated.
      if (item.quantity > snapshot.availableForPos) {
        throw new InsufficientStockError(
          item.variantId,
          item.quantity,
          Math.max(snapshot.availableForPos, 0),
          locked.get(item.variantId)?.sku,
        );
      }

      const freeStock = Math.max(snapshot.availableForBasket, 0);
      const fromFreeStock = Math.min(item.quantity, freeStock);
      const needFromBaskets = item.quantity - fromFreeStock;
      let fromDisplacedBaskets = 0;

      if (needFromBaskets > 0) {
        // Displacement order: soonest-to-expire first, ties by insertion order.
        // Deterministic and reproducible -- explicitly NOT a customer tier.
        const holds = await this.select<ReservationRow>(
          manager,
          `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
             FROM stock_reservations
            WHERE status = 'active'
              AND kind = 'basket'
              AND "variantId" = $1
              AND "expiresAt" > $2
            ORDER BY "expiresAt" ASC, id ASC
              FOR UPDATE`,
          [item.variantId, now],
        );

        const { touched, released } = await this.takeFromReservations(
          manager,
          holds,
          needFromBaskets,
          ReservationStatus.REVOKED,
          ReservationReleaseReason.SOLD_IN_STORE,
          now,
        );
        if (released < needFromBaskets) {
          // Cannot happen once availableForPos passed, but never guess.
          throw new InsufficientStockError(
            item.variantId,
            item.quantity,
            fromFreeStock + released,
            locked.get(item.variantId)?.sku,
          );
        }
        fromDisplacedBaskets = released;
        affectedBasketLines.push(
          ...(await this.syncAffectedCartLines(
            manager,
            touched,
            ReservationReleaseReason.SOLD_IN_STORE,
            now,
          )),
        );
      }

      // R2c: the decrement and the COGS allocation are ONE pool write, read
      // and written under the row lock `lockVariants` took above.
      const pool = await this.readPool(manager, item.variantId);
      if (pool.stock < item.quantity) {
        throw new InsufficientStockError(
          item.variantId,
          item.quantity,
          snapshot.physicalStock,
          locked.get(item.variantId)?.sku,
        );
      }
      const after = await this.allocateOrderLineCosts(manager, {
        orderId: input.orderId,
        variantId: item.variantId,
        quantity: item.quantity,
        pool,
        now,
      });
      const { balanceAfter } = await this.writePool(
        manager,
        item.variantId,
        pool,
        after,
        {
          reason: StockMovementReason.POS_SALE,
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          actorDisplaySnapshot: input.actorDisplaySnapshot,
          branchId: input.branchId,
          now,
        },
      );

      consumed.push({
        variantId: item.variantId,
        quantityConsumed: item.quantity,
        balanceAfter,
        fromFreeStock,
        fromDisplacedBaskets,
      });
    }

    return { consumed, affectedBasketLines };
  }

  // ==========================================================================
  // Online fulfilment (payment phase 2)
  // ==========================================================================

  /**
   * Consumes this order's ORDER allocations and decrements stock.
   *
   * Idempotent per order: the order row is locked FOR UPDATE and the existence
   * of an `online_fulfillment` ledger row for the order is the completion
   * marker, so a second call after success is a no-op.
   *
   * Never displaces anyone's basket -- only POS is allowed to do that. When the
   * allocations have expired and free stock is insufficient it throws
   * InsufficientStockForFulfilmentError so the caller can record AWAITING_STOCK
   * instead of rolling back a confirmed payment.
   */
  async consumeForOnlineFulfilment(
    manager: EntityManager,
    input: { orderId: number; actorUserId?: number | null; now?: Date },
  ): Promise<{ consumed: ConsumedVariantResult[]; alreadyFulfilled: boolean }> {
    const now = input.now ?? new Date();

    // Lock order first (global lock order: order -> variant -> reservation).
    const orderRows = await this.select<{ id: number }>(
      manager,
      `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
      [input.orderId],
    );
    if (orderRows.length === 0) {
      throw new NotFoundException(InventoryMessages.ORDER_NOT_FOUND);
    }

    const done = await this.select<{ count: number | string }>(
      manager,
      `SELECT COUNT(*) AS count
         FROM stock_movements
        WHERE "orderId" = $1
          AND reason = $2`,
      [input.orderId, StockMovementReason.ONLINE_FULFILLMENT],
    );
    if (InventoryService.toInt(done[0]?.count) > 0) {
      return { consumed: [], alreadyFulfilled: true };
    }

    const lines = await this.select<{
      variantId: number | null;
      quantity: number | string;
    }>(
      manager,
      `SELECT "variantId", SUM(quantity) AS quantity
         FROM order_items
        WHERE "orderId" = $1
        GROUP BY "variantId"
        ORDER BY "variantId" ASC`,
      [input.orderId],
    );
    if (lines.some((l) => l.variantId === null)) {
      throw new InsufficientStockForFulfilmentError(
        input.orderId,
        InventoryMessages.ORDER_ITEM_WITHOUT_VARIANT,
      );
    }
    if (lines.length === 0) {
      return { consumed: [], alreadyFulfilled: false };
    }

    const items = lines.map((l) => ({
      variantId: Number(l.variantId),
      quantity: InventoryService.toInt(l.quantity),
    }));
    const variantIds = items.map((i) => i.variantId);

    await this.lockVariants(manager, variantIds); // R1
    await this.expireDueReservations(manager, { variantIds, now }); // R5

    const consumed: ConsumedVariantResult[] = [];

    for (const item of items) {
      const allocations = await this.select<ReservationRow>(
        manager,
        `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
           FROM stock_reservations
          WHERE status = 'active'
            AND kind = 'order'
            AND "orderId" = $1
            AND "variantId" = $2
            AND "expiresAt" > $3
          ORDER BY "expiresAt" ASC, id ASC
            FOR UPDATE`,
        [input.orderId, item.variantId, now],
      );

      const { released: fromAllocation } = await this.takeFromReservations(
        manager,
        allocations,
        item.quantity,
        ReservationStatus.CONSUMED,
        ReservationReleaseReason.FULFILLED,
        now,
      );

      const shortfall = item.quantity - fromAllocation;
      if (shortfall > 0) {
        // The allocation expired (or was never made). Top up from FREE stock
        // only -- online fulfilment must not displace another customer.
        const availability = await this.computeAvailability(
          manager,
          [item.variantId],
          now,
        );
        const snapshot = availability.get(item.variantId)!;
        if (shortfall > snapshot.availableForBasket) {
          throw new InsufficientStockForFulfilmentError(
            input.orderId,
            `variant ${item.variantId}: needs ${shortfall} more unit(s), ` +
              `${Math.max(snapshot.availableForBasket, 0)} free`,
          );
        }
      }

      // R2c, exactly as the POS path: same allocator, same lock, same write.
      const pool = await this.readPool(manager, item.variantId);
      if (pool.stock < item.quantity) {
        throw new InsufficientStockForFulfilmentError(
          input.orderId,
          `variant ${item.variantId}: physical stock below ${item.quantity}`,
        );
      }
      const after = await this.allocateOrderLineCosts(manager, {
        orderId: input.orderId,
        variantId: item.variantId,
        quantity: item.quantity,
        pool,
        now,
      });
      const { balanceAfter } = await this.writePool(
        manager,
        item.variantId,
        pool,
        after,
        {
          reason: StockMovementReason.ONLINE_FULFILLMENT,
          orderId: input.orderId,
          actorUserId: input.actorUserId ?? null,
          actorDisplaySnapshot: null,
          branchId: null,
          now,
        },
      );

      consumed.push({
        variantId: item.variantId,
        quantityConsumed: item.quantity,
        balanceAfter,
        fromFreeStock: Math.max(shortfall, 0),
        fromDisplacedBaskets: 0,
      });
    }

    return { consumed, alreadyFulfilled: false };
  }

  // ==========================================================================
  // Cancellation / return
  // ==========================================================================

  /**
   * Restores everything this order took out of physical stock, WITH THE EXACT
   * COST IT LEFT WITH, and records the whole-order reversal line by line in
   * `order_item_adjustments` (docs/PURCHASE-COST-ACCOUNTING.md §5.1).
   *
   * WHAT IS RESTORED PHYSICALLY is still derived from the order's own net
   * ledger balance per variant (`HAVING SUM(delta) < 0`) — stock is never
   * invented, and an order that never consumed anything restores nothing.
   * That quantity is then attributed to the order's lines of that variant,
   * ascending id, each giving back its unknown-cost units first and then its
   * known units at an exact share of the COGS it recognised (`restockSplit`)
   * — never the variant's current average. Units the ledger says left but no
   * line can account for (pre-0037 history only) come back as UNVALUED.
   *
   * WHAT IS REVERSED FINANCIALLY is decided by the caller: `reverseRevenue`
   * is true exactly when the existing order semantics book this reversal
   * against revenue (a void of a paid sale, a return, a settled refund).
   *
   * IDEMPOTENT: the ledger rows are the memory. A second call finds nothing
   * left to restock and no revenue left to reverse, writes no row, and reports
   * `alreadyRestored`.
   */
  async restoreForOrder(
    manager: EntityManager,
    input: {
      orderId: number;
      reason: StockMovementReason;
      actorUserId: number | null;
      actorDisplaySnapshot: string;
      /** Book the reversal against revenue too (see above). */
      reverseRevenue: boolean;
      /** Defaults from `reason`: cancellation → `void`, otherwise `return_refund`. */
      kind?: Extract<OrderItemAdjustmentKind, 'void' | 'return_refund'>;
      now?: Date;
    },
  ): Promise<{ restored: ConsumedVariantResult[]; alreadyRestored: boolean }> {
    const now = input.now ?? new Date();
    const kind =
      input.kind ??
      (input.reason === StockMovementReason.CANCELLATION_RESTORE
        ? 'void'
        : 'return_refund');

    const orderRows = await this.select<{ id: number }>(
      manager,
      `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
      [input.orderId],
    );
    if (orderRows.length === 0) {
      throw new NotFoundException(InventoryMessages.ORDER_NOT_FOUND);
    }

    const netRows = await this.select<{
      variantId: number;
      net: number | string;
    }>(
      manager,
      `SELECT "variantId", SUM(delta) AS net
         FROM stock_movements
        WHERE "orderId" = $1
        GROUP BY "variantId"
       HAVING SUM(delta) < 0
        ORDER BY "variantId" ASC`,
      [input.orderId],
    );

    // Whatever is still allocated but never consumed simply goes back as a hold
    // release; it never touched physical stock so it is not part of `restored`.
    await this.releaseOrderAllocation(manager, {
      orderId: input.orderId,
      reason: ReservationReleaseReason.ORDER_CANCELLED,
      now,
    });

    const lines = await this.loadLineCostStates(manager, input.orderId);

    const restoredByLine = new Map<
      number,
      { knownQuantity: number; unknownQuantity: number; cogsReversed: bigint }
    >();
    const movementByVariant = new Map<number, number | null>();
    const restored: ConsumedVariantResult[] = [];

    if (netRows.length > 0) {
      await this.lockVariants(
        manager,
        netRows.map((r) => Number(r.variantId)),
      );
    }

    for (const row of netRows) {
      const variantId = Number(row.variantId);
      let remaining = Math.abs(InventoryService.toInt(row.net));
      const quantity = remaining;
      let knownQuantity = 0;
      let unknownQuantity = 0;
      let cost = 0n;

      for (const line of lines) {
        if (remaining === 0) break;
        if (line.variantId !== variantId) continue;
        const restockable =
          line.state.costKnownQuantity +
          line.state.costUnknownQuantity -
          line.state.restockedKnownQuantity -
          line.state.restockedUnknownQuantity;
        const take = Math.min(remaining, restockable);
        if (take <= 0) continue;
        const split = InventoryService.valuationStep(variantId, () =>
          restockSplit(line.state, take),
        );
        restoredByLine.set(line.id, split);
        knownQuantity += split.knownQuantity;
        unknownQuantity += split.unknownQuantity;
        cost += split.cogsReversed;
        remaining -= take;
      }
      // Ledger units no line accounts for: their cost was never recorded, so
      // they return UNVALUED rather than at a guessed cost.
      unknownQuantity += remaining;

      const pool = await this.readPool(manager, variantId);
      const after = InventoryService.valuationStep(
        variantId,
        () =>
          restoreToPool(pool, {
            knownQuantity,
            cost,
            unknownQuantity,
          }).pool,
      );
      const { balanceAfter, movementId } = await this.writePool(
        manager,
        variantId,
        pool,
        after,
        {
          reason: input.reason,
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          actorDisplaySnapshot: input.actorDisplaySnapshot,
          branchId: null,
          now,
        },
      );
      movementByVariant.set(variantId, movementId);
      restored.push({
        variantId,
        quantityConsumed: -quantity,
        balanceAfter,
        fromFreeStock: 0,
        fromDisplacedBaskets: 0,
      });
    }

    for (const line of lines) {
      const split = restoredByLine.get(line.id) ?? {
        knownQuantity: 0,
        unknownQuantity: 0,
        cogsReversed: 0n,
      };
      const revenueQuantity = input.reverseRevenue
        ? line.state.quantity - line.state.reversedRevenueQuantity
        : 0;
      if (
        revenueQuantity === 0 &&
        split.knownQuantity + split.unknownQuantity === 0
      ) {
        continue;
      }
      const revenueReversed =
        revenueQuantity > 0
          ? InventoryService.valuationStep(line.variantId ?? 0, () =>
              reverseRevenue(line.state, revenueQuantity),
            )
          : 0n;
      await this.insertAdjustment(manager, {
        orderId: input.orderId,
        orderItemId: line.id,
        kind,
        scope: 'order',
        revenueQuantity,
        revenueReversed,
        restockedKnownQuantity: split.knownQuantity,
        restockedUnknownQuantity: split.unknownQuantity,
        cogsReversed: split.cogsReversed,
        eventAt: now,
        actorUserId: input.actorUserId,
        actorDisplaySnapshot: input.actorDisplaySnapshot,
        reason: null,
        idempotencyKey: null,
        stockMovementId:
          line.variantId !== null &&
          split.knownQuantity + split.unknownQuantity > 0
            ? (movementByVariant.get(line.variantId) ?? null)
            : null,
      });
    }

    return { restored, alreadyRestored: netRows.length === 0 };
  }

  /**
   * Every line of an order with what it recognised at consumption and what has
   * been reversed since, from `order_item_adjustments`. Read under the order
   * row lock the caller holds, so the sums cannot move before they are used.
   *
   * A legacy `unknown` line (no split recorded) is treated as `quantity`
   * unknown-cost units; a `pending` line as nothing consumed.
   */
  async loadLineCostStates(
    manager: EntityManager,
    orderId: number,
  ): Promise<
    Array<{
      id: number;
      variantId: number | null;
      costStatus: 'pending' | 'known' | 'unknown';
      state: LineCostState;
    }>
  > {
    const rows = await this.select<{
      id: number;
      variantId: number | null;
      quantity: number | string;
      totalPrice: string;
      costStatus: 'pending' | 'known' | 'unknown';
      cogsTotal: string | null;
      costKnownQuantity: number | null;
      costUnknownQuantity: number | null;
      rq: number | string;
      rv: string;
      kq: number | string;
      uq: number | string;
      cv: string;
    }>(
      manager,
      `SELECT oi.id, oi."variantId", oi.quantity,
              oi.total_price::text          AS "totalPrice",
              oi."costStatus",
              oi."cogsTotal"::text          AS "cogsTotal",
              oi."costKnownQuantity", oi."costUnknownQuantity",
              COALESCE(a.rq, 0)             AS rq,
              COALESCE(a.rv, 0)::text       AS rv,
              COALESCE(a.kq, 0)             AS kq,
              COALESCE(a.uq, 0)             AS uq,
              COALESCE(a.cv, 0)::text       AS cv
         FROM order_items oi
         LEFT JOIN (
           SELECT "orderItemId",
                  SUM("revenueQuantity")                       AS rq,
                  SUM("revenueReversed")                       AS rv,
                  SUM(COALESCE("restockedKnownQuantity", 0))   AS kq,
                  SUM(COALESCE("restockedUnknownQuantity", 0)) AS uq,
                  SUM(COALESCE("cogsReversed", 0))             AS cv
             FROM order_item_adjustments
            WHERE "orderId" = $1
            GROUP BY "orderItemId"
         ) a ON a."orderItemId" = oi.id
        WHERE oi."orderId" = $1
        ORDER BY oi.id ASC`,
      [orderId],
    );
    return rows.map((r) => {
      const quantity = InventoryService.toInt(r.quantity);
      const legacyUnknown =
        r.costStatus === 'unknown' && r.costKnownQuantity === null;
      return {
        id: Number(r.id),
        variantId: r.variantId === null ? null : Number(r.variantId),
        costStatus: r.costStatus,
        state: {
          quantity,
          totalPrice: BigInt(r.totalPrice),
          cogsTotal: r.cogsTotal === null ? null : BigInt(r.cogsTotal),
          costKnownQuantity:
            r.costStatus === 'pending' ? 0 : (r.costKnownQuantity ?? 0),
          costUnknownQuantity:
            r.costStatus === 'pending'
              ? 0
              : legacyUnknown
                ? quantity
                : (r.costUnknownQuantity ?? 0),
          reversedRevenueQuantity: InventoryService.toInt(r.rq),
          reversedRevenue: BigInt(r.rv),
          restockedKnownQuantity: InventoryService.toInt(r.kq),
          restockedUnknownQuantity: InventoryService.toInt(r.uq),
          reversedCogs: BigInt(r.cv),
        },
      };
    });
  }

  /**
   * Refuses a WHOLE-ORDER reversal of an order that already has a line
   * adjustment (docs §5.1). The existing sales summary books a whole-order
   * refund at the order's full `total_price`; allowing one after a partial
   * refund would count the partial amount twice. The remaining units are
   * reversed with the line endpoint instead. Call under the order row lock.
   */
  async assertNoLineAdjustments(
    manager: EntityManager,
    orderId: number,
  ): Promise<void> {
    const rows = await this.select<{ n: number | string }>(
      manager,
      `SELECT count(*)::int AS n FROM order_item_adjustments
        WHERE "orderId" = $1 AND scope = 'line'`,
      [orderId],
    );
    if (InventoryService.toInt(rows[0]?.n) > 0) {
      throw costingError.conflict(
        CostingErrorCodes.ORDER_HAS_LINE_ADJUSTMENTS,
        {
          orderId,
        },
      );
    }
  }

  /** One `order_item_adjustments` row. The bounds trigger re-checks it. */
  async insertAdjustment(
    manager: EntityManager,
    row: {
      orderId: number;
      orderItemId: number;
      kind: OrderItemAdjustmentKind;
      scope: 'order' | 'line';
      revenueQuantity: number;
      revenueReversed: bigint;
      restockedKnownQuantity: number;
      restockedUnknownQuantity: number;
      cogsReversed: bigint;
      eventAt: Date;
      actorUserId: number | null;
      actorDisplaySnapshot: string | null;
      reason: string | null;
      idempotencyKey: string | null;
      stockMovementId: number | null;
    },
  ): Promise<number> {
    const rows = await this.select<{ id: number }>(
      manager,
      `INSERT INTO order_item_adjustments
         ("orderId", "orderItemId", kind, scope, "revenueQuantity",
          "revenueReversed", "restockedKnownQuantity", "restockedUnknownQuantity",
          "cogsReversed", "eventAt", "actorUserId", "actorDisplaySnapshot",
          reason, "idempotencyKey", "stockMovementId")
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9::bigint, $10, $11, $12,
               $13, $14, $15)
       RETURNING id`,
      [
        row.orderId,
        row.orderItemId,
        row.kind,
        row.scope,
        row.revenueQuantity,
        row.revenueReversed.toString(),
        row.restockedKnownQuantity,
        row.restockedUnknownQuantity,
        row.cogsReversed.toString(),
        row.eventAt,
        row.actorUserId,
        row.actorDisplaySnapshot,
        InventoryService.normaliseReasonText(row.reason),
        row.idempotencyKey,
        row.stockMovementId,
      ],
    );
    return Number(rows[0].id);
  }

  /**
   * Physically returns `lines` of an order to stock with their own exact
   * COGS — the primitive the line-adjustment endpoint uses. The caller holds
   * the order row lock and has validated the quantities against
   * `loadLineCostStates`; this locks the variants (R1), writes one pool change
   * and one movement per variant, and returns, per line, the split and the
   * movement id. No ledger row is written here.
   */
  async restockOrderLines(
    manager: EntityManager,
    input: {
      orderId: number;
      reason: StockMovementReason;
      actorUserId: number;
      actorDisplaySnapshot: string;
      reasonText: string | null;
      lines: Array<{
        orderItemId: number;
        variantId: number;
        state: LineCostState;
        units: number;
      }>;
      now: Date;
    },
  ): Promise<{
    perLine: Map<
      number,
      {
        knownQuantity: number;
        unknownQuantity: number;
        cogsReversed: bigint;
        movementId: number | null;
      }
    >;
    restored: ConsumedVariantResult[];
  }> {
    const perLine = new Map<
      number,
      {
        knownQuantity: number;
        unknownQuantity: number;
        cogsReversed: bigint;
        movementId: number | null;
      }
    >();
    const restored: ConsumedVariantResult[] = [];
    const variantIds = InventoryService.uniqueAscending(
      input.lines.map((l) => l.variantId),
    );
    if (variantIds.length === 0) return { perLine, restored };
    await this.lockVariants(manager, variantIds); // R1

    for (const variantId of variantIds) {
      const mine = input.lines
        .filter((l) => l.variantId === variantId && l.units > 0)
        .sort((a, b) => a.orderItemId - b.orderItemId);
      let knownQuantity = 0;
      let unknownQuantity = 0;
      let cost = 0n;
      const splits: Array<
        [
          number,
          {
            knownQuantity: number;
            unknownQuantity: number;
            cogsReversed: bigint;
          },
        ]
      > = [];
      for (const line of mine) {
        const split = InventoryService.valuationStep(variantId, () =>
          restockSplit(line.state, line.units),
        );
        splits.push([line.orderItemId, split]);
        knownQuantity += split.knownQuantity;
        unknownQuantity += split.unknownQuantity;
        cost += split.cogsReversed;
      }
      if (knownQuantity + unknownQuantity === 0) continue;
      const pool = await this.readPool(manager, variantId);
      const after = InventoryService.valuationStep(
        variantId,
        () =>
          restoreToPool(pool, { knownQuantity, cost, unknownQuantity }).pool,
      );
      const { balanceAfter, movementId } = await this.writePool(
        manager,
        variantId,
        pool,
        after,
        {
          reason: input.reason,
          reasonText: input.reasonText,
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          actorDisplaySnapshot: input.actorDisplaySnapshot,
          branchId: null,
          now: input.now,
        },
      );
      for (const [id, split] of splits)
        perLine.set(id, { ...split, movementId });
      restored.push({
        variantId,
        quantityConsumed: -(knownQuantity + unknownQuantity),
        balanceAfter,
        fromFreeStock: 0,
        fromDisplacedBaskets: 0,
      });
    }
    return { perLine, restored };
  }

  /** Releases an order's still-active ORDER allocations (cancel / payment fail). */
  async releaseOrderAllocation(
    manager: EntityManager,
    input: { orderId: number; reason: ReservationReleaseReason; now?: Date },
  ): Promise<{ releasedQuantity: number }> {
    const now = input.now ?? new Date();

    const allocations = await this.select<ReservationRow>(
      manager,
      `SELECT id, "variantId", kind, quantity, "userId", "cartItemId", "orderId", "expiresAt"
         FROM stock_reservations
        WHERE status = 'active'
          AND kind = 'order'
          AND "orderId" = $1
        ORDER BY id ASC
          FOR UPDATE`,
      [input.orderId],
    );
    if (allocations.length === 0) return { releasedQuantity: 0 };

    let releasedQuantity = 0;
    for (const allocation of allocations) {
      await this.leaveActive(
        manager,
        Number(allocation.id),
        ReservationStatus.RELEASED,
        input.reason,
        now,
      );
      releasedQuantity += InventoryService.toInt(allocation.quantity);
    }
    return { releasedQuantity };
  }

  // ==========================================================================
  // Admin stock edit
  // ==========================================================================

  async adjustStock(
    manager: EntityManager,
    input: AdjustStockInput,
  ): Promise<AdjustStockResult> {
    const now = new Date();
    const locked = await this.lockVariants(manager, [input.variantId]); // R1
    const previousStock = locked.get(input.variantId)!.stock;

    await this.expireDueReservations(manager, {
      variantIds: [input.variantId],
      now,
    }); // R5
    const availability = await this.computeAvailability(
      manager,
      [input.variantId],
      now,
    );
    const snapshot = availability.get(input.variantId)!;

    const target =
      input.mode === 'set'
        ? Math.trunc(input.value)
        : previousStock + Math.trunc(input.value);

    if (target < 0) {
      throw new BadRequestException(InventoryMessages.NEGATIVE_STOCK_REJECTED);
    }

    /*
     * AN INCREASE IS NOT AN ADJUSTMENT ANY MORE (docs §6). Units entering the
     * shelf need a cost, and this generic endpoint has no way to say what they
     * cost — so it refuses, naming the two operations that can: a purchase
     * receipt, or a correction with an explicit cost policy. Decreases still
     * work here, as a negative correction.
     */
    if (target > previousStock) {
      throw costingError.conflict(
        CostingErrorCodes.STOCK_INCREASE_REQUIRES_RECEIPT,
        { variantId: input.variantId },
      );
    }

    const reservedTotal = snapshot.basketReserved + snapshot.orderAllocated;
    const belowReserved = target < reservedTotal;
    if (belowReserved && !input.allowBelowReserved) {
      throw new BadRequestException(
        `Cannot set stock to ${target}: ${reservedTotal} unit(s) are currently reserved ` +
          `(${snapshot.basketReserved} in baskets, ${snapshot.orderAllocated} allocated to orders). ` +
          `Pass allowBelowReserved to override.`,
      );
    }

    const delta = target - previousStock;
    if (delta === 0) {
      return {
        variantId: input.variantId,
        previousStock,
        balanceAfter: previousStock,
        basketReserved: snapshot.basketReserved,
        orderAllocated: snapshot.orderAllocated,
        belowReserved,
      };
    }

    // A decrease only (the increase was refused above): a negative correction.
    // Unknown-cost units leave first and the known remainder takes an exact
    // `allocate`d share of the value. That cost is an INVENTORY LOSS on the
    // movement — never sales COGS, which only an order line carries.
    const pool = await this.readPool(manager, input.variantId);
    if (pool.stock < -delta) {
      throw new ConcurrentModificationError('variant', input.variantId, 0);
    }
    const after = InventoryService.valuationStep(
      input.variantId,
      () => consumeFromPool(pool, -delta).pool,
    );
    const { balanceAfter } = await this.writePool(
      manager,
      input.variantId,
      pool,
      after,
      {
        reason: StockMovementReason.MANUAL_ADJUSTMENT,
        // THE ADMINISTRATOR'S SENTENCE, ON THE LEDGER ROW ITSELF (migration
        // 0024), written inside the caller's transaction.
        reasonText: input.reason,
        orderId: null,
        actorUserId: input.actorUserId,
        actorDisplaySnapshot: input.actorDisplaySnapshot,
        branchId: null,
        now,
      },
    );

    return {
      variantId: input.variantId,
      previousStock,
      balanceAfter,
      basketReserved: snapshot.basketReserved,
      orderAllocated: snapshot.orderAllocated,
      belowReserved,
    };
  }

  /**
   * Record the opening quantity of a brand-new variant, AT ITS PURCHASE COST.
   *
   * ============================================================================
   * WHY THIS EXISTS INSTEAD OF SETTING `stock` ON THE INSERT
   * ============================================================================
   * Writing `stock: 10` straight onto the variant row would produce units with
   * NO LEDGER EVIDENCE and — since 0037 — NO VALUATION: the pool guard would
   * record them as unvalued, and every sale of them would report its profit as
   * unknown. So the opening balance is a real `initial_stock` movement, valued
   * at `unitCost`, written by the same transaction that creates the variant,
   * carrying the actor who created the product and the cost evidence.
   *
   * `unitCost` IS REQUIRED. There is no "unknown" opening balance: a product
   * that enters the catalogue with units enters with their cost
   * (`INITIAL_STOCK_REQUIRES_PURCHASE_COST` is raised before this is reached).
   * An explicit 0 is a legitimate cost — free inventory — and is not the same
   * as missing.
   *
   * WHY `quantity <= 0` IS A PROGRAMMING ERROR. A product created with zero
   * stock must have NO movement at all. The caller decides; this method
   * refuses to be handed the decision.
   */
  async recordInitialStock(
    manager: EntityManager,
    input: {
      variantId: number;
      quantity: number;
      unitCost: bigint;
      actorUserId: number | null;
      actorDisplaySnapshot: string | null;
    },
  ): Promise<{ variantId: number; balanceAfter: number }> {
    const quantity = Math.trunc(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(
        `recordInitialStock requires a positive integer quantity (got ${String(input.quantity)}). ` +
          'A product created with zero stock must record no movement at all.',
      );
    }
    const { balanceAfter } = await this.receiveValued(manager, {
      variantId: input.variantId,
      quantity,
      unitCost: input.unitCost,
      reason: StockMovementReason.INITIAL_STOCK,
      // No human sentence: the act IS the explanation.
      reasonText: null,
      supplierReference: null,
      actorUserId: input.actorUserId,
      actorDisplaySnapshot: input.actorDisplaySnapshot,
      now: new Date(),
    });
    return { variantId: input.variantId, balanceAfter };
  }

  // ==========================================================================
  // Valued intake, corrections and legacy valuation (docs §6)
  // ==========================================================================

  /**
   * Units in at a known unit cost: an opening balance or a purchase receipt.
   * Locks the variant (R1), grows the pool by exactly `quantity × unitCost`,
   * remembers the unit cost for the Admin form, and writes the movement.
   */
  async receiveValued(
    manager: EntityManager,
    input: {
      variantId: number;
      quantity: number;
      unitCost: bigint;
      reason: StockMovementReason;
      reasonText: string | null;
      supplierReference: string | null;
      actorUserId: number | null;
      actorDisplaySnapshot: string | null;
      now: Date;
    },
  ): Promise<{
    before: ValuationPool;
    after: ValuationPool;
    balanceAfter: number;
    movementId: number | null;
  }> {
    await this.lockVariants(manager, [input.variantId]); // R1
    const before = await this.readPool(manager, input.variantId);
    const after = InventoryService.valuationStep(
      input.variantId,
      () => receiveIntoPool(before, input.quantity, input.unitCost).pool,
    );
    const { balanceAfter, movementId } = await this.writePool(
      manager,
      input.variantId,
      before,
      after,
      {
        reason: input.reason,
        reasonText: input.reasonText,
        unitCost: input.unitCost,
        supplierReference: input.supplierReference,
        actorUserId: input.actorUserId,
        actorDisplaySnapshot: input.actorDisplaySnapshot,
        now: input.now,
      },
    );
    await this.rememberPurchaseCost(manager, input.variantId, input.unitCost);
    return { before, after, balanceAfter, movementId };
  }

  /**
   * Sets the remembered purchase cost the Admin form pre-fills. It is NOT a
   * valuation: it changes no stock, no value and writes no movement, which is
   * why it is not guarded by the pool trigger.
   */
  async rememberPurchaseCost(
    manager: EntityManager,
    variantId: number,
    unitCost: bigint | null,
  ): Promise<void> {
    await manager.query(
      `UPDATE product_variants SET "lastPurchaseUnitCost" = $2::bigint WHERE id = $1`,
      [variantId, unitCost === null ? null : unitCost.toString()],
    );
  }

  /**
   * A stock-count correction, damage, loss or administrative fix with an
   * EXPLICIT cost policy (docs §6). Reservation-aware exactly like
   * `adjustStock`.
   *
   *  - positive + `unitCost`      → valued at that cost
   *  - positive + `costUnknown`   → recorded as unvalued (unknown, never 0)
   *  - negative                   → unknown-cost units first, then an exact
   *                                 share of the value — an inventory loss
   *
   * The caller has already validated that exactly one policy was chosen for a
   * positive delta and none for a negative one.
   */
  async correctStock(
    manager: EntityManager,
    input: {
      variantId: number;
      quantityDelta: number;
      unitCost: bigint | null;
      costUnknown: boolean;
      reasonText: string;
      allowBelowReserved: boolean;
      actorUserId: number;
      actorDisplaySnapshot: string;
      now: Date;
    },
  ): Promise<{
    before: ValuationPool;
    after: ValuationPool;
    balanceAfter: number;
    movementId: number | null;
    basketReserved: number;
    orderAllocated: number;
  }> {
    await this.lockVariants(manager, [input.variantId]); // R1
    await this.expireDueReservations(manager, {
      variantIds: [input.variantId],
      now: input.now,
    }); // R5
    const snapshot = (
      await this.computeAvailability(manager, [input.variantId], input.now)
    ).get(input.variantId)!;
    const before = await this.readPool(manager, input.variantId);
    const target = before.stock + input.quantityDelta;
    if (target < 0) {
      throw new BadRequestException(InventoryMessages.NEGATIVE_STOCK_REJECTED);
    }
    const reservedTotal = snapshot.basketReserved + snapshot.orderAllocated;
    if (
      input.quantityDelta < 0 &&
      target < reservedTotal &&
      !input.allowBelowReserved
    ) {
      throw new ConflictException({
        error: 'STOCK_BELOW_RESERVED',
        message:
          `Cannot set stock to ${target}: ${reservedTotal} unit(s) are currently reserved ` +
          `(${snapshot.basketReserved} in baskets, ${snapshot.orderAllocated} allocated to orders). ` +
          `Pass allowBelowReserved to override.`,
      });
    }

    const after = InventoryService.valuationStep(input.variantId, () => {
      if (input.quantityDelta < 0) {
        return consumeFromPool(before, -input.quantityDelta).pool;
      }
      if (input.costUnknown) {
        return receiveUnvaluedIntoPool(before, input.quantityDelta).pool;
      }
      return receiveIntoPool(before, input.quantityDelta, input.unitCost!).pool;
    });
    const { balanceAfter, movementId } = await this.writePool(
      manager,
      input.variantId,
      before,
      after,
      {
        reason: StockMovementReason.INVENTORY_CORRECTION,
        reasonText: input.reasonText,
        unitCost:
          input.quantityDelta > 0 && !input.costUnknown ? input.unitCost : null,
        actorUserId: input.actorUserId,
        actorDisplaySnapshot: input.actorDisplaySnapshot,
        now: input.now,
      },
    );
    return {
      before,
      after,
      balanceAfter,
      movementId,
      basketReserved: snapshot.basketReserved,
      orderAllocated: snapshot.orderAllocated,
    };
  }

  /**
   * Values a variant's legacy UNVALUED units for the first time (docs §6).
   *
   * `expectedUnvaluedQuantity` is what the operator saw in the preview. If a
   * sale or return moved it since, the valuation would silently apply to a
   * different number of units than the one they confirmed, so it is refused
   * as stale instead. Nothing unvalued left means it was already done.
   */
  async initialiseValuation(
    manager: EntityManager,
    input: {
      variantId: number;
      totalValue: bigint;
      expectedUnvaluedQuantity: number;
      reasonText: string | null;
      actorUserId: number;
      actorDisplaySnapshot: string;
      now: Date;
    },
  ): Promise<{
    before: ValuationPool;
    after: ValuationPool;
    movementId: number | null;
  }> {
    await this.lockVariants(manager, [input.variantId]); // R1
    const before = await this.readPool(manager, input.variantId);
    if (before.unvaluedQuantity === 0) {
      throw costingError.conflict(CostingErrorCodes.INVENTORY_ALREADY_VALUED, {
        variantId: input.variantId,
      });
    }
    if (before.unvaluedQuantity !== input.expectedUnvaluedQuantity) {
      throw costingError.conflict(CostingErrorCodes.INVENTORY_VALUATION_STALE, {
        variantId: input.variantId,
        unvaluedQuantity: before.unvaluedQuantity,
      });
    }
    const after = InventoryService.valuationStep(
      input.variantId,
      () => initialiseInPool(before, input.totalValue).pool,
    );
    const { movementId } = await this.writePool(
      manager,
      input.variantId,
      before,
      after,
      {
        reason: StockMovementReason.VALUATION_INITIALIZATION,
        reasonText: input.reasonText,
        actorUserId: input.actorUserId,
        actorDisplaySnapshot: input.actorDisplaySnapshot,
        now: input.now,
      },
    );
    return { before, after, movementId };
  }

  // ==========================================================================

  /** Validates and sorts POS/checkout items into ascending variantId order (R1). */
  private normaliseItems(items: PosConsumeItem[]): PosConsumeItem[] {
    if (!items || items.length === 0) {
      throw new BadRequestException(InventoryMessages.VARIANT_IDS_REQUIRED);
    }
    const seen = new Set<number>();
    const normalised = items.map((item) => {
      const variantId = Number(item.variantId);
      const quantity = Math.trunc(Number(item.quantity));
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException(
          InventoryMessages.QUANTITY_MUST_BE_POSITIVE,
        );
      }
      if (seen.has(variantId)) {
        throw new BadRequestException(
          `${InventoryMessages.DUPLICATE_VARIANT_IN_REQUEST}: ${variantId}`,
        );
      }
      seen.add(variantId);
      return { variantId, quantity };
    });
    return normalised.sort((a, b) => a.variantId - b.variantId);
  }
}
