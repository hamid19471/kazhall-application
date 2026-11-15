"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { Badge, Button, Spinner, cx } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { useAppSession } from "@/components/providers";
import {
  ADMIN_NAV,
  adminCrumbGate,
  adminCrumbLabel,
  adminRootGate,
  navGate,
} from "@/lib/admin-nav";
import type { AdminNavIcon, AdminNavItem } from "@/lib/admin-nav";
import { canAny, canReach } from "@/lib/permissions";
import type { AccessGate } from "@/lib/permissions";
import { adminLoginHref } from "@/lib/routes";
import { fetchNavCounts } from "@/lib/admin-api";
import type { AdminNavCounts } from "@/lib/admin-api";
import {
  AlertIcon,
  BoxIcon,
  ChartIcon,
  ClipboardIcon,
  CloseIcon,
  DashboardIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  LogoMark,
  LogoutIcon,
  MenuIcon,
  ReceiptIcon,
  ScaleIcon,
  SlidersIcon,
  StoreIcon,
  TagIcon,
  TillIcon,
  UserIcon,
  UsersIcon,
} from "@/components/icons";

const ADMIN_LOGIN_PATH = "/admin/login";
const PASSWORD_PATH = "/admin/account/password";

const NAV_ICONS: Record<AdminNavIcon, (props: { className?: string }) => ReactNode> = {
  dashboard: DashboardIcon,
  box: BoxIcon,
  tag: TagIcon,
  sliders: SlidersIcon,
  layers: LayersIcon,
  receipt: ReceiptIcon,
  scale: ScaleIcon,
  users: UsersIcon,
  till: TillIcon,
  store: StoreIcon,
  key: KeyIcon,
  chart: ChartIcon,
  clipboard: ClipboardIcon,
};

