"use client";

import Link from "next/link";
import type { Route } from "next";
import type { JSX, ReactNode } from "react";

import type { PosSaleResult } from "@kazhal/api-client";
import { Badge, Button, Card, Money, cx, formatDateTime, formatInteger } from "@kazhal/ui";

import { PrinterIcon, ReceiptIcon, TentIcon } from "./icons";
import { paymentMethodLabel } from "../lib/pos-domain";
import type { SaleFailure } from "../lib/sale-failure";
import type { TillLine } from "../lib/till-state";

/**
 * A 44×44 CSS-pixel hit target — the smallest a finger can reliably hit. Plain
 * `<button>` rather than the shared `Button`, because overriding that
 * component's own padding would depend on Tailwind's class ORDER rather than on
 * anything guaranteed.
 */
const STEPPER =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-line-strong " +
  "bg-surface text-xl leading-none text-ink transition-colors hover:bg-surface-muted " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)] " +
  "disabled:cursor-not-allowed disabled:opacity-55";

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

export interface BasketProps {
  lines: TillLine[];
  /** False while a sale is in flight or the basket is frozen. */
  editable: boolean;
  /** Variant ids the server named in an INSUFFICIENT_STOCK refusal. */
  flagged: ReadonlySet<number>;
  onQuantity: (variantId: number, quantity: number) => void;
  onRemove: (variantId: number) => void;
}

