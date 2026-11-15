"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import type { ReconciliationCaseSummary, ReconciliationQuery } from "@kazhal/api-client";
import { Badge, Card, EmptyState, ErrorState, Skeleton, cx } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import {
  AdminPageHeader,
  FilterBar,
  RequirePermission,
  Select,
  StatTile,
  count,
  when,
} from "@/components/admin/ui";
import { Pagination } from "@/components/common";
import { ReconciliationHelp } from "@/components/admin/reconciliation-help";
import {
  SEVERITY_LABEL,
  SEVERITY_TONE,
  readCase,
} from "@/components/admin/reconciliation-plain";
import { AlertIcon, ScaleIcon } from "@/components/icons";
import {
  CASE_TYPE_LABEL,
  channelLabel,
  reconciliationStateLabel,
} from "@/lib/labels";
import { formatRialString } from "@/lib/money";
import { adminCaseHref, adminReconciliationHref } from "@/lib/routes";

export interface QueueFilters extends ReconciliationQuery {
  page: number;
}

const CASE_TYPES = [
  "unapplied_receipt",
  "fulfilment_incomplete",
  "awaiting_stock",
  "operator_open",
] as const;

const ORDER_STATUSES = [
  "pending",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "canceled",
  "failed",
  "refunded",
] as const;

const FULFILLMENT_STATES = [
  "not_required",
  "pending",
  "fulfilled",
  "awaiting_stock",
  "failed",
] as const;

const PAYMENT_STATUSES = [
  "pending",
  "success",
  "failed",
  "refunded",
  "confirmed_unapplied",
] as const;

const STAGES = [
  {
    key: "needs_action" as const,
    label: "نیازمند اقدام",
    hint: "هنوز کسی تصمیمی نگرفته است.",
  },
  {
    key: "tracking" as const,
    label: "در حال پیگیری",
    hint: "تصمیم گرفته شده و منتظر اقدامی بیرون از این سامانه است.",
  },
  {
    key: "closed" as const,
    label: "بسته‌شده",
    hint: "تکلیف پرونده روشن شده است.",
  },
];

const PAGE_SIZE = 20;

/**
 * ===========================================================================
 * PAYMENT RECONCILIATION — rebuilt for a shop manager
 * ===========================================================================
 *
 * WHAT WAS WRONG WITH THE PREVIOUS VERSION. It opened with six technical
 * selects — case type, payment state, order state, fulfilment state, branch,
 * closed — and a table of enum names. Every one of those is real and useful,
 * and not one of them is what a store manager opens this page to find out.
 * They want to know what needs doing today, and for each row: did we get the
 * money, did the goods leave, and what do I do next.
 *
 * WHAT IT DOES NOW:
 *
 *  - SUMMARY CARDS first, so the shape of the work is visible before any
 *    reading. One request for all of them (`/reconciliation/summary`).
 *  - THREE TABS that partition the queue, defaulting to «نیازمند اقدام». A
 *    manager who empties all three has handled everything.
 *  - EVERY ROW ANSWERS THE SIX QUESTIONS in plain Persian, derived from the
 *    same data the badges show (`reconciliation-plain.ts`).
 *  - THE TECHNICAL FILTERS ARE STILL HERE, one click away under «فیلترهای
 *    پیشرفته». They were not removed — they were moved out of the way of the
 *    primary workflow.
 *
 * The severity labels are the brief's four: فوری / نیازمند بررسی / منتظر اقدام
 * خارجی / حل‌شده.
 */
export function ReconciliationQueue({ filters }: { filters: QueueFilters }) {
  return (
    <RequirePermission permissions={["reconciliation.read"]}>
      <QueueBody filters={filters} />
    </RequirePermission>
  );
}

