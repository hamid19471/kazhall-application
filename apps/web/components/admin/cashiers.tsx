"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";

import { Badge, Button, ErrorState } from "@kazhal/ui";
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
  AccountStatusBadge,
  BranchCell,
  UserIdentity,
  idParam,
  pageInfoOf,
} from "@/components/admin/people-shared";
import { useAppSession } from "@/components/providers";
import { can } from "@/lib/permissions";
import { PlusIcon, TillIcon } from "@/components/icons";
import { fetchBranches, fetchCashiers } from "@/lib/admin-api";
import type { AdminCashierRow, AdminUserFilters } from "@/lib/admin-api";
import { cashierBlockedReasonLabel } from "@/lib/labels";
import { adminCashiersHref, adminUserHref } from "@/lib/routes";
import { enumParam, pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 20;
const BRANCH_OPTION_LIMIT = 100;
const STATUSES = ["active", "deactivated"] as const;

/**
 * CASHIER ACCOUNTS — and nothing else.
 *
 * THIS SYSTEM HAS NO CONCEPT OF A PHYSICAL TILL. There is no terminal entity,
 * no register id, and nothing on a sale that records which machine rang it up
 * beyond the cashier and the branch. So "disable that register" is not a thing
 * this console can do, and no affordance here should imply otherwise. The
 * equivalent operation is to deactivate a cashier's ACCOUNT, or the BRANCH.
 *
 * `canSellNow` is the honest composite of every predicate `POST /orders/pos`
 * will evaluate at the till, which is the whole point of the page: the manager
 * finds out here, not the cashier at 9am with a customer waiting.
 */
export function AdminCashiers({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["users.read"]}>
      <CashiersBody filters={parseFilters(params)} />
    </RequirePermission>
  );
}

interface Filters extends AdminUserFilters {
  page: number;
}

function parseFilters(params: RawSearchParams): Filters {
  return {
    page: pageParam(params),
    search: textParam(params, "search"),
    branchId: idParam(params, "branchId"),
    status: enumParam(params, "status", STATUSES),
  };
}

