"use client";

import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

import { isApiError } from "@kazhal/api-client";
import type { ApiError, PageInfo } from "@kazhal/api-client";
import { Badge } from "@kazhal/ui";
import type { BadgeTone } from "@kazhal/ui";

import { FormError, Notice } from "@/components/common";
import { Gate } from "@/components/admin/ui";
import { ACCOUNT_SURFACES, accountFailure, surfaceLabel } from "@/lib/labels";
import { adminBranchHref, adminUserHref, adminUsersHref } from "@/lib/routes";
import { intParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";
import type { AdminPage, AdminRoleRef, AdminUserRow } from "@/lib/admin-api";

/**
 * ===========================================================================
 * SHARED PARTS OF THE PEOPLE SCREENS
 * ===========================================================================
 *
 * Four screens (`users`, `user-detail`, `cashiers`, `branch-detail`) render the
 * SAME facts about an account: who it is, which roles it holds, which branch it
 * belongs to, which surfaces it may open. Writing those four times is how the
 * users table ends up saying "بدون شعبه" where the cashier table says "—", and
 * how one of them quietly forgets the inactive-branch warning.
 *
 * Nothing here fetches. Every component takes a row the caller already has.
 */

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * `AdminPage<T>` → the `PageInfo` that `<Pagination>` consumes.
 *
 * The admin list endpoints return a flat `{ total, page, limit, totalPages }`
 * rather than the `{ items, pageInfo }` shape `@kazhal/api-client` normalizes
 * for the storefront, and they do not send `hasNextPage`. Deriving it here —
 * once — is what keeps four screens from each computing `page < totalPages`
 * slightly differently.
 *
 * `totalPages` is floored at 1 so an empty result set renders as "صفحهٔ ۱ از ۱"
 * instead of "از ۰".
 */
export function pageInfoOf(page: Omit<AdminPage<unknown>, "data">): PageInfo {
  const totalPages = page.totalPages > 0 ? page.totalPages : 1;
  return {
    page: page.page,
    limit: page.limit,
    total: page.total,
    totalPages,
    hasNextPage: page.page < totalPages,
    hasPreviousPage: page.page > 1,
  };
}

/**
 * A row id read from the URL.
 *
 * `intParam` accepts `0`, and every id column on these routes is declared
 * `@Min(1)` — so `?roleId=0` would leave this screen showing a 400 from the
 * API instead of simply ignoring a filter that cannot match anything.
 */
export function idParam(params: RawSearchParams, key: string): number | undefined {
  const value = intParam(params, key);
  return value !== undefined && value >= 1 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export function asApiError(error: unknown): ApiError | null {
  return isApiError(error) ? error : null;
}

/** The canonical read is `body.error ?? body.details.code`; `ApiError` did it. */
export function apiErrorCode(error: unknown): string | null {
  return asApiError(error)?.code ?? null;
}

/**
 * A refused mutation, explained.
 *
 * Branches on `error.code` — never on the human message, which the API writes
 * in English. A code this app knows gets the Persian sentence plus what to do
 * about it; a 403 with no code gets the one answer that is always true ("your
 * account lacks the authority"); anything else falls through to the server's
 * own messages, because inventing a friendlier sentence for an unknown failure
 * is how a real defect gets reported as "مشکلی پیش آمد".
 *
 * `extra` lets a caller add one line for a code whose `details` carry numbers
 * worth naming — `BRANCH_IN_USE` is the only current case.
 */
export function MutationError({
  error,
  extra,
  className,
}: {
  error: unknown;
  extra?: Record<string, ReactNode>;
  className?: string;
}) {
  if (!error) return null;

  const code = apiErrorCode(error);
  const failure = accountFailure(code);
  const addition = code ? extra?.[code] : undefined;

  if (failure) {
    return (
      <Notice tone="danger" title={failure.title} className={className}>
        <p>{failure.body}</p>
        {addition ? <p className="mt-1.5">{addition}</p> : null}
      </Notice>
    );
  }

  const api = asApiError(error);

  if (api?.status === 403) {
    return (
      <Notice tone="danger" title="حساب شما اجازهٔ این کار را ندارد" className={className}>
        <p>
          سرور این درخواست را رد کرد و هیچ تغییری ثبت نشد. از مدیر ارشد بخواهید اختیار لازم را به
          نقش شما اضافه کند.
        </p>
      </Notice>
    );
  }

  if (api?.status === 404) {
    return (
      <Notice tone="warning" title="این رکورد دیگر وجود ندارد" className={className}>
        <p>
          ممکن است همین حالا شخص دیگری آن را حذف کرده باشد. صفحه را به‌روز کنید تا وضعیت واقعی را
          ببینید.
        </p>
      </Notice>
    );
  }

  return <FormError error={error} className={className} />;
}

// ---------------------------------------------------------------------------
// The cells every people table repeats
// ---------------------------------------------------------------------------

/**
 * Username over mobile.
 *
 * Both are `<bdi dir="ltr" data-numeric>`: a Latin username and a phone number
 * placed in RTL prose otherwise render with their punctuation on the wrong end,
 * and `09121234567` beside a Persian word becomes genuinely unreadable.
 */
export function UserIdentity({ user, href }: { user: AdminUserRow; href?: Route }) {
  const name = user.username ? (
    <bdi dir="ltr" data-numeric="">
      {user.username}
    </bdi>
  ) : (
    <span className="text-ink-muted">بدون نام کاربری</span>
  );

  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-bold text-ink">
        {href ? (
          <Link href={href} className="text-primary no-underline">
            {name}
          </Link>
        ) : (
          name
        )}
      </p>
      <p className="mt-0.5 truncate text-2xs text-ink-subtle">
        {user.mobile ? (
          <bdi dir="ltr" data-numeric="">
            {user.mobile}
          </bdi>
        ) : (
          "بدون شمارهٔ موبایل"
        )}
      </p>
    </div>
  );
}

/**
 * Staff or customer.
 *
 * There is NO `kind` column in the database. A staff account is precisely an
 * account that has a username and a password hash; a customer account has a
 * mobile number and signs in with a one-time code. `isStaff` on the wire is
 * that same derivation, made server-side.
 */
export function AccountKindBadge({ user }: { user: AdminUserRow }) {
  return (
    <Badge size="sm" tone={user.isStaff ? "primary" : "neutral"}>
      {user.isStaff ? "کارمند" : "مشتری"}
    </Badge>
  );
}

/**
 * Role badges, in Persian, with an inactive role called out.
 *
 * A deactivated role grants NOTHING even while it is still assigned, so hiding
 * that state would make the permissions section below look wrong for no
 * visible reason.
 */
export function RoleBadges({ roles }: { roles: AdminRoleRef[] }) {
  if (roles.length === 0) {
    return <span className="text-2xs text-ink-subtle">بدون نقش</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((role) => {
        const tone: BadgeTone = !role.isActive ? "warning" : role.isSystem ? "primary" : "accent";
        return (
          <Badge key={role.id} size="sm" tone={tone}>
            {role.titleFa}
            {!role.isActive ? " — نقش غیرفعال" : ""}
          </Badge>
        );
      })}
    </span>
  );
}

