"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent, ReactNode } from "react";

import { Badge, Input, Money, PersianDateRangeFields, Skeleton, cx, formatRialString, readDayRange } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, Pagination, QueryBoundary } from "@/components/common";
import { useCategories } from "@/components/providers";
import {
  AdminPageHeader,
  AdminSection,
  DataTable,
  EmptyRow,
  FilterBar,
  RequireRole,
  Select,
  StatTile,
  Td,
  Th,
  Tr,
  count,
  when,
} from "@/components/admin/ui";
import { pageInfoOf } from "@/components/admin/people-shared";
import { ChartIcon } from "@/components/icons";
import {
  PROFIT_GROUP_BY,
  fetchBranches,
  fetchCashiers,
  fetchProfitBreakdown,
  fetchProfitOrder,
  fetchProfitOrders,
  fetchProfitSummary,
} from "@/lib/admin-api";
import type {
  CostCoverage,
  ProfitBreakdownRow,
  ProfitFilters,
  ProfitGroupBy,
  ProfitMoneyFields,
  ProfitOrderLine,
} from "@/lib/admin-api";
import { formatPercentString } from "@/lib/costing";
import {
  INCOMPLETE_COST_WARNING,
  channelLabel,
  costCoverageLabel,
  costCoverageTone,
  lineAdjustmentKindLabel,
  lineCostStatusLabel,
  lineCostStatusTone,
  profitGroupByLabel,
} from "@/lib/labels";
import { adminOrderHref, adminProfitOrderHref, adminProfitReportHref, adminReportsHref } from "@/lib/routes";

export interface ProfitReportParams extends ProfitFilters {
  groupBy: ProfitGroupBy;
  /** Page of the orders list. */
  page: number;
  /** Page of the breakdown table. */
  bpage: number;
}

const PAGE_SIZE = 20;

const ROLE_REASON =
  "گزارش سود ناخالص و هر رقمی از قیمت خرید تنها در اختیار مدیر کل سامانه است و به هیچ نقش دیگری واگذار نمی‌شود.";

/** The one sentence this whole feature must never let anyone forget. */
function GrossNotNet() {
  return (
    <Notice tone="info" className="mb-5" icon={<ChartIcon className="size-5" />}>
      <p className="text-xs leading-relaxed">
        <b>این گزارش سود ناخالص است، نه سود خالص.</b> سود ناخالص = درآمد خالص فروش − بهای تمام‌شدهٔ
        کالای فروش‌رفته. هزینه‌هایی مانند اجاره، حقوق، مالیات، ارسال و کارمزد درگاه در این سامانه
        ثبت نمی‌شوند و از آن کم نشده‌اند.
      </p>
    </Notice>
  );
}

export function ProfitReport({ params }: { params: ProfitReportParams }) {
  return (
    <RequireRole roles={["super_admin"]} reason={ROLE_REASON}>
      <ProfitReportBody params={params} />
    </RequireRole>
  );
}

/** The filters as URL query values, without either page. */
function filterQuery(params: ProfitReportParams) {
  return {
    from: params.from,
    to: params.to,
    channel: params.channel,
    branchId: params.branchId,
    cashierUserId: params.cashierUserId,
    productId: params.productId,
    variantId: params.variantId,
    categoryId: params.categoryId,
    groupBy: params.groupBy === "day" ? undefined : params.groupBy,
  };
}

function apiFilters(params: ProfitReportParams): ProfitFilters {
  const { from, to, channel, branchId, cashierUserId, productId, variantId, categoryId } = params;
  return { from, to, channel, branchId, cashierUserId, productId, variantId, categoryId };
}

