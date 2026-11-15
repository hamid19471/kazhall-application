"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { ApiError, PageInfo } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Spinner, cx, formatInteger } from "@kazhal/ui";

import { useAppSession } from "@/components/providers";
import { AlertIcon, ChevronEndIcon, ChevronStartIcon } from "@/components/icons";
import { adminLoginHref, href, signInHref } from "@/lib/routes";

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

export function PageHeading({
  title,
  description,
  action,
  level = 1,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  level?: 1 | 2;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <Tag className={level === 1 ? "text-2xl text-ink" : "text-xl text-ink"}>{title}</Tag>
        {description ? (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export interface Crumb {
  label: string;
  /** Omit for the current page, which is rendered as text, not a link. */
  href?: string;
}

/**
 * Breadcrumbs.
 *
 * The separator is a `/` inside an `aria-hidden` span rather than a CSS
 * `::before`, so it never lands in the accessible name of the link — and the
 * last crumb is plain text with `aria-current="page"`, because a link to the
 * page you are already on is noise for keyboard and screen-reader users alike.
 */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="مسیر صفحه" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-ink-subtle">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="text-line-strong">
                /
              </span>
            ) : null}
            {item.href ? (
              <Link href={href(item.href)} className="no-underline hover:text-primary">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink-muted">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Inline messages
// ---------------------------------------------------------------------------

export type NoticeTone = "info" | "warning" | "danger" | "success" | "neutral";

const NOTICE_TONES: Record<NoticeTone, string> = {
  info: "border-info/30 bg-info-soft",
  warning: "border-warning/30 bg-warning-soft",
  danger: "border-danger/30 bg-danger-soft",
  success: "border-success/30 bg-success-soft",
  neutral: "border-line bg-surface-muted",
};

const NOTICE_ICON_TONES: Record<NoticeTone, string> = {
  info: "text-info",
  warning: "text-warning",
  danger: "text-danger",
  success: "text-success",
  neutral: "text-ink-subtle",
};

/**
 * An inline message.
 *
 * `role="alert"` only for the tones that mean something went wrong — an
 * assertive live region for a neutral hint interrupts a screen-reader user for
 * no reason.
 */
export function Notice({
  tone = "info",
  title,
  children,
  icon,
  action,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const assertive = tone === "danger" || tone === "warning";
  return (
    <div
      role={assertive ? "alert" : undefined}
      className={cx("flex gap-3 rounded-md border px-4 py-3", NOTICE_TONES[tone], className)}
    >
      <span aria-hidden="true" className={cx("mt-0.5 shrink-0", NOTICE_ICON_TONES[tone])}>
        {icon ?? <AlertIcon className="size-5" />}
      </span>
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-ink">
        {title ? <p className="font-bold">{title}</p> : null}
        {children ? <div className={title ? "mt-1 text-ink-muted" : "text-ink-muted"}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

/**
 * The failure message for a MUTATION, as opposed to a failed page load.
 *
 * `ErrorState` is a whole-panel treatment; this is the one-line version that
 * sits under a form. Both read `error.messages` (always an array — the
 * ValidationPipe returns arrays) and neither ever renders `error.code` as the
 * headline.
 */
export function FormError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const api = error as ApiError;
  const messages = Array.isArray(api?.messages) && api.messages.length > 0 ? api.messages : null;

  return (
    <Notice tone="danger" className={className}>
      {messages ? (
        messages.length === 1 ? (
          <p>{messages[0]}</p>
        ) : (
          <ul className="list-inside list-disc space-y-1">
            {messages.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        )
      ) : (
        <p>مشکلی پیش آمد. لطفاً دوباره تلاش کنید.</p>
      )}
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Loading / error boundary for a client query
// ---------------------------------------------------------------------------

/**
 * The three states every remote read has.
 *
 * Rendering it in one place is what keeps "loading", "failed, here is retry"
 * and "loaded but empty" from being quietly forgotten on the tenth screen.
 * `skeleton` is optional on purpose: a skeleton is only worth it where the real
 * layout is predictable (a product grid, a table). Elsewhere a spinner is
 * honest and a fake shape is not.
 *
 * ## A FIRST LOAD IS NOT A BACKGROUND REFRESH
 *
 * `useApiQuery.refetch()` re-runs the effect, which sets `isLoading` again.
 * This used to show the skeleton whenever `isLoading` was true, which was
 * correct for the first load and wrong for every refetch after it — and since
 * realtime turned refetching into a routine event rather than a user action,
 * the difference stopped being cosmetic:
 *
 *  - The storefront catalogue replaced its grid with a skeleton on every
 *    `availability:updated` frame, i.e. on any variant in the shop changing.
 *  - Worse, unmounting the loaded subtree DESTROYS ITS STATE. The product
 *    detail page holds the customer's chosen variant in the unmounted half, so
 *    a till sale anywhere in that product bounced the customer back to "choose
 *    a variant" — the exact opposite of "show the updated availability for the
 *    variant they are looking at".
 *
 * So the skeleton is keyed on having NO DATA YET. A refresh keeps the loaded
 * content on screen and marks it `aria-busy`, which is what the attribute is
 * for: the content is real, and it is being updated.
 */
export function QueryBoundary<T>({
  isLoading,
  error,
  data,
  onRetry,
  skeleton,
  empty,
  isEmpty,
  children,
  label = "در حال بارگذاری",
}: {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  onRetry?: () => void;
  skeleton?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  label?: string;
}) {
  if (error) {
    return <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />;
  }

  if (data === undefined) {
    if (skeleton) {
      return (
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="kz-sr-only">{label}</span>
          {skeleton}
        </div>
      );
    }
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" label={label} />
      </div>
    );
  }

  const body = empty && isEmpty?.(data) ? <>{empty}</> : <>{children(data)}</>;
  // A refresh over already-rendered content: announce it, do not replace it.
  return isLoading ? <div aria-busy="true">{body}</div> : body;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Page links built from the normalized `PageInfo`.
 *
 * `normalizePage` has already absorbed the API's three spellings of the
 * page-count field (`totalPages`, `totalPage`, `tatalPage`) and both nestings,
 * so nothing here has to know which endpoint it came from.
 *
 * These are real `<a href>`s, not buttons: pagination is navigation, it must be
 * middle-clickable, and the page number belongs in the URL so a result set can
 * be shared and restored.
 */
export function Pagination({
  pageInfo,
  buildHref,
  className,
}: {
  pageInfo: PageInfo;
  buildHref: (page: number) => string;
  className?: string;
}) {
  const { page, totalPages, total } = pageInfo;
  if (totalPages <= 1) return null;

  const windowed = pageWindow(page, totalPages);

  return (
    <nav aria-label="صفحه‌بندی" className={cx("flex flex-wrap items-center justify-center gap-2", className)}>
      <PageLink
        href={pageInfo.hasPreviousPage ? buildHref(page - 1) : undefined}
        label="صفحهٔ قبل"
        icon={<ChevronStartIcon className="size-4" />}
      />

      <ul className="flex items-center gap-1">
        {windowed.map((entry, index) =>
          entry === "gap" ? (
            <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-ink-subtle">
              …
            </li>
          ) : (
            <li key={entry}>
              <Link
                href={href(buildHref(entry))}
                aria-current={entry === page ? "page" : undefined}
                aria-label={`صفحهٔ ${formatInteger(entry)}`}
                data-numeric=""
                className={cx(
                  "grid size-10 place-items-center rounded-md text-sm font-semibold no-underline",
                  "transition-colors duration-150 ease-kz",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                  entry === page
                    ? "bg-primary text-primary-ink"
                    : "border border-line text-ink hover:bg-surface-muted",
                )}
              >
                {formatInteger(entry)}
              </Link>
            </li>
          ),
        )}
      </ul>

      <PageLink
        href={pageInfo.hasNextPage ? buildHref(page + 1) : undefined}
        label="صفحهٔ بعد"
        icon={<ChevronEndIcon className="size-4" />}
      />

      <p className="w-full text-center text-xs text-ink-subtle">
        صفحهٔ <bdi data-numeric="">{formatInteger(page)}</bdi> از{" "}
        <bdi data-numeric="">{formatInteger(totalPages)}</bdi> — مجموعاً{" "}
        <bdi data-numeric="">{formatInteger(total)}</bdi> مورد
      </p>
    </nav>
  );
}

function PageLink({ href: target, label, icon }: { href?: string; label: string; icon: ReactNode }) {
  if (!target) {
    return (
      <span
        aria-disabled="true"
        className="grid size-10 place-items-center rounded-md border border-line text-ink-subtle opacity-50"
      >
        <span aria-hidden="true">{icon}</span>
        <span className="kz-sr-only">{label}</span>
      </span>
    );
  }
  return (
    <Link
      href={href(target)}
      className="grid size-10 place-items-center rounded-md border border-line text-ink no-underline transition-colors duration-150 ease-kz hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
    >
      <span aria-hidden="true">{icon}</span>
      <span className="kz-sr-only">{label}</span>
    </Link>
  );
}

/** `1 … 4 5 [6] 7 8 … 20` — always shows the first, last and a window of 2. */
function pageWindow(page: number, totalPages: number): Array<number | "gap"> {
  const pages = new Set<number>([1, totalPages, page]);
  for (let offset = 1; offset <= 2; offset += 1) {
    if (page - offset >= 1) pages.add(page - offset);
    if (page + offset <= totalPages) pages.add(page + offset);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous !== 0 && value - previous > 1) out.push("gap");
    out.push(value);
    previous = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Access gates
//
// These gate NAVIGATION and rendering only. The server re-reads roles from the
// database on every request and is the sole authority; a gate here is a
// courtesy that saves the customer a pointless round trip, never a control.
//
// 401 and 403 stay DISTINCT at this level ("you are not signed in" vs "your
// account may not do this"), even though a resource LOOKUP folds 403 into 404
// so that ids cannot be enumerated. The two rules do not conflict: one is about
// the viewer, the other about a specific record.
// ---------------------------------------------------------------------------

export function RequireSession({
  children,
  title = "برای ادامه وارد شوید",
  description = "این بخش به حساب کاربری شما مربوط است.",
}: {
  children: ReactNode;
  title?: string;
  description?: string;
}) {
  const { session, isLoading, error } = useAppSession();
  const pathname = usePathname();

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" label="در حال بررسی حساب کاربری" />
      </div>
    );
  }

  if (error) {
    return <ErrorState error={error} />;
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <h2 className="text-lg text-ink">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{description}</p>
        <Button className="mt-5" fullWidth>
          <Link href={signInHref(pathname)} className="text-primary-ink no-underline">
            ورود با شمارهٔ موبایل
          </Link>
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}

export function RequireRole({ role, children }: { role: "super_admin" | "sale" | "site"; children: ReactNode }) {
  const { session, isLoading, hasRole } = useAppSession();
  const pathname = usePathname();

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" label="در حال بررسی دسترسی" />
      </div>
    );
  }

  /*
   * Not signed in — a different problem from "signed in, not allowed", and the
   * viewer can actually fix this one.
   *
   * WHICH sign-in matters. Staff have a username and a password; customers have
   * an OTP and no password at all. Sending an administrator to the customer's
   * OTP screen left the admin area with no reachable way in, so an admin route
   * goes to the admin login and everything else to the customer one.
   */
  if (!session) {
    const staffArea = pathname.startsWith("/admin");
    return (
      <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <h2 className="text-lg text-ink">برای دیدن این بخش وارد شوید</h2>
        <p className="mt-2 text-sm text-ink-muted">
          {staffArea
            ? "ورود به بخش مدیریت با نام کاربری و رمز عبور انجام می‌شود."
            : "این بخش نیازمند حساب کاربری است."}
        </p>
        <Button className="mt-5" fullWidth>
          <Link
            href={staffArea ? adminLoginHref(pathname) : signInHref(pathname)}
            className="text-primary-ink no-underline"
          >
            ورود
          </Link>
        </Button>
      </div>
    );
  }

  if (!hasRole(role)) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <Badge tone="danger">دسترسی ندارید</Badge>
        <h2 className="mt-3 text-lg text-ink">این بخش برای حساب شما در دسترس نیست</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          شما با حساب <bdi dir="ltr">{session.identifier}</bdi> وارد شده‌اید و این حساب دسترسی لازم
          را ندارد. اگر فکر می‌کنید اشتباهی رخ داده، با مدیر سامانه تماس بگیرید.
        </p>
        <Button variant="secondary" className="mt-5">
          <Link href="/" className="no-underline">
            بازگشت به فروشگاه
          </Link>
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