/** Branch name, plus the warning that makes a cashier unable to sell. */
export function BranchCell({ user }: { user: AdminUserRow }) {
  if (user.branchId === null) {
    return <span className="text-2xs text-ink-subtle">بدون شعبه</span>;
  }

  const name = user.branchName ?? `شعبهٔ ${user.branchId}`;

  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-ink">
        <Gate permissions={["branches.read"]} fallback={<span>{name}</span>}>
          <Link href={adminBranchHref(user.branchId)} className="no-underline">
            {name}
          </Link>
        </Gate>
      </p>
      {user.branchIsActive === false ? (
        <p className="mt-1">
          <Badge size="sm" tone="warning">
            شعبه غیرفعال است
          </Badge>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A link to one user's page — rendered as plain text for a caller who cannot
 * open it.
 *
 * The branch screens are reachable with `branches.read` alone, and sending
 * somebody who holds only that to `/admin/users/12` lands them on a "you do
 * not have the required authority" card. A gate here is a courtesy, not a
 * control: the route re-checks on every request regardless.
 */
export function UserLink({
  id,
  children,
  className,
}: {
  id: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Gate permissions={["users.read"]} fallback={<>{children}</>}>
      <Link href={adminUserHref(id)} className={className}>
        {children}
      </Link>
    </Gate>
  );
}

/** The same courtesy for a link INTO the directory, pre-filtered. */
export function UsersListLink({
  query,
  children,
  className,
}: {
  query: Record<string, string | number | boolean | null | undefined>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Gate permissions={["users.read"]} fallback={<>{children}</>}>
      <Link href={adminUsersHref(query)} className={className}>
        {children}
      </Link>
    </Gate>
  );
}

export function AccountStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <Badge size="sm" tone={isActive ? "success" : "danger"}>
      {isActive ? "فعال" : "غیرفعال"}
    </Badge>
  );
}

/**
 * WHICH SURFACES this account can open a session on.
 *
 * Decided by a PERMISSION on one of the account's roles, not by a role name:
 * `admin.access` opens the console, `pos.access` opens the till. So a custom
 * role can let somebody into the till without making them an administrator,
 * and this column is the only place that fact is visible in a list.
 */
export function SurfaceBadges({ canAccess }: { canAccess: AdminUserRow["canAccess"] }) {
  const allowed = ACCOUNT_SURFACES.filter((surface) => canAccess[surface]);
  if (allowed.length === 0) {
    return <span className="text-2xs text-ink-subtle">هیچ‌کدام</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {allowed.map((surface) => (
        <Badge key={surface} size="sm" tone={surface === "pos" ? "info" : "neutral"}>
          {surfaceLabel(surface)}
        </Badge>
      ))}
    </span>
  );
}