function ProfitReportBody({ params }: { params: ProfitReportParams }) {
  const api = useApi();
  const router = useRouter();
  const { categories } = useCategories();
  const filters = apiFilters(params);
  const filterKey = JSON.stringify(filters);

  const summary = useApiQuery(
    (signal) => fetchProfitSummary(api, filters, { signal }),
    [api, filterKey],
  );
  const breakdown = useApiQuery(
    (signal) =>
      fetchProfitBreakdown(
        api,
        { ...filters, groupBy: params.groupBy, page: params.bpage, limit: PAGE_SIZE },
        { signal },
      ),
    [api, filterKey, params.groupBy, params.bpage],
  );
  const orders = useApiQuery(
    (signal) => fetchProfitOrders(api, { ...filters, page: params.page, limit: PAGE_SIZE }, { signal }),
    [api, filterKey, params.page],
  );
  const branches = useApiQuery((signal) => fetchBranches(api, { limit: 100 }, { signal }), [api]);
  const cashiers = useApiQuery((signal) => fetchCashiers(api, { limit: 100 }, { signal }), [api]);

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
    router.push(
      adminProfitReportHref({
        from: range.from,
        to: range.to,
        channel: field("channel"),
        branchId: field("branchId"),
        cashierUserId: field("cashierUserId"),
        productId: field("productId"),
        variantId: field("variantId"),
        categoryId: field("categoryId"),
        groupBy: params.groupBy === "day" ? undefined : params.groupBy,
      }),
    );
  }

  return (
    <>
      <AdminPageHeader
        title="گزارش سود ناخالص"
        description="درآمد، بهای تمام‌شدهٔ کالای فروش‌رفته و سود ناخالص، بر اساس روزهای تقویمی کامل به وقت تهران (هر دو سر بازه شامل). همهٔ مبالغ به ریال است."
        actions={
          <Link href={adminReportsHref()} className="text-sm">
            گزارش فروش ←
          </Link>
        }
      />

      <GrossNotNet />

      <FilterBar key={filterKey} onSubmit={apply} onReset={() => router.push(adminProfitReportHref())}>
        <PersianDateRangeFields
          fromLabel="از تاریخ (شامل همان روز)"
          toLabel="تا تاریخ (شامل همان روز)"
          defaultFrom={params.from}
          defaultTo={params.to}
          containerClassName="min-w-0"
        />
        <Select
          name="channel"
          label="کانال فروش"
          defaultValue={params.channel ?? ""}
          options={[
            { value: "", label: "هر دو کانال" },
            { value: "online", label: channelLabel("online") },
            { value: "pos", label: channelLabel("pos") },
          ]}
        />
        <Select
          name="branchId"
          label="شعبه"
          defaultValue={params.branchId === undefined ? "" : String(params.branchId)}
          options={withCurrent(
            [
              { value: "", label: "همهٔ شعبه‌ها و سایت" },
              ...(branches.data?.data ?? []).map((branch) => ({
                value: String(branch.id),
                label: branch.isActive ? branch.name : `${branch.name} (غیرفعال)`,
              })),
            ],
            params.branchId,
            (id) => `شعبهٔ شمارهٔ ${count(id)}`,
          )}
        />
        <Select
          name="cashierUserId"
          label="صندوق‌دار"
          defaultValue={params.cashierUserId === undefined ? "" : String(params.cashierUserId)}
          options={withCurrent(
            [
              { value: "", label: "همهٔ صندوق‌داران" },
              ...(cashiers.data?.data ?? []).map((user) => ({
                value: String(user.id),
                label: user.isActive ? user.identifier : `${user.identifier} (غیرفعال)`,
              })),
            ],
            params.cashierUserId,
            (id) => `کاربر شمارهٔ ${count(id)}`,
          )}
        />
        <Select
          name="categoryId"
          label="دسته‌بندی"
          defaultValue={params.categoryId === undefined ? "" : String(params.categoryId)}
          options={withCurrent(
            [
              { value: "", label: "همهٔ دسته‌ها" },
              ...categories.map((category) => ({ value: String(category.id), label: category.title })),
            ],
            params.categoryId,
            (id) => `دستهٔ شمارهٔ ${count(id)}`,
          )}
        />
        <Input
          name="productId"
          label="شناسهٔ کالا"
          numeric
          defaultValue={params.productId === undefined ? "" : String(params.productId)}
          hint="شناسهٔ عددی کالا، از صفحهٔ کالا."
          containerClassName="min-w-0"
        />
        <Input
          name="variantId"
          label="شناسهٔ گونه"
          numeric
          defaultValue={params.variantId === undefined ? "" : String(params.variantId)}
          containerClassName="min-w-0"
        />
      </FilterBar>

      <SummarySection
        isLoading={summary.isLoading}
        error={summary.error}
        data={summary.data}
        onRetry={summary.refetch}
      />

      <AdminSection
        className="mt-6"
        title="تفکیک سود ناخالص"
        description="ردیف‌هایی که قیمت خرید همهٔ فروش‌هایشان معلوم است اول می‌آیند؛ ردیفِ بدون قیمت خرید هیچ‌وقت پرسود نشان داده نمی‌شود."
      >
        <GroupByPicker params={params} />
        <div className="mt-3">
          <QueryBoundary
            isLoading={breakdown.isLoading}
            error={breakdown.error}
            data={breakdown.data}
            onRetry={breakdown.refetch}
            label="در حال بارگذاری تفکیک"
            skeleton={<Skeleton shape="block" height="12rem" />}
          >
            {(data) => (
              <>
                <DataTable minWidth="60rem" caption={`سود ناخالص به تفکیک ${profitGroupByLabel(params.groupBy)}`}>
                  <thead>
                    <tr>
                      <Th>{profitGroupByLabel(params.groupBy)}</Th>
                      <Th numeric>درآمد خالص فروش</Th>
                      <Th numeric>با قیمت خرید معلوم</Th>
                      <Th numeric>با قیمت خرید نامعلوم</Th>
                      <Th numeric>بهای تمام‌شده</Th>
                      <Th numeric>سود ناخالص</Th>
                      <Th numeric>حاشیه سود ناخالص</Th>
                      <Th>پوشش قیمت خرید</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.length === 0 ? (
                      <EmptyRow colSpan={8}>در این بازه فروشی ثبت نشده است.</EmptyRow>
                    ) : (
                      data.data.map((row, index) => (
                        <Tr key={`${String(row.key)}-${index}`}>
                          <Td>
                            <span className="block font-bold text-ink">{breakdownLabel(row, params.groupBy)}</span>
                            <RowWarning coverage={row.costCoverage} />
                          </Td>
                          <MoneyCells row={row} />
                        </Tr>
                      ))
                    )}
                  </tbody>
                </DataTable>
                <Pagination
                  className="mt-4"
                  pageInfo={pageInfoOf(data)}
                  buildHref={(target) =>
                    adminProfitReportHref({
                      ...filterQuery(params),
                      ...(params.page > 1 ? { page: params.page } : {}),
                      ...(target > 1 ? { bpage: target } : {}),
                    })
                  }
                />
              </>
            )}
          </QueryBoundary>
        </div>
      </AdminSection>

      <AdminSection
        className="mt-6"
        title="سفارش‌ها"
        description="هر سفارشی که درآمد آن در این بازه شناسایی شده است. برای دیدن بهای هر قلم، سفارش را باز کنید."
      >
        <QueryBoundary
          isLoading={orders.isLoading}
          error={orders.error}
          data={orders.data}
          onRetry={orders.refetch}
          label="در حال بارگذاری سفارش‌ها"
          skeleton={<Skeleton shape="block" height="12rem" />}
        >
          {(data) => (
            <>
              <DataTable minWidth="68rem" caption="سود ناخالص سفارش‌ها">
                <thead>
                  <tr>
                    <Th>سفارش</Th>
                    <Th>تاریخ درآمد</Th>
                    <Th>کانال / شعبه</Th>
                    <Th numeric>درآمد خالص فروش</Th>
                    <Th numeric>با قیمت خرید معلوم</Th>
                    <Th numeric>با قیمت خرید نامعلوم</Th>
                    <Th numeric>بهای تمام‌شده</Th>
                    <Th numeric>سود ناخالص</Th>
                    <Th numeric>حاشیه سود ناخالص</Th>
                    <Th>پوشش قیمت خرید</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.length === 0 ? (
                    <EmptyRow colSpan={10}>سفارشی در این بازه نیست.</EmptyRow>
                  ) : (
                    data.data.map((row) => (
                      <Tr key={row.orderId}>
                        <Td>
                          <Link href={adminProfitOrderHref(row.orderId)} className="no-underline">
                            <bdi dir="ltr" data-numeric="" className="font-bold text-primary">
                              {row.orderNumber ?? `#${row.orderId}`}
                            </bdi>
                          </Link>
                          <RowWarning coverage={row.costCoverage} />
                        </Td>
                        <Td>
                          <span className="whitespace-nowrap text-xs" data-numeric="">
                            {when(row.revenueAt)}
                          </span>
                        </Td>
                        <Td>
                          <span className="block text-xs">{channelLabel(row.channel)}</span>
                          {row.branchNameSnapshot ? (
                            <span className="block text-2xs text-ink-subtle">{row.branchNameSnapshot}</span>
                          ) : null}
                          {row.cashierDisplaySnapshot ? (
                            <bdi dir="ltr" className="block text-2xs text-ink-subtle">
                              {row.cashierDisplaySnapshot}
                            </bdi>
                          ) : null}
                        </Td>
                        <MoneyCells row={row} />
                      </Tr>
                    ))
                  )}
                </tbody>
              </DataTable>
              <Pagination
                className="mt-4"
                pageInfo={pageInfoOf(data)}
                buildHref={(target) =>
                  adminProfitReportHref({
                    ...filterQuery(params),
                    ...(params.bpage > 1 ? { bpage: params.bpage } : {}),
                    ...(target > 1 ? { page: target } : {}),
                  })
                }
              />
            </>
          )}
        </QueryBoundary>
      </AdminSection>
    </>
  );
}

