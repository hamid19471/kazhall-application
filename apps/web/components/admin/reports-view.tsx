"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";

import type { SalesReportQuery } from "@kazhal/api-client";
import {
  Badge,
  Button,
  Card,
  Money,
  PersianDateRangeFields,
  Skeleton,
  cx,
  formatDateTime,
  formatInteger,
  readDayRange,
} from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { RequireRole } from "@/components/admin/ui";
import { Notice, PageHeading, Pagination, QueryBoundary } from "@/components/common";
import { ChartIcon } from "@/components/icons";
import { channelLabel, orderStatusLabel, orderStatusTone } from "@/lib/labels";
import { adminProfitReportHref, adminReportsHref } from "@/lib/routes";

export interface ReportFilters extends SalesReportQuery {
  page: number;
}

const CHANNELS = [
  { value: "online", label: "اینترنتی" },
  { value: "pos", label: "حضوری" },
] as const;

const STATUSES = [
  "pending",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "canceled",
  "failed",
  "refunded",
] as const;

/**
 * Sales reporting.
 *
 * ## Dates
 *
 * `from`/`to` are INCLUSIVE local calendar days (`YYYY-MM-DD`) in the report
 * timezone — Asia/Tehran by default — which the server converts to a half-open
 * UTC instant range. The resolved timezone and bounds come back on every
 * response and are shown, because "sales in September" is meaningless without
 * saying whose September.
 *
 * ## Event dates
 *
 * Each figure is placed in the range by its OWN event date: gross by when the
 * money was taken, refunds by when the refund was recorded, voids by when the
 * sale was reversed. A September sale refunded in October is in September's
 * gross AND October's refunds — and in neither twice. That is why the row list
 * carries `soldInRange`/`refundedInRange`/`voidedInRange`: they are exactly the
 * booleans the summary aggregates, so the list can explain the totals.
 *
 * ## Profit
 *
 * There is none, and this screen says so out loud. Cost of goods is not
 * modelled anywhere in the system, so any "profit" figure would be revenue
 * wearing a misleading label.
 */
export function ReportsView({ filters }: { filters: ReportFilters }) {
  /*
   * THE MAIN ADMINISTRATOR, AND NOBODY ELSE.
   *
   * `/reports/*` carries `@Roles(super_admin)` and `@Audiences('admin')`, and
   * no capability code participates — there is deliberately no reports entry in
   * `PERMISSION_CATALOG`, so no custom role can be given this by granting it
   * something. The gate here is not the control; the API refuses regardless.
   * It exists so a delegated administrator who follows a bookmarked link is
   * told WHY in one sentence instead of watching three requests return 403.
   *
   * It also stops the requests from being made: `RequireRole` renders nothing
   * until the session is known and renders the refusal instead of the body, so
   * `ReportsBody` — and therefore `api.admin.salesSummary` — never mounts for
   * anyone else.
   */
  return (
    <RequireRole roles={["super_admin"]}>
      <ReportsBody filters={filters} />
    </RequireRole>
  );
}

