"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";

import { Button, ErrorState } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, Pagination } from "@/components/common";
import {
  AdminPageHeader,
  DataTable,
  EmptyRow,
  FilterBar,
  Gate,
  RequirePermission,
  SearchField,
  Select,
  TableSkeleton,
  Td,
  Th,
  Tr,
  count,
} from "@/components/admin/ui";
import {
  AccountKindBadge,
  AccountStatusBadge,
  BranchCell,
  RoleBadges,
  SurfaceBadges,
  UserIdentity,
  idParam,
  pageInfoOf,
} from "@/components/admin/people-shared";
import { useAppSession } from "@/components/providers";
import { can } from "@/lib/permissions";
import { PlusIcon, UsersIcon } from "@/components/icons";
import { fetchBranches, fetchRoles, fetchUsers } from "@/lib/admin-api";
import type { AdminUserFilters } from "@/lib/admin-api";
import { adminUserHref, adminUsersHref } from "@/lib/routes";
import { enumParam, pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 20;

/** Every branch the filter can offer. The API caps `limit` at 100. */
const BRANCH_OPTION_LIMIT = 100;

const STATUSES = ["active", "deactivated"] as const;
const KINDS = ["staff", "customer"] as const;

/**
 * THE ACCOUNT DIRECTORY.
 *
 * One list for staff and customers alike, because they are one table. The
 * screen's whole job is to make the derivation visible: the thing that makes an
 * account a staff account is that it HAS A USERNAME, and therefore a password;
 * a customer has a mobile number and a one-time code. There is no `kind`
 * column anywhere in the database to read instead, so the `kind` filter is a
 * predicate over `username IS NOT NULL`, not a lookup.
 */
export function AdminUsers({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["users.read"]}>
      <UsersBody filters={parseFilters(params)} />
    </RequirePermission>
  );
}

interface Filters extends AdminUserFilters {
  page: number;
}

/**
 * The URL is the only source of the filter state.
 *
 * Anything unparseable is DROPPED rather than passed on: `?roleId=abc` becomes
 * "no role filter", not a 400 from the API, and `?status=banana` becomes "any
 * status" instead of an empty table the operator cannot explain.
 */
function parseFilters(params: RawSearchParams): Filters {
  return {
    page: pageParam(params),
    search: textParam(params, "search"),
    roleId: idParam(params, "roleId"),
    branchId: idParam(params, "branchId"),
    status: enumParam(params, "status", STATUSES),
    kind: enumParam(params, "kind", KINDS),
  };
}

