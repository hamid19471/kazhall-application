import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { StockMovementReason } from './entities/stock-movement.entity';
import {
  AdminInventoryQueryDto,
  StockStateFilter,
} from './dto/admin-inventory-query.dto';
import { AdminMovementsQueryDto } from './dto/admin-movements-query.dto';
import {
  AdminMovementListPage,
  AdminStockListPage,
  AdminStockMovementRowView,
  AdminStockRowView,
  DEFAULT_LOW_STOCK_THRESHOLD,
  MAX_LOW_STOCK_THRESHOLD,
  STOCK_SCOPE,
} from './views/admin-inventory.view';

/**
 * THE RESERVATION ARITHMETIC, EXPRESSED ONCE.
 *
 * This lateral is the SET-BASED form of `InventoryService.computeAvailability`
 * and its predicate is identical, deliberately and to the character:
 *
 *     r.status = 'active' AND r."expiresAt" > $1
 *     SUM(r.quantity) FILTER (WHERE r.kind = 'basket' | 'order')
 *
 * The `expiresAt > now` half is what makes this read CORRECT WITHOUT RUNNING
 * LAZY EXPIRY (R5). A reservation that is due but not yet swept is excluded by
 * the predicate, so the number this screen shows already matches the number a
 * basket or a till would get — and an administrative read never has to take
 * write locks or mutate reservation rows just to render a list.
 *
 * A lateral rather than a GROUP BY so the computed columns are ordinary join
 * output and can be used in WHERE, which is what lets the `stockState` filter
 * and the summary aggregate share one predicate instead of two copies.
 */
const RESERVATION_LATERAL = `LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(r.quantity) FILTER (WHERE r.kind = 'basket'), 0) AS basket_reserved,
              COALESCE(SUM(r.quantity) FILTER (WHERE r.kind = 'order'), 0)  AS order_allocated
         FROM stock_reservations r
        WHERE r."variantId" = v.id
          AND r.status = 'active'
          AND r."expiresAt" > $1::timestamptz
     ) res ON TRUE`;

const STOCK_FROM = `FROM product_variants v
       JOIN products p ON p.id = v."productId"
       ${RESERVATION_LATERAL}`;

/** Storefront availability. Mirrors `AvailabilitySnapshot.availableForBasket`. */
const AVAILABLE_FOR_WEB = `(v.stock - res.basket_reserved - res.order_allocated)`;

/** Till availability: a POS sale may take basket holds, never order allocations. */
const AVAILABLE_FOR_POS = `(v.stock - res.order_allocated)`;

const MOVEMENT_FROM = `FROM stock_movements m
       JOIN product_variants v ON v.id = m."variantId"
       JOIN products p ON p.id = v."productId"
       LEFT JOIN orders o ON o.id = m."orderId"`;

const MOVEMENT_COLUMNS = `m.id                     AS id,
              m."variantId"            AS "variantId",
              v.sku                    AS sku,
              p.id                     AS "productId",
              p.title                  AS "productTitle",
              m.delta                  AS delta,
              m."balanceAfter"         AS "balanceAfter",
              m.reason                 AS reason,
              m."reasonText"           AS "reasonText",
              m."orderId"              AS "orderId",
              o."orderNumber"          AS "orderNumber",
              m."actorUserId"          AS "actorUserId",
              m."actorDisplaySnapshot" AS "actorDisplaySnapshot",
              m."branchId"             AS "branchId",
              m."createdAt"            AS "createdAt"`;

/**
 * Postgres returns `bigint` and every `SUM()` as a STRING, and `json` columns
 * as already-parsed values. These row shapes state that rather than pretending
 * the driver hands back numbers.
 */
interface StockSqlRow {
  variantId: number | string;
  sku: string;
  isActive: boolean;
  isDefault: boolean;
  productId: number | string;
  productTitle: string;
  categories: Array<{ id: number | string; title: string }>;
  price: number | string | null;
  effectivePrice: number | string | null;
  physicalStock: number | string;
  basketReserved: number | string;
  orderAllocated: number | string;
  availableForWeb: number | string;
  availableForPos: number | string;
}

interface StockSummarySqlRow {
  total: string;
  lowStockCount: string;
  outOfStockCount: string;
}

