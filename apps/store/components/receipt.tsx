"use client";

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";

import type { PosSaleResult } from "@kazhal/api-client";
import { Button, Card, ErrorState, Money, Skeleton, cx, formatDateTime, formatInteger } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { PeakIcon, PrinterIcon } from "./icons";
import { channelLabel, orderStatusLabel, paymentMethodLabel } from "../lib/pos-domain";
import { readCachedSaleStable } from "../lib/receipt-store";
import { ownSale, type OwnSale } from "../lib/catalog";

/**
 * The customer's slip.
 *
 * Printing is the BROWSER's job: `window.print()` plus a print stylesheet. No
 * driver, no hardware integration, nothing to install on the terminal — the
 * shop's existing thermal or A4 printer is whatever the OS print dialog offers.
 *
 * Every value on the slip is a SALE-TIME SNAPSHOT (`productTitleSnapshot`,
 * `variantSkuSnapshot`, `attributesSnapshot`, `cashierDisplaySnapshot`,
 * `branchNameSnapshot`), so a reprint months later shows what was actually sold
 * even if the catalogue, the staff list or the branch has since changed.
 *
 * WHERE THE SLIP IS RE-READ FROM. `GET /orders/:id`, not `/reports/sales/:id`.
 * Reporting is `super_admin` only — a till must not be able to read the shop's
 * books — but `GET /orders/:id` is `@Roles(sale, super_admin)` and branch-
 * scoped, so a cashier can re-read the sale they just rang up and nothing else.
 * Seeing your own sale is not a reporting permission.
 */

interface ReceiptItem {
  key: string;
  title: string | null;
  sku: string | null;
  /**
   * «کد گونه» as snapshotted at sale time.
   *
   * `null` whenever the response did not carry one — the locally cached POS
   * result never does, and `GET /orders/:id` only does on builds whose
   * projection exposes the column. A slip prints what was sold; a code it was
   * not told is left off rather than reconstructed from the live catalogue,
   * which may have been re-coded since.
   */
  variantCode: string | null;
  /** The variant the customer actually bought, by real axis name. */
  attributes: Record<string, string> | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

interface ReceiptView {
  id: number;
  orderNumber: string | null;
  soldAt: string | null;
  status: string;
  channel: string;
  paymentMethod: string | null;
  cashier: string | null;
  branch: string | null;
  voidedAt: string | null;
  refundedAt: string | null;
  customer: { name: string | null; mobile: string | null } | null;
  items: ReceiptItem[];
  subtotal: number;
  totalPrice: number;
  source: "server" | "local";
}

function fromOrder(order: OwnSale): ReceiptView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    soldAt: order.soldAt,
    status: order.status,
    channel: order.channel,
    paymentMethod: order.paymentMethod,
    cashier: order.cashierDisplaySnapshot,
    branch: order.branchNameSnapshot,
    voidedAt: order.voidedAt,
    refundedAt: order.refundedAt,
    // `GET /orders/:id` carries a customer relation only when the sale had one;
    // a walk-in slip simply has no customer block rather than an invented one.
    customer: null,
    items: order.items.map((item) => ({
      key: String(item.id),
      title: item.productTitleSnapshot,
      sku: item.variantSkuSnapshot,
      variantCode: item.variantCodeSnapshot ?? null,
      attributes: item.attributesSnapshot,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      totalPrice: item.total_price,
    })),
    subtotal: order.subtotal,
    totalPrice: order.total_price,
    source: "server",
  };
}

function fromCache(sale: PosSaleResult): ReceiptView {
  return {
    id: sale.id,
    orderNumber: sale.orderNumber,
    soldAt: sale.soldAt,
    status: sale.status,
    channel: sale.channel,
    paymentMethod: sale.paymentMethod,
    cashier: sale.cashierDisplaySnapshot,
    branch: sale.branchNameSnapshot,
    voidedAt: sale.voidedAt,
    refundedAt: null,
    // The POS sale response carries only `customerId`, never the customer's
    // name or number — so a locally-rendered slip simply has no customer block
    // rather than an invented one.
    customer: null,
    items: sale.items.map((item) => ({
      key: String(item.id),
      title: item.productTitleSnapshot,
      sku: item.variantSkuSnapshot,
      // The POS sale response carries no code snapshot, so the locally
      // rendered slip simply has none; the server copy prints it on reprint.
      variantCode: null,
      attributes: item.attributesSnapshot ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
    })),
    subtotal: sale.subtotal,
    totalPrice: sale.totalPrice,
    source: "local",
  };
}

