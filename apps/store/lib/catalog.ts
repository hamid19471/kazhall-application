/**
 * Typed reads for the till's catalogue and for a cashier's own completed sale.
 *
 * Both go through `api.client` rather than a shared resource helper, for the
 * same reason the receipt reader does: these routes' envelopes carry fields the
 * generic page-normaliser would throw away, and a till must see the server's
 * shape exactly as the server wrote it.
 */

import type { CallOptions, KazhalApi, QueryParams } from "@kazhal/api-client";

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogAttributeValue {
  id: number;
  value: string;
  attribute?: { id: number; name: string };
}

export interface CatalogVariant {
  id: number;
  sku: string;
  /**
   * «کد گونه» — the shop's own id for this exact variant, distinct from the
   * warehouse `sku` and searchable at the till.
   *
   * OPTIONAL because it is optional on the wire: the POS catalogue projection
   * is adding it, and a till reading an older build must render the row
   * without it rather than print `undefined`. Never synthesized from anything.
   */
  variantCode?: string;
  /** EFFECTIVE price: the variant's own, else the product's base price. */
  price: number | null;
  attributeValues: CatalogAttributeValue[];
  /** `physicalStock − orderAllocated`. INDICATIVE — the sale route decides. */
  availableForPos: number;
  inStock: boolean;
}

export interface CatalogProduct {
  id: number;
  title: string;
  /** «کد محصول». Optional for the same reason as `variantCode`. */
  productCode?: string;
  primaryImage: { id: number; url: string } | null;
  categories: Array<{ id: number; title: string }>;
  effectivePrice: number | null;
  maxEffectivePrice: number | null;
  variants: CatalogVariant[];
  inStock: boolean;
}

export interface CatalogPage {
  data: CatalogProduct[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CatalogQuery {
  search?: string;
  categoryId?: number;
  page?: number;
  limit?: number;
}

function toQuery(query: CatalogQuery): QueryParams {
  const out: QueryParams = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value as string | number;
  }
  return out;
}

/** `GET /inventory/catalog` — `sale` and `super_admin` only. */
export function browseCatalog(
  api: KazhalApi,
  query: CatalogQuery,
  options: CallOptions = {},
): Promise<CatalogPage> {
  return api.client.get<CatalogPage>("/inventory/catalog", {
    ...options,
    envelope: "spread",
    query: toQuery(query),
  });
}

export interface PosCategory {
  id: number;
  title: string;
  productCount: number;
}

/** `GET /categories` — public, flat. There is no hierarchy to render. */
export function listCategories(
  api: KazhalApi,
  options: CallOptions = {},
): Promise<PosCategory[]> {
  return api.client.get<PosCategory[]>("/categories", {
    ...options,
    envelope: "data",
  });
}

// ---------------------------------------------------------------------------
// The cashier's own sale
// ---------------------------------------------------------------------------

export interface OwnSaleItem {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitleSnapshot: string | null;
  variantSkuSnapshot: string | null;
  /**
   * Sale-time snapshots of the shop's own codes.
   *
   * OPTIONAL: `order_items` stores them, but this projection does not expose
   * them on every build, and a slip must print what the server actually sent —
   * a reprint that invented a code would be worse than one that omits it.
   */
  productCodeSnapshot?: string | null;
  variantCodeSnapshot?: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface OwnSale {
  id: number;
  orderNumber: string | null;
  channel: string;
  status: string;
  paymentMethod: string | null;
  soldAt: string | null;
  voidedAt: string | null;
  refundedAt: string | null;
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  branchId: number | null;
  branchNameSnapshot: string | null;
  subtotal: number;
  total_price: number;
  items: OwnSaleItem[];
}

/**
 * `GET /orders/:id` — the receipt source for a CASHIER.
 *
 * WHY NOT `/reports/sales/:id`. That is a reporting route and is now
 * `super_admin` only: a till must not be able to read the shop's books. This
 * route is `@Roles(sale, super_admin)` and branch-scoped, so a cashier can
 * re-read the sale they just rang up — and nothing else — which is exactly the
 * permission the owner described. Seeing your own sale is not reporting.
 *
 * It carries every snapshot the slip needs: order number, seller, branch, sold
 * time, payment method, totals, and per line the product title, variant SKU and
 * variant attributes as they were at sale time.
 */
export function ownSale(
  api: KazhalApi,
  id: number,
  options: CallOptions = {},
): Promise<OwnSale> {
  return api.client.get<OwnSale>(`/orders/${id}`, {
    ...options,
    envelope: "data",
  });
}
