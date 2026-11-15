"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { ProductListItem, ProductQuery, ProductSort } from "@kazhal/api-client";
import { Badge, Button, EmptyState, Input, cx, formatInteger, parseRial } from "@kazhal/ui";
import {
  useApi,
  useApiQuery,
  useRealtimeEvent,
  useRealtimeResync,
} from "@kazhal/ui/api/react";

import { Pagination, QueryBoundary } from "@/components/common";
import { ProductCard, ProductCardSkeleton, ProductGrid } from "@/components/catalog/product-card";
import { CloseIcon, SearchIcon } from "@/components/icons";
import { useCategories } from "@/components/providers";
import { productsHref } from "@/lib/routes";

/**
 * The filters this page understands. Everything else in the URL is ignored
 * rather than forwarded — the server's `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so passing an unknown key through would turn a
 * cosmetic URL typo into a 400 on the whole catalogue.
 */
/**
 * Minimum gap between two listing refetches driven by the global availability
 * broadcast. Long enough that a busy shop cannot turn the listing into a
 * treadmill, short enough that a customer watching a grid sees a sold-out badge
 * appear while they are still looking at it.
 */
const LISTING_REFRESH_FLOOR_MS = 3_000;

export interface CatalogFilters {
  page: number;
  search?: string;
  categoryId?: number;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: ProductSort;
}

const SORTS: Array<{ value: ProductSort; label: string }> = [
  { value: "newest", label: "تازه‌ترین" },
  { value: "price_asc", label: "ارزان‌ترین" },
  { value: "price_desc", label: "گران‌ترین" },
];

const PAGE_SIZE = 24;

