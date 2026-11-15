"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { RealtimeStatus, Session } from "@kazhal/api-client";
import { Badge, Button, Skeleton, cx } from "@kazhal/ui";
import { useApi, useApiQuery, useRealtimeStatus, useSession } from "@kazhal/ui/api/react";

import { CompassIcon, PeakIcon, ReceiptIcon } from "./icons";
import { canOperatePos, hasSellableBranch } from "../lib/pos-domain";
import { clearSaleCache } from "../lib/receipt-store";

/**
 * The till shell: identity, branch, connection, navigation, and the one
 * `<main id="main" tabIndex={-1}>` the root layout's skip link targets.
 *
 * The gate here is NAVIGATION ONLY and keeps 401 and 403 distinct:
 *
 *   session === null            -> not signed in (401). Send them to /login.
 *   signed in, no POS role      -> forbidden (403). A `site` customer lands
 *                                  here and is never shown a till screen.
 *   signed in, POS role, branch -> the till.
 *   signed in, POS role, NO branch -> the shell, with selling refused. Only
 *                                  `POST /orders/pos` needs a branch; browsing
 *                                  the catalogue does not.
 *
 * Every one of those is re-decided by the SERVER on every request. Nothing here
 * grants anything.
 */

/**
 * Navigation.
 *
 * ONE ITEM, BY DESIGN. This app is the till: choose products, take the money,
 * print the receipt. It used to carry a second item, `/sales`, which opened a
 * management reporting console gated on `super_admin`.
 *
 * That whole surface is gone. Sales reports belong to the main administrator in
 * the WEB ADMIN CONSOLE, and the API now refuses `/reports/*` to anything that
 * is not an `admin`-audience `super_admin` session — so the POS could not open
 * it even if the link came back. Keeping a reporting screen in the till meant
 * the shop-floor device rendered the whole business's takings for whoever was
 * standing at it.
 *
 * The cashier's OWN receipt is not reporting and is still here: it is reached
 * from the completed sale (`/receipt/:id`), reads `GET /orders/:id` under
 * `pos.receipt.read_own`, and answers 404 for anybody else's sale.
 */
const TILL_NAV = { href: "/pos", label: "صندوق فروش", icon: ReceiptIcon } as const;

const POS_NAV = [TILL_NAV] as const;

const REALTIME_LABEL: Record<RealtimeStatus, { text: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  idle: { text: "آماده", tone: "neutral" },
  connecting: { text: "در حال اتصال", tone: "warning" },
  open: { text: "به‌روزرسانی زنده", tone: "success" },
  reconnecting: { text: "اتصال ناپایدار", tone: "warning" },
  closed: { text: "بدون به‌روزرسانی زنده", tone: "neutral" },
  error: { text: "قطع به‌روزرسانی", tone: "danger" },
};

export function PosShell({ children }: { children: ReactNode }) {
  const { session, isLoading, error, refresh } = useSession();

  if (isLoading && session === undefined) {
    return <ShellFrame header={<HeaderSkeleton />}>{<ShellSkeleton />}</ShellFrame>;
  }

  if (error && session === undefined) {
    return (
      <ShellFrame header={<BareHeader />}>
        <Gatekeeper
          title="ارتباط با سرور برقرار نشد"
          description="وضعیت ورود شما خوانده نشد. اتصال شبکه‌ی صندوق را بررسی کنید و دوباره تلاش کنید."
          action={
            <Button onClick={refresh} size="lg">
              تلاش دوباره
            </Button>
          }
        />
      </ShellFrame>
    );
  }

  // Neither loading nor errored, but still unresolved: keep the frame rather
  // than flashing a sign-in screen at a cashier who IS signed in.
  if (session === undefined) {
    return <ShellFrame header={<HeaderSkeleton />}>{<ShellSkeleton />}</ShellFrame>;
  }

  if (session === null) {
    return <SignedOut />;
  }

  /*
   * FORCED PASSWORD CHANGE, checked BEFORE the role gate and before anything
   * that fetches.
   *
   * An administrator issued a temporary password, so the API answers 403
   * PASSWORD_CHANGE_REQUIRED on every route except `/auth/pos/me`, rotation,
   * sign-out and the change itself. Rendering the till here is what produced
   * the defect this replaces: a catalogue that looked like it was working and
   * then failed on every request.
   *
   * This is NOT the control — the server already refuses. It is what stops a
   * cashier being shown a screen that cannot do anything. `AuthorizedShell` is
   * not reached, so `/branch/mine` is never called and the network panel stays
   * clean.
   */
  if (session.mustChangePassword === true) {
    return <PasswordChangeRequired />;
  }

  if (!canOperatePos(session)) {
    return <Forbidden session={session} />;
  }

  return <AuthorizedShell session={session}>{children}</AuthorizedShell>;
}

