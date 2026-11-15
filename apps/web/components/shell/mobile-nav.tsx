"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import type { ReactNode } from "react";

import { cx, formatInteger } from "@kazhal/ui";

import { useAppSession, useCart } from "@/components/providers";
import { BasketIcon, GridIcon, HomeIcon, UserIcon } from "@/components/icons";
import { signInHref } from "@/lib/routes";

/**
 * The mobile bottom bar.
 *
 * Hidden from `md:` up, where the header already carries the same four
 * destinations. It is a real `<nav>` with `aria-current="page"` on the active
 * item, not a row of styled divs — so a screen-reader user gets "current page"
 * instead of having to infer it from a colour.
 *
 * `pb-[env(safe-area-inset-bottom)]` keeps the row clear of the iOS home
 * indicator; the storefront layout reserves the matching space so the bar never
 * covers the last product in a list.
 */
export function MobileNav() {
  const pathname = usePathname();
  const { itemCount } = useCart();
  const { session } = useAppSession();

  return (
    <nav
      aria-label="پیمایش اصلی"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-4">
        <Item href={"/" as Route} pathname={pathname} label="خانه" icon={<HomeIcon />} exact />
        <Item href={"/products" as Route} pathname={pathname} label="کالاها" icon={<GridIcon />} />
        <Item
          href={"/cart" as Route}
          pathname={pathname}
          label="سبد"
          icon={<BasketIcon />}
          badge={itemCount}
        />
        <Item
          href={session ? ("/account" as Route) : signInHref(pathname)}
          pathname={pathname}
          label={session ? "حساب" : "ورود"}
          icon={<UserIcon />}
          matchPrefix="/account"
        />
      </ul>
    </nav>
  );
}

function Item({
  href,
  pathname,
  label,
  icon,
  badge,
  exact = false,
  matchPrefix,
}: {
  href: Route;
  pathname: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  exact?: boolean;
  matchPrefix?: string;
}) {
  const target = matchPrefix ?? href.split("?")[0] ?? href;
  const active = exact ? pathname === target : pathname === target || pathname.startsWith(`${target}/`);

  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cx(
          "relative flex flex-col items-center gap-1 py-2.5 text-2xs font-semibold no-underline",
          "transition-colors duration-150 ease-kz",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
          active ? "text-primary" : "text-ink-muted",
        )}
      >
        <span aria-hidden="true">{icon}</span>
        {label}
        {badge !== undefined && badge > 0 ? (
          <span
            data-numeric=""
            className="absolute top-1 start-[calc(50%+0.35rem)] min-w-4 rounded-pill bg-primary px-1 text-center text-[0.625rem] leading-4 font-bold text-primary-ink"
          >
            {formatInteger(badge)}
            <span className="kz-sr-only"> کالا در سبد</span>
          </span>
        ) : null}
      </Link>
    </li>
  );
}
