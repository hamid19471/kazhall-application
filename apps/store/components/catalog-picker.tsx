"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Badge, Button, Card, Money, Skeleton, cx, formatInteger } from "@kazhal/ui";
import { useApi, useApiQuery, useRealtimeEvent, useRealtimeResync } from "@kazhal/ui/api/react";

import { BoxIcon, CloseIcon, SearchIcon } from "./icons";
import {
  browseCatalog,
  listCategories,
  type CatalogProduct,
  type CatalogVariant,
  type PosCategory,
} from "../lib/catalog";

const PAGE_SIZE = 24;
/** Minimum gap between two catalogue re-reads driven by a realtime frame. */
const CATALOG_RELOAD_FLOOR_MS = 3_000;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Does the search term look like a product CODE rather than a product name?
 *
 * Conservative on purpose: it gates one extra HTTP read that only matters when
 * the catalogue found nothing, so a false negative costs a slightly vaguer
 * message and a false positive costs a wasted 404. ASCII, no whitespace, at
 * least three characters — a Persian title cannot match it.
 */
const LOOKS_LIKE_SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/;

export interface CatalogPickerProps {
  /** Called with the exact variant the cashier chose. Never a bare product. */
  onAdd: (product: CatalogProduct, variant: CatalogVariant) => void;
  /** Quantities already in the basket, so a tile can show what is committed. */
  basketByVariant: ReadonlyMap<number, number>;
  disabled?: boolean;
  /**
   * Changing this re-reads the catalogue.
   *
   * The till bumps it after a REFUSED sale — the one reconciliation no event
   * can drive, because a rolled-back transaction correctly announces nothing.
   */
  reloadToken?: number;
}

/**
 * The till's product catalogue — the PRIMARY way a sale starts.
 *
 * The shop has no barcode scanner, so nothing here asks the cashier to know a
 * code. They look, they search, they tap. SKU is still shown (it is what is
 * printed on the shelf label) and is still searchable, but it is never required.
 *
 * WHAT THE SERVER OWNS. Every product, category, price, attribute and stock
 * number comes from `GET /inventory/catalog` and `GET /categories`. Nothing is
 * hardcoded, and `availableForPos` is rendered exactly as received — it is
 * INDICATIVE, and `POST /orders/pos` remains the only authority on whether a
 * sale happens.
 */
