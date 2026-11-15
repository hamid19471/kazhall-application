"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import type {
  ApiError,
  CheckoutPreview,
  CheckoutResult,
  IdempotentAttempt,
} from "@kazhal/api-client";
import { beginIdempotentAttempt, isApiError } from "@kazhal/api-client";
import { Badge, Button, Card, EmptyState, Money, Spinner, cx, formatDateTime, formatInteger } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { AddressPicker, useAddresses } from "@/components/address/addresses";
import { FormError, Notice, PageHeading, RequireSession } from "@/components/common";
import { BasketIcon, CheckIcon, ClockIcon, ShieldIcon } from "@/components/icons";
import { useCart } from "@/components/providers";
import { useCountdown, useSubmit } from "@/lib/hooks";
import {
  CHECKOUT_CONFLICTS,
  cartChangeReasonLabel,
  hasCartChangeReasonLabel,
  type ConflictCopy,
} from "@/lib/labels";
import { orderHref } from "@/lib/routes";

export function CheckoutPageView() {
  return (
    <div className="mx-auto w-full max-w-[70rem] px-4 py-6 md:px-6 md:py-10">
      <PageHeading
        title="تأیید و ثبت سفارش"
        description="پیش از پرداخت، مبلغ نهایی را سرور محاسبه می‌کند و شما آن را تأیید می‌کنید."
      />
      <div className="mt-6">
        <RequireSession title="برای ثبت سفارش وارد شوید">
          <CheckoutFlow />
        </RequireSession>
      </div>
    </div>
  );
}

/**
 * The checkout.
 *
 * ## The quote is not a formality
 *
 * `POST /orders/quote` returns a server-computed `subtotal`/`total` and a
 * short-lived `quote.token`. The customer confirms THAT figure, and the token
 * is what `POST /orders` accepts as proof of what they agreed to. Nothing in
 * this component ever computes an authoritative total: the basket page's
 * estimate is labelled an estimate, and the number the customer approves comes
 * from the server every single time.
 *
 * ## One idempotency key per logical checkout
 *
 * `POST /orders` REQUIRES an `Idempotency-Key`, and the correct discipline is
 * one key per *attempt*, resent verbatim on every retry of that attempt:
 *
 *  - a request that ROLLED BACK rolls its key back too, so resending the same
 *    key after a refusal is not reuse — it is the intended behaviour;
 *  - a COMPLETED request replays its original response verbatim, so a
 *    double-submit yields one sale and one stock decrement, not two;
 *  - `quoteToken` is deliberately excluded from the server's request hash, so
 *    refreshing a stale quote and retrying with the SAME key is correct.
 *
 * The key is therefore renewed in exactly two places: when the customer changes
 * the delivery address (which DOES change the request payload, and would
 * otherwise be a 409 `IDEMPOTENCY_KEY_REUSED`), and when the server tells us
 * the key was reused.
 */
