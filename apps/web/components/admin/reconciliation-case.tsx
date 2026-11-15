"use client";

import Link from "next/link";
import { useState } from "react";

import type {
  ApiError,
  IdempotentAttempt,
  ReconciliationActionName,
  ReconciliationActionResult,
  ReconciliationCaseDetail,
  ReconciliationReceipt,
  ReconciliationResolutionType,
} from "@kazhal/api-client";
import { beginIdempotentAttempt, isApiError, isMissingOrForbidden } from "@kazhal/api-client";
import { Badge, Button, Card, ErrorState, Input, Skeleton, cx, formatDateTime, formatInteger, parseRial } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Breadcrumbs, FormError, Notice, PageHeading } from "@/components/common";
import { Gate, RequirePermission } from "@/components/admin/ui";
import { AlertIcon, CheckIcon, ScaleIcon, ShieldIcon } from "@/components/icons";
import {
  ACTION_LABEL,
  CASE_TYPE_DESCRIPTION,
  CASE_TYPE_LABEL,
  RESOLUTION_TYPE_LABEL,
  auditActionLabel,
  channelLabel,
  fulfillmentStateLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentReconciliationReasonLabel,
  paymentStatusLabel,
  paymentStatusTone,
  reconciliationStateLabel,
  reconciliationStateTone,
} from "@/lib/labels";
import { formatRialString } from "@/lib/money";
import { useSubmit } from "@/lib/hooks";

const MIN_REASON_LENGTH = 4;

const TEXTAREA_CLASS =
  "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink " +
  "placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 " +
  "focus-visible:outline-[color:var(--kz-focus)]";

/**
 * Conflict copy, keyed by the server's machine-readable code.
 *
 * Every one of these is a REFUSAL WITH A REASON, not a bug: the server checked
 * the case's current state under a row lock and declined. The operator needs to
 * know which fact blocked them, so each message names it.
 */
const CONFLICT_COPY: Record<string, string> = {
  RECONCILIATION_CASE_NOT_FOUND:
    "پرونده‌ای برای این سفارش وجود ندارد، یا دیگر چیزی برای تعیین تکلیف ندارد.",
  RECONCILIATION_ALREADY_RESOLVED:
    "این پرونده قبلاً بسته شده است. برای ثبت تصمیم تازه، ابتدا باید دوباره باز شود.",
  REFUND_ALREADY_CONFIRMED: "بازپرداخت این رسید پیش‌تر تأیید شده است؛ تأیید دوباره ثبت نمی‌شود.",
  REFUND_PENDING_CONFIRMATION:
    "برای این پرونده تعهد بازپرداخت ثبت شده است. تا وقتی بازپرداخت تأیید نشود، پرونده را نمی‌توان بدون اقدام مالی بست.",
  PAYMENT_NOT_ON_ORDER: "این رسید متعلق به این سفارش نیست.",
  PAYMENT_NOT_REFUNDABLE: "درگاه هرگز این تلاش پرداخت را تأیید نکرده؛ چیزی برای بازگرداندن نیست.",
  REFUND_AMOUNT_INVALID:
    "مبلغ بازپرداخت باید مثبت باشد و از بزرگ‌ترین رقم ثبت‌شده برای این رسید بیشتر نباشد.",
  ORDER_NOT_RETRYABLE:
    "وضعیت سفارش اجازهٔ تلاش دوباره برای آماده‌سازی را نمی‌دهد (فقط «پرداخت‌شده» با آماده‌سازی انجام‌نشده یا در انتظار موجودی).",
  ORDER_NOT_BACKORDERABLE:
    "این سفارش پرداخت‌شده نیست، یا کالایش قبلاً تخصیص یافته است؛ ثبت انتظار موجودی معنا ندارد.",
  IDEMPOTENCY_KEY_REQUIRED: "درخواست بدون کلید یکتا فرستاده شد. دوباره تلاش کنید.",
  IDEMPOTENCY_KEY_INVALID: "کلید یکتای این درخواست معتبر نبود. دوباره تلاش کنید.",
  IDEMPOTENCY_KEY_REUSED:
    "همین کلید قبلاً با محتوای دیگری ثبت شده است. فرم را ببندید و تصمیم را از نو ثبت کنید.",
  IDEMPOTENCY_REQUEST_IN_PROGRESS:
    "همین تصمیم هم‌اکنون در حال ثبت است. چند لحظه صبر کنید؛ ارسال دوباره، تصمیم دومی ثبت نمی‌کند.",
};

export function ReconciliationCase({ orderId }: { orderId: number }) {
  return (
    <RequirePermission permissions={["reconciliation.read"]}>
      <CaseLoader orderId={orderId} />
    </RequirePermission>
  );
}