/**
 * ===========================================================================
 * THE ADMIN APPLICATION SHELL
 * ===========================================================================
 *
 * A real management application, not a list of links. What that means in
 * practice, and why each piece is here:
 *
 *  - A STICKY SIDEBAR on desktop and a FOCUS-TRAPPING DRAWER below `lg:`. A
 *    console is used with both hands on a keyboard for hours; a nav that
 *    scrolls away, or a drawer that lets Tab escape behind the overlay, is the
 *    difference between a tool and a demo.
 *  - SECTIONS, because thirteen flat links is a wall. The grouping is the
 *    owner's mental model: what am I looking at (overview), what do I sell
 *    (catalogue), what is happening now (operations), who works here
 *    (organization), who may do what (access), how did we do (analytics).
 *  - EVERY ITEM IS CAPABILITY-GATED, from the same codes the API's guards
 *    declare. A delegated order manager sees Orders and nothing else — not a
 *    screen full of 403s.
 *  - BREADCRUMBS derived from the path, with Persian labels, so a deep page
 *    always says where it is and offers one click back.
 *  - COUNT BADGES fetched ONCE for the whole menu, not once per section.
 *
 * WHAT GATES HERE ARE NOT. Hiding a link is a courtesy. Every route behind it
 * re-checks its capability on every request, against the database, on the
 * server — see `PermissionsGuard`. Nothing in this file is a security control.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  /*
   * The sign-in route renders BARE: no nav, no gate, no session query. A page
   * whose entire job is to obtain a session cannot itself require one —
   * gating it is how an admin area ends up with no reachable way in.
   */
  if (pathname === ADMIN_LOGIN_PATH) {
    return (
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
        {children}
      </main>
    );
  }

  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, isResolved, isLoading } = useAppSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRoute, setDrawerRoute] = useState(pathname);

  /*
   * Closing on navigation is what makes the drawer usable at all: without it
   * the first tap opens a page behind an overlay that is still covering it.
   *
   * ADJUSTED DURING RENDER rather than in an effect. An effect would paint the
   * new page with the overlay still up and then remove it on a second pass —
   * a visible flash — and `setState` inside an effect body is the cascading
   * render React explicitly warns about. The link's own `onNavigate` covers
   * the common case; this covers the browser's back and forward buttons,
   * which no click handler sees.
   */
  if (drawerRoute !== pathname) {
    setDrawerRoute(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  const visibleSections = useMemo(
    () =>
      ADMIN_NAV.map((section) => ({
        ...section,
        items: section.items.filter((item) => canReach(session, navGate(item))),
      })).filter((section) => section.items.length > 0),
    [session],
  );

  /*
   * FORCED PASSWORD CHANGE — THE REDIRECT.
   *
   * A delegated user created by an administrator signs in with the temporary
   * password that administrator typed, and the API then answers 403
   * PASSWORD_CHANGE_REQUIRED on every route except `/auth/admin/me`, rotation,
   * sign-out and the change itself. Landing them on the dashboard means a
   * console made entirely of error states, so they are MOVED to the one screen
   * that can clear the flag rather than being offered a button to it.
   *
   * `replace`, not `push`: the dashboard they never got to use has no business
   * in the back stack. The card below stays as the visible fallback for a
   * blocked or slow navigation.
   *
   * NO LOOP IS POSSIBLE HERE. The condition excludes the destination, and the
   * destination fetches nothing but `/auth/admin/me`, which is reachable while
   * the flag is set.
   */
  const forcedChangePending = session?.mustChangePassword === true;
  const onPasswordRoute = pathname === PASSWORD_PATH;
  useEffect(() => {
    if (forcedChangePending && !onPasswordRoute) {
      router.replace(PASSWORD_PATH as Route);
    }
  }, [forcedChangePending, onPasswordRoute, router]);

  if (isLoading || !isResolved) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="flex min-h-[60vh] items-center justify-center"
      >
        <Spinner size="lg" />
        <span className="kz-sr-only">در حال بارگذاری بخش مدیریت</span>
      </div>
    );
  }

  /*
   * THE PASSWORD SCREEN RUNS BARE while it is the only thing the session may
   * do — and it also runs bare once that session is gone.
   *
   * Two reasons, both load-bearing:
   *
   *  - NOTHING MAY FETCH. The sidebar's count badges and every other chrome
   *    query would answer 403 PASSWORD_CHANGE_REQUIRED, putting a row of
   *    failed authenticated requests behind the very screen that exists to fix
   *    the problem.
   *  - THE SCREEN DESTROYS ITS OWN SESSION, on purpose. A password change kills
   *    every session this user holds, so `/auth/me` starts answering "signed
   *    out" mid-flow. Letting the shell race that with a signed-out card would
   *    rip the screen away one moment before it signs the operator back in. It
   *    owns its own aftermath; the shell must not second-guess it.
   */
  if (onPasswordRoute && (!session || forcedChangePending)) {
    return (
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-8 outline-none sm:px-6">
        {children}
      </main>
    );
  }

  if (!session) return <SignedOutCard />;

  /*
   * The redirect above is the real path out. This is the fallback the operator
   * sees if it is slow or blocked — never a dead end, and never a dashboard
   * made entirely of error states.
   */
  if (forcedChangePending) {
    return <PasswordChangeRequiredCard onGo={() => router.replace(PASSWORD_PATH as Route)} />;
  }

  if (visibleSections.length === 0) return <NoAccessCard identifier={session.identifier} />;

  return (
    <div className="flex min-h-screen w-full bg-canvas">
      <DesktopSidebar sections={visibleSections} />
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sections={visibleSections}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenDrawer={() => setDrawerOpen(true)} />
        <main
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 pb-16 pt-5 outline-none sm:px-6 lg:px-8"
        >
          <div className="mx-auto w-full max-w-[84rem] min-w-0">
            <Breadcrumbs />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * `/admin` matches EXACTLY, everything else by prefix.
 *
 * Without the exact case the dashboard link is highlighted on every page in
 * the console, because every admin path starts with `/admin`.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({
  sections,
  counts,
  onNavigate,
}: {
  sections: Array<{ key: string; title: string; items: AdminNavItem[] }>;
  counts: AdminNavCounts | undefined;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="پیمایش بخش مدیریت" className="flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section.key}>
          <h2 className="px-3 pb-1.5 text-2xs font-bold uppercase tracking-wide text-ink-subtle">
            {section.title}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = NAV_ICONS[item.icon];
              const count = item.badge ? (counts?.[item.badge] ?? 0) : 0;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm no-underline transition-colors duration-150 ease-kz",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                      active
                        ? "bg-primary-soft font-bold text-primary"
                        : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                    )}
                  >
                    <span aria-hidden="true" className="shrink-0">
                      <Icon className="size-[1.15rem]" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {count > 0 ? (
                      <Badge
                        tone={item.badge === "reconciliation" ? "danger" : "warning"}
                        size="sm"
                        srLabel={`${item.label}: ${count} مورد نیازمند توجه`}
                      >
                        <bdi data-numeric="">
                          {new Intl.NumberFormat("fa-IR").format(count)}
                        </bdi>
                      </Badge>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function DesktopSidebar({
  sections,
}: {
  sections: Array<{ key: string; title: string; items: AdminNavItem[] }>;
}) {
  const counts = useNavCounts();

  return (
    <aside className="hidden w-64 shrink-0 border-e border-line bg-surface lg:block">
      {/*
       * `sticky` + `h-screen` rather than `fixed`: a fixed sidebar has to be
       * compensated for with a body margin that is wrong the moment the
       * viewport changes, and in RTL that margin is on the wrong side often
       * enough to be a recurring bug.
       */}
      <div className="sticky top-0 flex h-screen flex-col overflow-y-auto px-3 py-4">
        <Identity />
        <div className="mt-5 min-h-0 flex-1">
          <NavList sections={sections} counts={counts} />
        </div>
        <AccountPanel />
      </div>
    </aside>
  );
}

/**
 * The mobile / tablet drawer.
 *
 * It traps focus, restores it on close, closes on Escape and on a click on the
 * scrim, and marks the rest of the page `aria-hidden` — a drawer that does
 * none of those is a visual effect, not a dialog, and a keyboard user tabs
 * straight out of it into a page they cannot see.
 */
function MobileDrawer({
  open,
  onClose,
  sections,
}: {
  open: boolean;
  onClose: () => void;
  sections: Array<{ key: string; title: string; items: AdminNavItem[] }>;
}) {
  const counts = useNavCounts();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /*
   * TWO EFFECTS, NOT ONE — AND THE SPLIT IS THE FIX.
   *
   * This was a single effect keyed on `[open, onClose]`. `onClose` is passed
   * as `() => setDrawerOpen(false)`, a fresh closure on every render of the
   * shell, so the effect tore down and re-ran on EVERY parent render while the
   * drawer was open. Each re-run did two damaging things:
   *
   *   - the cleanup called `restoreRef.current.focus()`, yanking focus out of
   *     the menu. A keyboard user tabbing through the sections was thrown back
   *     whenever the nav count badges refreshed;
   *   - the new run re-captured `restoreRef.current = document.activeElement`,
   *     which by then could be an element INSIDE the panel. On close that node
   *     was already unmounted, `.focus()` on a detached node does nothing, and
   *     focus fell to `<body>` — measured: `activeElement.tagName === "BODY"`
   *     after a real Escape.
   *
   * Capture and restore now key on `[open]` alone, so they run exactly on the
   * open and close transitions. The key handler keeps its own effect and reads
   * `onClose` through a ref, so re-subscribing costs nothing and never
   * disturbs focus.
   */
  const onCloseRef = useRef(onClose);
  // Written in an effect, not during render: a ref assignment in the render
  // body is the mutation React warns about, and this one has no reason to
  // happen before commit.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    panelRef.current?.querySelector<HTMLElement>("button, a")?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      // Resolved AT CLOSE TIME, so it cannot name a node React has since
      // replaced. Snapshotting `document.activeElement` on open did exactly
      // that, and focusing the detached result silently dropped the keyboard
      // user on <body>.
      document
        .querySelector<HTMLElement>("[data-kz-drawer-trigger]")
        ?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const panel = panelRef.current;
      if (event.key !== "Tab" || !panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="بستن منو"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 start-0 flex w-[min(19rem,86vw)] flex-col overflow-y-auto border-e border-line bg-surface px-3 py-4 shadow-raised"
      >
        <div className="flex items-start justify-between gap-2">
          <span id={titleId}>
            <Identity />
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            leadingIcon={<CloseIcon className="size-4" />}
          >
            بستن
          </Button>
        </div>
        <div className="mt-5 min-h-0 flex-1">
          <NavList sections={sections} counts={counts} onNavigate={onClose} />
        </div>
        <AccountPanel />
      </div>
    </div>
  );
}

function TopBar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const { session } = useAppSession();

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur sm:px-6 lg:px-8">
      <Button
        /*
         * A STABLE LOCATOR, so the drawer can hand focus back.
         *
         * `Button` is a plain function component and does not forward a ref,
         * and adding ref forwarding to a primitive every surface shares is a
         * larger change than this problem deserves. An attribute is enough:
         * `querySelector` finds whatever node is mounted at the moment the
         * drawer closes, which is exactly the guarantee a snapshot of
         * `document.activeElement` could not give.
         */
        data-kz-drawer-trigger=""
        variant="ghost"
        size="sm"
        className="lg:hidden"
        onClick={onOpenDrawer}
        leadingIcon={<MenuIcon className="size-5" />}
      >
        منو
      </Button>
      <span className="flex items-center gap-2 lg:hidden">
        <LogoMark className="size-6 text-primary" />
        <span className="text-sm font-extrabold text-ink">کژال</span>
      </span>
      <span className="ms-auto flex min-w-0 items-center gap-2">
        <UserIcon className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
        <bdi dir="ltr" className="truncate text-xs text-ink-muted">
          {session?.identifier}
        </bdi>
      </span>
    </header>
  );
}

/**
 * The masthead, which is also a link home — but only to a home the viewer has.
 *
 * It pointed unconditionally at `/admin`, making the logo a second, ungated
 * route to the dashboard: a delegated account with no `dashboard.read` got it
 * in the tab order on every page, and following it produced an access-denied
 * card. It now targets the first section that account can actually open, and
 * becomes plain text when there is none — the mark and the wordmark still
 * render either way, because they are identity, not navigation.
 */
function Identity() {
  const { session } = useAppSession();

  const dashboardReachable = canReach(session, adminRootGate());
  const firstReachable = ADMIN_NAV.flatMap((section) => section.items).find(
    (item) => canReach(session, navGate(item)),
  );
  const target: Route | null = dashboardReachable
    ? ("/admin" as Route)
    : (firstReachable?.href ?? null);

  const body = (
    <>
      <LogoMark className="size-8 shrink-0 text-primary" />
      <span className="min-w-0">
        <span className="block text-base font-extrabold leading-tight text-ink">کژال</span>
        <span className="block text-2xs leading-tight text-ink-subtle">
          سامانهٔ مدیریت فروشگاه
        </span>
      </span>
    </>
  );

  const className =
    "flex items-center gap-2.5 rounded-md px-3 py-1 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]";

  if (!target) {
    return <span className={className}>{body}</span>;
  }

  return (
    <Link href={target} className={className}>
      {body}
    </Link>
  );
}

/**
 * Identity, sign-out and account switching.
 *
 * Signing out is the ONLY way to change who you are here: sessions are
 * httpOnly cookies, so a second sign-in over a live one would silently replace
 * it. Revoking first and landing on the staff sign-in page makes switching an
 * explicit act rather than a surprise.
 */
function AccountPanel() {
  const api = useApi();
  const router = useRouter();
  const { session, refresh } = useAppSession();
  const [pending, setPending] = useState(false);

  const signOut = useCallback(() => {
    setPending(true);
    void (async () => {
      try {
        await api.auth.logout();
      } finally {
        // A failed sign-out must still land the operator somewhere they can
        // sign in as somebody else; the call is idempotent server-side.
        refresh();
        router.replace(adminLoginHref());
        setPending(false);
      }
    })();
  }, [api, refresh, router]);

  if (!session) return null;

  return (
    <div className="mt-4 shrink-0 rounded-md border border-line bg-surface-muted p-3">
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <UserIcon className="size-4 shrink-0" aria-hidden="true" />
        <bdi dir="ltr" className="truncate">
          {session.identifier}
        </bdi>
      </p>
      <p className="mt-2 flex flex-wrap gap-1">
        {session.roles.map((role) => (
          <Badge key={role} size="sm" tone={role === "super_admin" ? "primary" : "neutral"}>
            {ROLE_LABEL[role] ?? role}
          </Badge>
        ))}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link href={PASSWORD_PATH as Route} className="text-xs">
          تغییر گذرواژه
        </Link>
        <Link href="/" className="text-xs">
          فروشگاه
        </Link>
        <button
          type="button"
          disabled={pending}
          onClick={signOut}
          className="inline-flex items-center gap-1 text-xs text-ink-muted underline underline-offset-4 transition-colors duration-150 ease-kz hover:text-danger disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
        >
          <LogoutIcon className="size-3.5" aria-hidden="true" />
          {pending ? "در حال خروج…" : "خروج"}
        </button>
      </div>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: "مدیر ارشد",
  sale: "صندوق‌دار",
  site: "مشتری",
};

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Derived from the path, never from a prop.
 *
 * A prop-driven breadcrumb is one more thing every page has to remember, and
 * the page that forgets is always a deep one where the crumb mattered most.
 * Numeric segments render as `#id` rather than being dropped, so a product
 * page's trail still shows which product.
 */
function Breadcrumbs() {
  const pathname = usePathname();
  const { session } = useAppSession();
  const segments = pathname.split("/").filter(Boolean).slice(1);

  if (segments.length === 0) return null;

  /*
   * A CRUMB THE VIEWER CANNOT FOLLOW IS RENDERED AS TEXT, NOT AS A LINK.
   *
   * The trail is derived from the URL, which knows nothing about who is
   * reading it. On a delegated account that produced links into sections the
   * account has no capability for — an order reader was shown a «داشبورد»
   * root crumb on every single page, and following it landed them on an
   * access-denied card. The label still appears, because the trail is also
   * telling them WHERE THEY ARE; only the navigation is withdrawn.
   *
   * Segments with no menu item of their own (an id, `new`, `edit`) carry no
   * gate and stay links: their parent section is already reachable, or the
   * viewer could not be on this page at all.
   */
  const reachable = (gate: AccessGate | null): boolean =>
    gate === null || canReach(session, gate);

  const crumbs = segments.map((segment, index) => {
    const href = `/admin/${segments.slice(0, index + 1).join("/")}`;
    const numeric = /^\d+$/.test(segment);
    const label = numeric
      ? `#${new Intl.NumberFormat("fa-IR", { useGrouping: false }).format(Number(segment))}`
      : (adminCrumbLabel(segment) ?? segment);
    return {
      href,
      label,
      isLast: index === segments.length - 1,
      linkable: index === 0 ? reachable(adminCrumbGate(segment)) : true,
    };
  });

  const rootLinkable = canReach(session, adminRootGate());

  return (
    <nav aria-label="مسیر" className="mb-3">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-subtle">
        <li>
          {rootLinkable ? (
            <Link href="/admin" className="no-underline hover:underline">
              داشبورد
            </Link>
          ) : (
            <span>داشبورد</span>
          )}
        </li>
        {crumbs.map((crumb) => (
          <li key={crumb.href} className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            {crumb.isLast || !crumb.linkable ? (
              <span
                {...(crumb.isLast ? { "aria-current": "page" as const } : {})}
                className={crumb.isLast ? "font-bold text-ink-muted" : undefined}
              >
                {crumb.label}
              </span>
            ) : (
              <Link href={crumb.href as Route} className="no-underline hover:underline">
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Count badges
// ---------------------------------------------------------------------------

/**
 * ONE request for every badge in the menu.
 *
 * The counts come from the dashboard summary, which is a single bounded
 * endpoint — a badge per section fetching its own count would be three
 * requests on every page load, and the sidebar is on every page. A failure is
 * silent by design: a missing badge is a missing hint, not a broken console.
 */
function useNavCounts(): AdminNavCounts | undefined {
  const api = useApi();
  const { session } = useAppSession();
  const enabled = canAny(session, "dashboard.read");

  const { data } = useApiQuery(
    (signal) => fetchNavCounts(api, { signal }),
    [api],
    { enabled },
  );
  return data;
}

// ---------------------------------------------------------------------------
// Whole-shell states
// ---------------------------------------------------------------------------

function ShellCard({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-16 outline-none"
    >
      <div className="rounded-lg border border-line bg-surface p-6 text-center shadow-soft">
        {children}
      </div>
    </main>
  );
}

function SignedOutCard() {
  const pathname = usePathname();
  return (
    <ShellCard>
      <LockIcon className="mx-auto size-8 text-ink-subtle" aria-hidden="true" />
      <h1 className="mt-3 text-lg text-ink">برای ورود به بخش مدیریت وارد شوید</h1>
      <p className="mt-2 text-sm text-ink-muted">
        این بخش با نام کاربری و گذرواژهٔ کارکنان کار می‌کند.
      </p>
      <p className="mt-4">
        <Link href={adminLoginHref(pathname)} className="text-sm font-bold">
          رفتن به صفحهٔ ورود
        </Link>
      </p>
    </ShellCard>
  );
}

function NoAccessCard({ identifier }: { identifier: string }) {
  return (
    <ShellCard>
      <AlertIcon className="mx-auto size-8 text-warning" aria-hidden="true" />
      <h1 className="mt-3 text-lg text-ink">هیچ بخشی برای شما فعال نیست</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        حساب{" "}
        <bdi dir="ltr" className="font-bold">
          {identifier}
        </bdi>{" "}
        اجازهٔ ورود به پنل مدیریت را دارد، اما هنوز هیچ اختیاری به آن داده نشده است. از مدیر
        ارشد بخواهید نقش مناسب را به شما اختصاص دهد.
      </p>
    </ShellCard>
  );
}

function PasswordChangeRequiredCard({ onGo }: { onGo: () => void }) {
  return (
    <ShellCard>
      <LockIcon className="mx-auto size-8 text-warning" aria-hidden="true" />
      <h1 className="mt-3 text-lg text-ink">ابتدا گذرواژه را تغییر دهید</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        برای حساب شما یک گذرواژهٔ موقت تعیین شده است. تا زمانی که آن را تغییر ندهید، هیچ بخش
        دیگری در دسترس نیست.
      </p>
      <p className="mt-4">
        <Button onClick={onGo}>تغییر گذرواژه</Button>
      </p>
    </ShellCard>
  );
}
