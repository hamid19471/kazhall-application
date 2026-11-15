/**
 * Domain types transcribed from the API's view/DTO classes.
 *
 * Money is **integer Rial** everywhere. There are no decimals, no minor units
 * and no profit metric anywhere in the API.
 */

import type { ApiAudience } from "./audience";


// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The complete role set. There are exactly three — no `customer`, `admin`,
 * `staff` or `owner`.
 *
 *  - `site`        — the retail customer
 *  - `sale`        — the in-store cashier, pinned to one branch server-side
 *  - `super_admin` — the administrator
 *
 * Roles are re-read from the database on every request, so a revocation takes
 * effect on the next call. A role invented via `POST /roles` authorizes nothing.
 */
export type UserRole = "super_admin" | "sale" | "site";

export const USER_ROLES: readonly UserRole[] = ["super_admin", "sale", "site"] as const;

/**
 * The ONLY authoritative session shape, from `GET /auth/<audience>/me`.
 *
 * Never decode the httpOnly JWT in the browser — it is not readable by design,
 * and its `roles`/`branchId` are stale anyway (the server re-reads them per
 * request). Ask `/auth/<audience>/me` for the audience this client is.
 */
export interface Session {
  userId: number;
  /** Username, or the mobile number for an OTP-registered customer. */
  identifier: string;
  roles: UserRole[];
  /** `null` for a customer; the cashier's branch for a `sale` user. */
  branchId: number | null;
  /** Which application this session belongs to. Present since the audience split. */
  audience?: ApiAudience;
  /**
   * EFFECTIVE CAPABILITY CODES, expanded server-side from the roles on the
   * user row for THIS request.
   *
   * USE IT TO HIDE AFFORDANCES, NEVER TO DECIDE ANYTHING. Every one of these
   * is re-checked by the API's `PermissionsGuard` on the actual call; a client
   * that forged the list would change nothing but its own menu. Conversely, a
   * screen that shows a button this list does not contain is not a security
   * hole — it is a 403 the user did not need to see.
   *
   * Optional so a session read from an older API still type-checks; treat an
   * absent list as "no capabilities known", not as "all".
   */
  permissions?: string[];
  /**
   * An administrator issued a temporary password. Until it is replaced, every
   * API route except introspection, rotation, sign-out and the change itself
   * answers 403 `PASSWORD_CHANGE_REQUIRED`.
   */
  mustChangePassword?: boolean;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface ImageView {
  id: number;
  url: string;
  sortOrder?: number;
}

export interface CategoryRef {
  id: number;
  title: string;
}

export interface Category extends CategoryRef {
  productCount: number;
}

export interface AttributeValueView {
  id: number;
  value: string;
  attribute?: { id: number; name: string };
}

/**
 * Recomputed per request; `indicative: true` is the server saying "advisory,
 * not a promise". Never render it as a hard count to a customer.
 */
export interface AvailabilityView {
  availableForBasket: number;
  inStock: boolean;
  indicative: true;
  asOf: string;
}

export interface PublicVariant {
  id: number;
  sku: string;
  /**
   * «کد گونه» — the store's own business identifier for this exact variant.
   *
   * DISTINCT FROM `sku`, which is the warehouse's (often a vendor's) string.
   * Both are shown: the POS searches either, the receipt prints both.
   * Always begins with the parent product's `productCode`.
   */
  variantCode: string;
  price: number | null;
  attributeValues: AttributeValueView[];
  availability?: AvailabilityView;
}

export interface AdminVariant extends PublicVariant {
  stock: number;
  isActive: boolean;
  /**
   * The system-created variant that IS the product — a simple product's single
   * hidden variant. Lets the console tell a SIMPLE product from one that
   * happens to have exactly one optionless variant; from outside those look
   * identical, and guessing from shape gets the second case wrong.
   */
  isDefault: boolean;
}

export interface ProductListItem {
  id: number;
  title: string;
  /** «کد محصول». Searchable in Admin and at the POS. */
  productCode: string;
  basePrice: number | null;
  /** Cheapest active variant price, falling back to `basePrice`. */
  effectivePrice: number | null;
  /**
   * Dearest active variant price, same fallback. Equal to `effectivePrice`
   * when every active variant costs the same — which is the ONLY reliable
   * signal for whether a card should print a "from" price. `variantCount > 1`
   * is not: two variants at one price are one price.
   */
  maxEffectivePrice: number | null;
  primaryImage: ImageView | null;
  categories: CategoryRef[];
  inStock: boolean;
  variantCount: number;
}

export interface PublicProduct {
  id: number;
  title: string;
  /** «کد محصول» — the business identifier for this product family. */
  productCode: string;
  description: string | null;
  basePrice: number | null;
  categories: CategoryRef[];
  images: ImageView[];
  variants: PublicVariant[];
}

export interface AdminProduct extends Omit<PublicProduct, "variants"> {
  variants: AdminVariant[];
  bookmarkCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * WHERE THIS PRODUCT IS OFFERED. Admin-only — the storefront never receives
   * it, and neither does the POS.
   */
  visibility: ProductVisibility;
}

/**
 * The retail-channel dimension of «محل عرضه محصول».
 *
 *   "none"      no till sells it
 *   "all"       every ACTIVE branch sells it, INCLUDING ONES CREATED LATER
 *   "selected"  only the branches in `branches`
 *
 * `"all"` is evaluated at read time, never materialised as rows, so a branch
 * opened next month inherits it without anyone revisiting the catalogue.
 */
export type BranchVisibilityMode = "none" | "all" | "selected";

/**
 * A product's complete channel configuration.
 *
 * ⚠ THIS IS VISIBILITY, NOT INVENTORY. Selecting branches decides WHERE the
 * product may be sold from. It does NOT give those branches separate stock:
 * `stock`, basket reservations and order allocations all remain GLOBAL, and
 * every listed branch sells out of the same single quantity.
 *
 * Only `super_admin` may change any of it — including narrowing it.
 */
export interface ProductVisibility {
  /** The Website channel. */
  visibleOnSite: boolean;
  branchVisibility: BranchVisibilityMode;
  /**
   * The selected branches, with names resolved for display. Empty unless
   * `branchVisibility` is `"selected"`.
   *
   * A branch that has since been DEACTIVATED is still listed, with
   * `isActive: false`, so an operator can see the selection they made rather
   * than a silently shortened list.
   */
  branches: Array<{ id: number; name: string; isActive: boolean }>;
  /** Convenience: offered nowhere at all. */
  hiddenDraft: boolean;
}

/** `POST /products/admin/codes/product` — a fresh, unused «کد محصول». */
export interface GeneratedProductCode {
  productCode: string;
}

/** `POST /products/admin/codes/variant` — a fresh «کد گونه» under a parent. */
export interface GeneratedVariantCode {
  /** The NORMALISED parent, which may differ from what was sent. */
  productCode: string;
  variantCode: string;
}

export interface ProductAttributeValue {
  id: number;
  value: string;
}

/** `GET /attributes` — the attribute with its whole value set inlined. */
export interface ProductAttribute {
  id: number;
  name: string;
  values: ProductAttributeValue[];
}

/** `POST /products` — one variant, created together with its product. */
export interface CreateVariantBody {
  /** Integer Rial. Omit to inherit the product's `basePrice`. */
  price?: number;
  stock: number;
  sku: string;
  /**
   * «کد گونه». Must begin with the product's `productCode` followed by a
   * hyphen. Normalised server-side (trimmed, upper-cased, Persian digits
   * folded to ASCII); a duplicate is a 409 naming `variantCode`.
   */
  variantCode: string;
  attributeValueIds: number[];
}

export interface CreateProductBody {
  title: string;
  description: string;
  /**
   * «کد محصول». Normalised server-side; a duplicate is a 409 naming
   * `productCode`. Generate one with `catalog.generateProductCode()`.
   */
  productCode: string;
  basePrice?: number;
  /**
   * WHERE THE PRODUCT IS OFFERED — `super_admin` only.
   *
   * Omit all three and the product is created HIDDEN/DRAFT (offered nowhere),
   * which is what a delegated catalogue editor gets whether they ask for it or
   * not. `branchIds` is required when `branchVisibility` is `"selected"` and
   * refused otherwise.
   */
  visibleOnSite?: boolean;
  branchVisibility?: BranchVisibilityMode;
  branchIds?: number[];
  variants?: CreateVariantBody[];
  /**
   * OPENING QUANTITY FOR A SIMPLE PRODUCT — one created with NO `variants`.
   *
   * For such a product the server builds a single hidden default variant
   * carrying `basePrice`, and this is that variant's starting stock. It is
   * written as a real `initial_stock` ledger movement in the same transaction,
   * never assigned to `stock` behind the ledger's back.
   *
   * THE QUANTITY IS GLOBAL — one number shared by the website and every
   * eligible branch, never a per-branch figure. Branch visibility decides
   * WHERE a product may be sold, never HOW MANY each place holds.
   *
   * Two refusals, both naming `initialStock` in `details.field`:
   *   with `variants`          -> 400 INITIAL_STOCK_WITH_VARIANTS
   *   positive, no capability  -> 403 INITIAL_STOCK_REQUIRES_INVENTORY_ADJUST
   *                               (`inventory.adjust`; zero is always allowed)
   *
   * NOT ON PATCH. `UpdateProductBody` omits it deliberately and the server
   * rejects it outright — stock after creation moves only through
   * `adjustVariantStock`, which reconciles against reservations.
   */
  initialStock?: number;
  categoryIds?: number[];
  /** Ordered ids from `uploadImage`. The array index becomes `sortOrder`. */
  images?: number[];
}

/**
 * `PATCH /products/:id` — one entry of the partial variant upsert list.
 *
 * No `id` → CREATE. With `id` → UPDATE (the id must belong to this product).
 * `isActive: false` retires the variant; variants are never hard-deleted.
 * `stock` is accepted ONLY on a create — an update carrying it is rejected,
 * because stock moves exclusively through the inventory ledger.
 */
export interface UpsertVariantBody {
  id?: number;
  price?: number;
  stock?: number;
  sku?: string;
  /** «کد گونه». Required when creating; omit to leave an existing one alone. */
  variantCode?: string;
  /** Complete desired set. Required when creating; omit to leave untouched. */
  attributeValueIds?: number[];
  isActive?: boolean;
}

export interface UpdateProductBody {
  title?: string;
  description?: string;
  /** «کد محصول». Editable: `order_items` snapshots it, so history is safe. */
  productCode?: string;
  basePrice?: number;
  /**
   * `super_admin` only. Sending a configuration IDENTICAL to the stored one is
   * not a change and is allowed for anyone — so a delegated editor may keep
   * using a form that round-trips these fields.
   */
  visibleOnSite?: boolean;
  branchVisibility?: BranchVisibilityMode;
  branchIds?: number[];
  categoryIds?: number[];
  variants?: UpsertVariantBody[];
  /** COMPLETE desired ordered set. Omit = untouched; `[]` = delete them all. */
  images?: number[];
}

export type StockAdjustMode = "set" | "delta";

export interface AdjustVariantStockBody {
  mode: StockAdjustMode;
  /** `set`: the new absolute stock (>= 0). `delta`: the signed change. */
  value: number;
  reason?: string;
  /**
   * Permit the result to fall below what is already reserved. Default `false`,
   * i.e. such an adjustment is REFUSED — as 409 `STOCK_BELOW_RESERVED` from the
   * pre-check, or as a 400 from the authoritative re-check under the lock.
   */
  allowBelowReserved?: boolean;
}

export interface StockAdjustResult {
  variantId: number;
  productId: number;
  sku: string;
  previousStock: number;
  balanceAfter: number;
  basketReserved: number;
  orderAllocated: number;
  belowReserved: boolean;
}

export type ProductSort = "newest" | "price_asc" | "price_desc";

export interface ProductQuery {
  page?: number;
  limit?: number;
  /** Trimmed, max 200 chars server-side. */
  search?: string;
  categoryId?: number;
  minPrice?: number;
  maxPrice?: number;
  /** Server accepts `true`/`1`/`yes`/`on`. */
  inStockOnly?: boolean;
  sort?: ProductSort;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/**
 * Why a cart line changed underneath the customer. The API deliberately never
 * names a staff member, a branch or another customer — do not try to enrich it.
 */
export type CartChangeReason =
  | "sold_in_store"
  | "reservation_expired"
  | "stock_not_counted"
  /**
   * The line's SKU has been deactivated, so it cannot be ordered.
   *
   * DERIVED by the server per read from the variant's current state — it is
   * not stored, so it survives a reload and disappears the moment the SKU is
   * reactivated. The line stays in `data` with its units still held, and
   * `availableForBasket` is 0. `POST /orders` refuses the basket with
   * `409 VARIANT_INACTIVE` until the line is removed.
   *
   * It is the same string as the checkout diff's `not_sellable` change kind on
   * purpose: one condition, one name, two surfaces.
   */
  | "not_sellable"
  /**
   * The product was withdrawn from the WEBSITE («نمایش در وب‌سایت» turned off).
   *
   * DELIBERATELY NOT `not_sellable`: that means the SKU is deactivated, and a
   * product taken off the site may be perfectly active and selling briskly in
   * the shops. Telling a customer it is discontinued would be false, and would
   * make the two channels indistinguishable in exactly the case this feature
   * exists to separate.
   *
   * Like `not_sellable` it is DERIVED per read, carries `at: null` and
   * `quantityDelta: null`, leaves the line in `data` with its units held, and
   * BLOCKS CHECKOUT until the line is removed.
   */
  | "channel_unavailable";

export interface CartLineChange {
  reason: CartChangeReason;
  /** ENGLISH, developer-facing. A Persian UI renders its own copy. */
  message: string;
  /** Null for `not_sellable`: nothing happened at a particular instant. */
  at: string | null;
  /** Negative when units were taken away. Null for `not_sellable`. */
  quantityDelta: number | null;
}

export interface CartLine {
  id: number;
  status: string;
  productId: number;
  productTitle: string | null;
  productImages: Array<string | null>;
  /**
   * `price` is the EFFECTIVE price — the server applies the documented
   * `variant.price ?? product.basePrice` inheritance before it answers, so an
   * inherited-price variant quotes what checkout will charge rather than null
   * or zero. `attributeValues` names what the customer actually chose.
   */
  variant: {
    id: number;
    sku: string;
    price: number | null;
    attributeValues: AttributeValueView[];
  } | null;
  quantity: number;
  reservedQuantity: number;
  availableForBasket: number | null;
  /** Reservations last 4 hours. */
  expiresAt: string | null;
  tranches: Array<{ quantity: number; expiresAt: string | null }>;
  change: CartLineChange | null;
}

/**
 * `GET /cart` — `notices` is a SIBLING of `data`, not nested inside it.
 *
 * ## `notices` holds LINES, not changes
 *
 * This was typed `CartLineChange[]` and it is not. `CartService.findAll`
 * returns `{ items, notices }` where BOTH are `CartLineView[]`:
 *
 * ```ts
 * items:   views.filter((v) => v.status === CartItemStatus.ACTIVE),
 * notices: views.filter((v) => v.change !== null),
 * ```
 *
 * so a notice is a whole basket line whose `change` is non-null — carrying the
 * product title and the variant as well as the reason. The mistyping was not
 * cosmetic: a consumer reading `notice.reason` got `undefined`, and
 * `notice.quantityDelta` — also `undefined` — is not `null`, so a
 * `!== null` guard let it through and rendered `NaN`.
 *
 * It surfaces exactly where it hurts most. A line reduced by a till sale is
 * still in `data` and carries its own `change`, so the basket-level notice is
 * usually a duplicate nobody reads. A line FULLY displaced is removed from
 * `data` entirely, and then this array is the ONLY place `sold_in_store`
 * appears anywhere in the response.
 *
 * The extra fields are the reason this shape is right: with the line gone, a
 * notice that could not name the product would be a shrug.
 */
export interface CartView {
  data: CartLine[];
  /** Lines whose `change` is non-null — including ones removed from `data`. */
  notices: CartLine[];
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderChannel = string;
export type OrderStatus = string;
export type PaymentMethod = string;

export interface CheckoutQuote {
  token: string;
  /**
   * An opaque fingerprint of the basket the quote priced — verified on the
   * wire to be a HEX STRING (`"3055fbe36c00ec77a14786c863f74924"`), not a
   * counter. Compare it for equality if you must; never do arithmetic on it.
   */
  basketVersion: string;
  issuedAt: string;
  expiresAt: string;
  subtotal: number;
  total: number;
}

export interface CheckoutBasketLine {
  cartItemId: number;
  productId: number;
  variantId: number | null;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface CheckoutBasket {
  lines: CheckoutBasketLine[];
  subtotal: number;
  total: number;
}

export interface CheckoutPreview {
  quote: CheckoutQuote;
  basket: CheckoutBasket;
  notices: unknown[];
}

export interface OrderAddressSnapshot {
  addressId: number | null;
  province: string;
  city: string;
  address: string;
  postalCode: string;
  receiverMobile: string;
  capturedAt: string | null;
}

export interface CheckoutLine {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitleSnapshot: string;
  variantSkuSnapshot: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface CheckoutResult {
  id: number;
  orderNumber: string | null;
  status: OrderStatus;
  fulfillmentState: string;
  paymentMethod: PaymentMethod | null;
  soldAt: string | null;
  subtotal: number;
  totalPrice: number;
  address: OrderAddressSnapshot | null;
  items: CheckoutLine[];
  acceptedQuote: {
    /** The same opaque fingerprint the quote carried. A string, not a counter. */
    basketVersion: string;
    issuedAt: string;
    expiresAt: string;
    subtotal: number;
    total: number;
  };
}

/**
 * What the CUSTOMER is told about a reconciliation case, in customer-safe
 * vocabulary. Deliberately tiny and deliberately honest:
 *
 *  - `under_review` — "payment received; this order requires review". The money
 *    is recorded, nothing has been refunded or charged again, a human is on it.
 *  - `refund_in_progress` — a refund is BEING PROCESSED. It never means a
 *    refund completed: on completion the order's own `status` becomes
 *    `refunded` and this field goes back to `null`.
 *
 * It carries no operator note, no gateway reference, no internal error text and
 * no amount. `null` means there is nothing to say.
 */
export type CustomerOrderReviewState = "under_review" | "refund_in_progress";

/** `GET /me/orders/:id` — deliberately narrower than the staff view. */
export interface CustomerOrder {
  id: number;
  orderNumber: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  fulfillmentState: string;
  paymentMethod: PaymentMethod | null;
  soldAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  refundedAt: string | null;
  subtotal: number;
  totalPrice: number;
  discountCode: string | null;
  addressSnapshot: OrderAddressSnapshot | null;
  items: CheckoutLine[];
  /**
   * Customer-safe reconciliation state. Surface it as-is: never translate
   * `refund_in_progress` into "refunded", and never let `under_review` imply
   * the order is on its way.
   */
  reviewState: CustomerOrderReviewState | null;
}

export interface CreateOrderBody {
  /** The address id. The server DTO really does call this `address`. */
  address: number;
  discount_code?: string;
  /** Not part of the idempotency hash — a fresh token is not key reuse. */
  quoteToken?: string;
}

export interface PosOrderItem {
  productVariantId: number;
  quantity: number;
}

export interface CreatePosOrderBody {
  /** Iranian mobile. */
  mobile?: string;
  name?: string;
  paymentMethod: PaymentMethod;
  items: PosOrderItem[];
}

export interface PosSaleResult {
  id: number;
  orderNumber: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  fulfillmentState: string;
  paymentMethod: PaymentMethod;
  soldAt: string | null;
  voidedAt: string | null;
  branchId: number | null;
  branchNameSnapshot: string | null;
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  customerId: number | null;
  subtotal: number;
  totalPrice: number;
  items: CheckoutLine[];
  stock: Array<{
    variantId: number;
    quantityConsumed: number;
    balanceAfter: number;
    fromFreeStock: number;
    fromDisplacedBaskets: number;
  }>;
  displacedBasketLines: number;
}

/**
 * 409 `error`/`details.code` values from checkout. Branch on these, never on
 * the human message.
 */
export type CheckoutConflictCode =
  | "checkout_quote_required"
  | "checkout_quote_invalid"
  | "checkout_quote_stale"
  | "checkout_contents_changed"
  | "checkout_retry_required"
  | "INSUFFICIENT_STOCK"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REQUEST_IN_PROGRESS"
  | "IDEMPOTENCY_KEY_FOREIGN_CASHIER";

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/** Note `postal_code` and the shipped misspelling `reciver_mobile`. */
export interface CreateAddressBody {
  province: string;
  city: string;
  address: string;
  /** Exactly 10 characters. */
  postal_code: string;
  /** sic — the server DTO misspells "receiver". */
  reciver_mobile: string;
  description?: string;
}

export type UpdateAddressBody = Partial<CreateAddressBody>;

export interface Address extends CreateAddressBody {
  id: number;
}

// ---------------------------------------------------------------------------
// Branch / inventory
// ---------------------------------------------------------------------------

export interface Branch {
  id: number;
  name: string;
  address?: string;
  phone?: string;
}

export interface CreateBranchBody {
  name: string;
  address?: string;
  phone?: string;
}

/**
 * `availableForBasket = physicalStock − basketReserved − orderAllocated`
 * `availableForPos    = physicalStock − orderAllocated`
 */
export interface AvailabilitySnapshot {
  variantId: number;
  /**
   * The owning product.
   *
   * Added so the polling fallback can synthesize the same
   * `availability:invalidated` shape the socket sends — the frame carries a
   * `productId` so a listing page can reconcile one product instead of its
   * whole current page, and a fallback that omitted it would make the poller's
   * frames second-class.
   */
  productId: number;
  /**
   * `product_variants.isActive`.
   *
   * WAS MISSING, AND THE TILL PAID FOR IT. The API has always returned this
   * field on every availability row; this type dropped it, so a till reading
   * the batch endpoint could not tell a retired SKU from a sellable one and
   * its own "this line is deactivated" guard could never fire.
   *
   * The two quantities below are RAW -- unclamped and `isActive`-blind, so an
   * administrator can still reconcile what is physically on the shelf. A
   * retired variant can therefore report a POSITIVE `availableForPos`.
   * Sellability is `isActive && availableForPos > 0`; the number alone is not
   * an authorisation to sell.
   */
  isActive: boolean;
  physicalStock: number;
  basketReserved: number;
  orderAllocated: number;
  availableForBasket: number;
  availableForPos: number;
}

export interface SkuLookupResult {
  productId: number;
  productTitle: string;
  variantId: number;
  sku: string;
  unitPrice: number;
  isActive: boolean;
  isDefault: boolean;
  /** RAW, and not an authorisation to sell. See `sellableInStore`. */
  availability: AvailabilitySnapshot;
  /** `isActive && clamped availableForPos > 0` -- the till's answer. */
  sellableInStore: boolean;
  /** `isActive && clamped availableForBasket > 0`. */
  sellableOnline: boolean;
  /** Why not, so the till can say which it is. `null` when it is sellable. */
  unsellableReason: "variant_inactive" | "no_units_available" | null;
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface PaymentStartResult {
  paymentId: number;
  orderId: number;
  trackId: string;
  amount: number;
  paymentUrl: string;
  reused: boolean;
}

export interface PaymentVerifyResult {
  success: boolean;
  alreadyProcessed: boolean;
  applied: boolean;
  paymentStatus: string;
  requiresReconciliation: boolean;
  reconciliationReason: string | null;
  trackId: string;
  orderId: number;
  orderStatus: OrderStatus;
  fulfillmentState: string;
  expectedAmount: number;
  gatewayAmount: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * `GET /health` answers 200 **or 503** but BOTH bodies use the success envelope
 * with `success: true`. Read `status`/`database`, never `success`.
 */
export interface HealthReport {
  status: "ok" | "error";
  database: "up" | "down";
  latencyMs: number;
  uptimeSeconds: number;
  error?: string;
}
