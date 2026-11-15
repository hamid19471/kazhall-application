"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";

import { Badge, Button, ErrorState, Input, PersianDateRangeFields, readDayRange } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, Pagination } from "@/components/common";
import { useAppSession } from "@/components/providers";
import {
  AdminPageHeader,
  AdminSection,
  DataTable,
  EmptyRow,
  FilterBar,
  RequirePermission,
  SearchField,
  Select,
  TableSkeleton,
  Td,
  Th,
  Tr,
  count,
  when,
} from "@/components/admin/ui";
import { EyeIcon, RefreshIcon } from "@/components/icons";
import {
  ADMIN_FULFILLMENT_STATES,
  ADMIN_ORDER_DATE_FIELDS,
  ADMIN_ORDER_PAYMENT_STATES,
  ADMIN_ORDER_STATUSES,
  ADMIN_RECONCILIATION_FILTERS,
  fetchBranches,
  fetchCashiers,
  fetchOrders,
} from "@/lib/admin-api";
import type { AdminOrderFilters, AdminOrderRow } from "@/lib/admin-api";
import {
  ORDER_DATE_FIELD_NOTE,
  ORDER_PAYMENT_STATE_NOTE,
  channelLabel,
  fulfillmentStateLabel,
  fulfillmentStateTone,
  orderDateFieldLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentStateLabel,
  paymentStateTone,
  reconciliationStateLabel,
  reconciliationStateTone,
} from "@/lib/labels";
import { formatRialString } from "@/lib/money";
import { can } from "@/lib/permissions";
import { adminOrderHref, adminOrdersHref } from "@/lib/routes";
import { enumParam, intParam, localDateParam, pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 20;

const CHANNELS = ["online", "pos"] as const;

/**
 * ===========================================================================
 * THE ORDER LIST
 * ===========================================================================
 *
 * ## Every filter is in the URL, and every filter is server-side
 *
 * `GET /orders` is a bounded, filtered projection: there is no mode that
 * returns everything, and the whitelisting `ValidationPipe` answers 400 for a
 * key it does not declare rather than quietly returning an UNFILTERED list. So
 * the URL is the whole filter state, which also makes "paid orders in Sanandaj
 * that are still awaiting stock" a link somebody can be sent rather than a
 * sequence of clicks they have to be talked through.
 *
 * ## The three date axes are not interchangeable
 *
 * `from`/`to` are INCLUSIVE local calendar days in the report timezone
 * (Asia/Tehran), and `dateField` chooses WHICH timestamp they apply to. That is
 * not a convenience: an online basket checked out on the last day of a month
 * and paid on the first of the next belongs to one month's SALES and the other
 * month's MONEY, and a screen that ranged everything on `soldAt` would answer
 * the revenue question wrongly while looking right.
 *
 * ## Customer identity is minimal here on purpose
 *
 * `customerDisplay` is a name or an ALREADY-MASKED telephone number, masked by
 * the server. Nothing on this screen tries to enrich or un-mask it, and the
 * full address and telephone number are only on the order's own page — a page
 * an operator has to open deliberately, one order at a time. An operator
 * scanning order numbers has no business being handed two hundred customers'
 * addresses to get there.
 *
 * ## Money is never parsed
 *
 * Every Rial figure arrives as a string over a PostgreSQL `bigint`.
 * `formatRialString` groups the digits without converting to a `number`.
 */
export function AdminOrders({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["orders.read"]}>
      <OrdersBody params={params} />
    </RequirePermission>
  );
}

/**
 * The URL, parsed.
 *
 * Anything unrecognised becomes `undefined` rather than being passed through:
 * `query()` in `lib/admin-api.ts` then drops the key, so a hand-edited
 * `?status=nonsense` searches without a status filter instead of provoking a
 * 400 the operator cannot act on. `dateField` is the one exception — it has a
 * real server default (`sold`) and is always sent, so the screen and the server
 * cannot disagree about which axis the range ran on.
 */
