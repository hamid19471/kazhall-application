"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Badge, Skeleton, cx, formatInteger } from "@kazhal/ui";

import { useAppSession, useCart, useCategories } from "@/components/providers";
import { BasketIcon, CloseIcon, GridIcon, LogoMark, SearchIcon, UserIcon } from "@/components/icons";
import { SearchFormBoundary } from "@/components/shell/search-form";
import { categoryHref, signInHref } from "@/lib/routes";

/**
 * The storefront header.
 *
 * RTL notes that are easy to get wrong:
 *  - every offset is logical (`ms-`, `pe-`, `start-`), so nothing has to be
 *    mirrored by hand and nothing silently flips if the app is ever run LTR;
 *  - the category strip scrolls horizontally, which in RTL means it starts at
 *    the RIGHT edge — no `scrollLeft` maths is involved, the browser does it;
 *  - the basket count is wrapped in `<bdi>` via `formatInteger` + `dir` so the
 *    digits cannot reorder against the surrounding Persian.
 */
export function Header() {
  const pathname = usePathname();

  // The mobile search sheet must close on navigation — leaving it open over the
  // new page is the classic "I tapped a result and the overlay stayed" bug.
  // Rather than resetting it from an effect (a cascading render, and one frame
  // of stale UI), the state records WHICH page it was opened on: the moment the
  // path changes, it is no longer open.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const searchOpen = openedOn === pathname;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <p className="hidden border-b border-line/70 bg-surface-muted py-1.5 text-center text-2xs text-ink-muted md:block">
        تجهیزات کوهنوردی، شکار، کمپینگ و ماهیگیری — ارسال به سراسر ایران
      </p>

      <div className="mx-auto flex h-16 w-full max-w-[80rem] items-center gap-3 px-4 md:h-20 md:gap-6 md:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-md text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--kz-focus)]"
        >
          <LogoMark className="size-7 text-primary md:size-9" />
          <span className="flex flex-col leading-none">
            <span className="text-lg font-extrabold tracking-tight md:text-xl">کژال</span>
            <span className="hidden text-2xs font-medium text-ink-subtle md:block">
              تجهیزات طبیعت‌گردی
            </span>
          </span>
        </Link>

        <div className="hidden flex-1 md:block">
          <SearchFormBoundary />
        </div>

        <div className="ms-auto flex items-center gap-1 md:gap-2">
          <button
            type="button"
            onClick={() => setOpenedOn(searchOpen ? null : pathname)}
            aria-expanded={searchOpen}
            aria-controls="mobile-search"
            aria-label={searchOpen ? "بستن جست‌وجو" : "جست‌وجو"}
            className="grid size-11 place-items-center rounded-md text-ink-muted transition-colors duration-150 ease-kz hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)] md:hidden"
          >
            {searchOpen ? <CloseIcon /> : <SearchIcon />}
          </button>

          <AccountButton />
          <BasketButton />
        </div>
      </div>

      {searchOpen ? (
        <div id="mobile-search" className="border-t border-line px-4 py-3 md:hidden">
          <SearchFormBoundary autoFocus onSubmitted={() => setOpenedOn(null)} />
        </div>
      ) : null}

      <CategoryStrip />
    </header>
  );
}

// ---------------------------------------------------------------------------

