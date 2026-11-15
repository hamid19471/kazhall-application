import { RialString } from 'src/common/money/rial';
import {
  ValuationPool,
  averageUnitCost,
  valuedQuantity,
} from 'src/modules/inventory/valuation/valuation';

/**
 * ============================================================================
 * THE COSTING VIEWS — explicit allow-lists, never spread entities.
 * ============================================================================
 *
 * Contract: docs/PURCHASE-COST-ACCOUNTING.md §13. Every field below is named
 * on purpose. Nothing is built by spreading a `ProductVariant` or a
 * `StockMovement`, because the next column added to either (and there will be
 * one) would then appear on this wire unreviewed — and a cost screen is
 * exactly where an accidental field matters.
 *
 * MONEY IS A BASE-10 STRING. Every Rial field is read as `::text` in SQL and
 * travels as a string (`"125000"`); it is never a JavaScript `number` at any
 * point. Counts (`stock`, `unvaluedQuantity`, `delta`) stay numbers: they are
 * bounded by MAX_STOCK_UNITS.
 */

/** How many ledger rows the variant view carries. Contract §13. */
export const COSTING_RECENT_MOVEMENT_LIMIT = 20;

export type CostStatus = 'valued' | 'unvalued';

export interface PoolView {
  stock: number;
  unvaluedQuantity: number;
  valuedQuantity: number;
  inventoryCostValue: RialString;
  /** Display-only moving average, floor(value / valued units). */
  averageUnitCost: RialString | null;
  costStatus: CostStatus;
}

/**
 * The pool as the contract shows it. `averageUnitCost` comes from
 * `valuation.ts` — the only place cost arithmetic happens — and is never
 * stored or used to cost anything.
 */
export function poolView(pool: ValuationPool): PoolView {
  const average = averageUnitCost(pool);
  return {
    stock: pool.stock,
    unvaluedQuantity: pool.unvaluedQuantity,
    valuedQuantity: valuedQuantity(pool),
    inventoryCostValue: pool.value.toString(),
    averageUnitCost: average === null ? null : average.toString(),
    costStatus: pool.unvaluedQuantity === 0 ? 'valued' : 'unvalued',
  };
}

export interface CostingMovementView {
  id: number;
  reason: string;
  delta: number;
  balanceAfter: number;
  unitCost: RialString | null;
  costDelta: RialString | null;
  inventoryValueAfter: RialString | null;
  unvaluedQuantityAfter: number | null;
  supplierReference: string | null;
  reasonText: string | null;
  orderId: number | null;
  actorDisplaySnapshot: string | null;
  createdAt: Date;
}

export interface CostingVariantView extends PoolView {
  variantId: number;
  productId: number;
  productTitle: string;
  productCode: string;
  variantCode: string;
  sku: string;
  isDefault: boolean;
  isActive: boolean;
  /** The effective selling price: the variant's own, else the product's base price. */
  sellingPrice: RialString | null;
  lastPurchaseUnitCost: RialString | null;
}

export interface CostingVariantDetailView extends CostingVariantView {
  recentMovements: CostingMovementView[];
}

export interface CostingProductView {
  productId: number;
  productTitle: string;
  productCode: string;
  variants: CostingVariantView[];
  totals: {
    stock: number;
    unvaluedQuantity: number;
    inventoryCostValue: RialString;
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * The variant row, with every money column cast to text in the query itself.
 * `sellingPrice` is `COALESCE(variant.price, product.basePrice)`: a NULL
 * variant price INHERITS the base price, zero is a real price.
 */
export const VARIANT_VIEW_SELECT = `
  SELECT v.id                               AS "variantId",
         p.id                               AS "productId",
         p.title                            AS "productTitle",
         p."productCode"                    AS "productCode",
         v."variantCode"                    AS "variantCode",
         v.sku                              AS "sku",
         v."isDefault"                      AS "isDefault",
         v."isActive"                       AS "isActive",
         COALESCE(v.price, p."basePrice")::text AS "sellingPrice",
         v."lastPurchaseUnitCost"::text     AS "lastPurchaseUnitCost",
         v.stock                            AS "stock",
         v."unvaluedQuantity"               AS "unvaluedQuantity",
         v."inventoryCostValue"::text       AS "inventoryCostValue"
    FROM product_variants v
    JOIN products p ON p.id = v."productId"`;

export interface VariantViewRow {
  variantId: number | string;
  productId: number | string;
  productTitle: string;
  productCode: string;
  variantCode: string;
  sku: string;
  isDefault: boolean;
  isActive: boolean;
  sellingPrice: string | null;
  lastPurchaseUnitCost: string | null;
  stock: number | string;
  unvaluedQuantity: number | string;
  inventoryCostValue: string;
}

export function variantViewOf(row: VariantViewRow): CostingVariantView {
  const pool: ValuationPool = {
    stock: Number(row.stock),
    unvaluedQuantity: Number(row.unvaluedQuantity),
    value: BigInt(row.inventoryCostValue),
  };
  return {
    variantId: Number(row.variantId),
    productId: Number(row.productId),
    productTitle: row.productTitle,
    productCode: row.productCode,
    variantCode: row.variantCode,
    sku: row.sku,
    isDefault: row.isDefault === true,
    isActive: row.isActive === true,
    sellingPrice: row.sellingPrice ?? null,
    lastPurchaseUnitCost: row.lastPurchaseUnitCost ?? null,
    ...poolView(pool),
  };
}

export const MOVEMENT_VIEW_SELECT = `
  SELECT m.id                            AS "id",
         m.reason::text                  AS "reason",
         m.delta                         AS "delta",
         m."balanceAfter"                AS "balanceAfter",
         m."unitCost"::text              AS "unitCost",
         m."costDelta"::text             AS "costDelta",
         m."inventoryValueAfter"::text   AS "inventoryValueAfter",
         m."unvaluedQuantityAfter"       AS "unvaluedQuantityAfter",
         m."supplierReference"           AS "supplierReference",
         m."reasonText"                  AS "reasonText",
         m."orderId"                     AS "orderId",
         m."actorDisplaySnapshot"        AS "actorDisplaySnapshot",
         m."createdAt"                   AS "createdAt"
    FROM stock_movements m`;

export interface MovementViewRow {
  id: number | string;
  reason: string;
  delta: number | string;
  balanceAfter: number | string;
  unitCost: string | null;
  costDelta: string | null;
  inventoryValueAfter: string | null;
  unvaluedQuantityAfter: number | string | null;
  supplierReference: string | null;
  reasonText: string | null;
  orderId: number | string | null;
  actorDisplaySnapshot: string | null;
  createdAt: Date;
}

export function movementViewOf(row: MovementViewRow): CostingMovementView {
  return {
    id: Number(row.id),
    reason: row.reason,
    delta: Number(row.delta),
    balanceAfter: Number(row.balanceAfter),
    unitCost: row.unitCost ?? null,
    costDelta: row.costDelta ?? null,
    inventoryValueAfter: row.inventoryValueAfter ?? null,
    unvaluedQuantityAfter:
      row.unvaluedQuantityAfter === null ||
      row.unvaluedQuantityAfter === undefined
        ? null
        : Number(row.unvaluedQuantityAfter),
    supplierReference: row.supplierReference ?? null,
    reasonText: row.reasonText ?? null,
    orderId:
      row.orderId === null || row.orderId === undefined
        ? null
        : Number(row.orderId),
    actorDisplaySnapshot: row.actorDisplaySnapshot ?? null,
    createdAt: row.createdAt,
  };
}
