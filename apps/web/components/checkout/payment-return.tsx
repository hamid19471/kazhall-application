"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { ApiError, PaymentVerifyResult } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import { Badge, Button, Card, Money, Spinner, formatInteger } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { Notice } from "@/components/common";
import { AlertIcon, CheckIcon, ShieldIcon } from "@/components/icons";
import { useCart } from "@/components/providers";
import {
  VERIFY_COPY,
  fulfillmentStateLabel,
  orderStatusLabel,
  paymentStatusLabel,
  paymentReconciliationReasonLabel,
  type VerifyOutcome,
} from "@/lib/labels";
import { orderHref } from "@/lib/routes";

/**
 * The gateway return page.
 *
 * ## The one rule
 *
 * **A redirect back from the gateway proves nothing.** Anyone can open this URL
 * with any query string, a gateway can redirect after a failure, and a
 * "success=1" parameter is just a parameter. The ONLY thing that decides what
 * the customer is told is the answer to `POST /payment/verify` — so this screen
 * renders a spinner until that call returns, and never a success message
 * before it.
 *
 * ## The outcomes that are not "paid" or "failed"
 *
 * `verify` answers 200 even when the receipt could NOT be applied: `applied:
 * false` with `requiresReconciliation` and a `reconciliationReason`. That is
 * real money that has not settled the order, and it gets its own honest
 * message — not "successful", and not "failed" either, because the customer's
 * money did move.
 *
 * An unknown `trackId` and one belonging to somebody else return a byte-
 * identical 404 on purpose, so that this page cannot be used to probe for other
 * customers' payment attempts. It therefore renders ONE message for both.
 */
export function PaymentReturnView({ trackId }: { trackId?: string }) {
  const api = useApi();
  const { refresh: refreshCart } = useCart();
  const [result, setResult] = useState<PaymentVerifyResult | null>(null);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [pending, setPending] = useState(Boolean(trackId));

  /*
   * `refreshCart` is read through a ref, NOT listed as an effect dependency.
   * Its identity changes as the cart provider settles right after mount; as a
   * dependency that re-ran the effect, whose cleanup ABORTED the verify call
   * in flight, while a `started` guard stopped the re-run from asking again.
   * The server had already verified the payment (an aborted fetch still
   * arrives), but the customer was shown «وضعیت پرداخت هنوز مشخص نیست».
   * Found by the PR #3 browser verification.
   */
  const refreshCartRef = useRef(refreshCart);
  useEffect(() => {
    refreshCartRef.current = refreshCart;
  }, [refreshCart]);

  useEffect(() => {
    if (!trackId) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api.payment.verify(trackId, { signal: controller.signal });
        setResult(response.data);
        refreshCartRef.current();
      } catch (cause) {
        if (isApiError(cause) && cause.kind === "aborted") return;
        setError(isApiError(cause) ? cause : undefined);
      } finally {
        // An aborted call belongs to an unmounted (or superseded) render and
        // must not settle this screen into an "undetermined" verdict.
        if (!controller.signal.aborted) setPending(false);
      }
    })();

    // Only an unmount or a genuinely different trackId/API cancels the call;
    // `verify` is idempotent server-side, so a re-run simply asks again.
    return () => controller.abort();
  }, [api, trackId]);

  if (!trackId) {
    return (
      <Shell>
        <Notice tone="warning" title="شناسهٔ پرداخت در آدرس نبود">
          <p>
            بدون شناسهٔ پرداخت نمی‌توان وضعیت را از درگاه پرسید. وضعیت سفارش خود را از فهرست
            سفارش‌ها ببینید.
          </p>
        </Notice>
        <BackLinks />
      </Shell>
    );
  }

  if (pending) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <Spinner size="lg" label="در حال بررسی نتیجهٔ پرداخت" />
          <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
            در حال گرفتن نتیجهٔ قطعی از درگاه پرداخت هستیم. این صفحه را نبندید — تا وقتی پاسخ درگاه
            نرسد، هیچ نتیجه‌ای اعلام نمی‌شود.
          </p>
        </div>
      </Shell>
    );
  }

  const outcome = classify(result, error);
  const copy = VERIFY_COPY[outcome];

  return (
    <Shell>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={outcome === "paid" ? "mt-0.5 text-success" : "mt-0.5 text-warning"}
        >
          {outcome === "paid" ? <CheckIcon className="size-7" /> : <AlertIcon className="size-7" />}
        </span>
        <div className="min-w-0">
          <h1 className="text-xl text-ink">{copy.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{copy.body}</p>
        </div>
      </div>

      {result ? <VerifyFacts result={result} /> : null}

      {result?.requiresReconciliation ? (
        <Notice tone="warning" className="mt-5" title="این پرداخت نیاز به بررسی انسانی دارد">
          <div className="space-y-1">
            {result.reconciliationReason ? (
              <p>{paymentReconciliationReasonLabel(result.reconciliationReason)}</p>
            ) : null}
            <p>
              پول شما ثبت شده و گم نمی‌شود. تا تعیین تکلیف، سفارش «پرداخت‌شده» اعلام نمی‌شود و
              مبلغ دیگری هم از شما گرفته نخواهد شد.
            </p>
          </div>
        </Notice>
      ) : null}

      {result && result.expectedAmount !== result.gatewayAmount ? (
        <Notice tone="danger" className="mt-4" title="مبلغ اعلامی درگاه با مبلغ سفارش یکی نیست">
          <dl className="space-y-1">
            <div className="flex gap-2">
              <dt className="text-ink-subtle">مبلغ سفارش</dt>
              <dd>
                <Money value={result.expectedAmount} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-subtle">مبلغ اعلامی درگاه</dt>
              <dd>
                <Money value={result.gatewayAmount} />
              </dd>
            </div>
          </dl>
        </Notice>
      ) : null}

      <BackLinks orderId={result?.orderId} />

      <p className="mt-6 flex items-start gap-1.5 text-2xs leading-relaxed text-ink-subtle">
        <ShieldIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        نتیجهٔ بالا از پاسخ سرور به «تأیید پرداخت» گرفته شده است، نه از بازگشت مرورگر از درگاه.
      </p>
    </Shell>
  );
}

