/**
 * What the till sees when it browses.
 *
 * WHY THIS IS NOT `GET /products`. That endpoint is `@Public()`, and the number
 * a till must show is `availableForPos` — physical stock minus stock already
 * allocated to paid online orders. Publishing that anonymously would tell the
 * whole internet exactly how much of everything sits in the shop. It also
 * returns no variant ids at all, so a till built on it would have to fetch each
 * product's detail separately just to learn what it may sell: one request per
 * tile, on every keystroke of a search.
 *
 * So this is a separate, `sale`-gated, paginated projection that answers the
 * till's actual question — "what can I sell right now, and for how much" — in
 * one request per page.
 */

export interface PosCatalogAttributeValueView {
  id: number;
  value: string;
  /** The axis this value belongs to (رنگ, ظرفیت …). Absent only if unlinked. */
  attribute?: { id: number; name: string };
}

export interface PosCatalogVariantView {
  id: number;
  sku: string;
  /**
   * «کد گونه». Shown beside the SKU at the till and searchable, because a
   * cashier reads whichever string is printed on the box and should not have
   * to know which field the store calls it.
   */
  variantCode: string;
  /**
   * The EFFECTIVE unit price in integer Rial: the variant's own price when it
   * sets one, otherwise the product's `basePrice` — the same inheritance the
   * order path charges. `null` only when neither exists, which the till must
   * render as "price not set" rather than as a free item.
   */
  price: number | null;
  attributeValues: PosCatalogAttributeValueView[];
  /**
   * INDICATIVE. `physicalStock − orderAllocated`: a POS sale may take units an
   * ecommerce basket is holding, but never units allocated to a paid online
   * order. It can change between this read and the sale, which is why
   * `POST /orders/pos` re-checks under a lock and may still refuse.
   */
  availableForPos: number;
  inStock: boolean;
}

export interface PosCatalogProductView {
  id: number;
  title: string;
  /** «کد محصول» — the family identifier, also searchable. */
  productCode: string;
  primaryImage: { id: number; url: string } | null;
  categories: Array<{ id: number; title: string }>;
  /** Cheapest / dearest ACTIVE variant effective price, for a "from" price. */
  effectivePrice: number | null;
  maxEffectivePrice: number | null;
  /** ACTIVE variants only. A product with none is not sellable at the till. */
  variants: PosCatalogVariantView[];
  /** True when any active variant has `availableForPos > 0`. */
  inStock: boolean;
}

export interface PosCatalogPage {
  data: PosCatalogProductView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