function withCurrent(
  options: Array<{ value: string; label: string }>,
  current: number | undefined,
  fallbackLabel: (id: number) => string,
) {
  if (current === undefined) return options;
  const value = String(current);
  if (options.some((option) => option.value === value)) return options;
  return [...options, { value, label: fallbackLabel(current) }];
}

function breakdownLabel(row: ProfitBreakdownRow, groupBy: ProfitGroupBy): string {
  if (row.label) return row.label;
  if (groupBy === "channel" && row.key !== null) return channelLabel(String(row.key));
  if (row.key === null || row.key === undefined) return "نامشخص";
  return String(row.key);
}

/**
 * The §9 sentence, word for word, under every row whose cost is not fully
 * known — so a partial or missing cost can never be read as a real profit.
 */
function RowWarning({ coverage }: { coverage: CostCoverage }) {
  if (coverage === "complete") return null;
  return (
    <span className="mt-1 block max-w-[28ch] text-2xs leading-relaxed text-warning">
      {INCOMPLETE_COST_WARNING}
    </span>
  );
}

function CoverageBadge({ coverage, percent }: { coverage: CostCoverage; percent: string | null }) {
  return (
    <Badge size="sm" tone={costCoverageTone(coverage)}>
      {costCoverageLabel(coverage)}
      {percent !== null ? (
        <>
          {" "}
          <bdi data-numeric="">{formatPercentString(percent)}</bdi>
        </>
      ) : null}
    </Badge>
  );
}