function CheckoutFlow() {
  const api = useApi();
  const { lines, isLoading: cartLoading, refresh: refreshCart } = useCart();
  const { addresses, isLoading: addressesLoading, refresh: refreshAddresses } = useAddresses();

  const [addressId, setAddressId] = useState<number | null>(null);
  const [preview, setPreview] = useState<CheckoutPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [order, setOrder] = useState<CheckoutResult | null>(null);

  const [quoteError, setQuoteError] = useState<ApiError | undefined>(undefined);
  const [placeError, setPlaceError] = useState<ApiError | undefined>(undefined);
  const [conflict, setConflict] = useState<{ copy: ConflictCopy; error: ApiError } | null>(null);

  // ONE attempt for this whole checkout. See the note above.
  const attemptRef = useRef<IdempotentAttempt>(beginIdempotentAttempt("checkout"));

  const quoteCountdown = useCountdown(preview?.quote.expiresAt);

  const selectAddress = useCallback((id: number) => {
    setAddressId((current) => {
      if (current !== null && current !== id) {
        // The address is part of the request body, so a different address is a
        // genuinely different request. Reusing the key here is the one case the
        // server rejects outright.
        attemptRef.current.renew();
      }
      return id;
    });
    // A new address invalidates the confirmation, not necessarily the quote —
    // but re-confirming an amount is cheap and mis-shipping an order is not.
    setConfirmed(false);
  }, []);

  const { run: requestQuote, isPending: isQuoting } = useSubmit(async () => {
    setQuoteError(undefined);
    setConflict(null);
    setConfirmed(false);
    try {
      const result = await api.orders.quote();
      setPreview(result);
    } catch (cause) {
      setPreview(null);
      setQuoteError(isApiError(cause) ? cause : undefined);
    }
  });

  const { run: placeOrder, isPending: isPlacing } = useSubmit(async () => {
    if (addressId === null || !preview) return;
    setPlaceError(undefined);
    setConflict(null);

    try {
      const result = await api.orders.checkout(
        { address: addressId, quoteToken: preview.quote.token },
        // The SAME attempt object every time — including every retry below.
        { attempt: attemptRef.current },
      );
      setOrder(result.data);
      refreshCart();
    } catch (cause) {
      if (!isApiError(cause)) return;

      const code = cause.code;
      const copy = code ? CHECKOUT_CONFLICTS[code] : undefined;

      if (copy) {
        setConflict({ copy, error: cause });

        // A reused key means this attempt is spent for this payload. Mint a
        // fresh one so the customer's next try is a new decision, not a replay.
        if (code === "IDEMPOTENCY_KEY_REUSED") attemptRef.current.renew();

        // Anything that invalidates the agreed price sends us back for a new
        // one — and the customer must confirm the new figure, not the old.
        if (copy.next === "requote") {
          setPreview(null);
          setConfirmed(false);
          refreshCart();
          void requestQuote();
        }

        // INSUFFICIENT_STOCK carries no fresh quote by design: the CLIENT has
        // to reduce the line first. The basket is re-read so the panel below
        // can offer that reduction against a current line id.
        if (copy.next === "reduce") refreshCart();
        return;
      }

      setPlaceError(cause);
    }
  });

  // --- rendering -----------------------------------------------------------

  if (order) {
    return <OrderPlaced order={order} />;
  }

  if (cartLoading || addressesLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" label="در حال آماده‌سازی سفارش" />
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <EmptyState
        icon={<BasketIcon className="size-8" />}
        title="سبد شما خالی است"
        description="برای ثبت سفارش، ابتدا کالایی به سبد اضافه کنید."
        action={
          <Link href="/products" className="no-underline">
            <span className="inline-flex h-11 items-center rounded-md bg-primary px-5 font-semibold text-primary-ink">
              دیدن کالاها
            </span>
          </Link>
        }
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
      <div className="space-y-6">
        <Card tone="outlined" as="section">
          <h2 className="text-lg text-ink">نشانی تحویل</h2>
          <p className="mt-1 text-sm text-ink-muted">
            نشانی انتخابی در لحظهٔ ثبت سفارش ذخیره می‌شود و بعد از آن، ویرایش نشانی روی سفارش ثبت‌شده
            اثری ندارد.
          </p>
          <div className="mt-4">
            <AddressPicker
              addresses={addresses}
              selectedId={addressId}
              onSelect={selectAddress}
              onAdded={refreshAddresses}
            />
          </div>
        </Card>

        {conflict ? (
          <ConflictPanel
            conflict={conflict}
            onRequote={() => void requestQuote()}
            onRetry={() => void placeOrder()}
            onReduced={() => {
              setConflict(null);
              setPreview(null);
              setConfirmed(false);
              void requestQuote();
            }}
            isBusy={isQuoting || isPlacing}
          />
        ) : null}

        <Card tone="outlined" as="section">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg text-ink">تأیید مبلغ</h2>
            {preview ? (
              <Badge tone={quoteCountdown.expired ? "danger" : "info"}>
                {quoteCountdown.expired ? (
                  "مهلت این تأیید تمام شد"
                ) : quoteCountdown.text ? (
                  <>
                    <bdi data-numeric="">{quoteCountdown.text}</bdi> تا پایان اعتبار
                  </>
                ) : (
                  "در حال محاسبهٔ اعتبار"
                )}
              </Badge>
            ) : null}
          </div>

          {!preview ? (
            <>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                با زدن دکمهٔ زیر، مبلغ نهایی و موجودی هر ردیف را از سرور می‌گیریم. تا وقتی این مبلغ
                را تأیید نکنید، سفارشی ثبت نمی‌شود.
              </p>
              <FormError error={quoteError} className="mt-4" />
              <Button className="mt-4" isLoading={isQuoting} onClick={() => void requestQuote()}>
                محاسبهٔ مبلغ نهایی
              </Button>
            </>
          ) : (
            <QuotePanel
              preview={preview}
              confirmed={confirmed}
              onConfirmChange={setConfirmed}
              expired={quoteCountdown.expired}
              onRequote={() => void requestQuote()}
              isQuoting={isQuoting}
            />
          )}
        </Card>
      </div>

      <Card tone="raised" className="lg:sticky lg:top-44">
        <h2 className="text-lg text-ink">خلاصه</h2>

        {preview ? (
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="جمع کالاها" value={<Money value={preview.basket.subtotal} />} />
            <div className="border-t border-line pt-2">
              <Row
                label="مبلغ قابل پرداخت"
                value={<Money value={preview.quote.total} className="text-base font-bold text-ink" />}
                strong
              />
            </div>
          </dl>
        ) : (
          <p className="mt-4 text-sm text-ink-muted">
            مبلغ قابل پرداخت پس از محاسبهٔ سرور نمایش داده می‌شود.
          </p>
        )}

        <FormError error={placeError} className="mt-4" />

        <Button
          size="lg"
          fullWidth
          className="mt-5"
          isLoading={isPlacing}
          disabled={
            addressId === null || !preview || !confirmed || quoteCountdown.expired || isQuoting
          }
          onClick={() => void placeOrder()}
        >
          ثبت سفارش
        </Button>

        {addressId === null ? (
          <p className="mt-2 text-xs text-warning">ابتدا نشانی تحویل را انتخاب کنید.</p>
        ) : !preview ? (
          <p className="mt-2 text-xs text-ink-subtle">ابتدا مبلغ نهایی را محاسبه کنید.</p>
        ) : !confirmed ? (
          <p className="mt-2 text-xs text-ink-subtle">برای ادامه، مبلغ محاسبه‌شده را تأیید کنید.</p>
        ) : null}

        <p className="mt-4 flex items-start gap-1.5 text-2xs leading-relaxed text-ink-subtle">
          <ShieldIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ثبت سفارش، پرداخت نیست. پس از ثبت، به درگاه هدایت می‌شوید و سفارش فقط پس از تأیید نهایی
          درگاه «پرداخت‌شده» می‌شود.
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={strong ? "font-semibold text-ink" : "text-ink-muted"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

function QuotePanel({
  preview,
  confirmed,
  onConfirmChange,
  expired,
  onRequote,
  isQuoting,
}: {
  preview: CheckoutPreview;
  confirmed: boolean;
  onConfirmChange: (value: boolean) => void;
  expired: boolean;
  onRequote: () => void;
  isQuoting: boolean;
}) {
  return (
    <div className="mt-4 space-y-4">
      {preview.notices.length > 0 ? (
        <Notice tone="warning" title="از زمان افزودن به سبد، چیزی تغییر کرده است">
          <ul className="list-inside list-disc space-y-1">
            {preview.notices.map((notice, index) => (
              <li key={index}>{describeNotice(notice)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <ul className="divide-y divide-line rounded-md border border-line">
        {preview.basket.lines.map((line) => (
          <li key={line.cartItemId} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{line.productTitle}</p>
              <p className="mt-0.5 text-xs text-ink-subtle">
                <bdi data-numeric="">{formatInteger(line.quantity)}</bdi> ×{" "}
                <Money value={line.unitPrice} withUnit={false} />
              </p>
            </div>
            <Money value={line.totalPrice} className="text-sm font-bold text-ink" />
          </li>
        ))}
      </ul>

      <p className="flex items-center gap-1.5 text-xs text-ink-subtle">
        <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
        این مبلغ در{" "}
        <bdi>{formatDateTime(preview.quote.issuedAt)}</bdi> توسط سرور محاسبه شده است.
      </p>

      {expired ? (
        <Notice tone="warning" title="اعتبار این محاسبه تمام شد">
          <div className="space-y-2">
            <p>برای اینکه تصمیم شما روی عددهای امروز باشد، مبلغ را دوباره می‌گیریم.</p>
            <Button size="sm" isLoading={isQuoting} onClick={onRequote}>
              محاسبهٔ دوباره
            </Button>
          </div>
        </Notice>
      ) : (
        <label
          className={cx(
            "flex cursor-pointer gap-3 rounded-md border p-3",
            confirmed ? "border-primary bg-primary-soft" : "border-line-strong bg-surface",
          )}
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => onConfirmChange(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]"
          />
          <span className="text-sm leading-relaxed text-ink">
            مبلغ{" "}
            <Money value={preview.quote.total} className="font-bold" /> و ردیف‌های بالا را دیدم و
            تأیید می‌کنم.
          </span>
        </label>
      )}
    </div>
  );
}

/**
 * PERSIAN FIRST, then the server's sentence.
 *
 * A checkout notice carries `kind` (a `CheckoutChangeKind`) and an ENGLISH
 * `message` written for a developer. This used to print the message straight
 * at the customer. The four kinds that name a basket-line event —
 * `sold_in_store`, `reservation_expired`, `stock_not_counted` and
 * `not_sellable` — are the same strings the basket screen already has Persian
 * copy for, so they are looked up there and the two surfaces say the same
 * thing about the same condition.
 *
 * The money/quantity kinds (`price_changed`, `line_added`, `quantity_changed`,
 * `total_changed`) have no entry in that map and still fall through to the
 * server's text, exactly as before — this widens the Persian coverage without
 * changing what any existing kind renders.
 */
function describeNotice(notice: unknown): string {
  if (typeof notice === "string") return notice;
  if (notice && typeof notice === "object") {
    const code =
      (notice as { kind?: unknown }).kind ?? (notice as { reason?: unknown }).reason;
    if (typeof code === "string" && hasCartChangeReasonLabel(code)) {
      return cartChangeReasonLabel(code);
    }
    const message = (notice as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    if (typeof code === "string") return code;
  }
  return "یکی از ردیف‌های سبد تغییر کرده است.";
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * The 409 panel.
 *
 * Every branch is chosen by the machine-readable CODE (`body.error ??
 * body.details.code`), never by the human message — the message is Persian
 * prose written for a customer and is free to change. The panel then offers the
 * ONE action that can actually resolve that particular conflict, because
 * "please try again" is not an answer to "you asked for 5 and 2 are left".
 */
function ConflictPanel({
  conflict,
  onRequote,
  onRetry,
  onReduced,
  isBusy,
}: {
  conflict: { copy: ConflictCopy; error: ApiError };
  onRequote: () => void;
  onRetry: () => void;
  onReduced: () => void;
  isBusy: boolean;
}) {
  const { copy, error } = conflict;

  return (
    <Notice tone="warning" title={copy.title}>
      <div className="space-y-3">
        <p>{copy.body}</p>

        {copy.next === "reduce" ? (
          <InsufficientStockAction error={error} onReduced={onReduced} />
        ) : copy.next === "retry" ? (
          <Button size="sm" isLoading={isBusy} onClick={onRetry}>
            تلاش دوباره
          </Button>
        ) : copy.next === "requote" ? (
          <Button size="sm" isLoading={isBusy} onClick={onRequote}>
            محاسبهٔ دوبارهٔ مبلغ
          </Button>
        ) : null}
      </div>
    </Notice>
  );
}

/**
 * `INSUFFICIENT_STOCK` is the one conflict the server cannot fix for us: it
 * carries no fresh quote, on purpose, because the only correct next step is for
 * the customer to want less. `details` names the variant, the SKU, what was
 * requested and what is available; this finds the matching basket line and
 * offers the exact reduction, rather than telling the customer to go and work
 * it out on another page.
 */
function InsufficientStockAction({ error, onReduced }: { error: ApiError; onReduced: () => void }) {
  const api = useApi();
  const { lines, refresh } = useCart();
  const [failure, setFailure] = useState<ApiError | undefined>(undefined);

  const details = error.details ?? {};
  const variantId = typeof details.variantId === "number" ? details.variantId : undefined;
  const sku = typeof details.sku === "string" ? details.sku : undefined;
  const requested = typeof details.requested === "number" ? details.requested : undefined;
  const available = typeof details.available === "number" ? details.available : undefined;

  const line = variantId !== undefined ? lines.find((item) => item.variant?.id === variantId) : undefined;
  const canReduce = line !== undefined && available !== undefined && available >= 0;

  const { run: reduce, isPending } = useSubmit(async () => {
    if (!line || available === undefined) return;
    setFailure(undefined);
    try {
      // ABSOLUTE quantity. `0` removes the line, which is the honest outcome
      // when nothing at all is left.
      await api.cart.setQuantity(line.id, available);
      refresh();
      onReduced();
    } catch (cause) {
      setFailure(isApiError(cause) ? cause : undefined);
      refresh();
    }
  });

  return (
    <div className="space-y-2">
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {sku ? (
          <div className="flex gap-1">
            <dt className="text-ink-subtle">کد کالا</dt>
            <dd dir="ltr" data-numeric="">
              {sku}
            </dd>
          </div>
        ) : null}
        {requested !== undefined ? (
          <div className="flex gap-1">
            <dt className="text-ink-subtle">درخواست شما</dt>
            <dd data-numeric="">{formatInteger(requested)}</dd>
          </div>
        ) : null}
        {available !== undefined ? (
          <div className="flex gap-1">
            <dt className="text-ink-subtle">قابل رزرو</dt>
            <dd data-numeric="">{formatInteger(available)}</dd>
          </div>
        ) : null}
      </dl>

      {canReduce ? (
        <Button size="sm" isLoading={isPending} onClick={() => void reduce()}>
          {available === 0
            ? "حذف این ردیف از سبد"
            : `کاهش به ${formatInteger(available ?? 0)} عدد و محاسبهٔ دوباره`}
        </Button>
      ) : (
        <p className="text-xs">
          تعداد این ردیف را در{" "}
          <Link href="/cart" className="font-semibold">
            سبد خرید
          </Link>{" "}
          کم کنید و دوباره تلاش کنید.
        </p>
      )}

      <FormError error={failure} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placed
// ---------------------------------------------------------------------------

/**
 * The order exists — and is `pending`, i.e. NOT paid.
 *
 * This screen is careful never to congratulate anybody. It says the order was
 * registered, states plainly that no money has moved yet, and offers the
 * payment step. Calling this "successful" is how a customer closes the tab
 * believing they have bought something.
 */
function OrderPlaced({ order }: { order: CheckoutResult }) {
  const api = useApi();
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const { run: pay, isPending } = useSubmit(async () => {
    setError(undefined);
    try {
      const result = await api.payment.start(order.id);
      // A full navigation: the gateway is a different origin, and the return
      // trip lands on our own `/checkout/payment/return`.
      window.location.assign(result.data.paymentUrl);
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  return (
    <Card tone="raised" padding="lg" className="mx-auto max-w-2xl">
      <div className="flex items-center gap-2 text-success">
        <CheckIcon className="size-6" />
        <h2 className="text-xl text-ink">سفارش شما ثبت شد</h2>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-ink-muted">
        شمارهٔ سفارش:{" "}
        <bdi data-numeric="" className="font-bold text-ink">
          {order.orderNumber ?? formatInteger(order.id)}
        </bdi>
        . این سفارش هنوز پرداخت نشده است و تا زمان تأیید نهایی درگاه، مبلغی از حساب شما کم نشده
        محسوب می‌شود.
      </p>

      <dl className="mt-5 space-y-2 rounded-md bg-surface-muted p-4 text-sm">
        <Row label="جمع کالاها" value={<Money value={order.subtotal} />} />
        <Row
          label="مبلغ قابل پرداخت"
          value={<Money value={order.totalPrice} className="text-base font-bold text-ink" />}
          strong
        />
      </dl>

      <FormError error={error} className="mt-4" />

      <div className="mt-6 flex flex-wrap gap-3">
        <Button size="lg" isLoading={isPending} onClick={() => void pay()}>
          رفتن به درگاه پرداخت
        </Button>
        <Link href={orderHref(order.id)} className="no-underline">
          <Button size="lg" variant="secondary">
            دیدن سفارش
          </Button>
        </Link>
      </div>

      <p className="mt-4 text-2xs leading-relaxed text-ink-subtle">
        اگر پرداخت را نیمه‌کاره رها کنید، سفارش در وضعیت «در انتظار پرداخت» می‌ماند و می‌توانید
        بعداً از صفحهٔ سفارش، پرداخت را ادامه دهید.
      </p>
    </Card>
  );
}