function CashiersBody({ filters }: { filters: Filters }) {
  const api = useApi();
  const router = useRouter();
  const { session } = useAppSession();

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchCashiers(api, { ...filters, limit: PAGE_SIZE }, { signal }),
    [api, JSON.stringify(filters)],
  );

  /*
   * The branch list only LABELS the branch filter, and `GET /branch` declares
   * `branches.read` — which this page's own `users.read` does not imply. Firing
   * it regardless produced a 403 on every load for a staff manager who has no
   * business reading the branch register; not firing it costs the filter,
   * which is hidden rather than rendered empty.
   */
  const canReadBranches = can(session, "branches.read");
  const branches = useApiQuery(
    (signal) => fetchBranches(api, { limit: BRANCH_OPTION_LIMIT }, { signal }),
    [api],
    { enabled: canReadBranches },
  );

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
      adminCashiersHref({
        search: field("search"),
        branchId: field("branchId"),
        status: field("status"),
      }),
    );
  }

  const header = (
    <AdminPageHeader
      title="صندوق‌داران"
      description="کارکنانی که نقششان اجازهٔ باز‌کردن صندوق فروشگاه را می‌دهد، همراه با پاسخ یک سؤال: همین حالا می‌تواند بفروشد یا نه؟"
      actions={
        <Gate permissions={["users.create"]}>
          <Link href="/admin/cashiers/new" className="no-underline">
            <Button leadingIcon={<PlusIcon className="size-4" />}>صندوق‌دار تازه</Button>
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
          title="فهرست صندوق‌داران خوانده نشد"
          description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد. هیچ حسابی تغییر نکرده است."
          onRetry={refetch}
        />
      </>
    );
  }

  return (
    <>
      {header}

      <Notice tone="info" className="mb-5" icon={<TillIcon className="size-5" />}>
        <p>
          این صفحه <b>حساب‌های صندوق‌دار</b> را اداره می‌کند، نه دستگاه‌های صندوق را. در این سامانه
          اصلاً موجودیتی به نام «صندوق» یا «پایانهٔ فروش» وجود ندارد: روی هیچ فروشی ثبت نمی‌شود که
          کدام دستگاه فیزیکی آن را زده است، و تنها چیزی که ثبت می‌شود فروشنده و شعبه است. پس
          «غیرفعال‌کردن یک صندوق» کاری نیست که از این سامانه بربیاید؛ آنچه می‌شود غیرفعال کرد،
          حسابِ صندوق‌دار است یا خودِ شعبه.
        </p>
      </Notice>

      <FilterBar onSubmit={apply} onReset={() => router.push(adminCashiersHref())}>
        <SearchField
          label="جست‌وجو در نام کاربری و شمارهٔ موبایل"
          defaultValue={filters.search ?? ""}
        />
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
      </FilterBar>

      {isLoading || !data ? (
        <TableSkeleton rows={6} columns={5} />
      ) : (
        <>
          {/*
            `filteredOut` exists so this page can EXPLAIN a short page instead
            of looking broken. The `pos.access` test needs roles expanded into
            capabilities, which the SQL page query cannot do, so it runs after
            the page is fetched and may drop rows from it.
          */}
          {data.filteredOut > 0 ? (
            <Notice tone="neutral" className="mb-4">
              <p>
                در این صفحه {count(data.filteredOut)} حساب کنار گذاشته شد، چون اختیار باز‌کردن
                صندوق را ندارند. این آزمون پس از خواندن صفحه انجام می‌شود، پس ممکن است تعداد
                ردیف‌های این صفحه از اندازهٔ صفحه کمتر باشد. شماره‌گذاری صفحه‌ها بر اساس شمار کل
                کارکنان انجام می‌شود، نه بر اساس ردیف‌های باقی‌مانده.
              </p>
            </Notice>
          ) : null}

          <DataTable minWidth="58rem" caption="فهرست صندوق‌داران">
            <thead>
              <tr>
                <Th>صندوق‌دار</Th>
                <Th>شعبه</Th>
                <Th>می‌تواند بفروشد؟</Th>
                <Th>وضعیت حساب</Th>
                <Th numeric>نشست‌های باز</Th>
                <Th>
                  <span className="kz-sr-only">اقدام</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.data.length === 0 ? (
                <EmptyRow colSpan={6}>
                  صندوق‌داری با این فیلترها پیدا نشد. اگر هنوز کسی ساخته نشده، از «صندوق‌دار تازه»
                  شروع کنید.
                </EmptyRow>
              ) : (
                data.data.map((cashier) => (
                  <Tr key={cashier.id}>
                    <Td>
                      <UserIdentity user={cashier} href={adminUserHref(cashier.id)} />
                    </Td>
                    <Td>
                      <BranchCell user={cashier} />
                    </Td>
                    <Td>
                      <SellingCell cashier={cashier} />
                    </Td>
                    <Td>
                      <AccountStatusBadge isActive={cashier.isActive} />
                    </Td>
                    <Td numeric>{count(cashier.activeSessionCount)}</Td>
                    <Td>
                      <Link href={adminUserHref(cashier.id)} className="whitespace-nowrap text-xs">
                        مدیریت حساب ←
                      </Link>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </DataTable>

          <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
            ستون «نشست‌های باز» شمار نشست‌های این حساب در <b>همهٔ</b> سطوح است، نه فقط صندوق: این
            فهرست تفکیک به‌ازای سطح را برنمی‌گرداند. برای دیدن اینکه چند نشست از آنِ صندوق است،
            صفحهٔ خود کاربر را باز کنید.
          </p>

          <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
            همهٔ کارها — تغییر شعبه، قطع نشست‌ها، بازنشانی گذرواژه و فعال یا غیرفعال‌کردن حساب — در
            صفحهٔ خود کاربر انجام می‌شود، تا یک عملیات دو جای متفاوت نداشته باشد.
          </p>

          <Pagination
            className="mt-8"
            pageInfo={pageInfoOf(data)}
            buildHref={(target) =>
              adminCashiersHref({
                search: filters.search,
                branchId: filters.branchId,
                status: filters.status,
                ...(target > 1 ? { page: target } : {}),
              })
            }
          />
        </>
      )}
    </>
  );
}

/**
 * The one column this page exists for.
 *
 * `password_change_required` is the interesting case: the server still reports
 * `canSellNow: true` for it, because the till lets the cashier in and then
 * forces the change. Rendering it as a flat "no" would be wrong, and hiding it
 * would leave the manager surprised at the till — so it is a "yes" with the
 * obstacle named.
 */
function SellingCell({ cashier }: { cashier: AdminCashierRow }) {
  const reason = cashierBlockedReasonLabel(cashier.blockedReason);

  if (cashier.canSellNow) {
    return (
      <div className="min-w-0">
        <Badge size="sm" tone="success">
          بله
        </Badge>
        {reason ? <p className="mt-1 text-2xs text-warning">اما {reason}.</p> : null}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <Badge size="sm" tone="danger">
        خیر
      </Badge>
      <p className="mt-1 text-2xs text-ink-muted">{reason || "دلیل آن اعلام نشده است."}</p>
    </div>
  );
}