function readFilters(params: RawSearchParams): AdminOrderFilters & { page: number } {
  return {
    page: pageParam(params),
    search: textParam(params, "search", 64),
    channel: enumParam(params, "channel", CHANNELS),
    status: enumParam(params, "status", ADMIN_ORDER_STATUSES),
    fulfillmentState: enumParam(params, "fulfillmentState", ADMIN_FULFILLMENT_STATES),
    paymentState: enumParam(params, "paymentState", ADMIN_ORDER_PAYMENT_STATES),
    branchId: idParam(params, "branchId"),
    cashierUserId: idParam(params, "cashierUserId"),
    reconciliationState: enumParam(
      params,
      "reconciliationState",
      ADMIN_RECONCILIATION_FILTERS,
    ),
    from: localDateParam(params, "from"),
    to: localDateParam(params, "to"),
    dateField: enumParam(params, "dateField", ADMIN_ORDER_DATE_FIELDS) ?? "sold",
  };
}

/** A positive row id. The API's `@Min(1)` rejects 0, so 0 is not a filter. */
function idParam(params: RawSearchParams, key: string): number | undefined {
  const parsed = intParam(params, key);
  return parsed !== undefined && parsed >= 1 ? parsed : undefined;
}

function OrdersBody({ params }: { params: RawSearchParams }) {
  const api = useApi();
  const router = useRouter();
  const { session } = useAppSession();
  const filters = readFilters(params);

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchOrders(api, { ...filters, limit: PAGE_SIZE }, { signal }),
    [api, JSON.stringify(filters)],
  );

  /*
   * The branch and cashier pickers are extra reads, so they are only attempted
   * when the caller actually holds the capability that serves them. Without it
   * the same filter is still available as a numeric field — a delegated order
   * manager who may not browse the staff directory can still be told "filter on
   * cashier 7" and do it, rather than losing the filter altogether.
   */
  const mayListBranches = can(session, "branches.read");
  const mayListStaff = can(session, "users.read");

  const branches = useApiQuery(
    (signal) => fetchBranches(api, { limit: 100 }, { signal }),
    [api],
    { enabled: mayListBranches },
  );
  const cashiers = useApiQuery(
    (signal) => fetchCashiers(api, { limit: 100 }, { signal }),
    [api],
    { enabled: mayListStaff },
  );

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string): string | undefined => {
      const value = form.get(key);
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    };
    // A reversed range is refused where it is shown; nothing is swapped or sent.
    const range = readDayRange(form);
    if (range.error) return;

    /*
     * `page` is deliberately NOT carried over. A filter change produces a
     * different result set, so keeping page 4 would land the operator on an
     * empty page of a list they have not seen the start of.
     */
    router.push(
      adminOrdersHref({
        search: field("search"),
        channel: field("channel"),
        status: field("status"),
        fulfillmentState: field("fulfillmentState"),
        paymentState: field("paymentState"),
        branchId: field("branchId"),
        cashierUserId: field("cashierUserId"),
        reconciliationState: field("reconciliationState"),
        from: range.from,
        to: range.to,
        // The server's own default; omitting it keeps the URL readable.
        dateField: field("dateField") === "sold" ? undefined : field("dateField"),
      }),
    );
  }

  /** The current filters, minus the page — for building a page link. */
  const pageQuery = {
    search: filters.search,
    channel: filters.channel,
    status: filters.status,
    fulfillmentState: filters.fulfillmentState,
    paymentState: filters.paymentState,
    branchId: filters.branchId,
    cashierUserId: filters.cashierUserId,
    reconciliationState: filters.reconciliationState,
    from: filters.from,
    to: filters.to,
    dateField: filters.dateField === "sold" ? undefined : filters.dateField,
  };

  return (
    <>
      <AdminPageHeader
        title="سفارش‌ها"
        description={
          <>
            سفارش‌های سایت و صندوق فروشگاه، در یک فهرست. بازهٔ «از تاریخ» و «تا تاریخ»{" "}
            <b>روزهای تقویمی کامل به وقت رسمی تهران</b> است و هر دو سرِ بازه شامل می‌شوند؛
            «محور تاریخ» تعیین می‌کند این بازه روی کدام تاریخ سفارش اعمال شود. همهٔ مبالغ به
            ریال است.
          </>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={refetch}
            leadingIcon={<RefreshIcon className="size-4" />}
          >
            به‌روزرسانی
          </Button>
        }
      />

      <Notice tone="info" className="mb-5" icon={<EyeIcon className="size-5" />}>
        <p>
          در این فهرست از هر مشتری فقط <b>کمینهٔ هویت</b> نمایش داده می‌شود: نام، یا شمارهٔ
          موبایلِ ماسک‌شده (مثل <bdi dir="ltr" data-numeric="">***۱۲۳۴</bdi>). ماسک‌کردن در
          سرور انجام می‌شود و این صفحه تلاشی برای برداشتن آن نمی‌کند. نشانی کامل و شمارهٔ کامل
          موبایل فقط در صفحهٔ خودِ سفارش دیده می‌شود — جایی که باید عمداً و یکی‌یکی باز شود.
        </p>
      </Notice>

      <FilterBar key={JSON.stringify(filters)} onSubmit={apply} onReset={() => router.push(adminOrdersHref())}>
        <SearchField
          label="جست‌وجو"
          defaultValue={filters.search ?? ""}
          placeholder="شمارهٔ سفارش یا شناسهٔ عددی"
        />

        <Select
          name="channel"
          label="کانال فروش"
          defaultValue={filters.channel ?? ""}
          options={[
            { value: "", label: "هر دو کانال" },
            ...CHANNELS.map((value) => ({ value, label: channelLabel(value) })),
          ]}
        />

        <Select
          name="status"
          label="وضعیت سفارش (پول)"
          defaultValue={filters.status ?? ""}
          options={[
            { value: "", label: "همهٔ وضعیت‌ها" },
            ...ADMIN_ORDER_STATUSES.map((value) => ({
              value,
              label: orderStatusLabel(value),
            })),
          ]}
        />

        <Select
          name="fulfillmentState"
          label="وضعیت آماده‌سازی (کالا)"
          hint="مستقل از وضعیت پول نگه داشته می‌شود."
          defaultValue={filters.fulfillmentState ?? ""}
          options={[
            { value: "", label: "همهٔ وضعیت‌ها" },
            ...ADMIN_FULFILLMENT_STATES.map((value) => ({
              value,
              label: fulfillmentStateLabel(value),
            })),
          ]}
        />

        <Select
          name="paymentState"
          label="وضعیت پرداخت (محاسبه‌شده)"
          hint={ORDER_PAYMENT_STATE_NOTE.none}
          defaultValue={filters.paymentState ?? ""}
          options={[
            { value: "", label: "همهٔ وضعیت‌ها" },
            ...ADMIN_ORDER_PAYMENT_STATES.map((value) => ({
              value,
              label: paymentStateLabel(value),
            })),
          ]}
        />

        {mayListBranches ? (
          <Select
            name="branchId"
            label="شعبه"
            hint="سفارش اینترنتی شعبه ندارد؛ انتخاب شعبه آن‌ها را از فهرست خارج می‌کند."
            defaultValue={filters.branchId === undefined ? "" : String(filters.branchId)}
            options={[
              { value: "", label: "همهٔ شعبه‌ها و سایت" },
              ...optionsWithCurrent(
                (branches.data?.data ?? []).map((branch) => ({
                  value: String(branch.id),
                  label: branch.isActive ? branch.name : `${branch.name} (غیرفعال)`,
                })),
                filters.branchId,
                (id) => `شعبهٔ شمارهٔ ${count(id)}`,
              ),
            ]}
          />
        ) : (
          <Input
            name="branchId"
            label="شناسهٔ شعبه"
            numeric
            hint="فهرست شعبه‌ها برای حساب شما قابل مشاهده نیست؛ شناسهٔ عددی را وارد کنید."
            defaultValue={filters.branchId === undefined ? "" : String(filters.branchId)}
            containerClassName="min-w-0"
          />
        )}

        {mayListStaff ? (
          <Select
            name="cashierUserId"
            label="فروشندهٔ ثبت‌کنندهٔ فروش"
            hint="همان کسی که فروش را زده است — نه کسی که بعداً آن را ابطال یا مرجوع کرده."
            defaultValue={
              filters.cashierUserId === undefined ? "" : String(filters.cashierUserId)
            }
            options={[
              { value: "", label: "همهٔ فروشندگان" },
              ...optionsWithCurrent(
                (cashiers.data?.data ?? []).map((user) => ({
                  value: String(user.id),
                  label: user.isActive ? user.identifier : `${user.identifier} (غیرفعال)`,
                })),
                filters.cashierUserId,
                (id) => `کاربر شمارهٔ ${count(id)}`,
              ),
            ]}
          />
        ) : (
          <Input
            name="cashierUserId"
            label="شناسهٔ فروشنده"
            numeric
            hint="فهرست کارکنان برای حساب شما قابل مشاهده نیست؛ شناسهٔ عددی را وارد کنید."
            defaultValue={
              filters.cashierUserId === undefined ? "" : String(filters.cashierUserId)
            }
            containerClassName="min-w-0"
          />
        )}

        <Select
          name="reconciliationState"
          label="پروندهٔ مغایرت پرداخت"
          hint="«بدون پرونده» یعنی هرگز بررسی نشده — که با «باز» یکی نیست."
          defaultValue={filters.reconciliationState ?? ""}
          options={[
            { value: "", label: "مهم نیست" },
            ...ADMIN_RECONCILIATION_FILTERS.map((value) => ({
              value,
              label: value === "none" ? "بدون پرونده (بررسی‌نشده)" : reconciliationStateLabel(value),
            })),
          ]}
        />

        <Select
          name="dateField"
          label="محور تاریخ"
          hint={ORDER_DATE_FIELD_NOTE[filters.dateField ?? "sold"]}
          defaultValue={filters.dateField ?? "sold"}
          options={ADMIN_ORDER_DATE_FIELDS.map((value) => ({
            value,
            label: orderDateFieldLabel(value),
          }))}
        />

        <PersianDateRangeFields
          fromLabel="از تاریخ (شامل همان روز)"
          toLabel="تا تاریخ (شامل همان روز)"
          defaultFrom={filters.from}
          defaultTo={filters.to}
          containerClassName="min-w-0"
        />
      </FilterBar>

      {error ? (
        <ErrorState
          error={error}
          title="فهرست سفارش‌ها خوانده نشد"
          description="ممکن است یکی از فیلترها را سرور نپذیرفته باشد، یا ارتباط برقرار نشده باشد."
          onRetry={refetch}
        />
      ) : isLoading || !data ? (
        <AdminSection title="سفارش‌ها">
          <TableSkeleton rows={8} columns={6} />
        </AdminSection>
      ) : (
        <AdminSection
          title="سفارش‌ها"
          description={
            <>
              <bdi data-numeric="">{count(data.total)}</bdi> سفارش با این فیلترها. ترتیب:
              تازه‌ترین فروش در بالا.
            </>
          }
        >
          <DataTable minWidth="76rem" caption="فهرست سفارش‌ها">
            <thead>
              <tr>
                <Th>شمارهٔ سفارش</Th>
                <Th>کانال</Th>
                <Th>وضعیت سفارش</Th>
                <Th>آماده‌سازی</Th>
                <Th>پرداخت</Th>
                <Th>شعبه</Th>
                <Th>فروشنده</Th>
                <Th>مشتری</Th>
                <Th numeric>اقلام / تعداد</Th>
                <Th numeric>مبلغ</Th>
                <Th>تاریخ فروش</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.length === 0 ? (
                <EmptyRow colSpan={11}>
                  سفارشی با این فیلترها پیدا نشد. اگر انتظار داشتید چیزی ببینید، بازهٔ تاریخ و
                  «محور تاریخ» را بررسی کنید — سفارش پرداخت‌نشده تاریخ دریافت وجه ندارد و با
                  محور «تاریخ دریافت وجه» در هیچ بازه‌ای نمی‌آید.
                </EmptyRow>
              ) : (
                data.data.map((order) => <OrderRow key={order.id} order={order} />)
              )}
            </tbody>
          </DataTable>

          <Pagination
            className="mt-6"
            pageInfo={{
              page: data.page,
              limit: data.limit,
              total: data.total,
              totalPages: Math.max(1, data.totalPages),
              hasNextPage: data.page < data.totalPages,
              hasPreviousPage: data.page > 1,
            }}
            buildHref={(target) =>
              adminOrdersHref({ ...pageQuery, ...(target > 1 ? { page: target } : {}) })
            }
          />
        </AdminSection>
      )}
    </>
  );
}