interface MovementSqlRow {
  id: number | string;
  variantId: number | string;
  sku: string;
  productId: number | string;
  productTitle: string;
  delta: number | string;
  balanceAfter: number | string;
  reason: StockMovementReason;
  reasonText: string | null;
  orderId: number | string | null;
  orderNumber: string | null;
  actorUserId: number | string | null;
  actorDisplaySnapshot: string | null;
  branchId: number | string | null;
  createdAt: Date;
}

interface StockFilter {
  where: string;
  /** `$1` is always the read clock; every other filter follows in order. */
  params: unknown[];
  threshold: number;
}

/**
 * ============================================================================
 * AdminInventoryService — the READ side of stock administration.
 * ============================================================================
 *
 * It owns no stock logic and writes nothing. Every number it reports is
 * derived from the same two facts `InventoryService` derives them from
 * (`product_variants.stock` and the active, unexpired reservations), using the
 * same predicate, so the stock screen and the till can never disagree about
 * what is sellable.
 *
 * It reads OUTSIDE a transaction on purpose: these are dashboards, the numbers
 * are indicative the moment they leave the process, and taking the variant
 * locks that a consuming path takes would let a stock report block a sale.
 */
@Injectable()
export class AdminInventoryService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * TypeORM types `query` as `Promise<any>`. Narrowing it once here keeps every
   * call site genuinely typed instead of spreading `any` through the class.
   */
  private rows<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return this.dataSource.query<T[]>(sql, parameters);
  }

  // ==========================================================================
  // 1. The stock list
  // ==========================================================================

  async listStock(query: AdminInventoryQueryDto): Promise<AdminStockListPage> {
    const filter = this.buildStockFilter(query);
    const page = query.page;
    const limit = query.limit;

    // ONE aggregate answers both the page total and the three summary counts.
    // Splitting them would run the same scan twice for the same predicate, and
    // `trackedVariantCount` IS the total by construction — see the view.
    const summaryRows = await this.rows<StockSummarySqlRow>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (
                WHERE ${AVAILABLE_FOR_WEB} > 0
                  AND ${AVAILABLE_FOR_WEB} <= ${filter.threshold}
              )::text AS "lowStockCount",
              COUNT(*) FILTER (WHERE ${AVAILABLE_FOR_WEB} <= 0)::text AS "outOfStockCount"
         ${STOCK_FROM}
        ${filter.where}`,
      filter.params,
    );

    const total = Number(summaryRows[0]?.total ?? 0);
    const summary = {
      lowStockCount: Number(summaryRows[0]?.lowStockCount ?? 0),
      outOfStockCount: Number(summaryRows[0]?.outOfStockCount ?? 0),
      trackedVariantCount: total,
    };
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    if (total === 0 || (page - 1) * limit >= total) {
      return {
        data: [],
        total,
        page,
        limit,
        totalPages,
        summary,
        scope: STOCK_SCOPE,
      };
    }

    // `v.id ASC` is the required tiebreaker: product titles are not unique, so
    // ordering by title alone lets two variants of two same-named products
    // swap places between page requests and hide a row entirely.
    const rows = await this.rows<StockSqlRow>(
      `${this.stockSelect(filter.where)}
        ORDER BY p.title ASC, v.id ASC
        LIMIT $${filter.params.length + 1} OFFSET $${filter.params.length + 2}`,
      [...filter.params, limit, (page - 1) * limit],
    );

    return {
      data: rows.map((row) => this.toStockRow(row, filter.threshold)),
      total,
      page,
      limit,
      totalPages,
      summary,
      scope: STOCK_SCOPE,
    };
  }

  // ==========================================================================
  // 3. One variant
  // ==========================================================================

  /** `null` when no variant has that id, so the caller answers 404 itself. */
  async findVariantStock(
    variantId: number,
    lowStockThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD,
  ): Promise<AdminStockRowView | null> {
    const rows = await this.rows<StockSqlRow>(
      `${this.stockSelect('WHERE v.id = $2')} LIMIT 1`,
      [new Date(), variantId],
    );
    const row = rows[0];
    return row ? this.toStockRow(row, lowStockThreshold) : null;
  }

  async recentMovementsForVariant(
    variantId: number,
    limit: number,
  ): Promise<AdminStockMovementRowView[]> {
    const rows = await this.rows<MovementSqlRow>(
      `SELECT ${MOVEMENT_COLUMNS}
         ${MOVEMENT_FROM}
        WHERE m."variantId" = $1
        ORDER BY m."createdAt" DESC, m.id DESC
        LIMIT $2`,
      [variantId, limit],
    );
    return rows.map((row) => this.toMovementRow(row));
  }

  // ==========================================================================
  // 2. The ledger
  // ==========================================================================

  async listMovements(
    query: AdminMovementsQueryDto,
  ): Promise<AdminMovementListPage> {
    const { where, params } = this.buildMovementFilter(query);
    const page = query.page;
    const limit = query.limit;

    const countRows = await this.rows<{ count: string }>(
      `SELECT COUNT(*)::text AS count ${MOVEMENT_FROM} ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    if (total === 0 || (page - 1) * limit >= total) {
      return { data: [], total, page, limit, totalPages };
    }

    // `m.id DESC` is a correctness requirement, not decoration:
    // `stock_movements.createdAt` is written from ONE `now` per operation, so a
    // multi-SKU POS sale produces several rows sharing the timestamp exactly.
    // Without the tiebreaker those rows shuffle between pages and a reader can
    // see the same movement twice, or never.
    const rows = await this.rows<MovementSqlRow>(
      `SELECT ${MOVEMENT_COLUMNS}
         ${MOVEMENT_FROM}
        ${where}
        ORDER BY m."createdAt" DESC, m.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );

    return {
      data: rows.map((row) => this.toMovementRow(row)),
      total,
      page,
      limit,
      totalPages,
    };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private stockSelect(where: string): string {
    // The categories array is a correlated aggregate in the SELECT list rather
    // than a second round trip: a per-row follow-up query is the N+1 this list
    // exists to avoid, and a join would multiply the variant rows by their
    // product's categories and then need de-duplicating in memory.
    return `SELECT v.id                             AS "variantId",
              v.sku                            AS sku,
              v."isActive"                     AS "isActive",
              v."isDefault"                    AS "isDefault",
              p.id                             AS "productId",
              p.title                          AS "productTitle",
              COALESCE((
                SELECT json_agg(json_build_object('id', c.id, 'title', c.title) ORDER BY c.id)
                  FROM product_category pc
                  JOIN categories c ON c.id = pc.category_id
                 WHERE pc.product_id = p.id
              ), '[]'::json)                   AS categories,
              v.price                          AS price,
              COALESCE(v.price, p."basePrice") AS "effectivePrice",
              v.stock                          AS "physicalStock",
              res.basket_reserved              AS "basketReserved",
              res.order_allocated              AS "orderAllocated",
              ${AVAILABLE_FOR_WEB}             AS "availableForWeb",
              ${AVAILABLE_FOR_POS}             AS "availableForPos"
         ${STOCK_FROM}
        ${where}`;
  }

  private buildStockFilter(query: AdminInventoryQueryDto): StockFilter {
    // INLINED, NOT BOUND, and the one place in this file that interpolates a
    // value into SQL. It is a `@IsInt @Min(0) @Max(1000)` integer re-truncated
    // here, so it cannot carry syntax; and it appears in fragments that some of
    // these queries do not use, where a bound-but-unreferenced `$n` is a
    // Postgres bind error rather than a harmless spare.
    const threshold = normaliseThreshold(query.lowStockThreshold);
    // `$1` is the read clock, shared by every fragment below.
    const params: unknown[] = [new Date()];
    const where: string[] = [];

    if (!query.includeInactive) {
      where.push(`v."isActive" = true`);
    }

    if (query.categoryId !== undefined) {
      params.push(query.categoryId);
      where.push(`EXISTS (SELECT 1 FROM product_category pc
                           WHERE pc.product_id = p.id
                             AND pc.category_id = $${params.length})`);
    }

    if (query.search) {
      params.push(`%${query.search.toLowerCase()}%`);
      const needle = `$${params.length}`;
      where.push(
        `(LOWER(p.title) LIKE ${needle} OR LOWER(v.sku) LIKE ${needle})`,
      );
    }

    switch (query.stockState) {
      case StockStateFilter.OUT_OF_STOCK:
        where.push(`${AVAILABLE_FOR_WEB} <= 0`);
        break;
      case StockStateFilter.LOW_STOCK:
        where.push(
          `${AVAILABLE_FOR_WEB} > 0 AND ${AVAILABLE_FOR_WEB} <= ${threshold}`,
        );
        break;
      case StockStateFilter.IN_STOCK:
        where.push(`${AVAILABLE_FOR_WEB} > ${threshold}`);
        break;
      default:
        break;
    }

    return {
      where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      params,
      threshold,
    };
  }

  private buildMovementFilter(query: AdminMovementsQueryDto): {
    where: string;
    params: unknown[];
  } {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (query.variantId !== undefined)
      add(`m."variantId" = $?`, query.variantId);
    if (query.productId !== undefined)
      add(`v."productId" = $?`, query.productId);
    if (query.reason !== undefined) add(`m.reason = $?`, query.reason);
    if (query.actorUserId !== undefined)
      add(`m."actorUserId" = $?`, query.actorUserId);
    if (query.orderId !== undefined) add(`m."orderId" = $?`, query.orderId);
    if (query.from !== undefined)
      add(`m."createdAt" >= $?::timestamptz`, query.from);
    if (query.to !== undefined)
      add(`m."createdAt" <= $?::timestamptz`, query.to);

    return {
      where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      params,
    };
  }

  private toStockRow(row: StockSqlRow, threshold: number): AdminStockRowView {
    const availableForWeb = Number(row.availableForWeb);
    const availableForPos = Number(row.availableForPos);

    return {
      variantId: Number(row.variantId),
      sku: row.sku,
      isActive: row.isActive === true,
      isDefault: row.isDefault === true,
      productId: Number(row.productId),
      productTitle: row.productTitle,
      categories: (row.categories ?? []).map((c) => ({
        id: Number(c.id),
        title: c.title,
      })),
      price: toMoney(row.price),
      effectivePrice: toMoney(row.effectivePrice),
      physicalStock: Number(row.physicalStock),
      basketReserved: Number(row.basketReserved),
      orderAllocated: Number(row.orderAllocated),
      // Clamped exactly where the rest of the codebase clamps -- at the point
      // of DISPLAY (`PosCatalogService` does `Math.max(availableForPos, 0)`).
      // A negative availability means over-selling, which is a data problem to
      // investigate, never a quantity to offer a customer.
      availableForWeb: Math.max(availableForWeb, 0),
      availableForPos: Math.max(availableForPos, 0),
      // The flags are derived from the UNCLAMPED value so they agree with the
      // SQL predicate the summary counts with, row for row.
      lowStock: availableForWeb > 0 && availableForWeb <= threshold,
      outOfStock: availableForWeb <= 0,
    };
  }

  private toMovementRow(row: MovementSqlRow): AdminStockMovementRowView {
    return {
      id: Number(row.id),
      variantId: Number(row.variantId),
      sku: row.sku,
      productId: Number(row.productId),
      productTitle: row.productTitle,
      delta: Number(row.delta),
      balanceAfter: Number(row.balanceAfter),
      reason: row.reason,
      reasonText: row.reasonText,
      orderId: row.orderId === null ? null : Number(row.orderId),
      orderNumber: row.orderNumber,
      actorUserId: row.actorUserId === null ? null : Number(row.actorUserId),
      actorDisplaySnapshot: row.actorDisplaySnapshot,
      branchId: row.branchId === null ? null : Number(row.branchId),
      createdAt: row.createdAt,
    };
  }
}

/**
 * Integer Rial out of a `bigint` column.
 *
 * NULL is the inheritance signal for `product_variants.price` and is preserved
 * as `null`; `'0'` is a real, free-of-charge price and must survive as `0`,
 * which is why this cannot be written as `Number(value) || null`.
 */
/**
 * Guarantees the threshold is a plain non-negative integer BEFORE it is
 * interpolated into SQL.
 *
 * The DTO already rejects anything else, so this is belt and braces — but it is
 * the one value in this file that is not a bound parameter, and "the validator
 * upstream would have caught it" is not a property the next caller of this
 * class inherits.
 */
function normaliseThreshold(value: number | undefined): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0)
    return DEFAULT_LOW_STOCK_THRESHOLD;
  return Math.min(parsed, MAX_LOW_STOCK_THRESHOLD);
}

function toMoney(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
