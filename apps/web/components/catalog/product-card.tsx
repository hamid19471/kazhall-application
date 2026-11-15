import Link from "next/link";

import type { ProductListItem } from "@kazhal/api-client";
import { Badge, Card, Money, Skeleton, cx, formatInteger } from "@kazhal/ui";

import { ProductImage } from "@/components/catalog/product-image";
import { productHref } from "@/lib/routes";

/**
 * One product in a grid.
 *
 * Everything on this card comes from `ProductListItem` and nothing is invented:
 * there is no rating (the API has none), no review count, no "٪۲۰ تخفیف" badge
 * unless `basePrice` really is above `effectivePrice`, and no stock number —
 * list-level stock is explicitly indicative, so it is rendered as a boolean
 * ("موجود" / "ناموجود") and never as a count.
 *
 * The whole card is one link. The title carries the accessible name and the
 * image is `alt`-labelled with the same title, so a screen reader hears the
 * product once, not twice.
 */
export function ProductCard({ product, priority = false }: { product: ProductListItem; priority?: boolean }) {
  const price = product.effectivePrice;
  /*
   * A "from" price is only honest when the active variants really do cost
   * different amounts. `variantCount > 1` is not that test — two variants at
   * one price are one price — so the range comes from the server's own
   * cheapest/dearest pair.
   */
  const hasPriceRange =
    price !== null &&
    product.maxEffectivePrice !== null &&
    product.maxEffectivePrice > price;
  const hasDiscount =
    product.basePrice !== null &&
    price !== null &&
    product.basePrice > price;

  return (
    <Card
      as="li"
      tone="outlined"
      padding="none"
      interactive
      className="group relative flex flex-col overflow-hidden"
    >
      <div className="relative aspect-square w-full overflow-hidden">
        <ProductImage
          url={product.primaryImage?.url}
          alt={product.title}
          priority={priority}
          sizes="(min-width: 1024px) 20rem, (min-width: 640px) 33vw, 50vw"
          className="size-full transition-transform duration-300 ease-kz group-hover:scale-[1.03]"
        />
        {!product.inStock ? (
          <span className="absolute top-2 start-2">
            <Badge tone="neutral" size="sm">
              ناموجود
            </Badge>
          </span>
        ) : hasDiscount ? (
          <span className="absolute top-2 start-2">
            <Badge tone="danger" size="sm">
              تخفیف‌خورده
            </Badge>
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3 md:p-4">
        {product.categories.length > 0 ? (
          <p className="truncate text-2xs text-ink-subtle">
            {product.categories.map((category) => category.title).join(" · ")}
          </p>
        ) : null}

        <h3 className="text-sm leading-snug font-semibold text-ink md:text-base">
          <Link
            href={productHref(product.id)}
            className="text-ink no-underline before:absolute before:inset-0 before:content-[''] focus-visible:outline-none group-focus-within:underline"
          >
            {product.title}
          </Link>
        </h3>

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div className="min-w-0">
            {hasDiscount ? (
              <Money value={product.basePrice} struck withUnit={false} className="block text-xs" />
            ) : null}
            {price === null ? (
              <span className="text-sm text-ink-subtle">قیمت اعلام نشده</span>
            ) : hasPriceRange ? (
              <span className="flex items-baseline gap-1">
                <span className="text-2xs text-ink-subtle">از</span>
                <Money value={price} className="block text-base font-bold text-ink" />
              </span>
            ) : (
              <Money value={price} className="block text-base font-bold text-ink" />
            )}
          </div>

          {product.variantCount > 1 ? (
            <span className="shrink-0 text-2xs text-ink-subtle">
              <bdi data-numeric="">{formatInteger(product.variantCount)}</bdi> گونه
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** The grid's loading state. Matches the card's real box, so nothing shifts. */
export function ProductCardSkeleton() {
  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <Skeleton shape="block" className="aspect-square w-full rounded-none" />
      <div className="flex flex-col gap-2 p-3 md:p-4">
        <Skeleton width="45%" height="0.75rem" />
        <Skeleton width="85%" />
        <Skeleton width="55%" height="1.1rem" />
      </div>
    </li>
  );
}

export function ProductGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ul
      className={cx(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4",
        className,
      )}
    >
      {children}
    </ul>
  );
}