// ---------------------------------------------------------------------------

function AuthorizedShell({ session, children }: { session: Session; children: ReactNode }) {
  const api = useApi();
  const pathname = usePathname();
  const router = useRouter();
  const realtime = useRealtimeStatus();
  const [signingOut, setSigningOut] = useState(false);

  const branchId = session.branchId;
  /*
   * The branch is read from the SERVER, never typed, chosen or cached from a
   * form — and through `/branch/mine` rather than `/branch/{id}`.
   *
   * `GET /branch/{id}` is ADMIN-AUDIENCE ONLY, so the till's request for it
   * was answered 401 on every single load: the header silently fell back to
   * printing the branch NUMBER, and the network panel carried a failed
   * authenticated request on every page. `mine` serves both surfaces, needs no
   * capability, and discloses nothing the caller does not already have — the
   * branch id is on their own session.
   */
  const branch = useApiQuery((signal) => api.branch.mine({ signal }), [api], {
    enabled: branchId !== null,
  });

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await api.auth.logout();
    } catch {
      // `logout` is idempotent server-side and the client marks the session
      // signed-out regardless; a failed call must never trap a cashier.
    } finally {
      clearSaleCache();
      setSigningOut(false);
      router.replace("/login");
    }
  }, [api, router]);

  const status = REALTIME_LABEL[realtime];
  const branchLabel =
    branchId === null
      ? "بدون شعبه"
      : (branch.data?.name ?? `شعبه‌ی ${new Intl.NumberFormat("fa-IR").format(branchId)}`);

  return (
    <ShellFrame
      header={
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <BrandMark />

          <nav aria-label="بخش‌های صندوق" className="order-3 w-full sm:order-2 sm:w-auto">
            <ul className="flex gap-2">
              {POS_NAV.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "inline-flex h-12 items-center gap-2 rounded-md px-4 text-base font-semibold no-underline transition-colors",
                        active
                          ? "bg-primary text-primary-ink"
                          : "text-ink hover:bg-surface-muted",
                      )}
                    >
                      <Icon className="size-5" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="order-2 ms-auto flex items-center gap-3 sm:order-3">
            <div className="text-end">
              <p className="text-sm font-semibold text-ink">{session.identifier}</p>
              <p className="text-xs text-ink-muted">
                {branchLabel}
                {!hasSellableBranch(session) ? " — فروش غیرفعال" : ""}
              </p>
            </div>
            <Badge tone={status.tone} size="sm" srLabel={`وضعیت اتصال: ${status.text}`}>
              {status.text}
            </Badge>
            <Button variant="secondary" size="sm" onClick={signOut} isLoading={signingOut}>
              خروج
            </Button>
          </div>
        </div>
      }
    >
      {children}
    </ShellFrame>
  );
}

// ---------------------------------------------------------------------------

function ShellFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="kz-chrome sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        {header}
      </header>
      {/*
        The skip-link target declared by the root layout. `tabIndex={-1}` makes
        it programmatically focusable so "skip to content" actually moves focus
        rather than only moving the scroll position.
      */}
      <main id="main" tabIndex={-1} className="flex-1 focus-visible:outline-none">
        {children}
      </main>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="order-1 flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-md bg-primary-soft text-primary"
      >
        <PeakIcon className="size-6" />
      </span>
      <div>
        <p className="text-lg font-bold leading-tight text-ink">صندوق فروش کژال</p>
        <p className="text-xs text-ink-muted">تجهیزات کوهنوردی، شکار، کمپینگ و ماهیگیری</p>
      </div>
    </div>
  );
}

