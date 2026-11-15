import { EntityManager } from 'typeorm';
import { ReservationReleaseReason } from './entities/stock-reservation.entity';
import { StockMovementReason } from './entities/stock-movement.entity';

/**
 * ============================================================================
 * SHARED INVENTORY CONTRACT  --  owned by the lead agent, implemented by
 * InventoryService (workstream D), consumed by orders/POS (C), cart (D),
 * payment (D) and products/stock-adjust (B).
 *
 * DO NOT change a signature in this file without the lead agent. Every
 * workstream compiles against it.
 * ============================================================================
 *
 * FOUR DISTINCT QUANTITIES (never conflate them):
 *
 *   physicalStock   product_variants.stock. What is on the shelf. The only
 *                   number a stock movement ever changes. NEVER negative.
 *   basketReserved  SUM(active reservations WHERE kind='basket'). Soft; a POS
 *                   sale may displace these.
 *   orderAllocated  SUM(active reservations WHERE kind='order'). Held by a
 *                   created order awaiting payment. POS MUST NOT displace these.
 *
 * TWO DISTINCT AVAILABILITIES (they legitimately differ):
 *
 *   availableForBasket = physicalStock - basketReserved - orderAllocated
 *   availableForPos    = physicalStock - orderAllocated
 *
 * The gap between them is exactly the quantity a POS sale is allowed to take
 * away from ecommerce baskets.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY RULES (mandatory for every implementer and caller)
 *
 * R1  LOCK ORDER. Any operation touching more than one variant MUST acquire
 *     row locks in ascending variantId order via lockVariants(). This is the
 *     only thing preventing deadlock between a multi-SKU POS sale and a
 *     multi-SKU checkout.
 *
 * R2  PHYSICAL STOCK is only ever changed by a conditional UPDATE, with
 *     affected-rows asserted === 1. Read-modify-write without a guard is
 *     banned. The RETURNING value is the committed balance and is what must be
 *     published in realtime events and written to StockMovement.balanceAfter.
 *
 * R2c SINCE 0037 THAT UPDATE ALSO CARRIES THE COST. `InventoryService.writePool`
 *     is the single writer of stock + unvaluedQuantity + inventoryCostValue:
 *     it compare-and-sets the pool it read under the row lock (R1) to the pool
 *     `valuation.ts` computed, and a database trigger refuses any other UPDATE
 *     of those columns. COGS is allocated to order lines by the same call, in
 *     the same transaction, for POS and Web alike
 *     (docs/PURCHASE-COST-ACCOUNTING.md §4.1, §7).
 *
 * R3  RESERVATION STATE only ever leaves ACTIVE via
 *         UPDATE stock_reservations SET status = :next ...
 *          WHERE id = :id AND status = 'active'
 *     with affected-rows asserted === 1. This is what makes double-release
 *     structurally impossible rather than merely unlikely.
 *
 * R4  expiresAt IS IMMUTABLE after insert. Reads, retries and idempotent
 *     replays never touch it. A quantity increase creates a NEW row with its
 *     own TTL; it never extends an existing row.
 *
 * R5  LAZY EXPIRY. Every availability computation and every consuming
 *     operation first calls expireDueReservations() for the variants it cares
 *     about, inside the same transaction. Correctness therefore never depends
 *     on the background sweeper having run.
 *
 * R6  Everything a POS sale does -- displacement, basket mutation, stock
 *     decrement, order + line snapshots, payment-method record, seller
 *     attribution, stock movements, idempotency row -- commits in ONE
 *     transaction, or none of it does.
 *
 * R7  Notifications are emitted AFTER commit and are advisory only. The next
 *     authenticated basket read must reproduce the same corrected state from
 *     the database. A dropped websocket frame is never a correctness problem.
 *
 * ---------------------------------------------------------------------------
 * DISPLACEMENT ORDERING (deterministic, documented, no customer tiers)
 *
 * When a POS sale needs more than the free-unreserved quantity, basket
 * reservations are revoked ordered by  (expiresAt ASC, id ASC)  -- i.e. the
 * reservations closest to expiring anyway are taken first, ties broken by
 * insertion order. This is deterministic and reproducible in tests, and it is
 * deliberately NOT a customer-priority scheme.
 */

export const BASKET_RESERVATION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (owner-confirmed)

/**
 * TTL for stock allocated to a created-but-unpaid order.
 * PROVISIONAL DEFAULT -- pending owner decision (see docs/ARCHITECTURE.md D-2).
 * Overridable via ORDER_ALLOCATION_TTL_MS.
 */