export function CatalogView({ filters }: { filters: CatalogFilters }) {
  const api = useApi();
  const router = useRouter();
  const { categories } = useCategories();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const query = useMemo<ProductQuery>(() => {
    const q: ProductQuery = { page: filters.page, limit: PAGE_SIZE };
    if (filters.search) q.search = filters.search;
    if (filters.categoryId !== undefined) q.categoryId = filters.categoryId;
    if (filters.minPrice !== undefined) q.minPrice = filters.minPrice;
    if (filters.maxPrice !== undefined) q.maxPrice = filters.maxPrice;
    if (filters.inStockOnly) q.inStockOnly = true;
    if (filters.sort) q.sort = filters.sort;
    return q;
  }, [filters]);

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => api.catalog.listProducts(query, { signal }),
    [api, JSON.stringify(query)],
  );

  /*
   * ===========================================================================
   * LIVE AVAILABILITY ON THE LISTING — NOW TARGETED
   * ===========================================================================
   *
   * `availability:invalidated` reaches every storefront socket, anonymous
   * visitors included, and it fires for any variant in the shop. The listing
   * used to have no way to tell whether a frame concerned anything it was
   * showing: `GET /products` returns a product-level `inStock` and a
   * `variantCount`, never variant ids, so the only option was to refetch the
   * whole current page on every frame and lean on a rate floor to survive it.
   *
   * The frame now carries `productId`, so the page can ask the question it
   * could not ask before: is this product on screen? A frame for a product this
   * page is not showing costs nothing at all — no request, no floor, no
   * deferred work — which is what makes a shop-wide signal cheap rather than
   * merely survivable.
   *
   * The floor stays for the frames that DO match, because one product can have
   * several variants and a single till sale can name each of them.
   *
   * Note what is deliberately NOT done: no field of the payload is written into
   * a row. The frame carries no availability value at all now, so the old
   * hazard — collapsing a variant-level boolean into a product-level summary —
   * cannot be expressed. The refetch re-derives the summary on the server,
   * which is the only place that can compute it correctly.
   */
  const refreshListing = useThrottledRefetch(refetch, LISTING_REFRESH_FLOOR_MS);
  useRealtimeResync(refreshListing);

  /** Product ids currently rendered, so a frame can be tested against them. */
  const shownProductIds = useMemo(() => {
    const ids = new Set<number>();
    for (const product of data?.items ?? []) ids.add(product.id);
    return ids;
  }, [data]);

  useRealtimeEvent(
    "availability:invalidated",
    useCallback(
      (payload) => {
        if (shownProductIds.has(payload.productId)) refreshListing();
      },
      [shownProductIds, refreshListing],
    ),
  );

  /** Every filter change is a navigation, so the result set stays shareable. */
  const applyFilters = useCallback(
    (patch: Partial<CatalogFilters>) => {
      const next = { ...filters, ...patch };
      // Any change other than the page itself invalidates the page number:
      // staying on page 7 of a result set that now has 2 pages shows nothing.
      if (!("page" in patch)) next.page = 1;
      router.push(
        productsHref({
          search: next.search,
          categoryId: next.categoryId,
          minPrice: next.minPrice,
          maxPrice: next.maxPrice,
          inStockOnly: next.inStockOnly ? "1" : undefined,
          sort: next.sort,
          page: next.page > 1 ? next.page : undefined,
        }),
      );
    },
    [filters, router],
  );

  const activeCategory = categories.find((category) => category.id === filters.categoryId);
  const hasActiveFilters =
    filters.search !== undefined ||
    filters.categoryId !== undefined ||
    filters.minPrice !== undefined ||
    filters.maxPrice !== undefined ||
    Boolean(filters.inStockOnly);

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-8">
      <div className="lg:sticky lg:top-44 lg:self-start">
        <Button
          variant="secondary"
          size="sm"
          fullWidth
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          aria-controls="catalog-filters"
          className="lg:hidden"
        >
          {filtersOpen ? "بستن فیلترها" : "فیلترها و مرتب‌سازی"}
        </Button>

        <div
          id="catalog-filters"
          className={cx("mt-3 lg:mt-0 lg:block", filtersOpen ? "block" : "hidden")}
        >
          <FilterPanel
            filters={filters}
            categories={categories}
            onApply={applyFilters}
            hasActiveFilters={hasActiveFilters}
          />
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted" aria-live="polite">
            {isLoading ? (
              "در حال جست‌وجو…"
            ) : data ? (
              <>
                <bdi data-numeric="">{formatInteger(data.pageInfo.total)}</bdi> کالا
                {activeCategory ? <> در «{activeCategory.title}»</> : null}
                {filters.search ? <> برای «{filters.search}»</> : null}
              </>
            ) : null}
          </p>

          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <span>مرتب‌سازی</span>
            <select
              value={filters.sort ?? "newest"}
              onChange={(event) => applyFilters({ sort: event.target.value as ProductSort })}
              className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--kz-focus)]"
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {hasActiveFilters ? (
          <ActiveFilterChips
            filters={filters}
            categoryTitle={activeCategory?.title}
            onApply={applyFilters}
          />
        ) : null}

        <QueryBoundary
          isLoading={isLoading}
          error={error}
          data={data}
          onRetry={refetch}
          label="در حال بارگذاری کالاها"
          skeleton={
            <ProductGrid>
              {Array.from({ length: 8 }, (_, index) => (
                <ProductCardSkeleton key={index} />
              ))}
            </ProductGrid>
          }
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              icon={<SearchIcon className="size-8" />}
              title="کالایی با این فیلترها پیدا نشد"
              description="می‌توانید عبارت جست‌وجو را کوتاه‌تر کنید یا یکی از فیلترها را بردارید."
              action={
                hasActiveFilters ? (
                  <Link href={productsHref()} className="no-underline">
                    <span className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3 text-sm font-semibold text-ink">
                      حذف همهٔ فیلترها
                    </span>
                  </Link>
                ) : undefined
              }
            />
          }
        >
          {(page) => (
            <>
              <ProductGrid>
                {page.items.map((product: ProductListItem, index: number) => (
                  <ProductCard key={product.id} product={product} priority={index < 4} />
                ))}
              </ProductGrid>

              <Pagination
                className="mt-8"
                pageInfo={page.pageInfo}
                buildHref={(target) =>
                  productsHref({
                    search: filters.search,
                    categoryId: filters.categoryId,
                    minPrice: filters.minPrice,
                    maxPrice: filters.maxPrice,
                    inStockOnly: filters.inStockOnly ? "1" : undefined,
                    sort: filters.sort,
                    page: target > 1 ? target : undefined,
                  })
                }
              />
            </>
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FilterPanel({
  filters,
  categories,
  onApply,
  hasActiveFilters,
}: {
  filters: CatalogFilters;
  categories: Array<{ id: number; title: string; productCount: number }>;
  onApply: (patch: Partial<CatalogFilters>) => void;
  hasActiveFilters: boolean;
}) {
  const [minText, setMinText] = useState(filters.minPrice?.toString() ?? "");
  const [maxText, setMaxText] = useState(filters.maxPrice?.toString() ?? "");

  function submitPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Persian digits are normalized back to ASCII before parsing, so a customer
    // typing ۵۰۰۰۰۰ gets the same filter as one typing 500000.
    const min = parseRial(minText);
    const max = parseRial(maxText);
    onApply({
      minPrice: min !== null && min >= 0 ? min : undefined,
      maxPrice: max !== null && max >= 0 ? max : undefined,
    });
  }

  return (
    <div className="space-y-6 rounded-lg border border-line bg-surface p-4">
      <fieldset>
        <legend className="mb-3 text-sm font-bold text-ink">دسته‌بندی</legend>
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              onClick={() => onApply({ categoryId: undefined })}
              aria-pressed={filters.categoryId === undefined}
              className={cx(
                "w-full rounded-md px-2 py-1.5 text-start text-sm transition-colors duration-150 ease-kz",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                filters.categoryId === undefined
                  ? "bg-primary-soft font-semibold text-primary"
                  : "text-ink-muted hover:bg-surface-muted",
              )}
            >
              همهٔ دسته‌ها
            </button>
          </li>
          {categories.map((category) => (
            <li key={category.id}>
              <button
                type="button"
                onClick={() => onApply({ categoryId: category.id })}
                aria-pressed={filters.categoryId === category.id}
                className={cx(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors duration-150 ease-kz",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                  filters.categoryId === category.id
                    ? "bg-primary-soft font-semibold text-primary"
                    : "text-ink-muted hover:bg-surface-muted",
                )}
              >
                <span className="truncate">{category.title}</span>
                <bdi data-numeric="" className="shrink-0 text-2xs text-ink-subtle">
                  {formatInteger(category.productCount)}
                </bdi>
              </button>
            </li>
          ))}
          {categories.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-ink-subtle">دسته‌بندی‌ای ثبت نشده است.</li>
          ) : null}
        </ul>
      </fieldset>

      <form onSubmit={submitPrice} className="space-y-3 border-t border-line pt-4">
        <p className="text-sm font-bold text-ink">محدودهٔ قیمت (ریال)</p>
        <Input
          label="از"
          numeric
          value={minText}
          onChange={(event) => setMinText(event.target.value)}
          placeholder="۰"
          className="h-9 text-sm"
        />
        <Input
          label="تا"
          numeric
          value={maxText}
          onChange={(event) => setMaxText(event.target.value)}
          placeholder="بدون سقف"
          className="h-9 text-sm"
        />
        <Button type="submit" variant="secondary" size="sm" fullWidth>
          اعمال قیمت
        </Button>
      </form>

      <div className="border-t border-line pt-4">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={Boolean(filters.inStockOnly)}
            onChange={(event) => onApply({ inStockOnly: event.target.checked })}
            className="size-4 accent-[color:var(--kz-primary)]"
          />
          فقط کالاهای موجود
        </label>
        <p className="mt-1.5 text-2xs leading-relaxed text-ink-subtle">
          موجودی در فهرست، تقریبی است و رزروهای فعال دیگران را کسر نمی‌کند.
        </p>
      </div>

      {hasActiveFilters ? (
        <Link href={productsHref()} className="block no-underline">
          <span className="flex h-9 w-full items-center justify-center rounded-md border border-line-strong bg-surface text-sm font-semibold text-ink">
            حذف همهٔ فیلترها
          </span>
        </Link>
      ) : null}
    </div>
  );
}