/** `sessionStorage` never changes underneath us, so there is nothing to watch. */
const NO_SUBSCRIBE = () => () => undefined;
/** The server has no session storage; its snapshot is always "nothing cached". */
const NO_SERVER_SNAPSHOT = () => null;

export function Receipt({ orderId }: { orderId: number }) {
  const api = useApi();

  // `useSyncExternalStore` rather than an effect: it gives the server a defined
  // "no cache" snapshot and lets the client swap in the cached slip during
  // hydration WITHOUT a mismatch and without a cascading setState.
  const cachedSale = useSyncExternalStore(
    NO_SUBSCRIBE,
    () => readCachedSaleStable(orderId),
    NO_SERVER_SNAPSHOT,
  );
  const cached = useMemo(() => (cachedSale ? fromCache(cachedSale) : null), [cachedSale]);

  const detail = useApiQuery(
    (signal) => ownSale(api, orderId, { signal }),
    [api, orderId],
  );

  /*
   * THE API DECIDES, NOT THE CACHE.
   *
   * The local slip is a resilience aid for the seconds right after a sale — it
   * must never stand in for a permission. So a REFUSAL from the server
   * (`GET /orders/:id` answers 404 for anything that is not this cashier's own
   * POS sale) discards the cache outright: if the server will not show you this
   * order, neither will this screen, even if a copy happens to be sitting in
   * `sessionStorage` from an earlier shift on the same terminal.
   *
   * A transport failure is a different fact — nobody refused anything — so the
   * cached slip may still be printed when the network is simply down.
   */
  const refused =
    detail.error !== undefined &&
    detail.error.kind !== "network" &&
    detail.error.kind !== "timeout";

  const view = detail.data
    ? fromOrder(detail.data)
    : refused
      ? null
      : cached;

  if (!view && detail.isLoading) {
    return (
      <div role="status" aria-busy="true" className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <span className="kz-sr-only">در حال بارگذاری رسید</span>
        <Skeleton shape="block" height="30rem" />
      </div>
    );
  }

  if (!view) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <ErrorState
          error={detail.error}
          onRetry={detail.refetch}
          title="این رسید در دسترس نیست"
          description="رسید فقط برای فروشی که خودتان ثبت کرده‌اید نمایش داده می‌شود. اگر این فروش را شما ثبت نکرده‌اید، از مدیر بخواهید آن را بررسی کند."
        />
        <p className="mt-6 text-center">
          <Link href="/pos">بازگشت به صندوق</Link>
        </p>
      </div>
    );
  }

  const reversed = view.voidedAt !== null || view.refundedAt !== null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <div className="kz-chrome mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link href="/pos" className="text-base font-semibold">
          → بازگشت به صندوق
        </Link>
        <div className="flex items-center gap-3">
          {detail.isLoading ? <span className="text-sm text-ink-muted">در حال به‌روزرسانی…</span> : null}
          <Button size="lg" leadingIcon={<PrinterIcon className="size-5" />} onClick={() => window.print()}>
            چاپ رسید
          </Button>
        </div>
      </div>

      {view.source === "local" ? (
        <p className="kz-chrome mb-4 rounded-md border border-line bg-surface-muted px-4 py-3 text-sm text-ink-muted">
          این نسخه از حافظه‌ی همین نشست نمایش داده می‌شود، چون خواندن سفارش از سرور هنوز کامل نشده
          است. مبالغ همان چیزی است که سرور هنگام ثبت فروش برگرداند.
        </p>
      ) : null}

      <Card as="article" tone="outlined" padding="lg" className="kz-receipt">
        <header className="flex flex-col items-center gap-1 border-b border-line pb-5 text-center">
          <span aria-hidden="true" className="text-primary">
            <PeakIcon className="size-9" />
          </span>
          <h1 className="text-xl text-ink">کژال — تجهیزات کوهنوردی و طبیعت‌گردی</h1>
          <p className="text-sm text-ink-muted">{view.branch ?? "شعبه نامشخص"}</p>
        </header>

        {reversed ? (
          <p className="mt-4 rounded-md border-2 border-danger bg-danger-soft px-4 py-3 text-center text-lg font-bold text-danger">
            {view.voidedAt !== null ? "این فروش ابطال شده است" : "این فروش مرجوع شده است"}
          </p>
        ) : null}

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="شماره سفارش">
            <span dir="ltr" data-numeric="" className="text-base font-bold">
              {view.orderNumber ?? `#${view.id}`}
            </span>
          </Field>
          <Field label="تاریخ و ساعت">{view.soldAt ? formatDateTime(view.soldAt) : "—"}</Field>
          <Field label="صندوق‌دار">{view.cashier ?? "—"}</Field>
          <Field label="شعبه">{view.branch ?? "—"}</Field>
          <Field label="شیوه پرداخت">{paymentMethodLabel(view.paymentMethod)}</Field>
          <Field label="وضعیت">{orderStatusLabel(view.status)}</Field>
          {view.channel !== "pos" ? (
            <Field label="کانال فروش">{channelLabel(view.channel)}</Field>
          ) : null}
          {view.customer && (view.customer.name || view.customer.mobile) ? (
            <Field label="مشتری">
              {view.customer.name ?? ""}
              {view.customer.mobile ? (
                <span dir="ltr" data-numeric="" className="ms-2">
                  {view.customer.mobile}
                </span>
              ) : null}
            </Field>
          ) : null}
        </dl>

        <table className="mt-6 w-full border-collapse text-sm">
          <caption className="kz-sr-only">اقلام این فروش</caption>
          <thead>
            <tr className="border-y border-line text-ink-muted">
              <th scope="col" className="py-2 text-start font-medium">
                کالا
              </th>
              <th scope="col" className="px-2 py-2 text-center font-medium">
                تعداد
              </th>
              <th scope="col" className="py-2 ps-3 text-end font-medium">
                بهای واحد
              </th>
              <th scope="col" className="py-2 ps-3 text-end font-medium">
                جمع
              </th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item) => (
              <tr key={item.key} className="border-b border-line align-top">
                <th scope="row" className="py-2.5 text-start font-normal">
                  <span className="block font-semibold text-ink">{item.title ?? "کالای حذف‌شده"}</span>
                  {/*
                    The variant, named. Without it a slip for a two-colour
                    product is ambiguous to the customer holding it, and to
                    whoever handles a return months later.
                  */}
                  {item.attributes && Object.keys(item.attributes).length > 0 ? (
                    <span className="block text-xs text-ink-muted">
                      {Object.entries(item.attributes)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                  {item.sku ? (
                    <span dir="ltr" data-numeric="" className="block text-xs text-ink-muted">
                      {item.sku}
                    </span>
                  ) : null}
                  {/*
                    «کد گونه» beside the SKU — the code the shop itself quotes
                    when a customer comes back with this slip. Two codes for one
                    line, so this one is labelled; printed only when the sale
                    snapshot actually carries it.
                  */}
                  {item.variantCode ? (
                    <span className="block text-xs text-ink-muted">
                      کد گونه:{" "}
                      <span dir="ltr" data-numeric="">
                        {item.variantCode}
                      </span>
                    </span>
                  ) : null}
                </th>
                <td className="px-2 py-2.5 text-center" data-numeric="">
                  {formatInteger(item.quantity)}
                </td>
                {/*
                  `ps-3` on both amount columns: they are end-aligned, so with no
                  inline padding the unit price and the line total touched and
                  read as one number on a narrow till (found by the PR #3
                  browser verification at 390px).
                */}
                <td className="py-2.5 ps-3 text-end">
                  <Money value={item.unitPrice} withUnit={false} />
                </td>
                <td className="py-2.5 ps-3 text-end font-semibold">
                  <Money value={item.totalPrice} withUnit={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="mt-5 flex flex-col gap-2 border-t border-line pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-muted">جمع اقلام</dt>
            <dd className="font-semibold text-ink">
              <Money value={view.subtotal} />
            </dd>
          </div>
          <div className={cx("flex justify-between text-lg", reversed && "line-through opacity-70")}>
            <dt className="font-bold text-ink">مبلغ کل</dt>
            <dd className="font-bold text-ink">
              <Money value={view.totalPrice} />
            </dd>
          </div>
        </dl>

        <footer className="mt-6 border-t border-line pt-4 text-center text-xs leading-relaxed text-ink-muted">
          <p>سپاس از خرید شما. برای مرجوعی، این رسید و شماره‌ی سفارش را همراه داشته باشید.</p>
          <p className="mt-1">همه‌ی مبالغ به ریال است.</p>
        </footer>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}