export const DEFAULT_ORDER_ALLOCATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface AvailabilitySnapshot {
  variantId: number;
  /**
   * The variant's product. Carried so a caller that has a variant id can name
   * the product without a second query — the realtime invalidation frame needs
   * it so a listing page can reconcile exactly one product instead of its whole
   * current page.
   */
  productId: number;
  /**
   * `product_variants.isActive`. Present so sellability can be derived from a
   * snapshot alone, via `deriveAvailability` in `availability.projection.ts`.
   *
   * It deliberately does NOT gate the two quantities below: those are the raw
   * arithmetic the inventory GATES depend on, and a retired variant must still
   * report its true reserved and allocated numbers to an administrator editing
   * its stock.
   */
  isActive: boolean;
  physicalStock: number;
  basketReserved: number;
  orderAllocated: number;
  /** physicalStock - basketReserved - orderAllocated. May be negative only if data is corrupt. */
  availableForBasket: number;
  /** physicalStock - orderAllocated. */
  availableForPos: number;
}

/**
 * What a till gets back for one scanned SKU.
 *
 * Composed entirely of facts the accepted contracts already define -- the SKU,
 * the variant's own price, and AvailabilitySnapshot. Nothing here is a new
 * business rule.
 */
export interface SkuLookupResult {
  /** «کد محصول» of the family this variant belongs to. */
  productCode: string;
  /** «کد گونه» — this exact variant. Searchable at the till alongside `sku`. */
  variantCode: string;
  productId: number;
  productTitle: string;
  variantId: number;
  sku: string;
  /** INTEGER RIAL, from `product_variants.price`. */
  unitPrice: number;
  /** A deactivated variant is returned but must not be sold; see isActive. */
  isActive: boolean;
  isDefault: boolean;
  /**
   * The RAW snapshot: unclamped and `isActive`-blind, so a cashier can
   * reconcile what is physically on the shelf even for a retired SKU.
   *
   * NOT AN AUTHORISATION TO SELL. Read `sellableInStore` for that.
   */
  availability: AvailabilitySnapshot;
  /**
   * THE AUTHORITATIVE ANSWER for a till: may this SKU be rung up right now?
   *
   * `isActive && clamped availableForPos > 0`, from `deriveAvailability` --
   * the same function every other surface derives sellability with. The
   * backend gate (`InventoryService.assertSellableUnderLock`) enforces the
   * same rule under a row lock, so a UI that honours this field agrees with
   * the server and a UI that ignores it is merely refused a little later.
   */
  sellableInStore: boolean;
  /** The same answer for the storefront: `isActive && availableForBasket > 0`. */
  sellableOnline: boolean;
  /**
   * Why the SKU cannot be sold in store, so the till can say which it is.
   * `null` when it can.
   *
   * `variant_inactive` outranks `no_units_available`: a retired SKU is refused
   * regardless of how many units are on the shelf, and telling a cashier
   * "out of stock" while they are holding the box would be a lie.
   */
  unsellableReason: 'variant_inactive' | 'no_units_available' | null;
}

/** One basket line affected by a POS displacement or by expiry. */
export interface AffectedBasketLine {
  cartItemId: number;
  userId: number;
  variantId: number;
  revokedQuantity: number;
  /** Quantity still active on the line after the change. 0 => line removed. */
  remainingQuantity: number;
  lineRemoved: boolean;
  reason: ReservationReleaseReason;
}

export interface PosConsumeItem {
  variantId: number;
  /** Already aggregated by the caller; MUST be > 0. */
  quantity: number;
}

export interface ConsumedVariantResult {
  variantId: number;
  quantityConsumed: number;
  /** COMMITTED physical stock after the decrement (from UPDATE ... RETURNING). */
  balanceAfter: number;
  /** How much came from never-reserved stock. */
  fromFreeStock: number;
  /** How much had to be taken from basket reservations. */
  fromDisplacedBaskets: number;
}

export interface PosConsumeResult {
  consumed: ConsumedVariantResult[];
  /** Empty when free stock was sufficient everywhere (baseline rule 2). */
  affectedBasketLines: AffectedBasketLine[];
}

export interface ReserveForBasketResult {
  cartItemId: number;
  variantId: number;
  /** Total active reserved quantity on this line after the call. */
  reservedQuantity: number;
  /**
   * Earliest expiry among the line's active reservations -- the moment the
   * line first starts losing units. Server-authoritative; exposed to clients.
   */
  expiresAt: Date;
  /** Per-tranche detail so a client can show a staged countdown if it wants. */
  tranches: Array<{ quantity: number; expiresAt: Date }>;
}