function QueueBody({ filters }: { filters: QueueFilters }) {
  const api = useApi();
  const router = useRouter();

  // The page defaults to the actionable tab. The URL still wins, so a link to
  // a specific stage (from the dashboard, say) lands where it points.
  const stage = filters.stage ?? "needs_action";

  const summary = useApiQuery(
    (signal) => api.reconciliation.summary({ signal }),
    [api],
  );

  const queue = useApiQuery(
    (signal) =>
      api.reconciliation.listQueue({ ...filters, stage, limit: PAGE_SIZE }, { signal }),
    [api, JSON.stringify({ ...filters, stage })],
  );

  const apply = (patch: Partial<QueueFilters>) => {
    router.push(adminReconciliationHref({ ...filters, stage, ...patch, page: 1 }));
  };

  return (
    <>
      <AdminPageHeader
        title="مغایرت پرداخت"
        description="سفارش‌هایی که پول و کالا در آن‌ها با هم جور نیست. هیچ اقدامی در این صفحه پول جابه‌جا نمی‌کند."
      />

      <ReconciliationHelp />

      {summary.error ? (
        <ErrorState
          error={summary.error}
          title="شمارش پرونده‌ها خوانده نشد"
          onRetry={summary.refetch}
          className="mb-5"
        />
      ) : summary.isLoading || !summary.data ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-busy="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} shape="block" height="6.5rem" />
          ))}
        </div>
      ) : (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile
            label="نیازمند اقدام"
            value={count(summary.data.needsAction)}
            hint="پرونده‌هایی که هنوز هیچ تصمیمی روی آن‌ها ثبت نشده است."
            tone={summary.data.needsAction > 0 ? "danger" : "success"}
          />
          <StatTile
            label="مشتری پرداخت کرده، سفارش ناقص است"
            value={count(summary.data.paidOrderIncomplete)}
            hint="پول دریافت شده اما کالا از انبار کسر نشده."
            tone={summary.data.paidOrderIncomplete > 0 ? "warning" : "neutral"}
          />
          <StatTile
            label="مشکل موجودی"
            value={count(summary.data.stockProblem)}
            hint="سفارش در انتظار تأمین کالاست."
            tone={summary.data.stockProblem > 0 ? "warning" : "neutral"}
          />
          <StatTile
            label="نیازمند بازپرداخت"
            value={count(summary.data.refundRequired)}
            hint="تصمیم به بازپرداخت گرفته شده و هنوز در درگاه انجام یا تأیید نشده است."
            tone={summary.data.refundRequired > 0 ? "danger" : "neutral"}
          />
          <StatTile
            label="حل‌شده در امروز"
            value={count(summary.data.resolvedToday)}
            hint="پرونده‌هایی که امروز (به وقت تهران) بسته شده‌اند."
            tone="success"
          />
        </div>
      )}

      {/* Tabs. Real links, so a stage is shareable and the back button works. */}
      <div
        role="tablist"
        aria-label="وضعیت پرونده‌ها"
        className="mb-4 flex gap-1 overflow-x-auto border-b border-line pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {STAGES.map((entry) => {
          const active = stage === entry.key;
          const badge =
            entry.key === "needs_action"
              ? summary.data?.needsAction
              : entry.key === "tracking"
                ? summary.data?.tracking
                : summary.data?.closed;
          return (
            <Link
              key={entry.key}
              role="tab"
              aria-selected={active}
              href={adminReconciliationHref({ ...filters, stage: entry.key, page: 1 })}
              title={entry.hint}
              className={cx(
                "-mb-px shrink-0 whitespace-nowrap rounded-t-md border border-b-2 px-4 py-2 text-sm no-underline transition-colors duration-150 ease-kz",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                active
                  ? "border-line border-b-primary bg-surface font-bold text-primary"
                  : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {entry.label}
              {typeof badge === "number" ? (
                <Badge size="sm" tone={active ? "primary" : "neutral"} className="ms-2">
                  <bdi data-numeric="">{count(badge)}</bdi>
                </Badge>
              ) : null}
            </Link>
          );
        })}
      </div>

      <p className="mb-4 text-xs leading-relaxed text-ink-subtle">
        {STAGES.find((entry) => entry.key === stage)?.hint}
      </p>

      <FilterBar
        collapsible
        summary="فیلترهای پیشرفته (نوع پرونده، وضعیت پرداخت، وضعیت سفارش…)"
        onReset={() =>
          router.push(adminReconciliationHref({ stage, page: 1 }))
        }
      >
        <Select
          label="نوع پرونده"
          value={filters.caseType ?? ""}
          onChange={(event) =>
            apply({ caseType: (event.target.value || undefined) as QueueFilters["caseType"] })
          }
          options={[
            { value: "", label: "همه" },
            ...CASE_TYPES.map((value) => ({ value, label: CASE_TYPE_LABEL[value] ?? value })),
          ]}
        />
        <Select
          label="وضعیت پرداخت"
          value={filters.paymentStatus ?? ""}
          onChange={(event) =>
            apply({
              paymentStatus: (event.target.value || undefined) as QueueFilters["paymentStatus"],
            })
          }
          options={[
            { value: "", label: "همه" },
            ...PAYMENT_STATUSES.map((value) => ({
              value,
              label: PAYMENT_STATUS_FA[value] ?? value,
            })),
          ]}
        />
        <Select
          label="وضعیت سفارش"
          value={filters.orderStatus ?? ""}
          onChange={(event) => apply({ orderStatus: event.target.value || undefined })}
          options={[
            { value: "", label: "همه" },
            ...ORDER_STATUSES.map((value) => ({ value, label: ORDER_STATUS_FA[value] ?? value })),
          ]}
        />
        <Select
          label="وضعیت آماده‌سازی"
          value={filters.fulfillmentState ?? ""}
          onChange={(event) => apply({ fulfillmentState: event.target.value || undefined })}
          options={[
            { value: "", label: "همه" },
            ...FULFILLMENT_STATES.map((value) => ({
              value,
              label: FULFILMENT_FA[value] ?? value,
            })),
          ]}
        />
      </FilterBar>

      {queue.error ? (
        <ErrorState error={queue.error} title="فهرست پرونده‌ها خوانده نشد" onRetry={queue.refetch} />
      ) : queue.isLoading || !queue.data ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="kz-sr-only">در حال بارگذاری</span>
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} shape="block" height="9rem" />
          ))}
        </div>
      ) : queue.data.items.length === 0 ? (
        <EmptyState
          icon={<ScaleIcon className="size-8 text-ink-subtle" />}
          title={
            stage === "needs_action"
              ? "هیچ پروندهٔ نیازمند اقدامی نیست"
              : stage === "tracking"
                ? "هیچ پروندهٔ در حال پیگیری وجود ندارد"
                : "هیچ پروندهٔ بسته‌شده‌ای با این فیلترها نیست"
          }
          description={
            stage === "needs_action"
              ? "پول و کالا در همهٔ سفارش‌ها با هم جور است."
              : "اگر فیلتر پیشرفته‌ای اعمال کرده‌اید، آن را پاک کنید."
          }
        />
      ) : (
        <>
          <ul className="space-y-3">
            {queue.data.items.map((row) => (
              <CaseCard key={row.orderId} row={row} />
            ))}
          </ul>
          <Pagination
            className="mt-6"
            pageInfo={queue.data.pageInfo}
            buildHref={(page) => adminReconciliationHref({ ...filters, stage, page })}
          />
        </>
      )}
    </>
  );
}

