import { Product } from '../entities/product.entity';
import { ProductImage } from '../entities/product-image.entity';
import { ProductVariant } from '../entities/product-variant.entity';
import type { ProductVisibilityView } from '../services/product-visibility.service';

/**
 * ============================================================================
 * RESPONSE PROJECTIONS
 *
 * Raw entities are NEVER returned from a controller. `Product` transitively
 * reaches `cartItems` (other customers' baskets) and `users` (who bookmarked
 * it) -- both were previously loaded into `findOne` and cached under a global
 * key, so every caller received, and every subsequent caller was served from
 * cache, other customers' private data.
 *
 * Two projections exist:
 *
 *   PublicProductView  -- anonymous storefront. No cart rows, no user rows, no
 *                         stock integers, no timestamps, no internal joins.
 *   AdminProductView   -- authenticated admin. Adds physical stock, inactive
 *                         variants, timestamps and a bookmark *count* (never
 *                         the bookmarking users themselves).
 *
 * Both are plain interfaces built by the mappers below from an explicitly
 * loaded relation set, so adding a relation to the entity can never silently
 * widen a response.
 * ============================================================================
 */

/**
 * Availability as shown in a catalog response.
 *
 * `indicative: true` is not decoration. Catalog availability is a snapshot
 * taken outside the inventory transaction; a POS sale may consume the last
 * unit a millisecond later. The AUTHORITATIVE check is performed by
 * `IInventoryService` at basket / checkout / POS time, under row locks. Never
 * treat this field as a guarantee, and never let it be the basis of a sale.
 */
export interface AvailabilityView {
  /** Units a storefront basket may currently take. Indicative only. */
  availableForBasket: number;
  inStock: boolean;
  indicative: true;
  /** When the snapshot was taken (server clock, ISO-8601). */
  asOf: string;
}

export interface AttributeValueView {
  id: number;
  value: string;
  attribute?: { id: number; name: string };
}

export interface ImageView {
  id: number;
  url: string;
  sortOrder: number | null;
}

export interface CategoryRefView {
  id: number;
  title: string;
}

export interface PublicVariantView {
  id: number;
  sku: string;
  /**
   * «کد گونه». Public on purpose: a customer reads it down a telephone to ask
   * about the exact variant, and the POS searches it. It reveals nothing about
   * where the product is sold.
   */
  variantCode: string;
  price: number | null;
  attributeValues: AttributeValueView[];
  /** Present only when availability was resolved for this request. */
  availability?: AvailabilityView;
}

export interface AdminVariantView extends PublicVariantView {
  /** Physical stock. Admin-only: never exposed on a public endpoint. */
  stock: number;
  isActive: boolean;
  /**
   * The system-created variant that IS the product — a simple product's single
   * hidden variant, carrying the product's own price and no options.
   *
   * Exposed because the Admin console has to tell a SIMPLE product from one
   * that happens to have exactly one variant, and those look identical from
   * outside: both are one row with no attribute values. Without this flag the
   * console has to guess from shape, and it guesses wrong for a product
   * deliberately created with a single optionless variant — showing it a
   * simple-product stock panel it should not have.
   *
   * ADMIN ONLY. `PublicVariantView` does not carry it: which variant the
   * system generated is an implementation detail of the catalogue, not
   * something a customer's browser has any use for.
   */
  isDefault: boolean;
}

/** Lightweight list projection -- deliberately not the detail projection. */
export interface PublicProductListItemView {
  id: number;
  title: string;
  productCode: string;
  basePrice: number | null;
  /** Cheapest active variant price, falling back to basePrice. */
  effectivePrice: number | null;
  /**
   * Dearest active variant price, same fallback. Equal to `effectivePrice`
   * when every active variant costs the same, which is how a listing card
   * knows whether to print one price or a "from" price. `variantCount > 1` is
   * NOT that signal: two variants at one price are one price, and saying
   * "from" there invents a range the shop does not offer.
   */
  maxEffectivePrice: number | null;
  primaryImage: ImageView | null;
  categories: CategoryRefView[];
  /** Indicative. See AvailabilityView. */
  inStock: boolean;
  variantCount: number;
}