function UsersBody({ filters }: { filters: Filters }) {
  const api = useApi();
  const router = useRouter();
  const { session } = useAppSession();

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchUsers(api, { ...filters, limit: PAGE_SIZE }, { signal }),
    [api, JSON.stringify(filters)],
  );

  /*
   * The role and branch lists exist ONLY to label the two id filters. They are
   * fetched separately and their failure is not this screen's failure: a
   * directory that refuses to render because the branch dropdown could not
   * load is worse than a directory with a shorter dropdown.
   *
   * NEITHER IS ATTEMPTED WITHOUT THE CAPABILITY IT NEEDS. `GET
   * /admin/access/roles` declares `rbac.read` and `GET /branch` declares
   * `branches.read`; a user manager holding neither would otherwise fire two
   * requests on every load that the server answers 403 — noise in the network
   * panel and in the audit trail that tells nobody anything. When the list
   * cannot be read the FILTER IS NOT RENDERED either: an "all roles" dropdown
   * with no roles in it is a broken control, not a degraded one.
   */
  const canReadRoles = can(session, "rbac.read");
  const canReadBranches = can(session, "branches.read");

  const roles = useApiQuery((signal) => fetchRoles(api, { signal }), [api], {
    enabled: canReadRoles,
  });
  const branches = useApiQuery(
    (signal) => fetchBranches(api, { limit: BRANCH_OPTION_LIMIT }, { signal }),
    [api],
    { enabled: canReadBranches },
  );

  /** Filters live in the URL, so a filtered directory can be shared and restored. */
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string): string | undefined => {
      const raw = form.get(name);
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim().slice(0, 200);
      return trimmed === "" ? undefined : trimmed;
    };
    router.push(
      adminUsersHref({
        search: field("search"),
        roleId: field("roleId"),
        branchId: field("branchId"),
        status: field("status"),
        kind: field("kind"),
      }),
    );
  }

  const header = (
    <AdminPageHeader
      title="کاربران"
      description={
        <>
          هر دو نوع حساب در همین فهرست‌اند. حساب <b>کارمند</b> با نام کاربری و گذرواژه وارد می‌شود و
          حساب <b>مشتری</b> با کد یک‌بارمصرف پیامکی. در پایگاه داده هیچ ستونی به نام «نوع حساب»
          وجود ندارد: تفاوت این دو دقیقاً همین است که حساب کارمند نام کاربری دارد و حساب مشتری
          ندارد.
        </>
      }
      actions={
        <Gate permissions={["users.create"]}>
          <Link href="/admin/users/new" className="no-underline">
            <Button leadingIcon={<PlusIcon className="size-4" />}>کاربر تازه</Button>
          </Link>
        </Gate>
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState
          error={error}
          title="فهرست کاربران خوانده نشد"
          description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد. هیچ حسابی تغییر نکرده است."
          onRetry={refetch}
        />
      </>
    );
  }

  return (
    <>
      {header}

      <Notice tone="info" className="mb-5" icon={<UsersIcon className="size-5" />}>
        <p>
          ستون «دسترسی» می‌گوید این حساب کدام سطح‌ها را می‌تواند باز کند، و از اختیارات نقش‌های او
          می‌آید نه از نام نقش: نقشی که <bdi dir="ltr">pos.access</bdi> دارد صندوق را باز می‌کند و
          نقشی که <bdi dir="ltr">admin.access</bdi> دارد پنل مدیریت را — بدون اینکه لازم باشد کسی
          مدیر کل شود.
        </p>
      </Notice>

      <FilterBar onSubmit={apply} onReset={() => router.push(adminUsersHref())}>
        <SearchField
          label="جست‌وجو در نام کاربری و شمارهٔ موبایل"
          defaultValue={filters.search ?? ""}
          placeholder="مثلاً kazhal یا ۰۹۱۲…"
        />
        {canReadRoles ? (
          <Select
            name="roleId"
            label="نقش"
            key={`role-${filters.roleId ?? ""}`}
            defaultValue={filters.roleId === undefined ? "" : String(filters.roleId)}
            options={[
              { value: "", label: "همهٔ نقش‌ها" },
              ...(roles.data ?? []).map((role) => ({
                value: String(role.id),
                label: role.isActive ? role.titleFa : `${role.titleFa} (نقش غیرفعال)`,
              })),
            ]}
          />
        ) : null}
        {canReadBranches ? (
          <Select
            name="branchId"
            label="شعبه"
            key={`branch-${filters.branchId ?? ""}`}
            defaultValue={filters.branchId === undefined ? "" : String(filters.branchId)}
            options={[
              { value: "", label: "همهٔ شعبه‌ها" },
              ...(branches.data?.data ?? []).map((branch) => ({
                value: String(branch.id),
                label: branch.isActive ? branch.name : `${branch.name} (غیرفعال)`,
              })),
            ]}
          />
        ) : null}
        <Select
          name="status"
          label="وضعیت حساب"
          key={`status-${filters.status ?? ""}`}
          defaultValue={filters.status ?? ""}
          options={[
            { value: "", label: "فعال و غیرفعال" },
            { value: "active", label: "فقط حساب‌های فعال" },
            { value: "deactivated", label: "فقط حساب‌های غیرفعال" },
          ]}
        />
        <Select
          name="kind"
          label="نوع حساب"
          key={`kind-${filters.kind ?? ""}`}
          defaultValue={filters.kind ?? ""}
          hint="کارمند = دارای نام کاربری؛ مشتری = بدون نام کاربری."
          options={[
            { value: "", label: "کارمند و مشتری" },
            { value: "staff", label: "فقط کارمندان" },
            { value: "customer", label: "فقط مشتریان" },
          ]}
        />
      </FilterBar>

      {isLoading || !data ? (
        <TableSkeleton rows={8} columns={6} />
      ) : (
        <>
          <DataTable minWidth="66rem" caption="فهرست کاربران">
            <thead>
              <tr>
                <Th>حساب</Th>
                <Th>نقش‌ها</Th>
                <Th>شعبه</Th>
                <Th>وضعیت</Th>
                <Th>دسترسی</Th>
                <Th numeric>نشست‌های باز</Th>
                <Th>
                  <span className="kz-sr-only">اقدام</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.data.length === 0 ? (
                <EmptyRow colSpan={7}>
                  با این فیلترها حسابی پیدا نشد. فیلترها را بردارید تا مطمئن شوید حسابی پشت آن‌ها
                  پنهان نمانده است.
                </EmptyRow>
              ) : (
                data.data.map((user) => (
                  <Tr key={user.id}>
                    <Td>
                      <div className="flex items-start gap-2">
                        <UserIdentity user={user} href={adminUserHref(user.id)} />
                        <AccountKindBadge user={user} />
                      </div>
                    </Td>
                    <Td>
                      <RoleBadges roles={user.roles} />
                    </Td>
                    <Td>
                      <BranchCell user={user} />
                    </Td>
                    <Td>
                      <AccountStatusBadge isActive={user.isActive} />
                      {user.mustChangePassword ? (
                        <p className="mt-1 text-2xs text-warning">
                          باید در ورود بعدی گذرواژه را عوض کند
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      <SurfaceBadges canAccess={user.canAccess} />
                    </Td>
                    <Td numeric>{count(user.activeSessionCount)}</Td>
                    <Td>
                      <Link href={adminUserHref(user.id)} className="whitespace-nowrap text-xs">
                        مدیریت حساب ←
                      </Link>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </DataTable>

          <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
            «نشست‌های باز» شمار نشست‌های فعال هر حساب در همهٔ سطوح روی هم است؛ این فهرست تفکیک
            به‌ازای سطح را برنمی‌گرداند. برای دیدن اینکه چند نشست از آنِ صندوق است و چند نشست از
            آنِ پنل مدیریت، صفحهٔ خود کاربر را باز کنید.
          </p>

          <Pagination
            className="mt-8"
            pageInfo={pageInfoOf(data)}
            buildHref={(target) =>
              adminUsersHref({
                search: filters.search,
                roleId: filters.roleId,
                branchId: filters.branchId,
                status: filters.status,
                kind: filters.kind,
                ...(target > 1 ? { page: target } : {}),
              })
            }
          />
        </>
      )}
    </>
  );
}