function CaseLoader({ orderId }: { orderId: number }) {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => api.reconciliation.getCase(orderId, { signal }),
    [api, orderId],
  );

  if (error) {
    return (
      <>
        <ErrorState error={error} {...(isMissingOrForbidden(error) ? {} : { onRetry: refetch })} />
        <p className="mt-6">
          <Link href="/admin/reconciliation" className="text-sm">
            بازگشت به صف مغایرت‌ها
          </Link>
        </p>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <div role="status" aria-busy="true" className="space-y-4">
        <span className="kz-sr-only">در حال بارگذاری پرونده</span>
        <Skeleton shape="block" height="10rem" />
        <Skeleton shape="block" height="16rem" />
      </div>
    );
  }

  return <CaseBody caseDetail={data} onChanged={refetch} />;
}

function CaseBody({
  caseDetail,
  onChanged,
}: {
  caseDetail: ReconciliationCaseDetail;
  onChanged: () => void;
}) {
  const [lastResult, setLastResult] = useState<ReconciliationActionResult | null>(null);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "مغایرت‌های پرداخت", href: "/admin/reconciliation" },
          { label: caseDetail.orderNumber ?? `#${caseDetail.orderId}` },
        ]}
      />

      <PageHeading
        title={
          <>
            پروندهٔ سفارش{" "}
            <bdi data-numeric="">
              {caseDetail.orderNumber ?? formatInteger(caseDetail.orderId)}
            </bdi>
          </>
        }
        description="شناسهٔ پرونده همان شناسهٔ سفارش است؛ یک سفارش می‌تواند چند رسید داشته باشد که همگی به همین پرونده تعلق دارند."
      />

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge tone={orderStatusTone(caseDetail.orderStatus)}>
          {orderStatusLabel(caseDetail.orderStatus)}
        </Badge>
        <Badge tone="neutral">{fulfillmentStateLabel(caseDetail.fulfillmentState)}</Badge>
        <Badge tone={reconciliationStateTone(caseDetail.reconciliationState)}>
          {reconciliationStateLabel(caseDetail.reconciliationState)}
        </Badge>
        <Badge tone="neutral">{channelLabel(caseDetail.channel)}</Badge>
        {caseDetail.reconciliationResolvedAt ? (
          <Badge tone="success">
            بسته‌شده در {formatDateTime(caseDetail.reconciliationResolvedAt)}
          </Badge>
        ) : null}
      </div>

      {lastResult ? <ActionResultNotice result={lastResult} /> : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="space-y-6">
          <WhyPanel caseDetail={caseDetail} />
          <MoneyPanel caseDetail={caseDetail} />
          <ReceiptsPanel caseDetail={caseDetail} />
          <StockPanel caseDetail={caseDetail} />
          <AuditPanel caseDetail={caseDetail} />
        </div>

        <div className="space-y-4 lg:sticky lg:top-8">
          <CustomerPanel caseDetail={caseDetail} />
          <ActionsPanel
            caseDetail={caseDetail}
            onDone={(result) => {
              setLastResult(result);
              onChanged();
            }}
          />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Evidence panels
// ---------------------------------------------------------------------------

function WhyPanel({ caseDetail }: { caseDetail: ReconciliationCaseDetail }) {
  return (
    <Card tone="outlined" as="section">
      <h2 className="text-lg text-ink">چرا این پرونده باز است</h2>
      <ul className="mt-3 space-y-2">
        {caseDetail.caseTypes.map((type) => (
          <li key={type} className="rounded-md bg-surface-muted p-3">
            <p className="text-sm font-bold text-ink">{CASE_TYPE_LABEL[type] ?? type}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              {CASE_TYPE_DESCRIPTION[type] ?? ""}
            </p>
          </li>
        ))}
      </ul>

      <Notice
        tone={caseDetail.fulfilmentAuthorized ? "success" : "warning"}
        className="mt-4"
        icon={caseDetail.fulfilmentAuthorized ? <CheckIcon className="size-5" /> : <AlertIcon className="size-5" />}
        title={
          caseDetail.fulfilmentAuthorized
            ? "دست‌کم یک رسید، مجوز کسر موجودی را می‌دهد"
            : "هیچ رسیدی مجوز کسر موجودی را نمی‌دهد"
        }
      >
        <p>
          این همان شرطی است که خود سرویس آماده‌سازی ارزیابی می‌کند. تا وقتی برقرار نباشد، «تلاش
          دوباره» هیچ کالایی را کسر نمی‌کند و با <bdi dir="ltr">blocked</bdi> برمی‌گردد.
        </p>
      </Notice>

      {caseDetail.authorizationClauses.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-xs">
            <caption className="mb-2 text-start text-xs text-ink-subtle">
              تشخیص بند‌به‌بند مجوز، برای هر رسید
            </caption>
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th scope="col" className="p-2 text-start font-semibold">
                  رسید
                </th>
                <th scope="col" className="p-2 text-start font-semibold">
                  موفق
                </th>
                <th scope="col" className="p-2 text-start font-semibold">
                  مبلغ درگاه
                </th>
                <th scope="col" className="p-2 text-start font-semibold">
                  برابری با درخواست
                </th>
                <th scope="col" className="p-2 text-start font-semibold">
                  برابری با سفارش
                </th>
                <th scope="col" className="p-2 text-start font-semibold">
                  دلیل حل‌شده
                </th>
                <th scope="col" className="p-2 text-start font-semibold">
                  نتیجه
                </th>
              </tr>
            </thead>
            <tbody>
              {caseDetail.authorizationClauses.map((clause) => (
                <tr key={clause.paymentId} className="border-b border-line/60">
                  <td className="p-2" data-numeric="">
                    {formatInteger(clause.paymentId)}
                  </td>
                  <ClauseCell value={clause.isSuccess} />
                  <ClauseCell value={clause.hasGatewayAmount} />
                  <ClauseCell value={clause.gatewayMatchesAmount} />
                  <ClauseCell value={clause.amountMatchesOrder} />
                  <ClauseCell value={clause.reasonResolved} />
                  <td className="p-2">
                    <Badge size="sm" tone={clause.qualifies ? "success" : "danger"}>
                      {clause.qualifies ? "مجاز" : "غیرمجاز"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function ClauseCell({ value }: { value: boolean }) {
  return (
    <td className="p-2">
      <span className={value ? "text-success" : "text-danger"} aria-hidden="true">
        {value ? "✓" : "✗"}
      </span>
      <span className="kz-sr-only">{value ? "برقرار" : "برقرار نیست"}</span>
    </td>
  );
}

function MoneyPanel({ caseDetail }: { caseDetail: ReconciliationCaseDetail }) {
  const { money } = caseDetail;
  return (
    <Card tone="outlined" as="section">
      <h2 className="text-lg text-ink">وضعیت پول</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <MoneyFact label="مبلغ سفارش" value={money.orderTotal} />
        <MoneyFact label="تأییدشده و نزد ما" value={money.confirmedHeld} />
        <MoneyFact
          label="تأییدشده اما اعمال‌نشده"
          value={money.confirmedUnapplied}
          tone={money.confirmedUnapplied !== "0" ? "warning" : undefined}
        />
        <MoneyFact label="بازپرداخت‌شده" value={money.refundedTotal} />
      </dl>

      <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
        «نزد ما» و «بازپرداخت‌شده» دو سطل جدا هستند؛ هیچ رسیدی در هر دو شمرده نمی‌شود.
      </p>

      {money.hasAmountDiscrepancy ? (
        <Notice tone="danger" className="mt-3" title="دست‌کم یک رسید، مبلغی متفاوت اعلام کرده است">
          <p>مغایرت خنثی نشده است؛ در جدول رسیدها، رقم ما و رقم درگاه جداگانه آمده‌اند.</p>
        </Notice>
      ) : null}
    </Card>
  );
}

function MoneyFact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className="rounded-md bg-surface-muted p-3">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd
        className={cx("mt-1 text-base font-bold", tone === "warning" ? "text-warning" : "text-ink")}
        data-numeric=""
      >
        <bdi>{formatRialString(value)}</bdi>
      </dd>
    </div>
  );
}

function ReceiptsPanel({ caseDetail }: { caseDetail: ReconciliationCaseDetail }) {
  return (
    <Card tone="outlined" as="section">
      <h2 className="text-lg text-ink">رسیدهای پرداخت</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
        شناسهٔ نشست درگاه (<bdi dir="ltr">track_id</bdi>) عمداً نمایش داده نمی‌شود؛ آن شناسه خودش
        اعتبارنامهٔ «تأیید پرداخت» است.
      </p>

      {caseDetail.receipts.length === 0 ? (
        <p className="mt-3 text-sm text-ink-subtle">این سفارش هیچ تلاش پرداختی ندارد.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {caseDetail.receipts.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReceiptRow({ receipt }: { receipt: ReconciliationReceipt }) {
  const mismatched =
    receipt.gatewayAmount !== null && receipt.gatewayAmount !== receipt.amount;

  return (
    <li className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-ink">
            رسید <bdi data-numeric="">{formatInteger(receipt.id)}</bdi>
          </p>
          <p className="mt-1 text-2xs text-ink-subtle">
            ایجاد {formatDateTime(receipt.createdAt)}
            {receipt.paidAt ? <> · تأیید درگاه {formatDateTime(receipt.paidAt)}</> : null}
          </p>
          {receipt.refNumber ? (
            <p className="mt-1 text-2xs text-ink-muted">
              مرجع درگاه:{" "}
              <bdi dir="ltr" data-numeric="">
                {receipt.refNumber}
              </bdi>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge size="sm" tone={paymentStatusTone(receipt.status)}>
            {paymentStatusLabel(receipt.status)}
          </Badge>
          {receipt.reconciledAt ? (
            <span className="text-2xs text-ink-subtle">
              بسته‌شده {formatDateTime(receipt.reconciledAt)}
            </span>
          ) : receipt.requiresReconciliation ? (
            <Badge size="sm" tone="warning">
              نیازمند بررسی
            </Badge>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-1">
          <dt className="text-ink-subtle">مبلغ درخواستی ما</dt>
          <dd data-numeric="">
            <bdi>{formatRialString(receipt.amount)}</bdi>
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-ink-subtle">مبلغ اعلامی درگاه</dt>
          <dd className={mismatched ? "text-danger" : undefined} data-numeric="">
            <bdi>{formatRialString(receipt.gatewayAmount, { fallback: "اعلام نشده" })}</bdi>
          </dd>
        </div>
        {receipt.gatewayAmountRaw ? (
          <div className="flex gap-1">
            <dt className="text-ink-subtle">رقم خام درگاه</dt>
            <dd dir="ltr" className="text-danger">
              {receipt.gatewayAmountRaw}
            </dd>
          </div>
        ) : null}
      </dl>

      {receipt.reconciliationReason ? (
        <p className="mt-2 text-xs text-warning">
          {paymentReconciliationReasonLabel(receipt.reconciliationReason)}
        </p>
      ) : null}
    </li>
  );
}

function StockPanel({ caseDetail }: { caseDetail: ReconciliationCaseDetail }) {
  const { stock } = caseDetail;
  return (
    <Card tone="outlined" as="section">
      <h2 className="text-lg text-ink">وضعیت کالا</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <NumberFact label="تعداد کل سفارش" value={stock.orderedUnits} />
        <NumberFact label="حرکت‌های آماده‌سازی" value={stock.fulfilmentMovements} />
        <NumberFact label="خالص حرکت انبار" value={stock.netMovementDelta} />
        <NumberFact label="واحدهای در تخصیص فعال" value={stock.activeAllocationUnits} />
      </dl>
      <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
        «حرکت‌های آماده‌سازی» صفر یعنی هرگز کالایی از انبار خارج نشده؛ در این حالت بازپرداخت هم
        چیزی به انبار برنمی‌گرداند. «تخصیص فعال» یک نگهداشت است، نه موجودی فیزیکی.
      </p>
    </Card>
  );
}

function NumberFact({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-muted p-3">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="mt-1 text-base font-bold text-ink" data-numeric="">
        {formatInteger(value)}
      </dd>
    </div>
  );
}

function CustomerPanel({ caseDetail }: { caseDetail: ReconciliationCaseDetail }) {
  const { customer } = caseDetail;
  return (
    <Card tone="outlined" as="section">
      <h2 className="text-base font-bold text-ink">مشتری</h2>
      <dl className="mt-3 space-y-2 text-sm">
        {customer.displayName ? (
          <div className="flex justify-between gap-2">
            <dt className="text-ink-subtle">نام</dt>
            <dd className="text-ink">{customer.displayName}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt className="text-ink-subtle">موبایل</dt>
          <dd dir="ltr" data-numeric="" className="text-ink">
            {customer.mobile ?? "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
        تنها اطلاعات تماسی که این نما ارائه می‌کند همین شماره است.
      </p>
    </Card>
  );
}

function AuditPanel({ caseDetail }: { caseDetail: ReconciliationCaseDetail }) {
  return (
    <Card tone="outlined" as="section">
      <h2 className="text-lg text-ink">سابقهٔ تصمیم‌ها</h2>
      {caseDetail.actions.length === 0 ? (
        <p className="mt-3 text-sm text-ink-subtle">هنوز هیچ تصمیمی روی این پرونده ثبت نشده است.</p>
      ) : (
        <ol className="mt-4 space-y-4 border-s-2 border-line ps-4">
          {caseDetail.actions.map((entry) => (
            <li key={entry.id} className="relative">
              <span
                aria-hidden="true"
                className="absolute -start-[1.3rem] top-1.5 size-2.5 rounded-pill bg-primary"
              />
              <p className="text-sm font-bold text-ink">{auditActionLabel(entry.action)}</p>
              <p className="mt-0.5 text-2xs text-ink-subtle">
                {formatDateTime(entry.createdAt)} · {entry.actorDisplaySnapshot}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{entry.reason}</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-ink-subtle">
                {entry.toOrderStatus ? (
                  <li>
                    وضعیت سفارش: {orderStatusLabel(entry.fromOrderStatus)} →{" "}
                    {orderStatusLabel(entry.toOrderStatus)}
                  </li>
                ) : null}
                {entry.toReconciliationState ? (
                  <li>
                    وضعیت پرونده: {reconciliationStateLabel(entry.fromReconciliationState)} →{" "}
                    {reconciliationStateLabel(entry.toReconciliationState)}
                  </li>
                ) : null}
                {entry.amount ? (
                  <li>
                    مبلغ: <bdi data-numeric="">{formatRialString(entry.amount)}</bdi>
                  </li>
                ) : null}
                {entry.externalReference ? (
                  <li>
                    مرجع:{" "}
                    <bdi dir="ltr" data-numeric="">
                      {entry.externalReference}
                    </bdi>
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The action panel.
 *
 * **Buttons come from `allowedActions[]` and from nowhere else.** The server
 * computes it from the case's current state, so rendering the full menu and
 * discovering legality through a 409 would be guessing — and would offer an
 * operator a "confirm refund" button on a case where that is not a legal move.
 * The server still validates every source state independently; this list is a
 * convenience and never the authorization.
 */
function ActionsPanel({
  caseDetail,
  onDone,
}: {
  caseDetail: ReconciliationCaseDetail;
  onDone: (result: ReconciliationActionResult) => void;
}) {
  const [open, setOpen] = useState<ReconciliationActionName | null>(null);

  return (
    <Card tone="raised" as="section">
      <h2 className="flex items-center gap-2 text-base font-bold text-ink">
        <ScaleIcon className="size-5 text-primary" aria-hidden="true" />
        تصمیم‌های مجاز
      </h2>

      {/*
        `allowedActions` ANSWERS A DIFFERENT QUESTION FROM "MAY YOU DO IT".
        The server computes that list from the CASE'S STATE — which moves are
        legal on a case in this condition — and every one of the routes behind
        those buttons additionally declares `reconciliation.act`. A reviewer
        holding only `reconciliation.read` must therefore be told what they can
        and cannot do, rather than being shown five buttons that all end in a
        refusal, or an empty card that reads as "this case needs nothing".
      */}
      <Gate
        permissions={["reconciliation.act"]}
        fallback={
          <div className="mt-3 rounded-md bg-surface-muted p-3">
            <p className="text-sm leading-relaxed text-ink-muted">
              شما این پرونده را می‌بینید ولی اختیار تصمیم‌گیری روی آن را ندارید: بررسی شواهد،
              رسیدها و ردّ ممیزی برای شما باز است، اما ثبت تصمیم — بازپرداخت، بستن پرونده یا تلاش
              دوبارهٔ کسر موجودی — نیاز به اختیار زیر دارد.
            </p>
            <p className="mt-2">
              <Badge size="sm" tone="neutral">
                <bdi dir="ltr">reconciliation.act</bdi>
              </Badge>
            </p>
            <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
              هیچ‌چیز روی این پرونده تغییر نکرده است. برای گرفتن این اختیار با مدیر ارشد صحبت
              کنید.
            </p>
          </div>
        }
      >
      {caseDetail.allowedActions.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          در وضعیت فعلی، هیچ تصمیمی روی این پرونده پذیرفته نمی‌شود.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {caseDetail.allowedActions.map((action) => (
            <li key={action}>
              <Button
                variant={open === action ? "primary" : "secondary"}
                size="sm"
                fullWidth
                onClick={() => setOpen((current) => (current === action ? null : action))}
              >
                {ACTION_LABEL[action] ?? action}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <ActionForm
          key={open}
          action={open}
          caseDetail={caseDetail}
          onCancel={() => setOpen(null)}
          onDone={(result) => {
            setOpen(null);
            onDone(result);
          }}
        />
      ) : null}
      </Gate>

      <p className="mt-4 flex items-start gap-1.5 text-2xs leading-relaxed text-ink-subtle">
        <ShieldIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        هر تصمیم یک سطر تغییرناپذیر در ردّ ممیزی ثبت می‌کند و با یک کلید یکتا محافظت می‌شود، پس
        دوبار کلیک‌کردن، تصمیم را — و پول را — دوبار جابه‌جا نمی‌کند.
      </p>
    </Card>
  );
}

const RESOLUTION_TYPES: ReconciliationResolutionType[] = [
  "no_discrepancy",
  "settled_externally",
  "customer_agreed",
  "gateway_duplicate",
];

function ActionForm({
  action,
  caseDetail,
  onCancel,
  onDone,
}: {
  action: ReconciliationActionName;
  caseDetail: ReconciliationCaseDetail;
  onCancel: () => void;
  onDone: (result: ReconciliationActionResult) => void;
}) {
  const api = useApi();

  // ONE key per DECISION, held for the lifetime of this form so that every
  // retry of the same decision replays instead of recording a second one.
  const [attempt] = useState<IdempotentAttempt>(() => beginIdempotentAttempt("recon"));

  const [reason, setReason] = useState("");
  const [expectedAmount, setExpectedAmount] = useState("");
  const [paymentId, setPaymentId] = useState<number | "">(
    caseDetail.receipts.find((receipt) => receipt.status === "success")?.id ??
      caseDetail.receipts[0]?.id ??
      "",
  );
  const [amount, setAmount] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [resolutionType, setResolutionType] = useState<ReconciliationResolutionType>(
    "no_discrepancy",
  );

  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [conflict, setConflict] = useState<string | null>(null);
  const [localProblem, setLocalProblem] = useState<string | null>(null);

  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;

  const { run: submit, isPending } = useSubmit(async () => {
    setError(undefined);
    setConflict(null);
    setLocalProblem(null);

    if (reasonTooShort) {
      setLocalProblem("دلیل باید دست‌کم ۴ نویسه باشد؛ این تنها سند «چرا» در ردّ ممیزی است.");
      return;
    }

    const base = { reason: reason.trim() };

    try {
      let response: { data: ReconciliationActionResult };

      switch (action) {
        case "retry_fulfilment":
          response = await api.reconciliation.retryFulfilment(caseDetail.orderId, base, { attempt });
          break;
        case "mark_refund_required": {
          const parsed = parseRial(expectedAmount);
          response = await api.reconciliation.markRefundRequired(
            caseDetail.orderId,
            { ...base, ...(parsed !== null && parsed > 0 ? { expectedAmount: parsed } : {}) },
            { attempt },
          );
          break;
        }
        case "confirm_external_refund": {
          const parsed = parseRial(amount);
          if (paymentId === "") {
            setLocalProblem("رسیدی که بازپرداخت شده است را انتخاب کنید.");
            return;
          }
          if (parsed === null || parsed <= 0) {
            setLocalProblem("مبلغ بازپرداخت‌شده را به ریال و به صورت عدد صحیح وارد کنید.");
            return;
          }
          if (externalReference.trim() === "") {
            setLocalProblem("مرجع بازپرداخت نزد ارائه‌دهنده الزامی است.");
            return;
          }
          response = await api.reconciliation.confirmExternalRefund(
            caseDetail.orderId,
            {
              ...base,
              paymentId,
              amount: parsed,
              externalReference: externalReference.trim(),
            },
            { attempt },
          );
          break;
        }
        case "mark_backorder":
          response = await api.reconciliation.markBackorder(caseDetail.orderId, base, { attempt });
          break;
        case "resolve_no_action":
          response = await api.reconciliation.resolve(
            caseDetail.orderId,
            { ...base, resolutionType },
            { attempt },
          );
          break;
        default:
          return;
      }

      onDone(response.data);
    } catch (cause) {
      if (!isApiError(cause)) return;
      const copy = cause.code ? CONFLICT_COPY[cause.code] : undefined;
      if (copy) {
        setConflict(copy);
        // A reused key means this key is spent for a DIFFERENT body. Renewing
        // makes the operator's corrected submission a new decision rather than
        // a rejected replay of the old one.
        if (cause.code === "IDEMPOTENCY_KEY_REUSED") attempt.renew();
        return;
      }
      setError(cause);
    }
  });

  return (
    <div className="mt-4 space-y-3 rounded-md border border-line bg-surface-muted p-3">
      <h3 className="text-sm font-bold text-ink">{ACTION_LABEL[action] ?? action}</h3>
      <ActionExplainer action={action} />

      {action === "mark_refund_required" ? (
        <Input
          label="مبلغ مورد انتظار بازپرداخت (ریال) — اختیاری"
          numeric
          value={expectedAmount}
          onChange={(event) => setExpectedAmount(event.target.value)}
          className="h-9 text-sm"
          hint="فقط روی سطر ممیزی ثبت می‌شود؛ هیچ پولی با این کار جابه‌جا نمی‌شود."
        />
      ) : null}

      {action === "confirm_external_refund" ? (
        <>
          <label className="block">
            <span className="block text-sm font-medium text-ink">رسیدی که بازپرداخت شد</span>
            <select
              value={paymentId === "" ? "" : String(paymentId)}
              onChange={(event) =>
                setPaymentId(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="mt-1.5 h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--kz-focus)]"
            >
              <option value="">انتخاب کنید…</option>
              {caseDetail.receipts.map((receipt) => (
                <option key={receipt.id} value={receipt.id}>
                  #{receipt.id} — {paymentStatusLabel(receipt.status)} —{" "}
                  {formatRialString(receipt.amount, { withUnit: false })}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-ink-subtle">
              یک سفارش می‌تواند چند رسید تأییدشده داشته باشد؛ هیچ چیزی حدس زده نمی‌شود.
            </span>
          </label>

          <Input
            label="مبلغ بازپرداخت‌شده (ریال)"
            numeric
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="h-9 text-sm"
          />

          <Input
            label="مرجع بازپرداخت نزد ارائه‌دهنده"
            required
            value={externalReference}
            onChange={(event) => setExternalReference(event.target.value)}
            className="h-9 text-sm"
            hint="فقط حروف و ارقام و . _ : / -"
          />
        </>
      ) : null}

      {action === "resolve_no_action" ? (
        <label className="block">
          <span className="block text-sm font-medium text-ink">نوع تعیین تکلیف</span>
          <select
            value={resolutionType}
            onChange={(event) =>
              setResolutionType(event.target.value as ReconciliationResolutionType)
            }
            className="mt-1.5 h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--kz-focus)]"
          >
            {RESOLUTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {RESOLUTION_TYPE_LABEL[value] ?? value}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div>
        <label htmlFor={`reason-${action}`} className="block text-sm font-medium text-ink">
          دلیل تصمیم
          <span className="text-danger ms-1" aria-hidden="true">
            *
          </span>
        </label>
        <textarea
          id={`reason-${action}`}
          rows={3}
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={cx("mt-1.5", TEXTAREA_CLASS)}
          placeholder="مثلاً: با بانک تماس گرفته شد؛ فقط یک برداشت ثبت شده است."
        />
        <p className="mt-1 text-xs text-ink-subtle">
          الزامی و دست‌کم ۴ نویسه. عیناً در ردّ ممیزی ثبت می‌شود و هرگز به مشتری نشان داده نمی‌شود.
        </p>
      </div>

      {localProblem ? <Notice tone="danger">{localProblem}</Notice> : null}
      {conflict ? <Notice tone="warning" title="سرور این تصمیم را نپذیرفت">{conflict}</Notice> : null}
      <FormError error={error} />

      <div className="flex gap-2">
        <Button size="sm" isLoading={isPending} disabled={reasonTooShort} onClick={() => void submit()}>
          ثبت تصمیم
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          انصراف
        </Button>
      </div>
    </div>
  );
}

/**
 * WHAT PRESSING THIS WILL ACTUALLY DO — six answers, before confirmation.
 *
 * An operator about to record a decision on somebody else's money needs the
 * same six facts every time, in the same order, so that reading them becomes a
 * habit rather than an effort:
 *
 *   money      does this move any money?
 *   order      does the order's status change?
 *   stock      does physical inventory change?
 *   note       is this only an internal record?
 *   gateway    must something be done in the provider's own panel first?
 *   reversible can this be undone?
 *
 * A prose paragraph cannot be scanned for those, and the previous version was
 * written in the vocabulary of the implementation ("the authorisation clause is
 * not relaxed", "returns with `blocked`") rather than of the person pressing
 * the button. The answers below are statements about what the API does — each
 * one is checked against the corresponding handler in
 * `apps/api/src/modules/payment/reconciliation.service.ts`.
 */
interface ActionFacts {
  money: string;
  order: string;
  stock: string;
  note: string;
  gateway: string | null;
  reversible: string;
}

const ACTION_FACTS: Record<ReconciliationActionName, ActionFacts> = {
  retry_fulfilment: {
    money: "نه. هیچ وجهی جابه‌جا نمی‌شود.",
    order: "اگر کسر موجودی موفق شود، وضعیت آماده‌سازی سفارش به «کسر شد» تغییر می‌کند.",
    stock: "بله — در صورت موفقیت، کالاها از موجودی فیزیکی انبار کم می‌شوند.",
    note: "نه؛ این یک اقدام واقعی روی موجودی است، نه یادداشت.",
    gateway: null,
    reversible:
      "کسر موجودی با «مرجوعی» یا «ابطال» سفارش قابل بازگشت است، اما نه از همین صفحه.",
  },
  mark_refund_required: {
    money: "نه. هیچ پولی بازگردانده نمی‌شود — این فقط ثبت می‌کند که باید بازگردانده شود.",
    order: "نه. وضعیت سفارش دست‌نخورده می‌ماند.",
    stock: "نه.",
    note: "بله — یک تعهد ثبت می‌شود و پرونده عمداً باز می‌ماند تا انجام شود.",
    gateway:
      "بعد از این، بازپرداخت را در پنل درگاه پرداخت انجام دهید و سپس «تأیید بازپرداخت انجام‌شده در درگاه» را ثبت کنید.",
    reversible:
      "خودِ ثبت پاک نمی‌شود (سابقه افزودنی است)، اما می‌توانید بعداً بازپرداخت را تأیید کنید.",
  },
  confirm_external_refund: {
    money:
      "این سامانه پولی جابه‌جا نمی‌کند. شما تأیید می‌کنید که بازپرداخت را قبلاً در پنل درگاه انجام داده‌اید.",
    order:
      "اگر این رسید همان پرداخت اصلی سفارش باشد، وضعیت سفارش به «مرجوع‌شده» تغییر می‌کند و مبلغ در گزارش فروش به‌عنوان بازپرداخت امروز ثبت می‌شود.",
    stock:
      "بله، اگر کالا قبلاً از انبار کسر شده بود: همان اقلام به موجودی بازمی‌گردند. اگر رسید تکراری بوده، هیچ موجودی‌ای برنمی‌گردد.",
    note: "نه؛ این یک ثبت مالی با اثر واقعی روی گزارش‌ها است.",
    gateway:
      "بازپرداخت باید پیش از این کار در پنل درگاه انجام شده باشد و شمارهٔ پیگیری آن را لازم دارید.",
    reversible: "نه. پرونده بسته می‌شود و این ثبت قابل حذف یا ویرایش نیست.",
  },
  mark_backorder: {
    money: "نه.",
    order: "نه. سفارش پرداخت‌شده باقی می‌ماند و منتظر موجودی می‌شود.",
    stock: "نه — هیچ کالایی کسر یا رزرو نمی‌شود.",
    note: "بله — تصمیم «منتظر می‌مانیم» ثبت می‌شود و پرونده در صف پیگیری می‌ماند.",
    gateway: null,
    reversible:
      "بله. به‌محض تأمین کالا می‌توانید «تلاش دوباره برای تکمیل موجودی» را بزنید.",
  },
  resolve_no_action: {
    money: "نه. هیچ وجهی جابه‌جا نمی‌شود.",
    order: "نه. وضعیت سفارش تغییر نمی‌کند.",
    stock: "نه.",
    note: "بله — پرونده بسته می‌شود با این توضیح که چیزی لازم نبوده جابه‌جا شود.",
    gateway: null,
    reversible: "نه. پرونده بسته می‌شود و این ثبت قابل حذف نیست.",
  },
};

function ActionExplainer({ action }: { action: ReconciliationActionName }) {
  const facts = ACTION_FACTS[action];

  const rows: Array<[string, string]> = [
    ["پولی جابه‌جا می‌شود؟", facts.money],
    ["وضعیت سفارش عوض می‌شود؟", facts.order],
    ["موجودی انبار عوض می‌شود؟", facts.stock],
    ["فقط یادداشت داخلی است؟", facts.note],
    ["برگشت‌پذیر است؟", facts.reversible],
  ];

  return (
    <div className="space-y-2">
      {facts.gateway ? (
        <Notice tone="warning" title="ابتدا در پنل درگاه پرداخت اقدام کنید">
          {facts.gateway}
        </Notice>
      ) : null}
      <dl className="divide-y divide-line rounded-md border border-line">
        {rows.map(([question, answer]) => (
          <div key={question} className="flex flex-wrap gap-x-2 p-2.5">
            <dt className="shrink-0 text-2xs font-bold text-ink-muted">{question}</dt>
            <dd className="min-w-0 flex-1 text-xs leading-relaxed text-ink">{answer}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ActionResultNotice({ result }: { result: ReconciliationActionResult }) {
  const blocked = typeof result.blocked === "string" && result.blocked !== "";

  return (
    <Notice
      tone={blocked ? "warning" : "success"}
      className="mt-5"
      icon={blocked ? <AlertIcon className="size-5" /> : <CheckIcon className="size-5" />}
      title={blocked ? "تصمیم ثبت شد، اما آماده‌سازی انجام نشد" : "تصمیم ثبت شد"}
    >
      <div className="space-y-1">
        <p>{result.message}</p>
        {blocked ? (
          <p className="font-semibold">
            دلیل توقف: <bdi dir="ltr">{result.blocked}</bdi> — این سفارش را «در حال ارسال» تلقی
            نکنید.
          </p>
        ) : null}
        {result.fulfilled === true ? <p>موجودی در همین فراخوانی کسر شد.</p> : null}
        {result.stockRestored === false ? (
          <p>هیچ موجودی‌ای برنگشت، چون این سفارش هرگز کالایی از انبار کسر نکرده بود.</p>
        ) : null}
        {result.stockRestored === true ? <p>موجودی فیزیکی به انبار بازگردانده شد.</p> : null}
        <p className="text-2xs text-ink-subtle">
          شمارهٔ سطر ممیزی: <bdi data-numeric="">{formatInteger(result.actionId)}</bdi>
        </p>
      </div>
    </Notice>
  );
}