/**
 * ADMIN list projection.
 *
 * A deliberate superset of the public list row, not a reuse of it. The public
 * card answers "may a customer buy this, and for how much"; this one answers
 * "is this product in a state I need to do something about" — which needs the
 * counts the storefront must never see (inactive variants, physical stock) and
 * the two availability booleans below.
 */
export interface AdminProductListItemView {
  id: number;
  title: string;
  productCode: string;
  basePrice: number | null;
  categories: CategoryRefView[];
  primaryImage: ImageView | null;
  /** EVERY variant, active or not. */
  variantCount: number;
  activeVariantCount: number;
  /** Physical stock summed over ACTIVE variants only. */
  totalStock: number;
  /** Cheapest active variant price, falling back to basePrice. */
  effectivePrice: number | null;
  /** Dearest active variant price, same fallback. */
  maxEffectivePrice: number | null;
  /**
   * OFFERABLE on that surface — i.e. the product has at least one active
   * variant. `sellableOnWeb` and `sellableOnPos` are therefore always equal,
   * and that is the honest answer rather than a bug: the model has no
   * per-surface activation flag. What genuinely differs between the two
   * surfaces is AVAILABILITY, because a basket hold blocks a web sale and does
   * not block a till sale — that is what the two `has…AvailableStock` fields
   * below report.
   */
  sellableOnWeb: boolean;
  sellableOnPos: boolean;
  /** Some active variant has `stock - basketReserved - orderAllocated > 0`. */
  hasWebAvailableStock: boolean;
  /** Some active variant has `stock - orderAllocated > 0`. */
  hasPosAvailableStock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicProductView {
  id: number;
  title: string;
  /** «کد محصول». */
  productCode: string;
  description: string;
  basePrice: number | null;
  categories: CategoryRefView[];
  images: ImageView[];
  variants: PublicVariantView[];
}

export interface AdminProductView {
  id: number;
  title: string;
  productCode: string;
  description: string;
  basePrice: number | null;
  categories: CategoryRefView[];
  images: ImageView[];
  /** Includes deactivated variants, which the public view omits. */
  variants: AdminVariantView[];
  /** Count only -- the bookmarking users are never disclosed. */
  bookmarkCount: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * WHERE THE PRODUCT IS OFFERED. Admin-only — deliberately absent from
   * `PublicProductView` and from every POS projection, so a branch's
   * configuration can never reach a customer or another shop's till.
   *
   * ⚠ Visibility, not inventory: stock remains global.
   */
  visibility: ProductVisibilityView;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function sortImages(images: ProductImage[] = []): ProductImage[] {
  return [...images].sort((a, b) => {
    const av = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bv = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return av === bv ? a.id - b.id : av - bv;
  });
}

export function toImageView(image: ProductImage): ImageView {
  return { id: image.id, url: image.url, sortOrder: image.sortOrder ?? null };
}

export function toCategoryRefViews(product: Product): CategoryRefView[] {
  return (product.categories ?? []).map((c) => ({ id: c.id, title: c.title }));
}

function toAttributeValueViews(variant: ProductVariant): AttributeValueView[] {
  return (variant.attributeValues ?? []).map((v) => ({
    id: v.id,
    value: v.value,
    attribute: v.attribute
      ? { id: v.attribute.id, name: v.attribute.name }
      : undefined,
  }));
}

export function toPublicVariantView(
  variant: ProductVariant,
  availability?: AvailabilityView,
): PublicVariantView {
  return {
    id: variant.id,
    sku: variant.sku,
    variantCode: variant.variantCode,
    price: variant.price ?? null,
    attributeValues: toAttributeValueViews(variant),
    ...(availability ? { availability } : {}),
  };
}

export function toAdminVariantView(
  variant: ProductVariant,
  availability?: AvailabilityView,
): AdminVariantView {
  return {
    ...toPublicVariantView(variant, availability),
    stock: variant.stock,
    isActive: variant.isActive,
    isDefault: variant.isDefault === true,
  };
}

/**
 * PUBLIC detail projection. Only ACTIVE variants are listed: a deactivated
 * variant is not sellable, so offering it in the storefront would be a lie.
 */
export function toPublicProductView(
  product: Product,
  availability?: ReadonlyMap<number, AvailabilityView>,
): PublicProductView {
  return {
    id: product.id,
    title: product.title,
    productCode: product.productCode,
    description: product.description,
    basePrice: product.basePrice ?? null,
    categories: toCategoryRefViews(product),
    images: sortImages(product.images).map(toImageView),
    variants: (product.variants ?? [])
      .filter((v) => v.isActive !== false)
      .map((v) => toPublicVariantView(v, availability?.get(v.id))),
  };
}

export function toAdminProductView(
  product: Product,
  availability?: ReadonlyMap<number, AvailabilityView>,
): AdminProductView {
  return {
    id: product.id,
    title: product.title,
    productCode: product.productCode,
    description: product.description,
    basePrice: product.basePrice ?? null,
    categories: toCategoryRefViews(product),
    images: sortImages(product.images).map(toImageView),
    variants: (product.variants ?? []).map((v) =>
      toAdminVariantView(v, availability?.get(v.id)),
    ),
    bookmarkCount: (product.users ?? []).length,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
    /*
     * A PLACEHOLDER the caller must overwrite. `toAdminProductView` maps a
     * loaded entity and has no manager to query the mapping rows with, and
     * inventing an optimistic default here would mean a caller that forgot to
     * fill it in silently reports the product as published. Hidden/draft is
     * the safe shape to be wrong in.
     */
    visibility: {
      visibleOnSite: product.visibleOnSite ?? false,
      branchVisibility: product.branchVisibility ?? 'none',
      branches: [],
      hiddenDraft:
        !(product.visibleOnSite ?? false) &&
        (product.branchVisibility ?? 'none') === 'none',
    },
  };
}

/**
 * List projection. `inStock` and `effectivePrice` come from a SQL-side
 * aggregate computed by the same query that paginated, so the list endpoint
 * never has to load variants into memory.
 */
/**
 * Admin list projection. Every aggregate is computed by the SAME paginating
 * SQL statement (including the reservation arithmetic behind
 * `hasWebAvailableStock` / `hasPosAvailableStock`), so a page of 100 products
 * costs one aggregate query and one relation load — never a per-row
 * availability call.
 */
export function toAdminProductListItemView(
  product: Product,
  aggregate: {
    variantCount: number;
    activeVariantCount: number;
    totalStock: number;
    effectivePrice: number | null;
    maxEffectivePrice: number | null;
    hasWebAvailableStock: boolean;
    hasPosAvailableStock: boolean;
  },
): AdminProductListItemView {
  const images = sortImages(product.images);
  const sellable = aggregate.activeVariantCount > 0;
  return {
    id: product.id,
    title: product.title,
    productCode: product.productCode,
    basePrice: product.basePrice ?? null,
    categories: toCategoryRefViews(product),
    primaryImage: images.length ? toImageView(images[0]) : null,
    variantCount: aggregate.variantCount,
    activeVariantCount: aggregate.activeVariantCount,
    totalStock: aggregate.totalStock,
    effectivePrice: aggregate.effectivePrice,
    maxEffectivePrice: aggregate.maxEffectivePrice,
    sellableOnWeb: sellable,
    sellableOnPos: sellable,
    hasWebAvailableStock: aggregate.hasWebAvailableStock,
    hasPosAvailableStock: aggregate.hasPosAvailableStock,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
  };
}

export function toPublicProductListItemView(
  product: Product,
  aggregate: {
    effectivePrice: number | null;
    maxEffectivePrice: number | null;
    inStock: boolean;
    variantCount: number;
  },
): PublicProductListItemView {
  const images = sortImages(product.images);
  return {
    id: product.id,
    title: product.title,
    productCode: product.productCode,
    basePrice: product.basePrice ?? null,
    effectivePrice: aggregate.effectivePrice,
    maxEffectivePrice: aggregate.maxEffectivePrice,
    primaryImage: images.length ? toImageView(images[0]) : null,
    categories: toCategoryRefViews(product),
    inStock: aggregate.inStock,
    variantCount: aggregate.variantCount,
  };
}