/**
 * Keeps a filtered-for id selectable even when it is not in the fetched page.
 *
 * The pickers read one page of 100 rows. Without this, opening a URL that
 * filters on the 101st branch — or on a cashier who has since been deactivated
 * out of the list — would render a `<select>` whose value matches no option, so
 * the browser would show the first option and the operator would submit a
 * filter they never chose, silently changing the result set.
 */
function optionsWithCurrent(
  options: Array<{ value: string; label: string }>,
  current: number | undefined,
  fallbackLabel: (id: number) => string,
): Array<{ value: string; label: string }> {
  if (current === undefined) return options;
  const value = String(current);
  if (options.some((option) => option.value === value)) return options;
  return [...options, { value, label: fallbackLabel(current) }];
}

function OrderRow({ order }: { order: AdminOrderRow }) {
  return (
    <Tr>
      <Td>
        <Link href={adminOrderHref(order.id)} className="no-underline">
          <bdi dir="ltr" data-numeric="" className="font-bold text-primary">
            {order.orderNumber ?? `#${order.id}`}
          </bdi>
        </Link>
        {order.reconciliationState !== null ? (
          <span className="mt-1 block">
            <Badge size="sm" tone={reconciliationStateTone(order.reconciliationState)}>
              {reconciliationStateLabel(order.reconciliationState)}
            </Badge>
          </span>
        ) : null}
      </Td>

      <Td>{channelLabel(order.channel)}</Td>

      <Td>
        <Badge size="sm" tone={orderStatusTone(order.status)}>
          {orderStatusLabel(order.status)}
        </Badge>
      </Td>

      <Td>
        <Badge size="sm" tone={fulfillmentStateTone(order.fulfillmentState)}>
          {fulfillmentStateLabel(order.fulfillmentState)}
        </Badge>
      </Td>

      <Td>
        <Badge size="sm" tone={paymentStateTone(order.paymentState)}>
          {paymentStateLabel(order.paymentState)}
        </Badge>
      </Td>

      {/* The name AS IT WAS at sale time, so a later rename cannot rewrite history. */}
      <Td>
        {order.branchNameSnapshot ?? (
          <span className="text-ink-subtle">بدون شعبه (سایت)</span>
        )}
      </Td>

      <Td>
        {order.cashierDisplaySnapshot ? (
          <bdi dir="ltr">{order.cashierDisplaySnapshot}</bdi>
        ) : (
          <span className="text-ink-subtle">—</span>
        )}
      </Td>

      {/*
        Rendered exactly as the server sent it. A digits-only value is already
        masked to its last four; adding anything to it here would be undoing a
        privacy decision made deliberately one layer down.
      */}
      <Td>
        {order.customerDisplay ? (
          <bdi>{order.customerDisplay}</bdi>
        ) : (
          <span className="text-ink-subtle">ثبت‌نشده</span>
        )}
      </Td>

      <Td numeric>
        {count(order.itemCount)} / {count(order.unitCount)}
      </Td>

      <Td numeric className="font-bold">
        {formatRialString(order.totalPrice)}
      </Td>

      <Td>
        <span className="text-2xs text-ink-muted" data-numeric="">
          {when(order.soldAt ?? order.createdAt)}
        </span>
      </Td>
    </Tr>
  );
}
