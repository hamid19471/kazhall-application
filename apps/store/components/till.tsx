"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  beginIdempotentAttempt,
  createAuthoritativeChannel,
  isApiError,
  type AuthoritativeChannel,
  type AvailabilitySnapshot,
  type CreatePosOrderBody,
  type IdempotentAttempt,
  type RealtimeInterest,
} from "@kazhal/api-client";
import { Badge, Button, Card, Input, Money, cx, formatInteger } from "@kazhal/ui";
import {
  useApi,
  useRealtimeEvent,
  useRealtimeInterest,
  useRealtimeResync,
  useSession,
} from "@kazhal/ui/api/react";

import { CatalogPicker } from "./catalog-picker";
import { Basket, SaleProblem, SaleRecorded } from "./till-panels";
import { PAYMENT_METHODS, hasSellableBranch, paymentMethodLabel } from "../lib/pos-domain";
import { cacheSale } from "../lib/receipt-store";
import { classifySaleFailure } from "../lib/sale-failure";
import {
  buildSaleBody,
  canSubmit,
  initialTillState,
  tillReducer,
  tillTotals,
} from "../lib/till-state";

/**
 * The till.
 *
 * THE WORKFLOW. This shop has no barcode scanner, so a sale starts by LOOKING:
 * the cashier browses a catalogue, searches or filters it, picks the exact
 * variant, and it lands in the basket. Nothing asks them to know a code. A SKU
 * is still shown beside every item and is still searchable — it is what is
 * printed on the shelf label — but no sale can ever require one.
 *
 * Three invariants survive unchanged from the previous design.
 *
 * 1. ATTRIBUTION IS TOKEN-ONLY. There is no cashier or branch input on this
 *    screen and none is ever sent. The server reads both from the access token.
 *
 * 2. ONE IDEMPOTENCY KEY PER SALE ATTEMPT, held across every retry, renewed
 *    only when a sale finishes or a human deliberately abandons the attempt.
 *    A timeout NEVER mints a new key — see `lib/sale-failure.ts`.
 *
 * 3. AVAILABILITY IS INDICATIVE, `POST /orders/pos` IS AUTHORITATIVE. The stock
 *    numbers on screen come from the server and are refreshed out of band; they
 *    warn, they never decide.
 */
/** Collapses the `visibilitychange` + `focus` pair browsers fire together. */
const VISIBILITY_DEDUPE_MS = 1000;