function BareHeader() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-3 sm:px-6">
      <BrandMark />
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
      <Skeleton shape="block" width="2.75rem" height="2.75rem" />
      <Skeleton width="14rem" height="1.25rem" />
      <span className="ms-auto">
        <Skeleton width="9rem" height="1.25rem" />
      </span>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-8 sm:px-6 lg:grid-cols-[1.3fr_1fr]"
    >
      <span className="kz-sr-only">در حال بررسی نشست صندوق‌دار</span>
      <Skeleton shape="block" height="22rem" />
      <Skeleton shape="block" height="22rem" />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SignedOut() {
  const router = useRouter();
  // A till that has lost its session should land on the sign-in screen without
  // a click, but the link stays visible in case the redirect is blocked.
  useEffect(() => {
    router.replace("/login");
  }, [router]);

  return (
    <ShellFrame header={<BareHeader />}>
      <Gatekeeper
        title="برای استفاده از صندوق وارد شوید"
        description="نشست شما پایان یافته یا هنوز وارد نشده‌اید."
        action={
          <Link
            href="/login"
            className="inline-flex h-13 items-center rounded-md bg-primary px-7 text-lg font-semibold text-primary-ink no-underline"
          >
            ورود صندوق‌دار
          </Link>
        }
      />
    </ShellFrame>
  );
}

/**
 * The redirect to the forced-change screen, with a visible way through if the
 * redirect is blocked.
 *
 * `/change-password` lives OUTSIDE the `(pos)` route group, so this component
 * is never rendered on it: the shell redirects one way only and the change
 * screen never sends the browser back into a gated route while the flag is
 * still set. That is what makes a loop impossible rather than merely unlikely.
 */
function PasswordChangeRequired() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/change-password");
  }, [router]);

  return (
    <ShellFrame header={<BareHeader />}>
      <Gatekeeper
        title="ابتدا گذرواژه را تغییر دهید"
        description={
          "گذرواژه‌ی شما را مدیر سیستم به‌صورت موقت تعیین کرده است. تا وقتی آن را با " +
          "گذرواژه‌ی خودتان جایگزین نکنید، فهرست کالاها و ثبت فروش کار نمی‌کند."
        }
        action={
          <Link
            href="/change-password"
            className="inline-flex h-13 items-center rounded-md bg-primary px-7 text-lg font-semibold text-primary-ink no-underline"
          >
            تغییر گذرواژه
          </Link>
        }
      />
    </ShellFrame>
  );
}

function Forbidden({ session }: { session: Session }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await api.auth.logout();
    } catch {
      /* idempotent */
    } finally {
      clearSaleCache();
      router.replace("/login");
    }
  };

  return (
    <ShellFrame header={<BareHeader />}>
      <Gatekeeper
        tone="danger"
        title="این حساب به صندوق فروش دسترسی ندارد"
        description={
          "صندوق فروش حضوری فقط برای نقش‌های «فروشنده» و «مدیر ارشد» باز است. " +
          "حساب شما این دسترسی را ندارد؛ اگر اشتباهی رخ داده با مدیر سیستم تماس بگیرید."
        }
        action={
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-ink-muted">
              حساب فعلی: <span dir="ltr">{session.identifier}</span>
            </p>
            <Button size="lg" variant="secondary" onClick={signOut} isLoading={busy}>
              خروج و ورود با حساب دیگر
            </Button>
          </div>
        }
      />
    </ShellFrame>
  );
}

function Gatekeeper({
  title,
  description,
  action,
  tone = "neutral",
}: {
  title: string;
  description: string;
  action?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-4 py-20 text-center sm:px-6">
      <span
        aria-hidden="true"
        className={cx(
          "flex size-16 items-center justify-center rounded-pill",
          tone === "danger" ? "bg-danger-soft text-danger" : "bg-surface-muted text-ink-subtle",
        )}
      >
        <CompassIcon className="size-8" />
      </span>
      <h1 className="text-2xl text-ink">{title}</h1>
      <p className="max-w-prose text-ink-muted">{description}</p>
      {action}
    </div>
  );
}
