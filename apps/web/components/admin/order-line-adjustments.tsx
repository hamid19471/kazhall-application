"use client";

import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";

import { isApiError } from "@kazhal/api-client";
import { Badge, Button, Input, Money, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import {
  AdminSection,
  ConfirmDialog,
  DataTable,
  EmptyRow,
  Td,
  Textarea,
  Th,
  Tr,
  count,
} from "@/components/admin/ui";
import { LINE_ADJUSTMENT_KINDS, fetchProfitOrder, postLineAdjustments } from "@/lib/admin-api";
import type { LineAdjustmentKind, ProfitOrderLine } from "@/lib/admin-api";
import { isKeyConflict, useAttemptKey } from "@/lib/attempt-key";
import { parseQuantityInput } from "@/lib/costing";
import { lineAdjustmentKindLabel, lineCostStatusLabel, lineCostStatusTone } from "@/lib/labels";
import { isSuperAdmin } from "@/lib/permissions";

const KIND_HINT: Record<LineAdjustmentKind, string> = {
  return_refund:
    "کالا به انبار برمی‌گردد و مبلغ آن به مشتری پس داده می‌شود. درآمد و بهای تمام‌شدهٔ همان واحدها برگشت می‌خورد.",
  refund_only:
    "پول پس داده می‌شود اما کالا به انبار برنمی‌گردد (مثلاً کالای آسیب‌دیده). درآمد برگشت می‌خورد ولی بهای تمام‌شده نه — این یک زیان واقعی است.",
  return_only:
    "کالا به انبار برمی‌گردد بدون بازپرداخت (مثلاً تعویض). درآمد تغییر نمی‌کند؛ بهای واحدها به ارزش موجودی برمی‌گردد.",
};

/** How many units of a line this kind may still reverse. */
function maxFor(line: ProfitOrderLine, kind: LineAdjustmentKind): number {
  const { revenueUnits, restockUnits } = line.remaining;
  if (kind === "return_refund") return Math.min(revenueUnits, restockUnits);
  if (kind === "refund_only") return revenueUnits;
  return restockUnits;
}

/**
 * «برگشت و بازپرداخت اقلام» — partial returns and refunds, per line
 * (docs/PURCHASE-COST-ACCOUNTING.md §5).
 *
 * SUPER_ADMIN ONLY, by role. For anybody else this renders nothing and never
 * requests `/reports/profit/orders/:id` (which carries cost) or posts the
 * adjustment.
 */
export function LineAdjustmentsPanel({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const { session } = useAppSession();
  if (!isSuperAdmin(session)) return null;
  return <PanelBody orderId={orderId} onDone={onDone} />;
}

function PanelBody({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const api = useApi();
  const kindName = useId();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchProfitOrder(api, orderId, { signal }),
    [api, orderId],
  );
  const [kind, setKind] = useState<LineAdjustmentKind>("return_refund");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<ReactNode>(null);

  const close = useCallback(() => setConfirming(false), []);

  if (error) {
    return (
      <AdminSection className="mt-4" title="برگشت و بازپرداخت اقلام">
        <FormError error={error} />
      </AdminSection>
    );
  }
  if (isLoading || !data) {
    return (
      <AdminSection className="mt-4" title="برگشت و بازپرداخت اقلام">
        <Skeleton shape="block" height="8rem" />
      </AdminSection>
    );
  }

  const lines = data.lines;
  const selections: Array<{ line: ProfitOrderLine; quantity: number }> = [];
  const rowProblems: Record<number, string> = {};
  for (const line of lines) {
    const raw = quantities[line.orderItemId] ?? "";
    const parsed = parseQuantityInput(raw);
    if (parsed.kind === "empty" || (parsed.kind === "value" && parsed.value === 0)) continue;
    if (parsed.kind === "invalid") {
      rowProblems[line.orderItemId] = "تعداد را با عدد صحیح بنویسید.";
      continue;
    }
    if (line.costStatus === "pending") {
      rowProblems[line.orderItemId] = "این قلم هنوز از انبار خارج نشده است؛ سفارش را لغو کنید.";
      continue;
    }
    const max = maxFor(line, kind);
    if (parsed.value > max) {
      rowProblems[line.orderItemId] = `حداکثر ${count(max)} واحد از این قلم باقی مانده است.`;
      continue;
    }
    selections.push({ line, quantity: parsed.value });
  }
  const reasonShort = reason.trim().length < 4;
  const hasRowProblem = Object.keys(rowProblems).length > 0;
  const revenueBack = kind !== "return_only";
  const stockBack = kind !== "refund_only";

  function review() {
    setTouched(true);
    setDone(null);
    if (selections.length === 0 || hasRowProblem || reasonShort) return;
    setConfirming(true);
  }

  function succeeded(message: ReactNode) {
    setConfirming(false);
    setQuantities({});
    setReason("");
    setTouched(false);
    setDone(message);
    refetch();
    onDone();
  }

  return (
    <AdminSection
      className="mt-4"
      title="برگشت و بازپرداخت اقلام"
      description="برای برگشت یا بازپرداخت بخشی از سفارش. وضعیت کلی سفارش تغییر نمی‌کند؛ پس از اولین برگشت جزئی، ابطال یا مرجوعیِ کل سفارش دیگر ممکن نیست و باقی اقلام از همین بخش برگشت می‌خورند."
    >
      {done ? (
        <Notice tone="success" className="mb-4">
          {done}
        </Notice>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-bold text-ink">نوع برگشت</legend>
        {LINE_ADJUSTMENT_KINDS.map((option) => (
          <label
            key={option}
            className="flex items-start gap-2.5 rounded-md border border-line p-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]"
          >
            <input
              type="radio"
              name={kindName}
              checked={kind === option}
              onChange={() => setKind(option)}
              className="mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-bold text-ink">{lineAdjustmentKindLabel(option)}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{KIND_HINT[option]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mt-4">
        <DataTable minWidth="48rem" caption="اقلام قابل برگشت">
          <thead>
            <tr>
              <Th>کالا</Th>
              <Th numeric>تعداد فروش</Th>
              <Th numeric>قابل بازپرداخت</Th>
              <Th numeric>قابل برگشت به انبار</Th>
              <Th>قیمت خرید</Th>
              <Th>تعداد این برگشت</Th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <EmptyRow colSpan={6}>این سفارش قلمی ندارد.</EmptyRow>
            ) : (
              lines.map((line) => {
                const max = maxFor(line, kind);
                const problem = rowProblems[line.orderItemId];
                return (
                  <Tr key={line.orderItemId}>
                    <Td>
                      <span className="block font-bold text-ink">{line.productTitle}</span>
                      <bdi dir="ltr" data-numeric="" className="block text-2xs text-ink-subtle">
                        {[line.productCode, line.variantCode].filter(Boolean).join(" · ")}
                      </bdi>
                    </Td>
                    <Td numeric>{count(line.quantity)}</Td>
                    <Td numeric>{count(line.remaining.revenueUnits)}</Td>
                    <Td numeric>{count(line.remaining.restockUnits)}</Td>
                    <Td>
                      <Badge size="sm" tone={lineCostStatusTone(line.costStatus)}>
                        {lineCostStatusLabel(line.costStatus)}
                      </Badge>
                    </Td>
                    <Td>
                      <Input
                        label={`تعداد برگشت «${line.productTitle}»`}
                        hideLabel
                        numeric
                        value={quantities[line.orderItemId] ?? ""}
                        onChange={(event) =>
                          setQuantities((current) => ({ ...current, [line.orderItemId]: event.target.value }))
                        }
                        disabled={max === 0 || line.costStatus === "pending"}
                        placeholder={max > 0 ? `حداکثر ${count(max)}` : "—"}
                        className="h-9 w-28 text-sm"
                        autoComplete="off"
                        {...(problem ? { error: problem } : {})}
                      />
                    </Td>
                  </Tr>
                );
              })
            )}
          </tbody>
        </DataTable>
      </div>

      <div className="mt-4">
        <Textarea
          label="دلیل (اجباری)"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          hint="دست‌کم ۴ نویسه؛ مثلاً «مشتری سایز را عوض کرد» یا «کالا هنگام تحویل شکسته بود»."
          {...(touched && reasonShort ? { error: "دلیل باید دست‌کم ۴ نویسه باشد." } : {})}
        />
      </div>

      {touched && selections.length === 0 && !hasRowProblem ? (
        <Notice tone="warning" className="mt-3">
          دست‌کم برای یک قلم تعداد بنویسید.
        </Notice>
      ) : null}

      <Button className="mt-4" onClick={review}>
        بررسی و ثبت برگشت
      </Button>

      {confirming ? (
        <ConfirmAdjustment
          orderId={orderId}
          kind={kind}
          reason={reason.trim()}
          selections={selections}
          revenueBack={revenueBack}
          stockBack={stockBack}
          onClose={close}
          onDone={succeeded}
          onStale={() => {
            setConfirming(false);
            refetch();
          }}
        />
      ) : null}
    </AdminSection>
  );
}

function ConfirmAdjustment({
  orderId,
  kind,
  reason,
  selections,
  revenueBack,
  stockBack,
  onClose,
  onDone,
  onStale,
}: {
  orderId: number;
  kind: LineAdjustmentKind;
  reason: string;
  selections: Array<{ line: ProfitOrderLine; quantity: number }>;
  revenueBack: boolean;
  stockBack: boolean;
  onClose: () => void;
  onDone: (message: ReactNode) => void;
  onStale: () => void;
}) {
  const api = useApi();
  const { key, settle } = useAttemptKey();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const units = selections.reduce((sum, item) => sum + item.quantity, 0);

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await postLineAdjustments(
        api,
        orderId,
        {
          kind,
          reason,
          lines: selections.map(({ line, quantity }) => ({ orderItemId: line.orderItemId, quantity })),
        },
        key,
      );
      onDone(
        <p>
          {lineAdjustmentKindLabel(kind)} ثبت شد.
          {result.totals ? (
            <>
              {" "}
              درآمد برگشتی <Money value={result.totals.revenueReversed} />، واحدهای برگشته به انبار{" "}
              <bdi data-numeric="">{count(result.totals.unitsRestocked)}</bdi>.
            </>
          ) : null}
        </p>,
      );
    } catch (caught) {
      setError(caught);
      settle(caught);
    } finally {
      setPending(false);
    }
  }

  const code = isApiError(error) ? error.code : undefined;
  const stale = code === "ADJUSTMENT_EXCEEDS_LINE";

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => (stale ? onStale() : void confirm())}
      title={`تأیید ${lineAdjustmentKindLabel(kind)}`}
      question="این کار برگشت‌ناپذیر است و در دفتر سفارش ثبت می‌شود."
      tone="danger"
      isPending={pending}
      confirmLabel={stale ? "بارگذاری دوباره" : "تأیید و ثبت"}
      consequences={[
        <>
          <bdi data-numeric="">{count(units)}</bdi> واحد از{" "}
          <bdi data-numeric="">{count(selections.length)}</bdi> قلم.
        </>,
        revenueBack
          ? "مبلغ این واحدها از درآمد فروش کم می‌شود؛ پول را از همان راهی که دریافت شده به مشتری برگردانید (این سامانه پولی جابه‌جا نمی‌کند)."
          : "درآمد فروش تغییر نمی‌کند.",
        stockBack
          ? "واحدها به موجودی انبار برمی‌گردند و بهای دقیق خودشان به ارزش موجودی اضافه می‌شود."
          : "کالا به انبار برنمی‌گردد و بهای آن به‌عنوان زیان باقی می‌ماند.",
        `دلیل: ${reason}`,
      ]}
    >
      <AdjustmentFailure error={error} />
    </ConfirmDialog>
  );
}

function AdjustmentFailure({ error }: { error: unknown }) {
  if (!error) return null;
  const code = isApiError(error) ? error.code : undefined;
  if (isKeyConflict(error)) {
    return (
      <Notice tone="warning" title="این برگشت قبلاً با مقادیر دیگری فرستاده شده است">
        <p className="text-xs leading-relaxed">
          ممکن است تلاش قبلی ثبت شده باشد. پنجره را ببندید و صفحه را به‌روز کنید تا چیزی دو بار ثبت
          نشود.
        </p>
      </Notice>
    );
  }
  const known: Record<string, { title: string; body: string }> = {
    ORDER_NOT_ADJUSTABLE: {
      title: "برای این سفارش برگشت ممکن نیست",
      body: "سفارش لغوشده، ابطال‌شده، کاملاً مرجوع‌شده یا پرداخت‌نشده است. هیچ تغییری ثبت نشد.",
    },
    ORDER_LINE_NOT_FULFILLED: {
      title: "قلمی هنوز از انبار خارج نشده است",
      body: "سفارش اینترنتیِ آماده‌نشده لغو می‌شود، نه بازپرداخت جزئی. هیچ تغییری ثبت نشد.",
    },
    ADJUSTMENT_EXCEEDS_LINE: {
      title: "تعداد از باقی‌ماندهٔ قلم بیشتر است",
      body: "از زمان باز شدن این صفحه برگشت دیگری ثبت شده است. «بارگذاری دوباره» را بزنید و تعدادها را دوباره بررسی کنید.",
    },
    ORDER_HAS_LINE_ADJUSTMENTS: {
      title: "این سفارش برگشت جزئی دارد",
      body: "باقی اقلام را از همین بخش برگشت بزنید.",
    },
  };
  const entry = code ? known[code] : undefined;
  if (entry) {
    return (
      <Notice tone="warning" title={entry.title}>
        <p className="text-xs leading-relaxed">{entry.body}</p>
      </Notice>
    );
  }
  if (isApiError(error) && error.status === 0) {
    return (
      <Notice tone="danger" title="ارتباط با سرور برقرار نشد">
        <p className="text-xs leading-relaxed">
          دوباره «تأیید و ثبت» را بزنید؛ همان کلید تکرار فرستاده می‌شود و سرور آن را دو بار ثبت
          نمی‌کند.
        </p>
      </Notice>
    );
  }
  return <FormError error={error} />;
}