function AccountButton() {
  const { session, isLoading } = useAppSession();
  const pathname = usePathname();

  if (isLoading) {
    return <Skeleton width="2.75rem" height="2.75rem" shape="block" className="hidden md:block" />;
  }

  if (!session) {
    return (
      <Link
        href={signInHref(pathname)}
        className={cx(
          // `min-w-11` with the existing `h-11` makes this a 44x44 tap target
          // on phones, where the label is hidden and only the icon remains.
          "flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm font-semibold text-ink md:justify-start",
          "transition-colors duration-150 ease-kz hover:bg-surface-muted",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
        )}
      >
        <UserIcon />
        <span className="hidden md:inline">ورود / ثبت‌نام</span>
        {/* The visible label is hidden on phones; keep the link named there. */}
        <span className="kz-sr-only md:hidden">ورود / ثبت‌نام</span>
      </Link>
    );
  }

  return (
    <Link
      href="/account"
      className={cx(
        "flex h-11 min-w-11 max-w-[9rem] items-center justify-center gap-2 rounded-md px-2 text-sm font-semibold text-ink md:justify-start",
        "transition-colors duration-150 ease-kz hover:bg-surface-muted",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
      )}
    >
      <UserIcon />
      <span className="hidden truncate md:inline" dir="ltr">
        {session.identifier}
      </span>
      <span className="kz-sr-only md:hidden">حساب کاربری</span>
    </Link>
  );
}

function BasketButton() {
  const { itemCount, isLoading } = useCart();

  return (
    <Link
      href="/cart"
      className={cx(
        "relative flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm font-semibold text-ink md:justify-start",
        "transition-colors duration-150 ease-kz hover:bg-surface-muted",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
      )}
    >
      <BasketIcon />
      <span className="hidden md:inline">سبد خرید</span>
      {/* An empty basket has no count badge, so on phones this is the name. */}
      <span className="kz-sr-only md:hidden">سبد خرید</span>
      {!isLoading && itemCount > 0 ? (
        <span
          className="absolute -top-0.5 start-0 min-w-5 rounded-pill bg-primary px-1 text-center text-2xs font-bold text-primary-ink"
          data-numeric=""
        >
          {formatInteger(itemCount)}
          <span className="kz-sr-only"> کالا در سبد</span>
        </span>
      ) : null}
    </Link>
  );
}

// ---------------------------------------------------------------------------

/**
 * The category nav, straight from `GET /categories`.
 *
 * Nothing here is hardcoded. If the API returns no categories the strip renders
 * a single link to the whole catalogue rather than inventing a taxonomy — a
 * fake "کوهنوردی / شکار / کمپینگ" row that 404s on click would be worse than an
 * honest empty nav.
 */
function CategoryStrip() {
  const { categories, isLoading } = useCategories();

  return (
    <nav aria-label="دسته‌بندی محصولات" className="border-t border-line bg-surface">
      <ul
        /*
         * `relative` makes this scroller a CONTAINING BLOCK. Without it an
         * absolutely positioned descendant (a visually-hidden label, a future
         * badge dot) resolves against the sticky <header> instead, escapes the
         * clip entirely, and lands at its static position — far off-screen to
         * the left in RTL — dragging a horizontal scrollbar onto the document.
         */
        className="relative mx-auto flex w-full max-w-[80rem] gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] md:px-5 [&::-webkit-scrollbar]:hidden"
      >
        <li className="shrink-0">
          <Link
            href="/products"
            /* `min-h-11` only below `md`: a 44px tap target on a phone, and the
               compact 34px strip everywhere a pointer is used. */
            className="flex min-h-11 items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm font-semibold text-ink transition-colors duration-150 ease-kz hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)] md:min-h-0"
          >
            <GridIcon className="size-4" />
            همهٔ کالاها
          </Link>
        </li>

        {isLoading
          ? Array.from({ length: 4 }, (_, index) => (
              <li key={index} className="shrink-0 py-1.5">
                <Skeleton width="6rem" height="1.5rem" shape="block" />
              </li>
            ))
          : categories.map((category) => (
              <li key={category.id} className="shrink-0">
                <Link
                  href={categoryHref(category.id)}
                  className="flex min-h-11 items-center gap-2 rounded-pill px-3 py-1.5 text-sm text-ink-muted transition-colors duration-150 ease-kz hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)] md:min-h-0"
                >
                  {category.title}
                  <Badge tone="neutral" size="sm" srLabel={`${category.productCount} کالا`}>
                    {formatInteger(category.productCount)}
                  </Badge>
                </Link>
              </li>
            ))}
      </ul>
    </nav>
  );
}