export function Basket({ lines, editable, flagged, onQuantity, onRemove }: BasketProps): JSX.Element {
  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line px-6 py-16 text-center">
        <span aria-hidden="true" className="text-ink-subtle">
          <TentIcon className="size-10" />
        </span>
        <p className="text-lg font-semibold text-ink">سبد خالی است</p>
        <p className="max-w-prose text-sm text-ink-muted">
          از فهرست کالاها کالای موردنظر را انتخاب کنید تا به این سبد افزوده شود. برای پیدا کردن
          سریع‌تر می‌توانید جست‌وجو کنید یا دسته‌بندی را تغییر دهید.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {lines.map((line) => {
        const short = line.availableForPos !== null && line.quantity > line.availableForPos;
        const isFlagged = flagged.has(line.variantId);
        /*
         * A LINE WHOSE SKU HAS BEEN RETIRED.
         *
         * It can only appear on a basket that was built while the SKU was
         * still active: the POS catalogue never lists a retired variant. An
         * administrator retiring it mid-sale reaches the till as a
         * `pos:availability:invalidated` frame, the authoritative refresh
         * reports `isActive: false`, and the row says so here.
         *
         * `availableForPos` is deliberately NOT how this is detected: the
         * figure is raw, so a retired variant with units in the stockroom
         * still reports a positive number. The row keeps showing that number,
         * because the stock is real -- what changed is that it cannot be sold.
         */
        const retired = !line.isActive;
        return (
          <Card
            as="li"
            key={line.variantId}
            tone="outlined"
            padding="sm"
            className={cx(
              "grid gap-3 sm:grid-cols-[1fr_auto]",
              (isFlagged || retired) && "border-danger bg-danger-soft",
            )}
          >
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-ink">{line.productTitle}</p>
              {/*
                The attributes come FIRST and the SKU second. Two lines for one
                product differ only by these values, and "سرمه‌ای / ۵۰ لیتر" is
                what the cashier and the customer are both looking at; the code
                is secondary information printed on the shelf label.
              */}
              {line.attributes.length > 0 ? (
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {line.attributes.map((attribute) => (
                    <span key={attribute.id}>
                      {attribute.name ? (
                        <span className="text-ink-subtle">{attribute.name}: </span>
                      ) : null}
                      <span className="font-semibold text-ink">{attribute.value}</span>
                    </span>
                  ))}
                </p>
              ) : null}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span dir="ltr" data-numeric="">
                  {line.sku}
                </span>
                {/*
                  «کد گونه» beside the SKU, when the catalogue sent one. Two
                  codes need telling apart, so this one is labelled; the SKU
                  above keeps its bare form, which is how it appears on the
                  shelf label the cashier is comparing against.
                */}
                {line.variantCode ? (
                  <>
                    <span aria-hidden="true">•</span>
                    <span>
                      کد گونه:{" "}
                      <span dir="ltr" data-numeric="">
                        {line.variantCode}
                      </span>
                    </span>
                  </>
                ) : null}
                <span aria-hidden="true">•</span>
                <span>
                  واحد: <Money value={line.unitPrice} className="text-ink" />
                </span>
              </p>
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                {line.availableForPos === null ? (
                  <Badge tone="neutral" size="sm">
                    موجودی نامشخص
                  </Badge>
                ) : (
                  <Badge tone={short ? "danger" : "neutral"} size="sm">
                    موجودی قابل فروش: {formatInteger(line.availableForPos)}
                  </Badge>
                )}
                {retired ? (
                  <Badge tone="danger" size="sm">
                    غیرفعال — قابل فروش نیست
                  </Badge>
                ) : null}
                {line.availabilityStale ? (
                  <Badge tone="warning" size="sm">
                    در حال به‌روزرسانی
                  </Badge>
                ) : null}
                {retired ? (
                  <span className="text-danger">
                    این کد کالا غیرفعال شده است و ثبت فروش آن ممکن نیست؛ آن را از سبد بردارید.
                  </span>
                ) : null}
                {short && !retired ? (
                  <span className="text-danger">
                    تعداد درخواستی بیش از موجودی نمایش‌داده‌شده است — عدد نمایشی تقریبی است و
                    تصمیم نهایی با سرور است.
                  </span>
                ) : null}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 sm:justify-end">
              <div className="flex items-center gap-1.5" role="group" aria-label={`تعداد ${line.productTitle}`}>
                <button
                  type="button"
                  className={STEPPER}
                  disabled={!editable}
                  aria-label={`کاهش تعداد ${line.productTitle}`}
                  onClick={() => onQuantity(line.variantId, line.quantity - 1)}
                >
                  <span aria-hidden="true">−</span>
                </button>
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  dir="ltr"
                  data-numeric=""
                  disabled={!editable}
                  aria-label={`تعداد ${line.productTitle}`}
                  value={line.quantity}
                  onChange={(event) => onQuantity(line.variantId, Number(event.target.value))}
                  className="h-11 w-16 rounded-md border border-line-strong bg-surface text-center text-base text-ink disabled:bg-surface-muted"
                />
                <button
                  type="button"
                  className={STEPPER}
                  disabled={!editable}
                  aria-label={`افزایش تعداد ${line.productTitle}`}
                  onClick={() => onQuantity(line.variantId, line.quantity + 1)}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>

              <p className="min-w-28 text-end text-lg font-bold text-ink">
                <Money value={line.unitPrice * line.quantity} />
              </p>

              <button
                type="button"
                className={cx(STEPPER, "border-transparent text-ink-muted hover:text-danger")}
                disabled={!editable}
                aria-label={`حذف ${line.productTitle} از سبد`}
                onClick={() => onRemove(line.variantId)}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          </Card>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export interface SaleProblemProps {
  failure: SaleFailure;
  onRetrySameKey: () => void;
  onStartNewSale: () => void;
  onDismiss: () => void;
  busy: boolean;
}

/**
 * The only place a cashier is told what to do about a failed sale.
 *
 * The wording is deliberately different for a REFUSAL (the server said no,
 * nothing was written, edit and try again) and an UNKNOWN OUTCOME (no answer
 * came back, the sale may exist). Collapsing the two into one "try again" is
 * exactly how a till double-sells.
 */
export function SaleProblem({
  failure,
  onRetrySameKey,
  onStartNewSale,
  onDismiss,
  busy,
}: SaleProblemProps): JSX.Element {
  const tone = failure.outcomeUnknown ? "warning" : "danger";
  return (
    <Card
      tone="outlined"
      padding="md"
      role="alert"
      aria-live="assertive"
      className={cx(
        "border-2",
        tone === "warning" ? "border-warning bg-warning-soft" : "border-danger bg-danger-soft",
      )}
    >
      <h3 className="text-lg text-ink">{failure.title}</h3>
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink">{failure.body}</p>

      {failure.stock ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-surface/70 p-3 text-sm sm:grid-cols-4">
          {failure.stock.sku ? (
            <Detail label="کد کالا">
              <span dir="ltr" data-numeric="">
                {failure.stock.sku}
              </span>
            </Detail>
          ) : null}
          {/*
            The shop's own codes, printed only when the server named them.
            Three different identifiers share this block, so each keeps its own
            label: the SKU above is the warehouse's string, «کد محصول» names the
            family and «کد گونه» the exact variant.
          */}
          {failure.stock.productCode ? (
            <Detail label="کد محصول">
              <span dir="ltr" data-numeric="">
                {failure.stock.productCode}
              </span>
            </Detail>
          ) : null}
          {failure.stock.variantCode ? (
            <Detail label="کد گونه">
              <span dir="ltr" data-numeric="">
                {failure.stock.variantCode}
              </span>
            </Detail>
          ) : null}
          {failure.stock.requested !== undefined ? (
            <Detail label="درخواستی">{formatInteger(failure.stock.requested)}</Detail>
          ) : null}
          {failure.stock.available !== undefined ? (
            <Detail label="موجود">{formatInteger(failure.stock.available)}</Detail>
          ) : null}
          {failure.stock.retryable !== undefined ? (
            <Detail label="قابل تلاش دوباره">{failure.stock.retryable ? "بله" : "خیر"}</Detail>
          ) : null}
        </dl>
      ) : null}

      {failure.reconciliation ? <ReconciliationNotice pointer={failure.reconciliation} /> : null}

      <div className="mt-5 flex flex-wrap gap-3">
        {failure.canRetrySameKey ? (
          <Button size="lg" onClick={onRetrySameKey} isLoading={busy}>
            تلاش دوباره با همان کلید
          </Button>
        ) : null}

        {failure.outcomeUnknown || failure.keyIsSpent ? (
          <>

            <Button size="lg" variant="secondary" onClick={onStartNewSale} disabled={busy}>
              رها کردن و شروع فروش جدید
            </Button>
          </>
        ) : (
          <Button size="lg" variant="secondary" onClick={onDismiss} disabled={busy}>
            اصلاح سبد
          </Button>
        )}
      </div>

      {failure.outcomeUnknown ? (
        <p className="mt-4 text-xs leading-relaxed text-ink-muted">
          «تلاش دوباره» همان کلید یکتای این فروش را می‌فرستد؛ اگر فروش قبلاً ثبت شده باشد سرور
          همان رسید را برمی‌گرداند و فروش دومی ساخته نمی‌شود. «شروع فروش جدید» کلید تازه می‌سازد،
          پس فقط وقتی از آن استفاده کنید که وضعیت فروش قبلی را در فهرست فروش‌ها بررسی کرده باشید.
        </p>
      ) : null}

      {failure.code ? (
        <p className="mt-3 text-2xs text-ink-subtle" dir="ltr">
          {failure.code}
        </p>
      ) : null}
    </Card>
  );
}

export function ReconciliationNotice({
  pointer,
}: {
  pointer: NonNullable<SaleFailure["reconciliation"]>;
}): JSX.Element {
  return (
    <div className="mt-4 rounded-md border border-warning/40 bg-surface/70 p-3 text-sm">
      <p className="font-semibold text-ink">این پرونده باید در صف مغایرت‌ها بررسی شود</p>
      <p className="mt-1 text-ink-muted">
        صندوق این تغییر وضعیت را انجام نمی‌دهد و آن را دوباره امتحان نمی‌کند. بررسی و تعیین تکلیف
        بر عهده‌ی کاربر دارای دسترسی مغایرت‌هاست.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        {pointer.orderId !== undefined ? (
          <Detail label="شناسه سفارش">{formatInteger(pointer.orderId)}</Detail>
        ) : null}
        {pointer.status ? <Detail label="وضعیت">{pointer.status}</Detail> : null}
        {pointer.fulfillmentState ? (
          <Detail label="وضعیت تحویل">{pointer.fulfillmentState}</Detail>
        ) : null}
        {pointer.reconciliationQueue ? (
          <Detail label="صف">{pointer.reconciliationQueue}</Detail>
        ) : null}
      </dl>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="font-semibold text-ink">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

export function SaleRecorded({
  sale,
  onNewSale,
}: {
  sale: PosSaleResult;
  onNewSale: () => void;
}): JSX.Element {
  const receiptHref = `/receipt/${sale.id}` as Route;
  return (
    <Card tone="outlined" padding="lg" className="border-2 border-success bg-success-soft">
      <div className="flex flex-col items-center gap-2 text-center">
        <span aria-hidden="true" className="text-success">
          <ReceiptIcon className="size-10" />
        </span>
        <h2 className="text-2xl text-ink">فروش ثبت شد</h2>
        <p className="text-sm text-ink-muted">شماره‌ی سفارش را برای مشتری بخوانید:</p>
        {/*
          The order number is shown EXACTLY as the server returned it — no
          prefixing, no reformatting, no digit conversion. It is the one string
          the customer and the shop will quote at each other later.
        */}
        <p
          dir="ltr"
          data-numeric=""
          className="select-all rounded-md bg-surface px-5 py-3 text-2xl font-bold tracking-wide text-ink"
        >
          {sale.orderNumber ?? `#${sale.id}`}
        </p>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Detail label="مبلغ کل">
          <Money value={sale.totalPrice} />
        </Detail>
        <Detail label="شیوه پرداخت">{paymentMethodLabel(sale.paymentMethod)}</Detail>
        <Detail label="صندوق‌دار">{sale.cashierDisplaySnapshot ?? "—"}</Detail>
        <Detail label="شعبه">{sale.branchNameSnapshot ?? "—"}</Detail>
        <Detail label="زمان">{sale.soldAt ? formatDateTime(sale.soldAt) : "—"}</Detail>
        <Detail label="تعداد اقلام">{formatInteger(sale.items.length)}</Detail>
      </dl>

      {sale.displacedBasketLines > 0 ? (
        <p className="mt-4 rounded-md bg-surface/70 p-3 text-xs leading-relaxed text-ink-muted">
          برای تکمیل این فروش، {formatInteger(sale.displacedBasketLines)} سطر از سبدهای رزروشده‌ی
          اینترنتی آزاد شد. مشتریان آن سبدها اطلاع‌رسانی می‌شوند؛ اطلاعات آن‌ها در صندوق نمایش داده
          نمی‌شود.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={receiptHref}
          className="inline-flex h-13 items-center gap-2 rounded-md bg-primary px-6 text-base font-semibold text-primary-ink no-underline"
        >
          <PrinterIcon className="size-5" />
          مشاهده و چاپ رسید
        </Link>
        <Button size="lg" variant="secondary" onClick={onNewSale}>
          فروش بعدی
        </Button>
      </div>
    </Card>
  );
}