export type StockAdjustMode = 'set' | 'delta';

export interface AdjustStockInput {
  variantId: number;
  mode: StockAdjustMode;
  value: number;
  actorUserId: number;
  actorDisplaySnapshot: string;
  /**
   * The operator's free-text explanation. SINCE MIGRATION 0024 IT IS
   * PERSISTED, on `stock_movements.reasonText`, beside the machine
   * `reason` enum (`manual_adjustment`) rather than instead of it.
   *
   * Trimmed by the implementation; whitespace-only collapses to NULL. It is
   * mandatory on `POST /admin/inventory/variants/:id/adjust` and optional on
   * the older `POST /products/variants/:id/stock/adjust`, which is why it is
   * optional here.
   */
  reason?: string;
  /**
   * When true, allow the resulting physical stock to fall below the currently
   * reserved quantity. Default false => the call is rejected and the caller is
   * told how much is reserved.
   */
  allowBelowReserved?: boolean;
}

export interface AdjustStockResult {
  variantId: number;
  previousStock: number;
  balanceAfter: number;
  basketReserved: number;
  orderAllocated: number;
  belowReserved: boolean;
}

/**
 * Every method takes the caller's EntityManager so it composes into the
 * caller's transaction. NONE of these methods opens its own transaction.
 */
export interface IInventoryService {
  /**
   * Record a brand-new variant's opening quantity as a real ledger movement
   * (`initial_stock`), inside the caller's transaction.
   *
   * Exists so creating a simple product with stock cannot take the shortcut of
   * writing `stock` directly onto the variant row, which would produce units
   * with no ledger evidence and leave every later reconciliation off by the
   * opening balance. Throws if handed a non-positive quantity: a product
   * created with zero stock must record NO movement.
   */
  recordInitialStock(
    manager: EntityManager,
    input: {
      variantId: number;
      quantity: number;
      /** Integer Rial per unit. Required: units never enter unvalued here. */
      unitCost: bigint;
      actorUserId: number | null;
      actorDisplaySnapshot: string | null;
    },
  ): Promise<{ variantId: number; balanceAfter: number }>;

  /**
   * Sets `lastPurchaseUnitCost`, the default the Admin form pre-fills for the
   * next receipt. NOT a valuation: no stock, no value, no movement.
   */
  rememberPurchaseCost(
    manager: EntityManager,
    variantId: number,
    unitCost: bigint | null,
  ): Promise<void>;

  /**
   * R1. Locks FOR UPDATE in ascending id order. Throws if any id is unknown.
   *
   * The locked row carries `isActive` so a sell path can decide sellability
   * against the same row version it decides stock against; enforcement lives
   * in `assertSellableUnderLock`, never here (restore paths legitimately lock
   * retired variants).
   */
  lockVariants(
    manager: EntityManager,
    variantIds: number[],
  ): Promise<
    Map<
      number,
      {
        id: number;
        stock: number;
        price: number;
        sku: string;
        isActive: boolean;
      }
    >
  >;

  /**
   * THE SELLABILITY GATE. Throws `VariantInactiveError` for the lowest-numbered
   * variant in `variantIds` whose locked row has `isActive = false`.
   *
   * Takes the MAP `lockVariants` returned, not ids, so it cannot be called
   * without the row lock whose value it tests.
   */
  assertSellableUnderLock(
    locked: ReadonlyMap<number, { sku: string; isActive: boolean }>,
    variantIds: readonly number[],
  ): void;

  /**
   * R5. Marks ACTIVE reservations whose expiresAt <= now as RELEASED
   * (reason=RESERVATION_EXPIRED) and soft-removes/reduces their basket lines.
   * Bounded by `limit`. Safe to run concurrently on many instances: each row
   * transition is a guarded conditional UPDATE (R3).
   */
  expireDueReservations(
    manager: EntityManager,
    opts?: { variantIds?: number[]; limit?: number; now?: Date },
  ): Promise<AffectedBasketLine[]>;

  getAvailability(
    manager: EntityManager,
    variantIds: number[],
  ): Promise<Map<number, AvailabilitySnapshot>>;

  /**
   * Adds `quantity` newly reserved units to a basket line as a NEW tranche
   * with its own TTL (R4). Existing tranches keep their original expiry.
   * Rejects when quantity exceeds availableForBasket.
   */
  reserveForBasket(
    manager: EntityManager,
    input: {
      userId: number;
      cartItemId: number;
      variantId: number;
      quantity: number;
      ttlMs?: number;
      now?: Date;
    },
  ): Promise<ReserveForBasketResult>;