export function CatalogPicker({
  onAdd,
  basketByVariant,
  disabled = false,
  reloadToken = 0,
}: CatalogPickerProps) {
  const api = useApi();
  const searchId = useId();

  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  /*
   * Changing a filter resets the page, and it happens HERE rather than in an
   * effect watching the filters. Staying on page 4 of a result set that now has
   * one page shows an empty grid — but a `setPage` inside an effect is a
   * cascading render, and React's own guidance is to adjust state in the event
   * that caused it. These two helpers are that event.
   */
  const changeSearch = useCallback((value: string) => {
    setTerm(value);
    setPage(1);
  }, []);

  const changeCategory = useCallback((value: number | null) => {
    setCategoryId(value);
    setPage(1);
  }, []);

  const [categories, setCategories] = useState<PosCategory[]>([]);
  const [picking, setPicking] = useState<CatalogProduct | null>(null);

  /*
   * Debounce the REMOTE query, not the input. The box stays fully responsive
   * while `debounced` lags behind it, so a cashier never types into a field
   * that feels stuck.
   */
  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [term]);

  /*
   * STALE RESPONSES CANNOT WIN. `useApiQuery` hands every run its own
   * `AbortController` and aborts the previous one whenever the dependencies
   * change, so a slow request for "کو" is cancelled the moment "کوله" is typed
   * — the older response never arrives at all, rather than arriving late and
   * overwriting the newer one. That is a stronger guarantee than comparing
   * sequence numbers after the fact, and it is the hook the rest of this
   * codebase already fetches with.
   */
  const query = useApiQuery(
    (signal) =>
      browseCatalog(
        api,
        {
          page,
          limit: PAGE_SIZE,
          ...(debounced !== "" ? { search: debounced } : {}),
          ...(categoryId !== null ? { categoryId } : {}),
        },
        { signal },
      ),
    [api, page, debounced, categoryId, reloadToken],
  );

  const products = query.data?.data ?? [];

  /*
   * WHEN THE SEARCH FINDS NOTHING, SAY WHETHER THE SKU IS RETIRED.
   *
   * The POS catalogue excludes inactive variants — including from its SKU
   * search — and must keep doing so: nothing unsellable should be offerable.
   * The side effect was that typing a retired SKU produced the same empty grid
   * as a typo, so a cashier holding the box in their hand was told "try
   * another term".
   *
   * `GET /inventory/lookup` is the endpoint that answers this question, and it
   * is read-capable for a retired SKU on purpose. It is consulted ONLY when
   * the catalogue came back empty and the term looks like a code rather than a
   * product name, so an ordinary search costs no extra request.
   *
   * It is a MESSAGE, not a way in: the variant is not added to the grid and
   * cannot be tapped. The server refuses the sale regardless.
   */
  const catalogueEmpty =
    !query.isLoading && products.length === 0 && debounced !== "";
  const probeSku = catalogueEmpty && LOOKS_LIKE_SKU.test(debounced);
  const skuProbe = useApiQuery(
    (signal) => api.inventory.lookupSku(debounced, { signal }),
    [api, debounced],
    { enabled: probeSku },
  );
  /*
   * Only the `variant_inactive` answer is surfaced. A SKU that exists, is
   * active and merely has no units left is already excluded from the POS
   * catalogue by the same `inStock` rule every other tile obeys, and saying
   * "retired" about it would be wrong.
   */
  const retiredSku =
    probeSku && skuProbe.data?.unsellableReason === "variant_inactive"
      ? skuProbe.data
      : null;
  const total = query.data?.total ?? 0;
  const totalPages = query.data?.totalPages ?? 0;
  const loading = query.isLoading;
  // The server's own messages are English and often internal; a cashier gets
  // one Persian sentence and a retry, never a raw API error.
  const failed = query.error !== undefined;
  const reload = query.refetch;

  useEffect(() => {
    let alive = true;
    listCategories(api)
      .then((rows) => {
        if (alive) setCategories(rows);
      })
      .catch(() => {
        // A missing filter bar is survivable; a blocked catalogue is not.
        if (alive) setCategories([]);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  /*
   * Stock moves under the till: an online checkout, another terminal, or an
   * administrator correcting a count. Every path does the same thing — re-read,
   * never trust the frame.
   *
   * BOTH events are needed, and not for redundancy. `stock:updated` is scoped
   * to `admins` ∪ `branch:<id>`, so a change carrying no branch — an admin
   * adjustment, a lapsed reservation — never reaches this socket.
   * `availability:updated` is the global broadcast and does.
   *
   * The reload is rate-floored because that global broadcast fires for every
   * variant in the shop, and this grid shows twenty-four of them at a time with
   * no way to know which. A signal inside the window is deferred to its edge
   * rather than dropped, so the grid still converges; it just cannot be turned
   * into a treadmill by a busy afternoon.
   */
  const reloadThrottled = useThrottledReload(reload, CATALOG_RELOAD_FLOOR_MS);
  /*
   * THE RECONNECT GOES THROUGH THE SAME FLOOR, which is the opposite of what
   * it looks like.
   *
   * A reconnect resync used to call `reload()` directly, to be "immediate".
   * But the direct call did not record that a reload had just run, so a frame
   * arriving in the same moment — and a reconnect is precisely when a backlog
   * of frames arrives — saw an empty window and reloaded again. One reconnect
   * plus one event meant two full catalogue page reads, and a flapping socket
   * multiplied that per flap.
   *
   * Routing it through the floor costs nothing in the case that matters: the
   * poller's grace period means the socket has been down for seconds, so the
   * window has long since elapsed and the throttle reloads IMMEDIATELY. The
   * only case it defers is a reconnect within 3 s of a reload that has already
   * just brought the grid up to date, which is the storm this is meant to
   * prevent. `apps/web/components/catalog/catalog-view.tsx` has always done it
   * this way; this was the copy that drifted.
   */
  useRealtimeResync(() => reloadThrottled());
  useRealtimeEvent("stock:updated", () => reloadThrottled());
  // The STAFF availability channel, not the shopper's. A basket reservation
  // cannot change what this grid may sell, so it never reaches here.
  useRealtimeEvent("pos:availability:invalidated", () => reloadThrottled());

  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  return (
    <section aria-labelledby="catalog-heading" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="catalog-heading" className="text-xl text-ink">
          انتخاب کالا
        </h2>
        <p className="text-sm text-ink-muted" aria-live="polite">
          {loading
            ? "در حال بارگذاری…"
            : total === 0
              ? "کالایی برای نمایش نیست"
              : `نمایش ${formatInteger(showingFrom)} تا ${formatInteger(showingTo)} از ${formatInteger(total)} کالا`}
        </p>
      </div>

      {/* ------------------------------- search ------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={searchId} className="text-sm font-medium text-ink">
          جست‌وجوی کالا
        </label>
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-ink-subtle"
          >
            <SearchIcon className="size-5" />
          </span>
          <input
            id={searchId}
            type="search"
            value={term}
            disabled={disabled}
            onChange={(event) => changeSearch(event.target.value)}
            // The catalogue search now matches «کد محصول» and «کد گونه» as well
            // as the SKU, and a cashier holding a box will only type the code
            // printed on it if the field says the code is accepted.
            placeholder="نام کالا، کد محصول، کد گونه، کد کالا یا ویژگی (مثلاً رنگ)"
            className={cx(
              "h-13 w-full rounded-md border border-line-strong bg-surface ps-11 pe-11 text-base text-ink",
              "placeholder:text-ink-subtle",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--kz-focus)]",
              "disabled:cursor-not-allowed disabled:bg-surface-muted",
            )}
          />
          {term !== "" ? (
            <button
              type="button"
              onClick={() => changeSearch("")}
              aria-label="پاک کردن جست‌وجو"
              className="absolute inset-y-0 end-1 my-auto flex size-11 items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
            >
              <CloseIcon className="size-5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* ----------------------------- categories ----------------------------- */}
      <div>
        <h3 className="kz-sr-only" id="category-heading">
          دسته‌بندی‌ها
        </h3>
        {/*
          The ONLY element allowed to scroll sideways. The page itself must
          never develop horizontal overflow, so the strip is a scroll container
          AND a containing block — an absolutely positioned descendant that
          escaped it would drag a scrollbar onto the document, which in RTL
          appears on the left.
        */}
        <ul
          aria-labelledby="category-heading"
          className="relative flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
        >
          <li className="shrink-0">
            <CategoryChip
              active={categoryId === null}
              disabled={disabled}
              onClick={() => changeCategory(null)}
            >
              همهٔ کالاها
            </CategoryChip>
          </li>
          {categories.map((category) => (
            <li key={category.id} className="shrink-0">
              <CategoryChip
                active={categoryId === category.id}
                disabled={disabled}
                onClick={() => changeCategory(category.id)}
              >
                {category.title}
              </CategoryChip>
            </li>
          ))}
        </ul>
      </div>

      {/* ------------------------------- results ------------------------------ */}
      {failed ? (
        <Card tone="outlined" padding="md" role="alert" className="border-danger">
          <p className="text-ink">فهرست کالاها بارگذاری نشد.</p>
          <p className="mt-1 text-sm text-ink-muted">
            اتصال صندوق را بررسی کنید و دوباره تلاش کنید.
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => reload()}>
            تلاش دوباره
          </Button>
        </Card>
      ) : loading && products.length === 0 ? (
        <div
          role="status"
          aria-busy="true"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
        >
          <span className="kz-sr-only">در حال بارگذاری کالاها</span>
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} shape="block" height="11rem" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line px-6 py-14 text-center">
          <span aria-hidden="true" className="text-ink-subtle">
            <BoxIcon className="size-9" />
          </span>
          <p className="text-lg font-semibold text-ink">
            {retiredSku ? "این کالا غیرفعال است" : "کالایی پیدا نشد"}
          </p>
          <p className="max-w-prose text-sm text-ink-muted">
            {retiredSku ? (
              <>
                «{retiredSku.productTitle}» با کد{" "}
                <span dir="ltr" data-numeric="">
                  {retiredSku.sku}
                </span>{" "}
                غیرفعال شده است و فروش آن ممکن نیست. تا زمانی که مدیر آن را فعال
                نکند، این کالا در فهرست فروش نمایش داده نمی‌شود.
              </>
            ) : debounced !== "" ? (
              "عبارت دیگری را امتحان کنید یا دسته‌بندی را تغییر دهید."
            ) : (
              "در این دسته‌بندی کالایی برای فروش ثبت نشده است."
            )}
          </p>
          {debounced !== "" || categoryId !== null ? (
            <Button
              variant="secondary"
              onClick={() => {
                changeSearch("");
                changeCategory(null);
              }}
            >
              نمایش همهٔ کالاها
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
            <ProductTile
              key={product.id}
              product={product}
              disabled={disabled}
              inBasket={product.variants.reduce(
                (sum, variant) => sum + (basketByVariant.get(variant.id) ?? 0),
                0,
              )}
              onPick={() => {
                const sellable = product.variants.filter((v) => v.inStock);
                // One sellable variant and no ambiguity: add it straight away.
                // Anything else must be chosen explicitly — a till may never
                // guess which variant the customer is holding.
                if (product.variants.length === 1 && sellable.length === 1) {
                  onAdd(product, sellable[0]!);
                  return;
                }
                setPicking(product);
              }}
            />
          ))}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav aria-label="صفحه‌بندی کالاها" className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            صفحهٔ قبل
          </Button>
          <span className="text-sm text-ink-muted">
            صفحهٔ {formatInteger(page)} از {formatInteger(totalPages)}
          </span>
          <Button
            variant="secondary"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            صفحهٔ بعد
          </Button>
        </nav>
      ) : null}

      {picking ? (
        <VariantDialog
          product={picking}
          onClose={() => setPicking(null)}
          onConfirm={(variant) => {
            onAdd(picking, variant);
            setPicking(null);
          }}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function CategoryChip({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cx(
        "inline-flex h-11 items-center whitespace-nowrap rounded-pill border px-4 text-sm font-semibold transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
        "disabled:cursor-not-allowed disabled:opacity-55",
        active
          ? "border-primary bg-primary text-primary-ink"
          : "border-line-strong bg-surface text-ink hover:bg-surface-muted",
      )}
    >
      {children}
    </button>
  );
}

function ProductTile({
  product,
  inBasket,
  disabled,
  onPick,
}: {
  product: CatalogProduct;
  inBasket: number;
  disabled: boolean;
  onPick: () => void;
}) {
  const multi = product.variants.length > 1;
  const ranged =
    product.effectivePrice !== null &&
    product.maxEffectivePrice !== null &&
    product.maxEffectivePrice > product.effectivePrice;
  const posStock = product.variants.reduce((sum, v) => sum + v.availableForPos, 0);
  const low = product.inStock && posStock > 0 && posStock <= 3;

  return (
    <Card as="li" tone="outlined" padding="none" className="flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={onPick}
        disabled={disabled || !product.inStock}
        className={cx(
          "flex h-full flex-col gap-2 p-3 text-start transition-colors",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
          product.inStock ? "hover:bg-surface-muted" : "cursor-not-allowed opacity-60",
        )}
      >
        <span className="flex items-start gap-2.5">
          {/*
            A COMPACT thumbnail, not a hero image. Most of this catalogue has no
            photograph yet, and a full-bleed placeholder on every tile would
            halve the number of products a cashier can see at once — which is
            the one thing a counter cannot afford. `alt=""` because the title
            sits right beside it; announcing the picture too would read the
            product twice.
          */}
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-muted text-ink-subtle"
          >
            {product.primaryImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.primaryImage.url}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
            ) : (
              <BoxIcon className="size-6" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block line-clamp-2 text-sm font-semibold text-ink">
              {product.title}
            </span>
            {/*
              «کد محصول» under the title — the string a cashier searches by and
              the one printed on the shelf label. Rendered only when the
              catalogue sent it; never derived from anything else on the tile.
            */}
            {product.productCode ? (
              <span
                dir="ltr"
                data-numeric=""
                className="mt-0.5 block truncate text-2xs text-ink-subtle"
              >
                {product.productCode}
              </span>
            ) : null}
          </span>
          {inBasket > 0 ? (
            <Badge tone="primary" size="sm" srLabel={`${inBasket} عدد در سبد`}>
              {formatInteger(inBasket)}
            </Badge>
          ) : null}
        </span>

        <span className="mt-auto flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          {product.effectivePrice === null ? (
            <span className="text-sm text-ink-subtle">قیمت ثبت نشده</span>
          ) : (
            <>
              {ranged ? <span className="text-2xs text-ink-subtle">از</span> : null}
              <Money value={product.effectivePrice} className="text-base font-bold text-ink" />
            </>
          )}
        </span>

        <span className="flex flex-wrap items-center gap-1.5">
          {!product.inStock ? (
            <Badge tone="danger" size="sm">
              ناموجود
            </Badge>
          ) : low ? (
            <Badge tone="warning" size="sm">
              موجودی کم: {formatInteger(posStock)}
            </Badge>
          ) : (
            <Badge tone="neutral" size="sm">
              موجودی: {formatInteger(posStock)}
            </Badge>
          )}
          {multi ? (
            <Badge tone="info" size="sm">
              {formatInteger(product.variants.length)} گونه
            </Badge>
          ) : null}
        </span>
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------

/**
 * The variant chooser.
 *
 * It lists the product's ACTIVE variants and makes the cashier pick one before
 * anything reaches the basket. Each row states its own attributes by their real
 * axis names, its SKU and its sellable stock, so "the navy 50-litre one" is
 * distinguishable from "the black 70-litre one" without reading a code.
 *
 * A modal, not an inline expander: at a counter the choice must be the only
 * thing on screen, and Escape must always get you out.
 */
function VariantDialog({
  product,
  onClose,
  onConfirm,
}: {
  product: CatalogProduct;
  onClose: () => void;
  onConfirm: (variant: CatalogVariant) => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Focus moves into the dialog so a keyboard user is not left behind on the
    // grid, and so Escape is heard.
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chosen = product.variants.find((v) => v.id === selected) ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-xl bg-surface shadow-raised outline-none sm:rounded-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line p-4">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg text-ink">
              انتخاب گونهٔ کالا
            </h3>
            <p className="mt-0.5 truncate text-sm text-ink-muted">{product.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
          >
            <CloseIcon className="size-5" />
          </button>
        </div>

        <fieldset className="min-h-0 flex-1 overflow-y-auto p-4">
          <legend className="kz-sr-only">گونه‌های موجود</legend>
          <ul className="flex flex-col gap-2">
            {product.variants.map((variant) => {
              const active = selected === variant.id;
              return (
                <li key={variant.id}>
                  <label
                    className={cx(
                      "flex cursor-pointer items-start gap-3 rounded-md border-2 p-3 transition-colors",
                      active
                        ? "border-primary bg-primary-soft"
                        : "border-line-strong bg-surface hover:bg-surface-muted",
                      !variant.inStock && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="variant"
                      className="mt-1 size-5 accent-[color:var(--kz-primary)]"
                      checked={active}
                      disabled={!variant.inStock}
                      onChange={() => setSelected(variant.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {variant.attributeValues.length > 0 ? (
                          variant.attributeValues.map((value) => (
                            <span key={value.id} className="text-sm">
                              {value.attribute ? (
                                <span className="text-ink-subtle">{value.attribute.name}: </span>
                              ) : null}
                              <span className="font-semibold text-ink">{value.value}</span>
                            </span>
                          ))
                        ) : (
                          <span className="text-sm font-semibold text-ink">گونهٔ استاندارد</span>
                        )}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                        <span dir="ltr" data-numeric="">
                          {variant.sku}
                        </span>
                        {/*
                          «کد گونه» next to the SKU. They are different strings
                          for the same variant — ours and the warehouse's — so
                          this one is labelled and only appears when the
                          catalogue actually sent it.
                        */}
                        {variant.variantCode ? (
                          <span>
                            کد گونه:{" "}
                            <span dir="ltr" data-numeric="">
                              {variant.variantCode}
                            </span>
                          </span>
                        ) : null}
                        {variant.inStock ? (
                          <Badge tone={variant.availableForPos <= 3 ? "warning" : "neutral"} size="sm">
                            موجودی: {formatInteger(variant.availableForPos)}
                          </Badge>
                        ) : (
                          <Badge tone="danger" size="sm">
                            ناموجود
                          </Badge>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-base font-bold text-ink">
                      {variant.price === null ? (
                        <span className="text-sm text-ink-subtle">—</span>
                      ) : (
                        <Money value={variant.price} />
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="flex flex-wrap gap-3 border-t border-line p-4">
          <Button
            size="lg"
            className="flex-1"
            disabled={chosen === null || !chosen.inStock}
            onClick={() => chosen && onConfirm(chosen)}
          >
            {chosen === null ? "ابتدا گونه را انتخاب کنید" : "افزودن به سبد"}
          </Button>
          <Button size="lg" variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * `reload`, but never more often than `floorMs`, and never dropping a signal.
 *
 * The first frame after a quiet period reloads immediately; frames inside the
 * window fold into one reload at its edge. A till that sees no traffic for a
 * minute still updates the instant something happens.
 */
function useThrottledReload(reload: () => void, floorMs: number): () => void {
  const reloadRef = useRef(reload);
  // Synced in an EFFECT, never during render: writing a ref while rendering is
  // the pattern that makes a component observe a value React has not committed.
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
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
    if (timerRef.current !== undefined) return;
    const wait = floorMs - (Date.now() - lastRunRef.current);
    if (wait <= 0) {
      lastRunRef.current = Date.now();
      reloadRef.current();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      lastRunRef.current = Date.now();
      reloadRef.current();
    }, wait);
  }, [floorMs]);
}