function ActiveFilterChips({
  filters,
  categoryTitle,
  onApply,
}: {
  filters: CatalogFilters;
  categoryTitle?: string;
  onApply: (patch: Partial<CatalogFilters>) => void;
}) {
  const chips: Array<{ key: string; label: string; clear: Partial<CatalogFilters> }> = [];
  if (filters.search) {
    chips.push({ key: "search", label: `جست‌وجو: ${filters.search}`, clear: { search: undefined } });
  }
  if (categoryTitle) {
    chips.push({ key: "category", label: categoryTitle, clear: { categoryId: undefined } });
  }
  if (filters.minPrice !== undefined) {
    chips.push({
      key: "min",
      label: `از ${formatInteger(filters.minPrice)} ریال`,
      clear: { minPrice: undefined },
    });
  }
  if (filters.maxPrice !== undefined) {
    chips.push({
      key: "max",
      label: `تا ${formatInteger(filters.maxPrice)} ریال`,
      clear: { maxPrice: undefined },
    });
  }
  if (filters.inStockOnly) {
    chips.push({ key: "stock", label: "فقط موجود", clear: { inStockOnly: false } });
  }

  if (chips.length === 0) return null;

  return (
    <ul className="mb-4 flex flex-wrap gap-2">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            type="button"
            onClick={() => onApply(chip.clear)}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
          >
            <Badge tone="primary">
              <span className="flex items-center gap-1">
                {chip.label}
                <CloseIcon className="size-3" />
                <span className="kz-sr-only">حذف این فیلتر</span>
              </span>
            </Badge>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * `refetch`, but never more often than `floorMs`, and never dropping a signal.
 *
 * A signal inside the window arms a single deferred refetch at the window's
 * edge; further signals before then fold into that same one. The FIRST signal
 * after a quiet period is not delayed at all, so a shop with one sale an hour
 * still updates instantly.
 *
 * This is the listing's counterpart to the basket's authoritative channel. The
 * basket needs ordering guarantees because it renders state a mutation can race;
 * a listing only ever re-reads a query it owns, and `useApiQuery` already aborts
 * the previous run on every re-run, so all that is missing here is the floor.
 */
function useThrottledRefetch(refetch: () => void, floorMs: number): () => void {
  const refetchRef = useRef(refetch);
  // Synced in an EFFECT, never during render: writing a ref while rendering is
  // the pattern that makes a component observe a value React has not committed.
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  const lastRunRef = useRef(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    },
    [],
  );

  return useCallback(() => {
    if (timerRef.current !== undefined) return; // already folded into a pending run
    const wait = floorMs - (Date.now() - lastRunRef.current);
    if (wait <= 0) {
      lastRunRef.current = Date.now();
      refetchRef.current();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      lastRunRef.current = Date.now();
      refetchRef.current();
    }, wait);
  }, [floorMs]);
}