/** The shared money columns. `grossProfit`/margin null → "—", never 0. */
function MoneyCells({ row }: { row: ProfitMoneyFields }) {
  return (
    <>
      <Td numeric>
        <Money value={row.netSalesRevenue} withUnit={false} />
      </Td>
      <Td numeric>
        <Money value={row.knownNetRevenue} withUnit={false} />
      </Td>
      <Td numeric>
        <Money value={row.unknownNetRevenue} withUnit={false} />
      </Td>
      <Td numeric>
        <Money value={row.netCogs} withUnit={false} />
      </Td>
      <Td numeric className="font-bold">
        <Money value={row.grossProfit} withUnit={false} />
      </Td>
      <Td numeric>{formatPercentString(row.grossMarginPercent)}</Td>
      <Td>
        <CoverageBadge coverage={row.costCoverage} percent={row.coveragePercent} />
      </Td>
    </>
  );
}

/**
 * «گروه‌بندی بر اساس» as LINKS, not a select that navigates on change: each is
 * a real, keyboard-reachable destination, and the current one says so with
 * `aria-current`.
 */
function GroupByPicker({ params }: { params: ProfitReportParams }) {
  return (
    <nav aria-label="گروه‌بندی بر اساس">
      <p className="mb-1.5 text-xs text-ink-muted">گروه‌بندی بر اساس</p>
      <ul className="flex flex-wrap gap-1.5">
        {PROFIT_GROUP_BY.map((option) => {
          const active = option === params.groupBy;
          return (
            <li key={option}>
              <Link
                href={adminProfitReportHref({
                  ...filterQuery(params),
                  groupBy: option === "day" ? undefined : option,
                })}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "inline-block rounded-md border px-3 py-1.5 text-xs no-underline",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                  active
                    ? "border-primary bg-primary-soft font-bold text-primary"
                    : "border-line-strong bg-surface text-ink-muted",
                )}
              >
                {profitGroupByLabel(option)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SummarySection({
  isLoading,
  error,
  data,
  onRetry,
}: {
  isLoading: boolean;
  error: unknown;
  data: Awaited<ReturnType<typeof fetchProfitSummary>> | undefined;
  onRetry: () => void;
}) {
  return (
    <section className="mt-2" aria-label="جمع‌بندی سود ناخالص">
      <QueryBoundary
        isLoading={isLoading}
        error={error}
        data={data}
        onRetry={onRetry}
        label="در حال محاسبهٔ جمع‌بندی"
        skeleton={
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} shape="block" height="6rem" />
            ))}
          </div>
        }
      >
        {(summary) => {
          const totals = summary.totals;
          const noKnown = totals.knownCost.lineCount === 0;
          const incomplete = totals.unknownCost.lineCount > 0;
          return (
            <>
              <p className="mb-3 text-xs text-ink-subtle">
                منطقهٔ زمانی گزارش: <bdi dir="ltr">{summary.timezone}</bdi>
                {summary.range?.startUtc && summary.range?.endUtc ? (
                  <>
                    {" "}
                    — از <bdi dir="ltr">{summary.range.startUtc}</bdi> تا (نامشمول){" "}
                    <bdi dir="ltr">{summary.range.endUtc}</bdi>
                  </>
                ) : (
                  " — بدون محدودیت تاریخ (کل دوره)"
                )}
              </p>

              {incomplete ? (
                <Notice tone="warning" className="mb-4" title={INCOMPLETE_COST_WARNING}>
                  <p className="text-xs leading-relaxed">
                    سود ناخالص و حاشیهٔ زیر فقط از فروش‌هایی محاسبه شده که قیمت خرید همهٔ واحدهایشان
                    معلوم است (<bdi data-numeric="">{count(totals.knownCost.lineCount)}</bdi> قلم).{" "}
                    <bdi data-numeric="">{count(totals.unknownCost.lineCount)}</bdi> قلم فروش قیمت خرید
                    ناقص یا نامعلوم دارد یا هنوز از انبار خارج نشده است و در سود حساب نشده است.
                  </p>
                </Notice>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label="درآمد ناخالص فروش"
                  value={formatRialString(totals.grossSalesRevenue)}
                  hint={`${count(totals.unitsSold)} واحد فروخته‌شده در این بازه.`}
                  tone="primary"
                />
                <StatTile
                  label="برگشت/ابطال"
                  value={formatRialString(totals.revenueReversed)}
                  hint={
                    <>
                      ابطال {formatRialString(totals.voidedRevenue)} · بازپرداخت{" "}
                      {formatRialString(totals.refundedRevenue)}. با تاریخ خود رویداد در بازه می‌آید.
                    </>
                  }
                  tone="warning"
                />
                <StatTile
                  label="درآمد خالص فروش"
                  value={formatRialString(totals.netSalesRevenue)}
                  hint="درآمد ناخالص منهای برگشت و ابطال."
                  tone="success"
                />
                <StatTile
                  label="پوشش اطلاعات قیمت خرید"
                  value={formatPercentString(totals.coveragePercent)}
                  hint="سهم درآمد ناخالصی که قیمت خرید آن معلوم است."
                  tone={incomplete ? "warning" : "neutral"}
                />
                <StatTile
                  label="بهای تمام‌شدهٔ فروش (پیش از برگشت)"
                  value={noKnown ? "—" : formatRialString(totals.knownCost.cogs)}
                  hint="بهای واحدهای فروش‌رفته با قیمت خرید معلوم، همان‌طور که هنگام خروج از انبار ثبت شد."
                />
                <StatTile
                  label="بهای برگشت‌خورده به انبار"
                  value={noKnown ? "—" : formatRialString(totals.knownCost.cogsReversed)}
                  hint="بهای اصلی واحدهایی که برگشت خوردند و دوباره به موجودی افزوده شدند — نه میانگین فعلی."
                />
                <StatTile
                  label="بهای تمام‌شده کالای فروش‌رفته"
                  value={noKnown ? "—" : formatRialString(totals.knownCost.netCogs)}
                  hint="بهای واحدهای فروش‌رفته با قیمت خرید معلوم، منهای بهای واحدهایی که به انبار برگشته‌اند."
                />
                <StatTile
                  label="سود ناخالص"
                  value={noKnown ? "—" : formatRialString(totals.knownCost.grossProfit)}
                  hint="درآمد خالص فروش‌های دارای قیمت خرید معلوم منهای بهای تمام‌شدهٔ آن‌ها. سود خالص نیست."
                  tone="success"
                />
                <StatTile
                  label="حاشیه سود ناخالص"
                  value={formatPercentString(noKnown ? null : totals.knownCost.grossMarginPercent)}
                  hint="سود ناخالص تقسیم بر درآمد خالصِ همان فروش‌های دارای قیمت خرید معلوم."
                />
                <StatTile
                  label="درآمد در انتظار خروج از انبار"
                  value={formatRialString(totals.unknownCost.pendingFulfilmentRevenue)}
                  hint="سفارش‌های اینترنتی پرداخت‌شده‌ای که هنوز از انبار کسر نشده‌اند؛ سود آن‌ها هنوز قابل محاسبه نیست."
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <StatTile
                  label="درآمد خالص با قیمت خرید معلوم"
                  value={formatRialString(totals.knownCost.netRevenue)}
                  hint={<Lines count={totals.knownCost.lineCount} />}
                />
                <StatTile
                  label="درآمد خالص با قیمت خرید نامعلوم"
                  value={formatRialString(totals.unknownCost.netRevenue)}
                  hint={
                    <>
                      <Lines count={totals.unknownCost.lineCount} /> شامل{" "}
                      {formatRialString(totals.unknownCost.unvaluedRevenue)} از موجودیِ ارزش‌گذاری‌نشده یا
                      قدیمی.
                    </>
                  }
                  tone={incomplete ? "warning" : "neutral"}
                />
              </div>

              <AdminSection
                className="mt-4"
                title="زیان موجودی (جدا از سود ناخالص)"
                description="کاهش‌های «اصلاح موجودی» و اصلاح دستیِ کاهشی در این بازه. این مبلغ بهای کالای فروش‌رفته نیست و از سود ناخالص بالا کم نشده است."
              >
                <dl className="grid gap-3 sm:grid-cols-3">
                  <LossFact label="واحدهای کسرشده">{count(totals.inventoryLosses.units)}</LossFact>
                  <LossFact label="بهای معلوم حذف‌شده">
                    <Money value={totals.inventoryLosses.knownCostRemoved} />
                  </LossFact>
                  <LossFact label="واحدهای کسرشدهٔ بدون قیمت خرید">
                    {count(totals.inventoryLosses.unknownCostUnits)}
                  </LossFact>
                </dl>
              </AdminSection>
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

function Lines({ count: lines }: { count: number }) {
  return <>{count(lines)} قلم فروش.</>;
}

function LossFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-muted p-3">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="mt-1 text-sm font-bold text-ink" data-numeric="">
        {children}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One order's line costs
// ---------------------------------------------------------------------------

export function ProfitOrderView({ orderId }: { orderId: number }) {
  return (
    <RequireRole roles={["super_admin"]} reason={ROLE_REASON}>
      <ProfitOrderBody orderId={orderId} />
    </RequireRole>
  );
}

function ProfitOrderBody({ orderId }: { orderId: number }) {
  const api = useApi();
  const query = useApiQuery((signal) => fetchProfitOrder(api, orderId, { signal }), [api, orderId]);

  return (
    <>
      <AdminPageHeader
        title="سود ناخالص سفارش"
        description="بهای تمام‌شدهٔ هر قلم همان است که هنگام خروج کالا از انبار ثبت شده و بعداً تغییر نمی‌کند."
        actions={
          <>
            <Link href={adminOrderHref(orderId)} className="text-sm">
              صفحهٔ سفارش ←
            </Link>
            <Link href={adminProfitReportHref()} className="text-sm">
              گزارش سود ناخالص ←
            </Link>
          </>
        }
      />
      <GrossNotNet />
      <QueryBoundary
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={query.refetch}
        label="در حال بارگذاری سفارش"
        skeleton={<Skeleton shape="block" height="16rem" />}
      >
        {(detail) => {
          const header = detail.order ?? detail;
          const totals = detail.totals;
          return (
            <>
              <dl className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <LossFact label="سفارش">
                  <bdi dir="ltr">{header.orderNumber ?? `#${orderId}`}</bdi>
                </LossFact>
                <LossFact label="کانال">{header.channel ? channelLabel(header.channel) : "—"}</LossFact>
                <LossFact label="تاریخ درآمد">{when(header.revenueAt ?? null)}</LossFact>
                <LossFact label="شعبه / صندوق‌دار">
                  {[header.branchNameSnapshot, header.cashierDisplaySnapshot].filter(Boolean).join(" · ") ||
                    "—"}
                </LossFact>
              </dl>

              {totals ? (
                <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="درآمد خالص فروش" value={formatRialString(totals.netSalesRevenue ?? null)} />
                  <StatTile label="بهای تمام‌شده کالای فروش‌رفته" value={formatRialString(totals.netCogs ?? null)} />
                  <StatTile label="سود ناخالص" value={formatRialString(totals.grossProfit ?? null)} tone="success" />
                  <StatTile
                    label="حاشیه سود ناخالص"
                    value={formatPercentString(totals.grossMarginPercent ?? null)}
                  />
                </div>
              ) : null}
              {totals?.costCoverage && totals.costCoverage !== "complete" ? (
                <Notice tone="warning" className="mb-4">
                  {INCOMPLETE_COST_WARNING}
                </Notice>
              ) : null}

              <OrderLinesTable lines={detail.lines} />
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

function OrderLinesTable({ lines }: { lines: ProfitOrderLine[] }) {
  return (
    <DataTable minWidth="64rem" caption="بهای اقلام سفارش">
      <thead>
        <tr>
          <Th>کالا</Th>
          <Th numeric>تعداد</Th>
          <Th numeric>مبلغ خط</Th>
          <Th>وضعیت قیمت خرید</Th>
          <Th numeric>بهای تمام‌شده</Th>
          <Th numeric>بهای هر واحد</Th>
          <Th numeric>معلوم / نامعلوم</Th>
          <Th>برگشت‌ها</Th>
        </tr>
      </thead>
      <tbody>
        {lines.length === 0 ? (
          <EmptyRow colSpan={8}>این سفارش قلمی ندارد.</EmptyRow>
        ) : (
          lines.map((line) => (
            <Tr key={line.orderItemId}>
              <Td>
                <span className="block font-bold text-ink">{line.productTitle}</span>
                <bdi dir="ltr" data-numeric="" className="block text-2xs text-ink-subtle">
                  {[line.productCode, line.variantCode].filter(Boolean).join(" · ")}
                </bdi>
              </Td>
              <Td numeric>{count(line.quantity)}</Td>
              <Td numeric>
                <Money value={line.totalPrice} withUnit={false} />
              </Td>
              <Td>
                <Badge size="sm" tone={lineCostStatusTone(line.costStatus)}>
                  {lineCostStatusLabel(line.costStatus)}
                </Badge>
              </Td>
              <Td numeric>
                <Money value={line.cogsTotal} withUnit={false} />
              </Td>
              <Td numeric>
                <Money value={line.unitCostDisplay} withUnit={false} />
              </Td>
              <Td numeric>
                {line.costKnownQuantity === null && line.costUnknownQuantity === null
                  ? "—"
                  : `${count(line.costKnownQuantity ?? 0)} / ${count(line.costUnknownQuantity ?? 0)}`}
              </Td>
              <Td>
                {line.adjustments.length === 0 ? (
                  <span className="text-ink-subtle">—</span>
                ) : (
                  <ul className="space-y-1 text-2xs">
                    {line.adjustments.map((adjustment) => (
                      <li key={adjustment.id}>
                        {lineAdjustmentKindLabel(adjustment.kind)} ·{" "}
                        <bdi data-numeric="">{count(adjustment.revenueQuantity)}</bdi> واحد ·{" "}
                        <Money value={adjustment.revenueReversed} withUnit={false} />
                        {adjustment.cogsReversed !== null ? (
                          <>
                            {" "}
                            (بهای برگشتی <Money value={adjustment.cogsReversed} withUnit={false} />)
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Td>
            </Tr>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
