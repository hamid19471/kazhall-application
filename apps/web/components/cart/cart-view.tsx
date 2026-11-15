"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { ApiError, CartLine } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import { Badge, Button, Card, EmptyState, Money, Skeleton, cx, formatDateTime, formatInteger } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { FormError, Notice, PageHeading, RequireSession } from "@/components/common";
import { ProductImage } from "@/components/catalog/product-image";
import { BasketIcon, ClockIcon, MinusIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { useCart } from "@/components/providers";
import { dedupeNotices } from "@/lib/cart-notices";
import { useCountdown, useSubmit } from "@/lib/hooks";
import { cartChangeReasonLabel } from "@/lib/labels";
import { productHref } from "@/lib/routes";

export function CartPageView() {
  return (
    <div className="mx-auto w-full max-w-[70rem] px-4 py-6 md:px-6 md:py-10">
      <PageHeading
        title="سبد خرید"
        description="موجودی هر کالا از لحظهٔ افزودن، چهار ساعت برای شما نگه داشته می‌شود."
      />
      <div className="mt-6">
        <RequireSession
          title="برای دیدن سبد خرید وارد شوید"
          description="سبد خرید شما روی حساب کاربری‌تان نگهداری می‌شود، نه روی این دستگاه."
        >
          <CartContents />
        </RequireSession>
      </div>
    </div>
  );
}

function CartContents() {
  const { lines, notices, isLoading, error, refresh } = useCart();

  // A notice can describe a line that is STILL in the basket with a reduced
  // quantity — the same fact then arrives twice: once as `line.change` and once
  // in the basket-level `notices` array. Showing both makes it look like two
  // separate things went wrong, so the line keeps its own copy and the
  // basket-level list drops the duplicate.
  const basketNotices = useMemo(() => dedupeNotices(notices, lines), [notices, lines]);

  if (error) {
    return (
      <Card tone="outlined">
        <p className="text-ink">سبد خرید بارگذاری نشد.</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={refresh}>
          تلاش دوباره
        </Button>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="kz-sr-only">در حال بارگذاری سبد خرید</span>
        {Array.from({ length: 2 }, (_, index) => (
          <Skeleton key={index} shape="block" height="7rem" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {basketNotices.length > 0 ? (
        <ul className="space-y-2">
          {basketNotices.map((notice) => (
            // `cart_items.id` is stable and unique per line, so it is a better
            // key than the reason and instant this used to concatenate — those
            // were `undefined` on a line and produced one shared key.
            <li key={notice.id}>
              <BasketNotice notice={notice} />
            </li>
          ))}
        </ul>
      ) : null}

      {lines.length === 0 ? (
        <EmptyState
          icon={<BasketIcon className="size-8" />}
          title="سبد خرید شما خالی است"
          description="کالایی که به سبد اضافه کنید، تا چهار ساعت برایتان کنار گذاشته می‌شود."
          action={
            <Link href="/products" className="no-underline">
              <span className="inline-flex h-11 items-center rounded-md bg-primary px-5 font-semibold text-primary-ink">
                دیدن کالاها
              </span>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
          {/*
            `min-w-0` is load-bearing. A grid item defaults to
            `min-width: auto`, which means "never shrink below your content" —
            so at 320px this list sized itself to the widest basket row (344px)
            instead of to its 288px track, and pushed a horizontal scrollbar
            onto the whole document. The rows below already shrink correctly
            once the list itself is allowed to.
          */}
          <ul className="min-w-0 space-y-3">
            {lines.map((line) => (
              <CartLineRow key={line.id} line={line} onChanged={refresh} />
            ))}
          </ul>
          <CartSummary lines={lines} />
        </div>
      )}
    </div>
  );
}

/**
 * A change to a line that is NO LONGER in the basket.
 *
 * It names the product, because it has to: the row it is talking about has been
 * removed, so "some units were sold in store" without a product name asks the
 * customer to guess which of their items it was.
 */
function BasketNotice({ notice }: { notice: CartLine }) {
  const change = notice.change;
  if (!change) return null;
  const expired = change.reason === "reservation_expired";
  return (
    <Notice tone={expired ? "warning" : "info"} title={cartChangeReasonLabel(change.reason)}>
      <div className="space-y-1">
        {notice.productTitle ? (
          <p className="font-medium text-ink">{notice.productTitle}</p>
        ) : null}
        {notice.variant ? (
          <p className="text-2xs text-ink-subtle" dir="ltr" data-numeric="">
            {notice.variant.sku}
          </p>
        ) : null}
        {/* Persian label only — see the line-level notice for why. */}
        {change.quantityDelta !== null ? (
          <p>
            تغییر تعداد: <bdi data-numeric="">{formatInteger(change.quantityDelta)}</bdi>
          </p>
        ) : null}
        {/* Semantic, like the expiry itself: the machine-readable instant is
            the server's, the visible text is the Persian rendering. */}
        {change.at ? (
          <p className="text-2xs text-ink-subtle">
            <time dateTime={change.at} data-numeric="">
              {formatDateTime(change.at)}
            </time>
          </p>
        ) : null}
      </div>
    </Notice>
  );
}

// ---------------------------------------------------------------------------

function CartLineRow({ line, onChanged }: { line: CartLine; onChanged: () => void }) {
  const api = useApi();
  const { mutate } = useCart();
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const unitPrice = line.variant?.price ?? null;
  const image = line.productImages.find((url): url is string => typeof url === "string" && url !== "");

  // The line's own deadline. `tranches` can hold several holds with different
  // expiries (a quantity increase starts a new four-hour window), so the line
  // countdown follows the EARLIEST one — that is the first thing the customer
  // can lose.
  const earliest = earliestExpiry(line);
  /*
   * The LINE countdown follows the earliest tranche — the first thing the
   * customer can lose. Its `onExpire` is `onChanged`, which re-reads the whole
   * basket from the server: at zero this line's state on screen is known to be
   * stale, and only `GET /cart` can say what replaced it. The hook fires once
   * per deadline, so a lapsed line does not start polling.
   */
  const countdown = useCountdown(earliest, { onExpire: onChanged });

  /*
   * Both mutations run inside `mutate`, the cart channel's bracket. It issues
   * exactly ONE authoritative `GET /cart` once the call settles — on the error
   * path too, because a refusal usually means the server already knows
   * something about this line that we do not — and guarantees that read
   * outranks any refetch a POS `availability:updated` started while the write
   * was in flight. The explicit `onChanged()` calls these used to make are
   * gone: they issued a second, unordered read.
   */
  const { run: setQuantity, isPending: isSaving } = useSubmit((next: number) =>
    mutate(async () => {
      setError(undefined);
      try {
        // ABSOLUTE, not a delta. `0` removes the line and answers `data: null`.
        await api.cart.setQuantity(line.id, next);
      } catch (cause) {
        setError(isApiError(cause) ? cause : undefined);
      }
    }),
  );

  const { run: remove, isPending: isRemoving } = useSubmit(() =>
    mutate(async () => {
      setError(undefined);
      try {
        await api.cart.remove(line.id);
      } catch (cause) {
        // A second delete is a 404 — the line is gone either way, which is what
        // the customer asked for, so it is not worth an error message.
        if (isApiError(cause) && cause.status !== 404) {
          setError(cause);
        }
      }
    }),
  );

  const busy = isSaving || isRemoving;
  const reduced = line.reservedQuantity < line.quantity;

  return (
    <Card as="li" tone="outlined" padding="none" className="overflow-hidden">
      <div className="flex gap-3 p-3 md:gap-4 md:p-4">
        <Link
          href={productHref(line.productId)}
          className="shrink-0 overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
        >
          <ProductImage url={image} alt={line.productTitle ?? "کالا"} className="size-20 md:size-24" />
        </Link>

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink md:text-base">
            <Link href={productHref(line.productId)} className="text-ink no-underline hover:text-primary">
              {line.productTitle ?? "کالای حذف‌شده"}
            </Link>
          </h3>

          {line.variant ? (
            <>
              {line.variant.attributeValues.length > 0 ? (
                /*
                 * What the customer actually chose, named. Two lines for the
                 * same product differ only by these values, so a basket that
                 * shows just a SKU makes the customer decode which is which.
                 */
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {line.variant.attributeValues.map((value) => (
                    <li key={value.id} className="text-xs text-ink-muted">
                      {value.attribute ? (
                        <>
                          <span className="text-ink-subtle">{value.attribute.name}:</span>{" "}
                          <span className="font-medium text-ink">{value.value}</span>
                        </>
                      ) : (
                        <span className="font-medium text-ink">{value.value}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-0.5 text-xs text-ink-subtle" dir="ltr" data-numeric="">
                {line.variant.sku}
              </p>
            </>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {unitPrice !== null ? (
              <p className="text-sm text-ink-muted">
                قیمت واحد: <Money value={unitPrice} className="font-semibold text-ink" />
              </p>
            ) : (
              <p className="text-sm text-ink-subtle">قیمت واحد در مرحلهٔ تأیید سفارش اعلام می‌شود.</p>
            )}
          </div>

          {reduced ? (
            <p className="mt-2 text-xs text-warning">
              از <bdi data-numeric="">{formatInteger(line.quantity)}</bdi> عدد درخواستی، فقط{" "}
              <bdi data-numeric="">{formatInteger(line.reservedQuantity)}</bdi> عدد برای شما رزرو
              شده است.
            </p>
          ) : null}

          {line.change ? (
            <div className="mt-2">
              <Notice
                /*
                 * `danger` for the two reasons that BLOCK the order rather
                 * than describing something that already happened to the line
                 * — a retired SKU and a product withdrawn from the website.
                 * The customer has to act on either before they can check out.
                 */
                tone={
                  line.change.reason === "not_sellable" ||
                  line.change.reason === "channel_unavailable"
                    ? "danger"
                    : line.change.reason === "reservation_expired"
                      ? "warning"
                      : "info"
                }
                className="px-3 py-2"
              >
                {/*
                  The server's `message` is ENGLISH ("Some of these units were
                  sold in one of our stores…"). It is a developer-facing
                  description, not shop copy, so a Persian storefront must not
                  print it at a customer. The Persian label is the text; the
                  raw message is only a fallback for a reason this build does
                  not yet know a phrase for.
                */}
                <p className="text-xs">
                  {cartChangeReasonLabel(line.change.reason)}
                  {line.change.quantityDelta !== null ? (
                    <>
                      {" "}
                      <bdi data-numeric="">{formatInteger(line.change.quantityDelta)}</bdi> عدد
                    </>
                  ) : null}
                </p>
              </Notice>
            </div>
          ) : null}

          <ReservationClock
            line={line}
            countdownText={countdown.text}
            expired={countdown.expired}
            announcement={countdown.announcement}
            onExpired={onChanged}
          />
        </div>

        <div className="flex shrink-0 flex-col items-end justify-between gap-3">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            aria-label={`حذف ${line.productTitle ?? "کالا"} از سبد`}
            className="grid size-9 place-items-center rounded-md text-ink-subtle transition-colors duration-150 ease-kz hover:bg-danger-soft hover:text-danger disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
          >
            <TrashIcon className="size-4" />
          </button>

          <div className="flex items-center rounded-md border border-line-strong bg-surface">
            <button
              type="button"
              // `quantity - 1` — the API takes the ABSOLUTE new quantity, and
              // `0` is how a line is removed through this same call.
              onClick={() => void setQuantity(line.quantity - 1)}
              disabled={busy}
              aria-label={line.quantity <= 1 ? "حذف از سبد" : "کاهش تعداد"}
              className="grid size-9 place-items-center text-ink-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
            >
              {line.quantity <= 1 ? <TrashIcon className="size-4" /> : <MinusIcon className="size-4" />}
            </button>
            <span className="w-9 text-center text-sm font-bold text-ink" data-numeric="" aria-live="polite">
              {formatInteger(line.quantity)}
            </span>
            <button
              type="button"
              onClick={() => void setQuantity(line.quantity + 1)}
              disabled={busy}
              aria-label="افزایش تعداد"
              className="grid size-9 place-items-center text-ink-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
            >
              <PlusIcon className="size-4" />
            </button>
          </div>

          {unitPrice !== null ? (
            <Money value={unitPrice * line.quantity} className="text-sm font-bold text-ink" />
          ) : null}
        </div>
      </div>

      {error ? <FormError error={error} className="mx-3 mb-3 md:mx-4 md:mb-4" /> : null}
    </Card>
  );
}

/**
 * The four-hour clock.
 *
 * ===========================================================================
 * WHAT THE CUSTOMER IS OWED HERE, AND WHAT THE BROWSER IS NOT ALLOWED TO DO
 * ===========================================================================
 *
 * The deadline is the SERVER's `expiresAt`, read fresh on every load. Nothing
 * here starts a local four-hour timer, so refreshing the page cannot extend a
 * reservation — the countdown re-derives itself from the same absolute instant
 * and, if that instant has passed, says so. `useCountdown` is given a deadline;
 * it has no idea how long a reservation lasts and cannot mint one.
 *
 * THREE THINGS ARE RENDERED, NOT ONE:
 *
 *  1. A live countdown, for the customer watching the page.
 *  2. The ABSOLUTE deadline in a semantic `<time datetime>`, because a
 *     countdown is useless to anything that is not a human reading it at that
 *     moment — a screen reader summarising the page, a browser translation, a
 *     bug report screenshot timestamped an hour later. `datetime` carries the
 *     machine-readable ISO instant; the element's text carries the Persian one.
 *  3. A COARSE spoken summary in a polite live region. A per-second countdown
 *     in `aria-live` is unusable: it interrupts continuously. The announcement
 *     string only changes at thresholds a customer would act on, so it speaks
 *     five or six times across a four-hour hold.
 *
 * AND WHEN IT REACHES ZERO the basket is RE-READ FROM THE SERVER. The line on
 * screen is a snapshot; at zero it is known to be stale, and the only thing
 * that can say what replaced it is `GET /cart`. `onExpire` fires once per
 * deadline — not a poll, not a retry.
 */
function ReservationClock({
  line,
  countdownText,
  expired,
  announcement,
  onExpired,
}: {
  line: CartLine;
  countdownText: string | null;
  expired: boolean;
  announcement: string | null;
  onExpired: () => void;
}) {
  const earliest = earliestExpiry(line);
  const tranches = line.tranches.filter((tranche) => tranche.expiresAt !== null);

  if (!earliest) {
    return (
      <p className="mt-2 text-xs text-ink-subtle">
        زمان نگهداری این کالا در سبد ثبت نشده است.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p
        className={cx(
          "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs",
          expired ? "text-danger" : "text-ink-muted",
        )}
      >
        <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
        {expired ? (
          <span>مهلت نگهداری این کالا به پایان رسیده است.</span>
        ) : countdownText === null ? (
          // Before mount there is no trustworthy "now", so the absolute
          // deadline is shown on its own rather than a guessed remainder.
          <span>
            تا <ExpiryTime iso={earliest} /> نگه داشته می‌شود
          </span>
        ) : (
          <span>
            <bdi data-numeric="">{countdownText}</bdi> تا پایان نگهداری{" "}
            <span className="text-ink-subtle">
              (تا <ExpiryTime iso={earliest} />)
            </span>
          </span>
        )}
      </p>

      {/*
        THE SPOKEN VERSION. `aria-live="polite"` waits for a pause, and the
        text only changes at thresholds, so this does not fight the countdown
        above — which is why that one is left out of the live region entirely.
      */}
      <p className="kz-sr-only" role="status" aria-live="polite">
        {announcement ?? ""}
      </p>

      {/*
        A SILENT TICK AT ZERO. Rendering nothing, but owning the `onExpire`
        crossing for the line as a whole, so the basket reconciles with the
        server the moment the earliest hold lapses.
      */}
      <ExpiryTrigger iso={earliest} onExpired={onExpired} />

      {tranches.length > 1 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-2xs text-ink-subtle">
            این کالا <bdi data-numeric="">{formatInteger(tranches.length)}</bdi> مهلت جداگانه دارد
          </summary>
          {/*
            EACH TRANCHE COUNTS DOWN SEPARATELY. Raising the quantity starts a
            NEW four-hour window, so a line can hold two units until 14:00 and
            one more until 16:30. Showing only the line's earliest deadline
            would tell the customer they are about to lose the whole line when
            they are about to lose part of it.
          */}
          <ul className="mt-1 space-y-0.5">
            {tranches.map((tranche) => (
              <TrancheRow
                key={`${tranche.expiresAt ?? "none"}-${tranche.quantity}`}
                quantity={tranche.quantity}
                expiresAt={tranche.expiresAt}
                onExpired={onExpired}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The absolute deadline, machine-readable.
 *
 * `datetime` is the raw ISO instant exactly as the server sent it — not a
 * reformatted one — so a consumer parsing this element gets the server's own
 * value with no chance of a timezone being applied twice. The visible text is
 * the Persian rendering for the person reading it.
 */
function ExpiryTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} data-numeric="">
      {formatDateTime(iso)}
    </time>
  );
}

/** Renders nothing; exists to own one deadline's zero-crossing. */
function ExpiryTrigger({ iso, onExpired }: { iso: string; onExpired: () => void }) {
  useCountdown(iso, { onExpire: onExpired });
  return null;
}

/** One tranche: how many units, counting down to its own deadline. */
function TrancheRow({
  quantity,
  expiresAt,
  onExpired,
}: {
  quantity: number;
  expiresAt: string | null;
  onExpired: () => void;
}) {
  const countdown = useCountdown(expiresAt, { onExpire: onExpired });

  return (
    <li className="text-2xs text-ink-subtle">
      <bdi data-numeric="">{formatInteger(quantity)}</bdi> عدد{" "}
      {expiresAt === null ? (
        "— مهلتی ثبت نشده"
      ) : countdown.expired ? (
        <span className="text-danger">— مهلت این بخش تمام شد</span>
      ) : (
        <>
          تا <ExpiryTime iso={expiresAt} />
          {countdown.text ? (
            <>
              {" — "}
              <bdi data-numeric="">{countdown.text}</bdi> مانده
            </>
          ) : null}
        </>
      )}
    </li>
  );
}

function earliestExpiry(line: CartLine): string | null {
  const candidates = [line.expiresAt, ...line.tranches.map((tranche) => tranche.expiresAt)].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, current) =>
    Date.parse(current) < Date.parse(earliest) ? current : earliest,
  );
}

// ---------------------------------------------------------------------------

/**
 * The basket summary.
 *
 * The figure shown is explicitly an ESTIMATE. The authoritative total is
 * produced by `POST /orders/quote` and confirmed at checkout — computing a
 * binding total in the browser from prices that may already be stale is exactly
 * the class of bug the quote flow exists to prevent. Lines whose unit price is
 * unknown are counted as unknown rather than as zero.
 */
function CartSummary({ lines }: { lines: CartLine[] }) {
  const priced = lines.filter((line) => line.variant?.price !== null && line.variant !== null);
  const unpriced = lines.length - priced.length;
  /*
   * A LINE THAT CANNOT BE ORDERED BLOCKS THE WHOLE BASKET, and the button says
   * so instead of leading the customer into a refusal.
   *
   * `POST /orders` refuses the entire basket while such a line is in it — the
   * order is atomic, so there is no partial checkout to offer. The server
   * decides; this only stops the page from inviting a click whose only possible
   * outcome is an error the customer then has to interpret.
   *
   * TWO reasons block, not one. `not_sellable` is a deactivated SKU;
   * `channel_unavailable` is a product withdrawn from the WEBSITE, which may
   * still be active and selling in the shops. They are separate codes on
   * purpose, but both leave the line in the basket and both make the order
   * impossible until it is removed — so a filter that knew only the first left
   * the checkout button enabled and led the customer straight into a refusal.
   */
  const blocked = lines.filter(
    (line) =>
      line.change?.reason === "not_sellable" || line.change?.reason === "channel_unavailable",
  );
  const estimate = priced.reduce((sum, line) => sum + (line.variant?.price ?? 0) * line.quantity, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <Card tone="raised" className="lg:sticky lg:top-44">
      <h2 className="text-lg text-ink">خلاصهٔ سبد</h2>

      <dl className="mt-4 space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-ink-muted">تعداد کالا</dt>
          <dd className="font-semibold text-ink" data-numeric="">
            {formatInteger(itemCount)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <dt className="text-ink-muted">برآورد مبلغ</dt>
          <dd>
            <Money value={estimate} className="text-base font-bold text-ink" />
          </dd>
        </div>
      </dl>

      {unpriced > 0 ? (
        <p className="mt-3 text-2xs leading-relaxed text-warning">
          قیمت <bdi data-numeric="">{formatInteger(unpriced)}</bdi> ردیف هنوز مشخص نیست و در این
          برآورد لحاظ نشده است.
        </p>
      ) : null}

      <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
        این عدد فقط یک برآورد است. مبلغ نهایی در مرحلهٔ «تأیید سفارش» توسط سرور محاسبه و به شما
        نشان داده می‌شود و پیش از پرداخت باید آن را تأیید کنید.
      </p>

      {blocked.length > 0 ? (
        <div className="mt-5">
          <Button size="lg" fullWidth disabled>
            ادامهٔ خرید و تأیید سفارش
          </Button>
          {/*
            ONE SENTENCE FOR BOTH BLOCKING REASONS. A retired SKU and a product
            withdrawn from the website are different facts, and the line's own
            notice states which one applies; repeating that here would mean
            either a wrong word on one of them («دیگر برای فروش موجود نیست» is
            false about an item still sold over the counter) or a summary that
            has to enumerate reasons. What the summary must convey is the
            single thing the customer has to do, so it says only that the order
            cannot be placed and the line has to go.
          */}
          <p role="alert" className="mt-2 text-2xs leading-relaxed text-danger">
            {blocked.length === 1 ? (
              <>
                ثبت سفارش «{blocked[0]!.productTitle ?? "این کالا"}» ممکن نیست. برای ادامه، آن را از
                سبد بردارید.
              </>
            ) : (
              <>
                ثبت سفارش <bdi data-numeric="">{formatInteger(blocked.length)}</bdi> ردیف از سبد شما
                ممکن نیست. برای ادامه، آن‌ها را از سبد بردارید.
              </>
            )}
          </p>
        </div>
      ) : (
        <Link href="/checkout" className="mt-5 block no-underline">
          <Button size="lg" fullWidth>
            ادامهٔ خرید و تأیید سفارش
          </Button>
        </Link>
      )}

      <p className="mt-3 text-center">
        <Link href="/products" className="text-xs">
          افزودن کالای دیگر
        </Link>
      </p>

      <div className="mt-4 flex items-center justify-center">
        <Badge tone="neutral" size="sm">
          همهٔ قیمت‌ها به ریال است
        </Badge>
      </div>
    </Card>
  );
}
