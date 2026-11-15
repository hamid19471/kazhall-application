"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId } from "react";
import type { FormEvent } from "react";

import { cx } from "@kazhal/ui";

import { productsHref } from "@/lib/routes";

import { SearchIcon } from "../icons";

/**
 * Catalogue search.
 *
 * Submitting navigates to `/products?search=…`, which is the same URL the
 * catalogue page reads its filters from — so a search is shareable, survives a
 * refresh and works with the back button, none of which is true of search state
 * held in a component.
 *
 * The server trims the term and caps it at 200 characters; this trims too, so
 * the URL never carries whitespace the API is about to discard anyway.
 */
export function SearchForm({
  className,
  autoFocus = false,
  onSubmitted,
}: {
  className?: string;
  autoFocus?: boolean;
  onSubmitted?: () => void;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("search") ?? "";
  const id = useId();

  /**
   * The field is UNCONTROLLED and keyed by the URL's own term.
   *
   * The URL is the single source of truth for a search, so mirroring it into
   * component state means keeping two copies in sync — which in practice means
   * an effect that resets the field on every navigation, one frame of stale
   * text, and a cascading render. Keying the input on `initial` makes React
   * remount it whenever the URL's term changes (back button, clicking a
   * category, clearing the filters) and lets the DOM own the typing.
   */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get("search");
    const value = typeof typed === "string" ? typed.trim().slice(0, 200) : "";
    router.push(productsHref(value === "" ? {} : { search: value }));
    onSubmitted?.();
  }

  return (
    <form role="search" onSubmit={submit} className={cx("relative w-full", className)}>
      <label htmlFor={id} className="kz-sr-only">
        جست‌وجو در محصولات
      </label>
      <input
        id={id}
        type="search"
        name="search"
        key={initial}
        defaultValue={initial}
        autoFocus={autoFocus}
        maxLength={200}
        placeholder="جست‌وجو: چادر، کیسه خواب، کوله…"
        className={cx(
          "h-11 w-full rounded-pill border border-line-strong bg-surface ps-11 pe-4 text-base text-ink",
          "placeholder:text-ink-subtle",
          "transition-[border-color] duration-150 ease-kz hover:border-ink-subtle",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--kz-focus)]",
        )}
      />
      <button
        type="submit"
        aria-label="جست‌وجو"
        className={cx(
          "absolute start-1 top-1 grid size-9 place-items-center rounded-pill text-ink-muted",
          "transition-colors duration-150 ease-kz hover:bg-surface-muted hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
        )}
      >
        <SearchIcon />
      </button>
    </form>
  );
}

/**
 * `SearchForm` behind a Suspense boundary.
 *
 * `useSearchParams()` opts its subtree out of static prerendering, and Next
 * fails the build unless that opt-out is contained by a `<Suspense>`. The
 * search box lives in the header, i.e. on EVERY page — so without this boundary
 * a single hook in one small component would make the entire storefront
 * client-rendered, including pages that are otherwise perfectly static.
 *
 * The fallback deliberately reserves the field's exact box so the header does
 * not jump when the real input arrives.
 */
export function SearchFormBoundary(props: {
  className?: string;
  autoFocus?: boolean;
  onSubmitted?: () => void;
}) {
  return (
    <Suspense
      fallback={
        <div
          aria-hidden="true"
          className={cx("h-11 w-full rounded-pill border border-line bg-surface-muted", props.className)}
        />
      }
    >
      <SearchForm {...props} />
    </Suspense>
  );
}