function classify(result: PaymentVerifyResult | null, error: ApiError | undefined): VerifyOutcome {
  if (result) {
    if (result.success && result.applied) return "paid";
    if (result.success && !result.applied) {
      return result.requiresReconciliation ? "under_review" : "paid_unapplied";
    }
    return "rejected";
  }

  if (!error) return "unknown";
  // Unknown trackId and foreign trackId are the SAME 404, deliberately.
  if (error.status === 404) return "not_found";
  // The gateway reported the payment as not successful.
  if (error.status === 400) return "rejected";
  // 502 (gateway unreachable / non-2xx), network, timeout — genuinely unknown.
  return "unknown";
}

function VerifyFacts({ result }: { result: PaymentVerifyResult }) {
  return (
    <dl className="mt-5 grid gap-x-6 gap-y-3 rounded-md bg-surface-muted p-4 text-sm sm:grid-cols-2">
      <Fact label="شمارهٔ سفارش">
        <bdi data-numeric="">{formatInteger(result.orderId)}</bdi>
      </Fact>
      <Fact label="وضعیت سفارش">
        <Badge tone="neutral">{orderStatusLabel(result.orderStatus)}</Badge>
      </Fact>
      <Fact label="وضعیت پرداخت">
        <Badge tone="neutral">{paymentStatusLabel(result.paymentStatus)}</Badge>
      </Fact>
      <Fact label="وضعیت آماده‌سازی">{fulfillmentStateLabel(result.fulfillmentState)}</Fact>
      {result.alreadyProcessed ? (
        <div className="sm:col-span-2">
          <p className="text-xs text-ink-subtle">
            این پرداخت پیش‌تر بررسی شده بود؛ نتیجهٔ همان بررسی دوباره نمایش داده شد. تکرار این
            صفحه، پرداخت دومی ایجاد نمی‌کند.
          </p>
        </div>
      ) : null}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="font-medium text-ink">{children}</dd>
    </div>
  );
}

function BackLinks({ orderId }: { orderId?: number }) {
  return (
    <div className="mt-6 flex flex-wrap gap-3">
      {orderId !== undefined ? (
        <Link href={orderHref(orderId)} className="no-underline">
          <Button>دیدن سفارش</Button>
        </Link>
      ) : null}
      <Link href="/account/orders" className="no-underline">
        <Button variant="secondary">سفارش‌های من</Button>
      </Link>
      <Link href="/products" className="no-underline">
        <Button variant="ghost">ادامهٔ خرید</Button>
      </Link>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 md:px-6 md:py-16">
      <Card tone="raised" padding="lg">
        {children}
      </Card>
    </div>
  );
}
