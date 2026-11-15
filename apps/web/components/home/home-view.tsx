"use client";

import Link from "next/link";

import { Button, EmptyState, ErrorState, cx, formatInteger } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { ProductCard, ProductCardSkeleton, ProductGrid } from "@/components/catalog/product-card";
import { QueryBoundary } from "@/components/common";
import { BoxIcon, ChevronEndIcon, CompassIcon } from "@/components/icons";
import { useCategories } from "@/components/providers";
import { categoryHref, productsHref } from "@/lib/routes";

/**
 * The home page.
 *
 * Two rules shaped everything here:
 *
 *  1. **No invented catalogue.** The category tiles and the product rows come
 *     from `GET /categories` and `GET /products`. If the shop has no products,
 *     this page says so instead of rendering placeholder cards — a storefront
 *     that looks stocked while the API returns nothing is the single most
 *     misleading thing a demo can do.
 *  2. **No unbacked promises.** The hero sells what the system actually does:
 *     a live catalogue, a four-hour stock hold, and a payment that is only
 *     called successful after verification.
 */
export function HomeView() {
  return (
    <>
      <Hero />
      <CategoryTiles />
      <NewestProducts />
    </>
  );
}

function Hero() {
  return (
    <section className="border-b border-line bg-surface-muted">
      <div className="mx-auto grid w-full max-w-[80rem] gap-8 px-4 py-12 md:grid-cols-[1.2fr_1fr] md:items-center md:px-6 md:py-20">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-primary">
            <CompassIcon className="size-5" />
            تجهیز برای بیرون از شهر
          </p>
          <h1 className="mt-4 text-display leading-tight font-extrabold text-ink">
            کوهنوردی، شکار، کمپینگ و ماهیگیری
          </h1>
          <p className="mt-4 max-w-prose text-lg leading-relaxed text-ink-muted">
            چادر، کیسه خواب، کوله‌پشتی، پوشاک و لوازم سفر — با موجودی زنده و رزرو چهارساعتهٔ سبد،
            تا وقتی تصمیم می‌گیرید، کالا برای شما کنار گذاشته می‌شود.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/products" className="no-underline">
              <Button size="lg" trailingIcon={<ChevronEndIcon className="size-5" />}>
                دیدن همهٔ کالاها
              </Button>
            </Link>
          </div>
        </div>

        <TopographyPanel />
      </div>
    </section>
  );
}

/**
 * A decorative contour panel.
 *
 * Pure SVG on `currentColor`, so it inherits whatever the palette currently is
 * and needs no image asset, no remote host and no `next/image` configuration.
 * `aria-hidden`, because it means nothing.
 */
function TopographyPanel() {
  return (
    <div className="relative hidden aspect-4/3 overflow-hidden rounded-xl border border-line bg-surface md:block">
      <svg
        aria-hidden="true"
        viewBox="0 0 400 300"
        className="absolute inset-0 size-full text-accent opacity-45"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        {Array.from({ length: 9 }, (_, index) => (
          <path
            key={index}
            d={`M-20 ${250 - index * 26} C 60 ${210 - index * 26}, 120 ${
              280 - index * 26
            }, 200 ${232 - index * 26} S 340 ${190 - index * 26}, 420 ${238 - index * 26}`}
          />
        ))}
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 400 300"
        className="absolute inset-0 size-full text-primary"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      >
        <path d="M40 250 L150 90 L205 170 L245 118 L360 250 Z" />
        <path d="M118 150 h64" strokeWidth="3" />
      </svg>
    </div>
  );
}

function CategoryTiles() {
  const { categories, isLoading, error, refresh } = useCategories();

  return (
    <section className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-xl text-ink">دسته‌بندی‌ها</h2>
        <Link href="/products" className="text-sm">
          همهٔ کالاها
        </Link>
      </div>

      {error ? (
        <ErrorState className="mt-5" error={error} onRetry={refresh} />
      ) : isLoading ? (
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="kz-shimmer h-24 rounded-lg" aria-hidden="true" />
          ))}
        </ul>
      ) : categories.length === 0 ? (
        <EmptyState
          className="mt-5"
          icon={<BoxIcon className="size-8" />}
          title="هنوز دسته‌بندی‌ای ثبت نشده است"
          description="به‌محض افزوده‌شدن دسته‌بندی‌ها، همین‌جا نمایش داده می‌شوند."
        />
      ) : (
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {categories.map((category) => (
            <li key={category.id}>
              <Link
                href={categoryHref(category.id)}
                className={cx(
                  "flex h-24 flex-col justify-between rounded-lg border border-line bg-surface p-4 no-underline",
                  "transition-shadow duration-200 ease-kz hover:shadow-raised",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                )}
              >
                <span className="font-bold text-ink">{category.title}</span>
                <span className="text-xs text-ink-subtle">
                  <bdi data-numeric="">{formatInteger(category.productCount)}</bdi> کالا
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewestProducts() {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => api.catalog.listProducts({ page: 1, limit: 8, sort: "newest" }, { signal }),
    [api],
  );

  return (
    <section className="mx-auto w-full max-w-[80rem] px-4 pb-14 md:px-6">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-xl text-ink">تازه‌ترین کالاها</h2>
        <Link href={productsHref({ sort: "newest" })} className="text-sm">
          دیدن همه
        </Link>
      </div>

      <div className="mt-5">
        <QueryBoundary
          isLoading={isLoading}
          error={error}
          data={data}
          onRetry={refetch}
          label="در حال بارگذاری تازه‌ترین کالاها"
          skeleton={
            <ProductGrid>
              {Array.from({ length: 4 }, (_, index) => (
                <ProductCardSkeleton key={index} />
              ))}
            </ProductGrid>
          }
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              icon={<BoxIcon className="size-8" />}
              title="هنوز کالایی در فروشگاه ثبت نشده است"
              description="فهرست کالاها مستقیماً از انبار خوانده می‌شود؛ به‌محض ثبت اولین کالا اینجا دیده می‌شود."
            />
          }
        >
          {(page) => (
            <ProductGrid>
              {page.items.map((product, index) => (
                <ProductCard key={product.id} product={product} priority={index < 4} />
              ))}
            </ProductGrid>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