  /**
   * Releases `quantity` units from a basket line, NEWEST TRANCHE FIRST so the
   * surviving units are always the oldest ones. Releasing oldest-first would
   * leave later-expiring units behind and effectively extend the customer's
   * hold, which R4 forbids.
   */
  releaseBasketQuantity(
    manager: EntityManager,
    input: {
      cartItemId: number;
      quantity: number;
      reason: ReservationReleaseReason;
      now?: Date;
    },
  ): Promise<{ releasedQuantity: number; remainingQuantity: number }>;

  /** Releases every active basket reservation on a line (line delete). */
  releaseBasketLine(
    manager: EntityManager,
    input: { cartItemId: number; reason: ReservationReleaseReason; now?: Date },
  ): Promise<{ releasedQuantity: number }>;

  /**
   * Checkout boundary. Converts the user's active BASKET reservations for the
   * given variants into ORDER allocations bound to `orderId`, with a fresh
   * allocation TTL. Tops up from free stock when the basket hold has shrunk
   * (displacement/expiry); throws when it cannot be satisfied.
   */
  convertBasketToOrderAllocation(
    manager: EntityManager,
    input: {
      userId: number;
      orderId: number;
      items: PosConsumeItem[];
      ttlMs?: number;
      now?: Date;
    },
  ): Promise<{ allocatedUntil: Date }>;

  /**
   * POS priority path. For each item: expire due reservations, take from free
   * stock first, and only then revoke the minimum necessary BASKET
   * reservations in (expiresAt ASC, id ASC) order. NEVER touches ORDER
   * allocations -- if availableForPos is insufficient the whole call throws.
   */
  consumeForPosSale(
    manager: EntityManager,
    input: {
      items: PosConsumeItem[];
      orderId: number;
      actorUserId: number;
      actorDisplaySnapshot: string;
      branchId: number;
      now?: Date;
    },
  ): Promise<PosConsumeResult>;

  /**
   * Online fulfilment. Consumes this order's ORDER allocations and decrements
   * stock. Idempotent per order: a second call after success is a no-op.
   * When allocations have expired and free stock is insufficient it throws
   * InsufficientStockForFulfilmentError so the caller can record
   * AWAITING_STOCK rather than rolling back a confirmed payment.
   */
  consumeForOnlineFulfilment(
    manager: EntityManager,
    input: { orderId: number; actorUserId?: number | null; now?: Date },
  ): Promise<{ consumed: ConsumedVariantResult[]; alreadyFulfilled: boolean }>;

  /**
   * Cancellation/return. Restores stock WITH ITS ORIGINAL COST, writes positive
   * movements, and records the reversal per line in `order_item_adjustments`.
   * `reverseRevenue` states whether the existing order semantics book this
   * reversal against revenue (docs/PURCHASE-COST-ACCOUNTING.md §5.1).
   */
  restoreForOrder(
    manager: EntityManager,
    input: {
      orderId: number;
      reason: StockMovementReason;
      actorUserId: number | null;
      actorDisplaySnapshot: string;
      reverseRevenue: boolean;
      kind?: 'void' | 'return_refund';
      now?: Date;
    },
  ): Promise<{ restored: ConsumedVariantResult[]; alreadyRestored: boolean }>;

  /** Releases an order's still-active ORDER allocations (cancel / payment fail). */
  releaseOrderAllocation(
    manager: EntityManager,
    input: {
      orderId: number;
      reason: ReservationReleaseReason;
      now?: Date;
    },
  ): Promise<{ releasedQuantity: number }>;

  /** Admin stock edit. Reservation-aware (see AdjustStockInput.allowBelowReserved). */
  adjustStock(
    manager: EntityManager,
    input: AdjustStockInput,
  ): Promise<AdjustStockResult>;
}

/** Thrown when availableForPos / availableForBasket is insufficient. */
export class InsufficientStockError extends Error {
  constructor(
    readonly variantId: number,
    readonly requested: number,
    readonly available: number,
    readonly sku?: string,
  ) {
    super(
      `Insufficient stock for variant ${variantId}${sku ? ` (${sku})` : ''}: requested ${requested}, available ${available}`,
    );
    this.name = 'InsufficientStockError';
  }
}

/** Payment already confirmed but stock cannot be allocated -- recoverable. */
export class InsufficientStockForFulfilmentError extends Error {
  constructor(
    readonly orderId: number,
    readonly detail: string,
  ) {
    super(`Order ${orderId} cannot be fulfilled from stock: ${detail}`);
    this.name = 'InsufficientStockForFulfilmentError';
  }
}