function ReportsBody({ filters }: { filters: ReportFilters }) {
  const api = useApi();
  const router = useRouter();

  const query: SalesReportQuery = {
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const summary = useApiQuery(
    (signal) => api.admin.salesSummary(query, { signal }),
    [api, JSON.stringify(query)],
  );

  const list = useApiQuery(
    (signal) => api.admin.salesList({ ...query, page: filters.page, limit: 20 }, { signal }),
    [api, JSON.stringify(query), filters.page],
  );

  const byCashier = useApiQuery(
    (signal) => api.admin.salesByCashier(query, { signal }),
    [api, JSON.stringify(query)],
  );

  function applyRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A reversed range is refused where it is shown; nothing is swapped or sent.
    const range = readDayRange(new FormData(event.currentTarget));
    if (range.error) return;
    router.push(
      adminReportsHref({
        from: range.from,
        to: range.to,
        channel: filters.channel,
        status: filters.status,
      }),
    );
  }

  function applyFilter(patch: Partial<ReportFilters>) {
    router.push(
      adminReportsHref({
        from: filters.from,
        to: filters.to,
        channel: patch.channel !== undefined ? patch.channel : filters.channel,
        status: patch.status !== undefined ? patch.status : filters.status,
      }),
    );
  }

  return (
    <>
      <PageHeading
        title="گزارش فروش"
        description="بازهٔ تاریخی به صورت روز تقویمی محلی (پیش‌فرض: آسیا/تهران) و همهٔ مبالغ به ریال."
      />
      <p className="mt-2 text-sm">
        <Link href={adminProfitReportHref()}>گزارش سود ناخالص (درآمد، بهای تمام‌شده و سود ناخالص) ←</Link>
      </p>

      <form onSubmit={applyRange} className="mt-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4">
        <PersianDateRangeFields
          key={`range-${filters.from ?? ""}-${filters.to ?? ""}`}
          fromLabel="از تاریخ (شامل همان روز)"
          toLabel="تا تاریخ (شامل همان روز)"
          defaultFrom={filters.from}
          defaultTo={filters.to}
          containerClassName="w-full sm:w-56"
        />

        <label className="block">
          <span className="block text-xs font-semibold text-ink-muted">کانال</span>
          <select
            value={filters.channel ?? ""}
            onChange={(event) =>
              applyFilter({
                channel: event.target.value === "" ? undefined : (event.target.value as "online" | "pos"),
              })
            }
            className="mt-1 h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink"
          >
            <option value="">همه</option>
            {CHANNELS.map((channel) => (
              <option key={channel.value} value={channel.value}>
                {channel.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-semibold text-ink-muted">وضعیت سفارش</span>
          <select
            value={filters.status ?? ""}
            onChange={(event) =>
              applyFilter({ status: event.target.value === "" ? undefined : event.target.value })
            }
            className="mt-1 h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink"
          >
            <option value="">همه</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {orderStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>

        <Button type="submit" variant="secondary">
          اعمال بازه
        </Button>
      </form>

      <section className="mt-6">
        <h2 className="text-lg text-ink">جمع‌بندی</h2>
        <div className="mt-3">
          <QueryBoundary
            isLoading={summary.isLoading}
            error={summary.error}
            data={summary.data}
            onRetry={summary.refetch}
            label="در حال محاسبهٔ جمع‌بندی"
            skeleton={
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} shape="block" height="5.5rem" />
                ))}
              </div>
            }
          >
            {(data) => (
              <>
                <p className="mb-3 text-xs text-ink-subtle">
                  منطقهٔ زمانی گزارش: <bdi dir="ltr">{data.timezone}</bdi>
                  {data.range.startUtc && data.range.endUtc ? (
                    <>
                      {" "}
                      — از <bdi dir="ltr">{data.range.startUtc}</bdi> تا (نامشمول){" "}
                      <bdi dir="ltr">{data.range.endUtc}</bdi>
                    </>
                  ) : (
                    " — بدون محدودیت تاریخ (کل دوره)"
                  )}
                </p>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="فروش ناخالص" money={data.totals.grossSales} tone="primary" />
                  <Stat label="بازپرداخت" money={data.totals.refundedTotal} tone="danger" />
                  <Stat label="ابطال" money={data.totals.voidedTotal} tone="warning" />
                  <Stat label="فروش خالص" money={data.totals.netSales} tone="success" />
                  <Stat label="تعداد فروش" count={data.totals.salesCount} />
                  <Stat label="واحد فروخته‌شده" count={data.totals.unitsSold} />
                  <Stat label="در انتظار پرداخت" count={data.totals.pendingCount} />
                  <Stat
                    label="لغو یا ناموفق"
                    count={data.totals.canceledOrFailedCount}
                  />
                </div>

                <Notice tone="neutral" className="mt-4" icon={<ChartIcon className="size-5" />}>
                  <div className="space-y-1 text-xs leading-relaxed">
                    <p>
                      <strong>این صفحه سود گزارش نمی‌کند.</strong> سود ناخالص (درآمد خالص منهای
                      بهای تمام‌شدهٔ کالای فروش‌رفته) در{" "}
                      <Link href={adminProfitReportHref()} className="font-bold">
                        گزارش سود ناخالص
                      </Link>{" "}
                      آمده است. سود خالص در این سامانه محاسبه نمی‌شود، چون هزینه‌هایی مانند اجاره،
                      حقوق و ارسال ثبت نمی‌شوند.
                    </p>
                    <p>
                      فروش خالص = ناخالص − بازپرداخت − ابطال، و هر رقم با تاریخ رویداد خودش در بازه
                      قرار می‌گیرد؛ پس یک فروش شهریور که مهر بازگردانده شود، در ناخالص شهریور و در
                      بازپرداخت مهر می‌آید و در هیچ‌کدام دوبار شمرده نمی‌شود.
                    </p>
                  </div>
                </Notice>

                {/*
                  * The server has always answered
                  * `dataQuality.refundsWithUnknownEventDate.{count,total,note}`.
                  * This block used to read a FLAT `dataQuality.count`, which no
                  * response ever carried, so the warning could never appear.
                  */}
                {data.dataQuality &&
                data.dataQuality.refundsWithUnknownEventDate.count > 0 ? (
                  <Notice tone="warning" className="mt-3" title="کیفیت داده">
                    <p className="text-xs leading-relaxed">
                      <bdi data-numeric="">
                        {formatInteger(data.dataQuality.refundsWithUnknownEventDate.count)}
                      </bdi>{" "}
                      سفارش بازپرداخت‌شده بدون تاریخ بازپرداخت وجود دارد، به ارزش{" "}
                      <Money
                        value={data.dataQuality.refundsWithUnknownEventDate.total}
                      />
                      . این یک شاخص کیفیت داده است، نه یک جمع دوره‌ای؛ آن را بین دوره‌ها جمع نزنید.
                    </p>
                  </Notice>
                ) : null}
              </>
            )}
          </QueryBoundary>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg text-ink">به تفکیک فروشنده</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
          هر رقم به فروشندهٔ اصلی سفارش نسبت داده می‌شود و با ابطال یا بازپرداخت بعدی بازنویسی
          نمی‌شود. «انجام‌دهندهٔ برگشت» فهرست جداگانه‌ای است؛ این دو را با هم جمع نزنید.
        </p>
        <div className="mt-3">
          <QueryBoundary
            isLoading={byCashier.isLoading}
            error={byCashier.error}
            data={byCashier.data}
            onRetry={byCashier.refetch}
            label="در حال بارگذاری تفکیک فروشنده"
            skeleton={<Skeleton shape="block" height="10rem" />}
            isEmpty={(data) => data.data.length === 0}
            empty={<p className="text-sm text-ink-subtle">در این بازه فروشی ثبت نشده است.</p>}
          >
            {(data) => (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[42rem] border-collapse text-sm">
                  <thead className="bg-surface-muted">
                    <tr className="text-ink-muted">
                      <Th>فروشنده</Th>
                      <Th>تعداد فروش</Th>
                      <Th>واحد</Th>
                      <Th>ناخالص</Th>
                      <Th>بازپرداخت</Th>
                      <Th>ابطال</Th>
                      <Th>خالص</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.map((row) => (
                      <tr key={row.cashierUserId ?? "unknown"} className="border-t border-line">
                        <Td>{row.cashierDisplaySnapshot ?? "نامشخص"}</Td>
                        <Td numeric>{formatInteger(row.salesCount)}</Td>
                        <Td numeric>{formatInteger(row.unitsSold)}</Td>
                        <Td>
                          <Money value={row.grossSales} withUnit={false} />
                        </Td>
                        <Td>
                          <Money value={row.refundedTotal} withUnit={false} />
                        </Td>
                        <Td>
                          <Money value={row.voidedTotal} withUnit={false} />
                        </Td>
                        <Td>
                          <Money value={row.netSales} withUnit={false} className="font-bold" />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryBoundary>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg text-ink">سفارش‌های این بازه</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
          یک سطر وقتی فهرست می‌شود که هر کدام از رویدادهای مالی‌اش در بازه بیفتد؛ برچسب‌ها می‌گویند
          کدام رویداد آن را وارد این فهرست کرده است.
        </p>
        <div className="mt-3">
          <QueryBoundary
            isLoading={list.isLoading}
            error={list.error}
            data={list.data}
            onRetry={list.refetch}
            label="در حال بارگذاری سفارش‌ها"
            skeleton={<Skeleton shape="block" height="14rem" />}
            isEmpty={(data) => data.data.length === 0}
            empty={<p className="text-sm text-ink-subtle">سفارشی در این بازه نیست.</p>}
          >
            {(data) => (
              <>
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full min-w-[48rem] border-collapse text-sm">
                    <thead className="bg-surface-muted">
                      <tr className="text-ink-muted">
                        <Th>سفارش</Th>
                        <Th>تاریخ درآمد</Th>
                        <Th>کانال</Th>
                        <Th>وضعیت</Th>
                        <Th>رویداد در بازه</Th>
                        <Th>واحد</Th>
                        <Th>مبلغ</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.data.map((row) => (
                        <tr key={row.id} className="border-t border-line">
                          <Td>
                            <bdi data-numeric="">{row.orderNumber ?? formatInteger(row.id)}</bdi>
                          </Td>
                          <Td>{row.revenueAt ? formatDateTime(row.revenueAt) : "—"}</Td>
                          <Td>{channelLabel(row.channel)}</Td>
                          <Td>
                            <Badge size="sm" tone={orderStatusTone(row.status)}>
                              {orderStatusLabel(row.status)}
                            </Badge>
                          </Td>
                          <Td>
                            <span className="flex flex-wrap gap-1">
                              {row.soldInRange ? (
                                <Badge size="sm" tone="success">
                                  فروش
                                </Badge>
                              ) : null}
                              {row.refundedInRange ? (
                                <Badge size="sm" tone="danger">
                                  بازپرداخت
                                </Badge>
                              ) : null}
                              {row.voidedInRange ? (
                                <Badge size="sm" tone="warning">
                                  ابطال
                                </Badge>
                              ) : null}
                              {!row.countsAsSale ? (
                                <Badge size="sm" tone="neutral">
                                  فروش محسوب نمی‌شود
                                </Badge>
                              ) : null}
                            </span>
                          </Td>
                          <Td numeric>{formatInteger(row.unitCount)}</Td>
                          <Td>
                            <Money value={row.total_price} withUnit={false} />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

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
                    adminReportsHref({
                      from: filters.from,
                      to: filters.to,
                      channel: filters.channel,
                      status: filters.status,
                      ...(target > 1 ? { page: target } : {}),
                    })
                  }
                />
              </>
            )}
          </QueryBoundary>
        </div>
      </section>
    </>
  );
}

function Stat({
  label,
  money,
  count,
  tone,
}: {
  label: string;
  /**
   * Integer Rial as a DECIMAL STRING, exactly as the API sends it. `<Money>`
   * groups the digits without parsing, so a figure past 2^53 renders every
   * digit instead of a rounded one — and never `NaN` or scientific notation.
   */
  money?: string;
  count?: number;
  tone?: "primary" | "success" | "danger" | "warning";
}) {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "success"
        ? "text-success"
        : tone === "danger"
          ? "text-danger"
          : tone === "warning"
            ? "text-warning"
            : "text-ink";

  return (
    <Card tone="outlined" padding="sm">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className={cx("mt-1.5 text-lg font-extrabold", toneClass)}>
        {money !== undefined ? (
          <Money value={money} withUnit={false} />
        ) : (
          <bdi data-numeric="">{formatInteger(count ?? 0)}</bdi>
        )}
      </p>
      {money !== undefined ? <p className="mt-0.5 text-2xs text-ink-subtle">ریال</p> : null}
    </Card>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="p-3 text-start text-xs font-semibold">
      {children}
    </th>
  );
}

function Td({ children, numeric = false }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <td className="p-3 align-middle" {...(numeric ? { "data-numeric": "" } : {})}>
      {children}
    </td>
  );
}