export function Till() {
  const api = useApi();
  const { session } = useSession();
  const [state, dispatch] = useReducer(tillReducer, initialTillState);

  // One key for the whole attempt. Created once per mounted till and renewed
  // only through `startNewSale`.
  const attemptRef = useRef<IdempotentAttempt | null>(null);
  if (attemptRef.current === null) attemptRef.current = beginIdempotentAttempt("pos");

  // A mirror of the latest state for callbacks that must not be re-created on
  // every interaction. Written in an effect, never during render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const submitLock = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [availabilityProblem, setAvailabilityProblem] = useState<string | null>(null);
  /**
   * Bumped to force `CatalogPicker` to re-read.
   *
   * Needed only for the one reconciliation no event can trigger: a REFUSED
   * sale, which rolls back and therefore correctly announces nothing.
   */
  const [catalogToken, setCatalogToken] = useState(0);
  // Mobile only: the basket lives behind a toggle so the catalogue gets the
  // whole narrow screen, but the count stays visible at all times.
  const [basketOpen, setBasketOpen] = useState(false);

  const branchReady = hasSellableBranch(session);
  const totals = useMemo(() => tillTotals(state.lines), [state.lines]);
  const gate = canSubmit(state, branchReady);
  const editable = state.phase === "editing";

  /** What the catalogue tiles need in order to show "3 in basket". */
  const basketByVariant = useMemo(() => {
    const map = new Map<number, number>();
    for (const line of state.lines) map.set(line.variantId, line.quantity);
    return map;
  }, [state.lines]);

  // -------------------------------------------------------------------------
  // Availability — indicative, refreshed out of band
  // -------------------------------------------------------------------------

  /*
   * ===========================================================================
   * ONE AUTHORITATIVE CHANNEL FOR THE TILL'S NUMBERS
   * ===========================================================================
   *
   * This is the same primitive the storefront basket uses, for the same two
   * reasons — and the till needed it just as badly, because it had neither
   * guarantee.
   *
   * 1. THE BURST. A sale, an admin correction and a lapsing reservation can all
   *    name a basket variant within one tick, and `visibilitychange` + `focus`
   *    fire together on every return to the terminal. The bare `Promise.all`
   *    this replaces issued one overlapping batch of `GET /inventory/availability`
   *    per signal: coming back to the till reliably fired two.
   *
   * 2. THE OVERTAKE. Those batches were unordered and unabortable, so a slow
   *    earlier response could land AFTER a newer one and repaint the cashier's
   *    screen with older numbers — the "stale unavailable quantity" the sale
   *    gate is supposed to catch, reintroduced by the refresh itself.
   *
   * The channel keeps exactly one read in flight plus at most one trailing
   * read, and stamps each with a monotonic ticket so an older response is
   * dropped rather than applied. See `createAuthoritativeChannel` and
   * `apps/web/lib/authoritative-channel.test.ts`.
   *
   * It reads ids from `stateRef` rather than closing over `state.lines`, so
   * adding an item does not rebuild the channel and abort a read in flight.
   */
  const readAvailability = useCallback(
    (signal: AbortSignal) => {
      const ids = stateRef.current.lines.map((line) => line.variantId);
      // ONE unknown id fails the WHOLE request with a 404, so only ids that
      // came back from a successful read are ever sent. The resource enforces
      // the endpoint's own 100-id cap.
      return api.inventory.availability(ids, { signal });
    },
    [api],
  );

  /**
   * The channel is built on FIRST USE, not during render.
   *
   * `read` closes over `stateRef` so that adding a basket line does not
   * rebuild the channel and abort a read in flight. That makes it a
   * ref-carrying function, and handing one to a factory during render is
   * exactly what `react-hooks`'s ref rule forbids — a factory is free to call
   * what it is given, and a ref read during render observes a value React has
   * not committed. Constructing lazily inside a callback moves the whole thing
   * off the render path, where reading a ref is what refs are for, and costs
   * one nullish-assignment on the first signal.
   *
   * `api` is created once per `ApiProvider` and never changes, so
   * `readAvailability` is stable for this component's life and the channel
   * built with it stays correct.
   */
  const channelRef = useRef<AuthoritativeChannel<AvailabilitySnapshot[]> | null>(null);
  const getChannel = useCallback((): AuthoritativeChannel<AvailabilitySnapshot[]> => {
    channelRef.current ??= createAuthoritativeChannel<AvailabilitySnapshot[]>({
      read: readAvailability,
      onResult: (snapshots) => {
        dispatch({
          type: "availability",
          snapshots: snapshots.map((snap) => ({
            variantId: snap.variantId,
            availableForPos: snap.availableForPos,
            // Carried so a SKU retired while it sits in an open basket blocks
            // checkout on the next authoritative read. The number alone cannot
            // say this: a retired variant's `availableForPos` stays positive.
            isActive: snap.isActive,
          })),
          at: new Date().toISOString(),
        });
        setAvailabilityProblem(null);
      },
      onError: (error) => {
        // Keep the last known numbers rather than blanking them: a stale
        // warning is more useful at a counter than no warning at all.
        setAvailabilityProblem(
          isApiError(error) && error.status === 404
            ? "یکی از کالاهای سبد روی سرور یافت نشد؛ عددهای موجودی به‌روزرسانی نشدند."
            : "به‌روزرسانی موجودی انجام نشد؛ عددهای نمایش‌داده‌شده ممکن است قدیمی باشند.",
        );
      },
    });
    return channelRef.current;
  }, [readAvailability]);

  /**
   * Ask for fresh numbers. An empty basket has nothing to ask about, and
   * asking anyway would dispatch an empty snapshot set that marks nothing
   * fresh while still costing a request — and would clear a standing warning
   * without having read anything.
   */
  const refreshAvailability = useCallback(() => {
    if (stateRef.current.lines.length === 0) return;
    getChannel().refresh();
  }, [getChannel]);

  const scheduleRefresh = useCallback(
    (delay: number) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshAvailability();
      }, delay);
    },
    [refreshAvailability],
  );

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      // Aborts the in-flight read and forgets any trailing one. NOT a latch,
      // so React Strict Mode's second mount still reads through the same
      // channel rather than sitting on stale numbers.
      channelRef.current?.stop();
    },
    [],
  );

  // Tell the realtime layer what this screen cares about. Under the default
  // polling transport this IS the periodic authoritative refetch, which is
  // deliberate: the event stream alone is not a correctness mechanism here.
  const variantKey = state.lines.map((line) => line.variantId).join(",");
  const interest = useMemo<RealtimeInterest | null>(
    () =>
      variantKey === ""
        ? null
        : { kind: "variants", variantIds: variantKey.split(",").map(Number) },
    [variantKey],
  );
  useRealtimeInterest(interest);

  // The recovery path. Missed frames are recovered HERE, by refetching, not by
  // trusting the stream.
  useRealtimeResync(() => {
    refreshAvailability();
  });

  useRealtimeEvent("stock:updated", (payload) => {
    if (!stateRef.current.lines.some((line) => line.variantId === payload.variantId)) return;
    // A frame from ANOTHER branch still touches the same global stock row, so
    // it is worth a refetch — just a debounced one, and never a repaint from
    // the frame's own number, which counts a different quantity (`newStock` is
    // physical stock; the basket shows availableForPos).
    const ours = payload.branchId === null || payload.branchId === session?.branchId;
    dispatch({ type: "markStale", variantIds: [payload.variantId] });
    scheduleRefresh(ours ? 0 : 600);
  });

  /*
   * ===========================================================================
   * THE TILL'S OWN AVAILABILITY CHANNEL
   * ===========================================================================
   *
   * `stock:updated` is branch-scoped, and a stock change that belongs to no
   * till — an administrator correcting a count — carries `branchId: null` and
   * so reaches the super-admin room only. A till subscribed to `stock:updated`
   * alone never learns about it.
   *
   * This till used to close that gap by subscribing to the CUSTOMER-facing
   * global broadcast. That worked and was wrong in two ways: it made the till
   * depend on an event written for shoppers, and it meant every basket
   * reservation in the shop — which cannot change what a till may sell,
   * because POS outranks basket holds — woke every terminal to re-read a
   * number that had not moved.
   *
   * `pos:availability:invalidated` is the staff channel: not branch-scoped
   * (physical stock is one number for the whole business) and published only
   * for reasons that can actually move `availableForPos`. The payload carries
   * no quantity, so the reaction is the same as before — re-read
   * `GET /inventory/availability`, the only endpoint that knows
   * `availableForPos`.
   */
  useRealtimeEvent("pos:availability:invalidated", (payload) => {
    if (!stateRef.current.lines.some((line) => line.variantId === payload.variantId)) return;
    dispatch({ type: "markStale", variantIds: [payload.variantId] });
    scheduleRefresh(0);
  });

  /*
   * Coming back to the terminal is the other moment the numbers must be
   * re-read — now the RECOVERY path rather than the path, since the socket
   * delivers a till sale or an admin correction while the screen sits idle.
   *
   * `visibilitychange` and `focus` both fire in the common case, so the
   * refetch is collapsed by a short window. The channel would fold the second
   * into a trailing read rather than a parallel one, but a trailing read is
   * still a request and there is nothing to learn from it.
   */
  const lastReconcileRef = useRef(0);
  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastReconcileRef.current < VISIBILITY_DEDUPE_MS) return;
      lastReconcileRef.current = now;
      refreshAvailability();
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, [refreshAvailability]);

  // -------------------------------------------------------------------------
  // Selling
  // -------------------------------------------------------------------------

  const submit = useCallback(
    async (bodyOverride?: CreatePosOrderBody) => {
      if (submitLock.current) return;
      const current = stateRef.current;
      const body = bodyOverride ?? buildSaleBody(current);
      if (bodyOverride === undefined && !canSubmit(current, branchReady).ok) return;

      submitLock.current = true;
      dispatch({ type: "submitStart", body });
      try {
        const attempt = attemptRef.current;
        const response = await api.orders.posSale(body, {
          ...(attempt ? { attempt } : {}),
          // Long enough for a slow till network, short enough that a cashier is
          // not left staring. A timeout here is an UNKNOWN outcome, not a
          // failure, and is handled as such.
          timeoutMs: 45_000,
        });
        cacheSale(response.data);
        dispatch({ type: "submitOk", sale: response.data });
        refreshAvailability();
      } catch (error) {
        dispatch({ type: "submitFail", failure: classifySaleFailure(error) });
        refreshAvailability();
        /*
         * RECONCILE THE CATALOGUE TOO, and do it here rather than waiting for a
         * frame.
         *
         * A refused sale emits NOTHING — the transaction rolled back, so there
         * is no committed change to announce, which is exactly the property
         * section 5 of the event audit requires. The catalogue's own
         * subscriptions are therefore silent after a 409, and the numbers that
         * led the cashier into the refusal would stay on screen. Bumping this
         * token makes the picker re-read.
         */
        setCatalogToken((token) => token + 1);
      } finally {
        submitLock.current = false;
      }
    },
    [api, branchReady, refreshAvailability],
  );

  const retrySameKey = useCallback(() => {
    const body = stateRef.current.submittedBody;
    if (!body) return;
    // Byte-for-byte the previous payload, on the SAME key. A completed sale
    // replays; an in-flight one waits; a rolled-back one is retried cleanly.
    void submit(body);
  }, [submit]);

  const startNewSale = useCallback(() => {
    // Renew and reset TOGETHER. A new basket on a spent key is a 409 waiting to
    // happen; a fresh key on an unresolved sale is a double sale waiting to
    // happen.
    attemptRef.current?.renew();
    dispatch({ type: "startNewSale" });
    setBasketOpen(false);
  }, []);

  // One keyboard accelerator, for the single action a busy counter repeats.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F4") return;
      event.preventDefault();
      if (canSubmit(stateRef.current, branchReady).ok) void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [branchReady, submit]);

  const flagged = useMemo(() => {
    const id = state.failure?.stock?.variantId;
    return new Set<number>(typeof id === "number" ? [id] : []);
  }, [state.failure]);

  // -------------------------------------------------------------------------

  if (state.phase === "completed" && state.sale) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <SaleRecorded sale={state.sale} onNewSale={startNewSale} />
      </div>
    );
  }

  const settlement = (
    <>
      <Card tone="raised" padding="md">
        <h2 id="checkout-heading" className="text-xl text-ink">
          تسویه
        </h2>

        <dl className="mt-4 flex flex-col gap-2 text-sm">
          <Row label="تعداد اقلام">{formatInteger(totals.itemCount)}</Row>
          <Row label="تعداد واحد">{formatInteger(totals.unitCount)}</Row>
        </dl>

        <div className="mt-4 flex items-baseline justify-between border-t border-line pt-4">
          <span className="text-base font-semibold text-ink">مبلغ قابل پرداخت</span>
          <span className="text-2xl font-bold text-ink">
            <Money value={totals.subtotal} />
          </span>
        </div>

        <fieldset className="mt-6" disabled={!editable}>
          <legend className="text-sm font-medium text-ink">شیوه پرداخت</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {PAYMENT_METHODS.map((method) => (
              <label
                key={method}
                className={cx(
                  "flex h-13 cursor-pointer items-center justify-center rounded-md border-2 px-2 text-center text-sm font-semibold transition-colors",
                  state.paymentMethod === method
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-line-strong bg-surface text-ink hover:bg-surface-muted",
                  !editable && "cursor-not-allowed opacity-55",
                )}
              >
                <input
                  type="radio"
                  name="paymentMethod"
                  value={method}
                  className="kz-sr-only"
                  checked={state.paymentMethod === method}
                  onChange={() => dispatch({ type: "setPaymentMethod", value: method })}
                />
                {paymentMethodLabel(method)}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            «کارت‌خوان» فقط ثبت دستی پرداختی است که روی دستگاه جداگانه انجام شده؛ اتصال سخت‌افزاری
            وجود ندارد.
          </p>
        </fieldset>

        <div className="mt-6 flex flex-col gap-4">
          <Input
            label="موبایل مشتری (اختیاری)"
            numeric
            autoComplete="off"
            placeholder="09xxxxxxxxx"
            disabled={!editable}
            value={state.mobile}
            onChange={(event) => dispatch({ type: "setMobile", value: event.target.value })}
            hint="برای فروش گذری خالی بگذارید."
          />
          <Input
            label="نام مشتری (اختیاری)"
            autoComplete="off"
            disabled={!editable || state.mobile.trim() === ""}
            value={state.name}
            onChange={(event) => dispatch({ type: "setName", value: event.target.value })}
            hint="فقط همراه با شماره موبایل ذخیره می‌شود."
          />
        </div>

        <Button
          size="lg"
          fullWidth
          className="mt-6"
          isLoading={state.phase === "submitting"}
          disabled={!gate.ok}
          onClick={() => void submit()}
        >
          ثبت فروش و صدور رسید
        </Button>

        <p aria-live="polite" className="mt-3 min-h-5 text-xs text-ink-muted">
          {gate.ok ? "کلید F4 هم همین فروش را ثبت می‌کند." : gate.reason}
        </p>

        {state.lines.length > 0 && editable ? (
          <Button
            variant="ghost"
            size="sm"
            fullWidth
            className="mt-2"
            onClick={() => dispatch({ type: "clearBasket" })}
          >
            خالی کردن سبد
          </Button>
        ) : null}
      </Card>

      <Card tone="muted" padding="sm">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
          <Badge tone="info" size="sm">
            نکته
          </Badge>
          <span>
            عددهای موجودی هر چند ثانیه از سرور خوانده می‌شوند و تقریبی‌اند. تصمیم نهایی همیشه با
            پاسخ سرور هنگام ثبت فروش است.
          </span>
        </p>
      </Card>
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 py-5 sm:px-6">
      {!branchReady ? (
        <Card
          tone="outlined"
          padding="md"
          role="alert"
          className="mb-5 border-2 border-danger bg-danger-soft"
        >
          <h2 className="text-lg text-ink">ثبت فروش حضوری برای این حساب ممکن نیست</h2>
          <p className="mt-2 text-sm text-ink">
            سرور هیچ شعبه‌ای برای حساب شما اعلام نکرده است. فروش حضوری بدون شعبه ثبت نمی‌شود.
            مرور کالاها در دسترس است. برای تخصیص شعبه با مدیر سیستم تماس بگیرید.
          </p>
        </Card>
      ) : null}

      {/*
        Catalogue FIRST in the DOM: it is the primary work, it is what the
        cashier reads first in RTL, and it is what a keyboard reaches first.
        The sale panel is the companion, not the headline.
      */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <CatalogPicker
            basketByVariant={basketByVariant}
            disabled={!editable}
            reloadToken={catalogToken}
            onAdd={(product, variant) => dispatch({ type: "addVariant", product, variant })}
          />
        </div>

        {/* ---------------- the sale ---------------- */}
        <section
          aria-labelledby="checkout-heading"
          className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24"
        >
          <Card tone="raised" padding="md">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl text-ink">سبد فروش</h2>
              <div className="flex items-center gap-2">
                <Badge tone={totals.unitCount > 0 ? "primary" : "neutral"} size="sm">
                  {formatInteger(totals.unitCount)} واحد
                </Badge>
                {/* The basket toggle exists only where the two columns stack. */}
                <Button
                  variant="secondary"
                  size="sm"
                  className="lg:hidden"
                  aria-expanded={basketOpen}
                  aria-controls="basket-region"
                  onClick={() => setBasketOpen((open) => !open)}
                >
                  {basketOpen ? "بستن سبد" : "نمایش سبد"}
                </Button>
              </div>
            </div>

            <p aria-live="polite" className="mt-2 min-h-6 text-sm">
              {state.notice ? (
                <span
                  className={cx(
                    state.notice.tone === "success" && "text-success",
                    state.notice.tone === "warning" && "text-warning",
                    state.notice.tone === "danger" && "text-danger",
                  )}
                >
                  {state.notice.text}
                </span>
              ) : null}
            </p>
          </Card>

          <div id="basket-region" className={cx("flex flex-col gap-4", !basketOpen && "hidden lg:flex")}>
            {state.failure ? (
              <SaleProblem
                failure={state.failure}
                busy={state.phase === "submitting"}
                onRetrySameKey={retrySameKey}
                onStartNewSale={startNewSale}
                onDismiss={() => dispatch({ type: "dismissFailure" })}
              />
            ) : null}

            {state.phase === "frozen" ? (
              <p className="rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-ink">
                سبد تا روشن‌شدن نتیجهٔ فروش قبلی قفل است. تغییر اقلام در این حالت باعث می‌شود سرور
                تلاش دوباره را یک درخواست متفاوت بداند.
              </p>
            ) : null}

            {availabilityProblem ? (
              <p className="rounded-md border border-line bg-surface-muted px-4 py-3 text-sm text-ink-muted">
                {availabilityProblem}
              </p>
            ) : null}

            <Basket
              lines={state.lines}
              editable={editable}
              flagged={flagged}
              onQuantity={(variantId, quantity) =>
                dispatch({ type: "setQuantity", variantId, quantity })
              }
              onRemove={(variantId) => dispatch({ type: "remove", variantId })}
            />

            {settlement}
          </div>
        </section>
      </div>

      <p role="status" aria-live="polite" className="kz-sr-only">
        {state.phase === "submitting" ? "در حال ثبت فروش. لطفاً صبر کنید." : ""}
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-semibold text-ink">{children}</dd>
    </div>
  );
}