/**
 * ONE CASE, answering the six questions.
 *
 * The technical badges are kept — an operator who knows the vocabulary should
 * not have to give it up — but they sit BELOW the sentence, not instead of it.
 */
function CaseCard({ row }: { row: ReconciliationCaseSummary }) {
  const plain = readCase(row);

  return (
    <Card as="li" tone="outlined" padding="md" interactive className="relative min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Badge size="sm" tone={SEVERITY_TONE[plain.severity]}>
              {plain.severity === "urgent" ? (
                <AlertIcon className="me-1 inline size-3 align-[-1px]" aria-hidden="true" />
              ) : null}
              {SEVERITY_LABEL[plain.severity]}
            </Badge>
            <Link
              href={adminCaseHref(row.orderId) as Route}
              className="no-underline before:absolute before:inset-0 before:content-['']"
            >
              <bdi dir="ltr" data-numeric="" className="text-sm font-bold text-primary">
                {row.orderNumber ?? `#${row.orderId}`}
              </bdi>
            </Link>
            <span className="text-2xs text-ink-subtle">{channelLabel(row.channel)}</span>
            {plain.needsGatewayAction ? (
              <Badge size="sm" tone="info">
                نیازمند اقدام در پنل درگاه
              </Badge>
            ) : null}
          </p>
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-ink">
            {plain.whatHappened}
          </p>
        </div>

        <div className="shrink-0 text-start sm:text-end">
          <p className="text-2xs text-ink-subtle">مبلغ سفارش</p>
          <p className="text-sm font-bold text-ink" data-numeric="">
            {formatRialString(row.money.orderTotal)}
          </p>
          {row.money.hasAmountDiscrepancy ? (
            <p className="mt-1 text-2xs text-danger">مبلغ دریافتی با سفارش نمی‌خواند</p>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 grid gap-2 sm:grid-cols-3">
        <QA question="پول مشتری دریافت شد؟" answer={plain.moneyLabel} />
        <QA question="کالا از انبار کسر شد؟" answer={plain.stockLabel} />
        <QA question="می‌شود سفارش را تکمیل کرد؟" answer={plain.fulfillableLabel} />
      </dl>

      <p className="mt-3 rounded-md bg-primary-soft/50 p-3 text-sm leading-relaxed text-ink">
        <b>قدم بعدی: </b>
        {plain.nextStep}
      </p>

      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-subtle">
        <span>
          وضعیت پرونده:{" "}
          <b className="text-ink-muted">{reconciliationStateLabel(row.reconciliationState)}</b>
        </span>
        <span>
          ایجاد: <bdi data-numeric="">{when(row.createdAt)}</bdi>
        </span>
        {row.paidAt ? (
          <span>
            پرداخت: <bdi data-numeric="">{when(row.paidAt)}</bdi>
          </span>
        ) : null}
        {row.reconciliationResolvedAt ? (
          <span>
            بسته‌شده: <bdi data-numeric="">{when(row.reconciliationResolvedAt)}</bdi>
          </span>
        ) : null}
        {row.caseTypes.map((type) => (
          <Badge key={type} size="sm" tone="neutral">
            {CASE_TYPE_LABEL[type] ?? type}
          </Badge>
        ))}
      </p>
    </Card>
  );
}

function QA({ question, answer }: { question: string; answer: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-muted p-2.5">
      <dt className="text-2xs text-ink-subtle">{question}</dt>
      <dd className="mt-0.5 text-xs leading-relaxed text-ink">{answer}</dd>
    </div>
  );
}

/*
 * These four maps stay LOCAL to the advanced-filter area on purpose.
 *
 * `lib/labels.ts` already owns the labels the rest of the console renders;
 * these are the *option* labels of the technical selects, worded for somebody
 * who has deliberately opened the advanced panel. Exporting them would invite
 * their use as primary labels elsewhere, which is exactly what this redesign
 * moved away from.
 */
const PAYMENT_STATUS_FA: Record<string, string> = {
  pending: "در انتظار پرداخت",
  success: "موفق",
  failed: "ناموفق",
  refunded: "بازپرداخت‌شده",
  confirmed_unapplied: "تأییدشده اما اعمال‌نشده",
};

const ORDER_STATUS_FA: Record<string, string> = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  processing: "در حال آماده‌سازی",
  shipped: "ارسال‌شده",
  delivered: "تحویل‌شده",
  canceled: "لغو‌شده",
  failed: "ناموفق",
  refunded: "مرجوع‌شده",
};

const FULFILMENT_FA: Record<string, string> = {
  not_required: "نیازی نیست",
  pending: "در انتظار کسر موجودی",
  fulfilled: "کسر شد",
  awaiting_stock: "در انتظار موجودی",
  failed: "ناموفق",
};
