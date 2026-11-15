"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { isApiError } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Input, Money, Skeleton, cx, formatRialString } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import { AdminSection, Fact, Modal, Textarea, count } from "@/components/admin/ui";
import { PURCHASE_COST_SENSITIVE_HINT } from "@/components/admin/cost-preview";
import {
  fetchCostingProduct,
  postInventoryCorrection,
  postStockReceipt,
  postValuation,
  putPurchasePrice,
} from "@/lib/admin-api";
import type { CostPoolView, CostingVariantView } from "@/lib/admin-api";
import {
  amountProblem,
  parseQuantityInput,
  parseRialInput,
  receiptPreview,
  removalPreview,
  unvaluedIncreasePreview,
  valuationPreview,
} from "@/lib/costing";
import { costStatusLabel } from "@/lib/labels";
import { isSuperAdmin } from "@/lib/permissions";
import { isKeyConflict, useAttemptKey } from "@/lib/attempt-key";

/**
 * «قیمت خرید و ارزش موجودی» on the product edit page.
 *
 * SUPER_ADMIN ONLY, BY ROLE (docs/PURCHASE-COST-ACCOUNTING.md §8). For anybody
 * else this renders nothing and — because the body below is never mounted —
 * issues no `/admin/costing/*` request at all. Hiding is a courtesy; the API
 * refuses regardless.
 *
 * Every figure here is about INVENTORY, not profit: the value of the units on
 * the shelf whose purchase cost is known. Units whose cost is unknown are
 * counted separately as «ارزش‌گذاری‌نشده» and are never valued at zero.
 */
export function ProductCostingSection({
  productId,
  onChanged,
}: {
  productId: number;
  /** Refreshes the product view (stock badges) after a receipt or correction. */
  onChanged: () => void;
}) {
  const { session } = useAppSession();
  if (!isSuperAdmin(session)) return null;
  return <CostingBody productId={productId} onChanged={onChanged} />;
}

type DialogKind = "receipt" | "correction" | "valuation" | "price";

function CostingBody({ productId, onChanged }: { productId: number; onChanged: () => void }) {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchCostingProduct(api, productId, { signal }),
    [api, productId],
  );
  const [dialog, setDialog] = useState<{ kind: DialogKind; variantId: number } | null>(null);
  const [done, setDone] = useState<ReactNode>(null);

  // STABLE, because `Modal` re-runs its focus trap whenever `onClose` changes.
  const close = useCallback(() => setDialog(null), []);
  const refetchRef = useRef(refetch);
  const changedRef = useRef(onChanged);
  useEffect(() => {
    refetchRef.current = refetch;
    changedRef.current = onChanged;
  });
  const finish = useCallback((message: ReactNode) => {
    setDialog(null);
    setDone(message);
    refetchRef.current();
    changedRef.current();
  }, []);
  const reload = useCallback(() => {
    setDialog(null);
    refetchRef.current();
  }, []);

  const variant = dialog ? data?.variants.find((row) => row.variantId === dialog.variantId) : undefined;

  return (
    <div id="costing" className="scroll-mt-24">
      <AdminSection
        title="قیمت خرید و ارزش موجودی"
        description={
          <>
            ارزش موجودیِ هر گونه با میانگین موزون متحرک محاسبه می‌شود. {PURCHASE_COST_SENSITIVE_HINT}
          </>
        }
      >
        {error ? (
          <ErrorState
            error={error}
            title="اطلاعات قیمت خرید خوانده نشد"
            {...(error.status === 403 ? {} : { onRetry: refetch })}
          />
        ) : isLoading || !data ? (
          <div role="status" aria-busy="true">
            <span className="kz-sr-only">در حال بارگذاری قیمت خرید</span>
            <Skeleton shape="block" height="10rem" />
          </div>
        ) : (
          <>
            {done ? (
              <Notice tone="success" className="mb-4">
                {done}
              </Notice>
            ) : null}

            <dl className="grid gap-2 sm:grid-cols-3">
              <Fact label="موجودی کل" numeric>
                {count(data.totals.stock)}
              </Fact>
              <Fact label="ارزش موجودی" hint="ارزش واحدهایی که قیمت خریدشان معلوم است.">
                <Money value={data.totals.inventoryCostValue} />
              </Fact>
              <Fact label="موجودی ارزش‌گذاری‌نشده" numeric>
                {count(data.totals.unvaluedQuantity)}
              </Fact>
            </dl>

            <ul className="mt-4 space-y-3">
              {data.variants.map((row) => (
                <VariantCostCard
                  key={row.variantId}
                  variant={row}
                  onOpen={(kind) => {
                    setDone(null);
                    setDialog({ kind, variantId: row.variantId });
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </AdminSection>

      {dialog && variant ? (
        dialog.kind === "receipt" ? (
          <ReceiptDialog variant={variant} onClose={close} onDone={finish} onReload={reload} />
        ) : dialog.kind === "correction" ? (
          <CorrectionDialog variant={variant} onClose={close} onDone={finish} onReload={reload} />
        ) : dialog.kind === "valuation" ? (
          <ValuationDialog variant={variant} onClose={close} onDone={finish} onReload={reload} />
        ) : (
          <PurchasePriceDialog variant={variant} onClose={close} onDone={finish} onReload={reload} />
        )
      ) : null}
    </div>
  );
}

function variantName(variant: CostingVariantView): string {
  if (variant.isDefault) return variant.productTitle;
  return variant.variantCode || variant.sku;
}

function VariantCostCard({
  variant,
  onOpen,
}: {
  variant: CostingVariantView;
  onOpen: (kind: DialogKind) => void;
}) {
  const unvalued = variant.unvaluedQuantity > 0;
  return (
    <li className={cx("rounded-md border p-4", variant.isActive ? "border-line" : "border-line bg-surface-muted")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{variantName(variant)}</p>
          <p className="mt-0.5 text-2xs text-ink-subtle">
            کد کالا: <bdi dir="ltr" data-numeric="">{variant.sku}</bdi>
            {variant.variantCode ? (
              <>
                {" · "}کد گونه: <bdi dir="ltr" data-numeric="">{variant.variantCode}</bdi>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!variant.isActive ? (
            <Badge size="sm" tone="neutral">
              غیرفعال
            </Badge>
          ) : null}
          <Badge size="sm" tone={unvalued ? "warning" : "success"}>
            {costStatusLabel(variant.costStatus)}
            {unvalued ? (
              <>
                {" "}
                (<bdi data-numeric="">{count(variant.unvaluedQuantity)}</bdi> واحد)
              </>
            ) : null}
          </Badge>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Fact label="موجودی" numeric>
          {count(variant.stock)}
        </Fact>
        <Fact label="ارزش موجودی">
          <Money value={variant.inventoryCostValue} />
        </Fact>
        <Fact
          label="میانگین بهای هر واحد"
          hint={
            variant.averageUnitCost === null
              ? "هیچ واحدِ دارای قیمت خرید معلوم در انبار نیست."
              : "فقط برای نمایش؛ بهای فروش از ارزش دقیق محاسبه می‌شود."
          }
        >
          <Money value={variant.averageUnitCost} />
        </Fact>
        <Fact label="آخرین قیمت خرید" hint="پیش‌فرض «ثبت ورود کالا»ی بعدی.">
          <Money value={variant.lastPurchaseUnitCost} />
        </Fact>
      </dl>

      {unvalued ? (
        <Notice tone="warning" className="mt-3">
          <bdi data-numeric="">{count(variant.unvaluedQuantity)}</bdi> واحد از موجودی این گونه قیمت
          خرید معلومی ندارد. سود فروش این واحدها «نامعلوم» گزارش می‌شود تا آن‌ها را ارزش‌گذاری کنید.
        </Notice>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onOpen("receipt")}>
          ثبت ورود کالا
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onOpen("correction")}>
          اصلاح موجودی
        </Button>
        {unvalued ? (
          <Button size="sm" variant="secondary" onClick={() => onOpen("valuation")}>
            ارزش‌گذاری موجودی قبلی
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onOpen("price")}>
          ویرایش قیمت خرید پیش‌فرض
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Dialog plumbing
// ---------------------------------------------------------------------------

/** Puts focus on the dialog's first real field (after `Modal` focused its close button). */
function useInitialFocus(marker: string) {
  useEffect(() => {
    document.querySelector<HTMLElement>(`[role="dialog"] [data-autofocus="${marker}"]`)?.focus();
  }, [marker]);
}

interface DialogProps {
  variant: CostingVariantView;
  onClose: () => void;
  onDone: (message: ReactNode) => void;
  onReload: () => void;
}

/** The refusals every costing dialog can meet, said in Persian with a next step. */
function CostingFailure({ error, onReload }: { error: unknown; onReload: () => void }) {
  if (!error) return null;
  if (isKeyConflict(error)) {
    return (
      <Notice
        tone="warning"
        title="این درخواست قبلاً با مقادیر دیگری فرستاده شده است"
        action={
          <Button size="sm" variant="secondary" onClick={onReload}>
            بارگذاری دوباره
          </Button>
        }
      >
        <p className="text-xs leading-relaxed">
          ممکن است تلاش قبلی شما ثبت شده باشد و فقط پاسخ آن نرسیده باشد. پیش از تلاش دوباره، این
          پنجره را ببندید و موجودی را دوباره بخوانید تا چیزی دو بار ثبت نشود.
        </p>
      </Notice>
    );
  }
  if (isApiError(error) && error.status === 403) {
    return (
      <Notice tone="danger" title="این کار فقط در اختیار مدیر کل است">
        <p className="text-xs">سرور درخواست را رد کرد و هیچ تغییری ثبت نشد.</p>
      </Notice>
    );
  }
  if (isApiError(error) && error.status === 0) {
    return (
      <Notice tone="danger" title="ارتباط با سرور برقرار نشد">
        <p className="text-xs leading-relaxed">
          معلوم نیست درخواست به سرور رسیده یا نه. دوباره «ثبت» را بزنید؛ همان کلید تکرار فرستاده
          می‌شود و سرور آن را دو بار ثبت نمی‌کند.
        </p>
      </Notice>
    );
  }
  return <FormError error={error} />;
}

function PoolLine({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className={cx("text-sm text-ink", strong && "font-extrabold")} data-numeric="">
        {value}
      </dd>
    </div>
  );
}

function rial(value: bigint | null): string {
  return value === null ? "—" : formatRialString(value.toString());
}

function resultSentence(after: CostPoolView | undefined): ReactNode {
  if (!after) return null;
  return (
    <>
      {" "}
      موجودی اکنون <bdi data-numeric="">{count(after.stock)}</bdi> واحد و ارزش موجودی{" "}
      <Money value={after.inventoryCostValue} /> است.
    </>
  );
}

// ---------------------------------------------------------------------------
// «ثبت ورود کالا»
// ---------------------------------------------------------------------------

function ReceiptDialog({ variant, onClose, onDone, onReload }: DialogProps) {
  const api = useApi();
  const formId = useId();
  const { key, settle } = useAttemptKey();
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState(variant.lastPurchaseUnitCost ?? "");
  const [supplierReference, setSupplierReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const [touched, setTouched] = useState(false);
  useInitialFocus("receipt");

  const q = parseQuantityInput(quantity, { allowZero: false });
  const c = parseRialInput(unitCost);
  const quantityProblem =
    q.kind === "empty" ? "تعداد لازم است." : q.kind === "invalid" ? amountProblem(q.reason, "تعداد") : undefined;
  const costProblem =
    c.kind === "empty"
      ? "قیمت خرید هر واحد لازم است؛ «۰» یعنی رایگان."
      : c.kind === "invalid"
        ? amountProblem(c.reason, "قیمت خرید")
        : undefined;
  const preview = q.kind === "value" && c.kind === "value" ? receiptPreview(variant, q.value, c.value) : null;
  const serverCostError =
    isApiError(error) && error.code?.startsWith("PURCHASE_COST_") ? error.messages[0] : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (pending || q.kind !== "value" || c.kind !== "value" || preview?.outOfRange) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await postStockReceipt(
        api,
        variant.variantId,
        {
          quantity: q.value,
          unitCost: c.value.toString(),
          ...(supplierReference.trim() ? { supplierReference: supplierReference.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        key,
      );
      onDone(
        <p>
          ورود <bdi data-numeric="">{count(result.quantity ?? q.value)}</bdi> واحد «{variantName(variant)}» ثبت
          شد.{resultSentence(result.after)}
        </p>,
      );
    } catch (caught) {
      setError(caught);
      settle(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`ثبت ورود کالا — ${variantName(variant)}`}
      description="برای کالایی که از تأمین‌کننده رسیده است. موجودی به‌اندازهٔ تعداد اضافه می‌شود و ارزش آن با قیمت خرید به ارزش موجودی افزوده می‌شود."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            انصراف
          </Button>
          <Button type="submit" form={formId} isLoading={pending} disabled={Boolean(preview?.outOfRange)}>
            تأیید و ثبت ورود کالا
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="تعداد"
            numeric
            data-autofocus="receipt"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            autoComplete="off"
            {...(touched && quantityProblem ? { error: quantityProblem } : {})}
          />
          <Input
            label="قیمت خرید هر واحد (ریال)"
            numeric
            value={unitCost}
            onChange={(event) => setUnitCost(event.target.value)}
            autoComplete="off"
            hint={variant.lastPurchaseUnitCost !== null ? "با آخرین قیمت خرید پر شده است." : undefined}
            {...((touched && costProblem) || serverCostError
              ? { error: serverCostError ?? costProblem }
              : {})}
          />
        </div>
        <Input
          label="شمارهٔ فاکتور یا مرجع تأمین‌کننده (اختیاری)"
          value={supplierReference}
          maxLength={120}
          onChange={(event) => setSupplierReference(event.target.value)}
        />
        <Textarea
          label="یادداشت (اختیاری)"
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />

        <section aria-label="پیش‌نمایش ارزش موجودی" className="rounded-md border border-line p-3">
          <p className="text-xs font-bold text-ink">پیش از تأیید، نتیجه را ببینید</p>
          <dl className="mt-2 divide-y divide-line">
            <PoolLine label="ارزش فعلی موجودی" value={<Money value={variant.inventoryCostValue} />} />
            <PoolLine label="ارزش ورودی (تعداد × قیمت خرید)" value={rial(preview?.incomingValue ?? null)} />
            <PoolLine label="ارزش موجودی پس از ورود" value={rial(preview?.newValue ?? null)} strong />
            <PoolLine label="میانگین فعلی بهای هر واحد" value={<Money value={variant.averageUnitCost} />} />
            <PoolLine label="میانگین متحرک جدید" value={rial(preview?.newAverage ?? null)} strong />
            <PoolLine
              label="موجودی پس از ورود"
              value={preview ? count(preview.newStock) : "—"}
            />
          </dl>
          {variant.unvaluedQuantity > 0 ? (
            <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
              <bdi data-numeric="">{count(variant.unvaluedQuantity)}</bdi> واحدِ ارزش‌گذاری‌نشده در
              میانگین حساب نمی‌شوند و ارزش‌گذاری‌نشده باقی می‌مانند.
            </p>
          ) : null}
          {preview?.outOfRange ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              ارزش موجودی از سقف مجاز فراتر می‌رود؛ سرور این ورود را نمی‌پذیرد.
            </p>
          ) : null}
        </section>

        {serverCostError ? null : <CostingFailure error={error} onReload={onReload} />}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// «اصلاح موجودی»
// ---------------------------------------------------------------------------

function CorrectionDialog({ variant, onClose, onDone, onReload }: DialogProps) {
  const api = useApi();
  const formId = useId();
  const policyName = useId();
  const { key, settle } = useAttemptKey();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [policy, setPolicy] = useState<"known" | "unknown">("known");
  const [unitCost, setUnitCost] = useState(variant.lastPurchaseUnitCost ?? "");
  const [allowBelowReserved, setAllowBelowReserved] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const [touched, setTouched] = useState(false);
  useInitialFocus("correction");

  const d = parseQuantityInput(delta, { allowNegative: true, allowZero: false });
  const increase = d.kind === "value" && d.value > 0;
  const decrease = d.kind === "value" && d.value < 0;
  const c = parseRialInput(unitCost);
  const belowZero = decrease && d.kind === "value" && variant.stock + d.value < 0;
  const reasonShort = reason.trim().length < 4;
  const refusedBelowReserved = isApiError(error) && error.code === "STOCK_BELOW_RESERVED";

  const deltaProblem =
    d.kind === "empty"
      ? "مقدار تغییر لازم است؛ مثبت برای افزایش و منفی (مثلاً ۳-) برای کاهش."
      : d.kind === "invalid"
        ? amountProblem(d.reason, "مقدار تغییر")
        : belowZero
          ? "موجودی نمی‌تواند منفی شود."
          : undefined;
  const costProblem =
    increase && policy === "known"
      ? c.kind === "empty"
        ? "قیمت خرید هر واحد را بنویسید، یا «قیمت خرید نامعلوم» را انتخاب کنید."
        : c.kind === "invalid"
          ? amountProblem(c.reason, "قیمت خرید")
          : undefined
      : undefined;

  const knownPreview =
    increase && policy === "known" && c.kind === "value" && d.kind === "value"
      ? receiptPreview(variant, d.value, c.value)
      : null;
  const unknownPreview =
    increase && policy === "unknown" && d.kind === "value" ? unvaluedIncreasePreview(variant, d.value) : null;
  const removal = decrease && d.kind === "value" && !belowZero ? removalPreview(variant, -d.value) : null;
  const serverCostError =
    isApiError(error) && error.code?.startsWith("PURCHASE_COST_") ? error.messages[0] : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (pending || d.kind !== "value" || deltaProblem || reasonShort || costProblem) return;
    if (knownPreview?.outOfRange) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await postInventoryCorrection(
        api,
        variant.variantId,
        {
          quantityDelta: d.value,
          reason: reason.trim(),
          ...(increase && policy === "known" && c.kind === "value" ? { unitCost: c.value.toString() } : {}),
          ...(increase && policy === "unknown" ? { costUnknown: true as const } : {}),
          ...(allowBelowReserved ? { allowBelowReserved: true } : {}),
        },
        key,
      );
      onDone(
        <p>
          اصلاح موجودی «{variantName(variant)}» ثبت شد.
          {result.costPolicy === "removed" && result.costRemoved !== null ? (
            <>
              {" "}
              بهای <Money value={result.costRemoved} /> به‌عنوان زیان موجودی ثبت شد.
            </>
          ) : null}
          {resultSentence(result.after)}
        </p>,
      );
    } catch (caught) {
      setError(caught);
      settle(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`اصلاح موجودی — ${variantName(variant)}`}
      description="برای اختلاف شمارش، کالای آسیب‌دیده یا گم‌شده. هر اصلاح با دلیل در دفتر گردش موجودی ثبت می‌شود."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            انصراف
          </Button>
          <Button type="submit" form={formId} isLoading={pending}>
            ثبت اصلاح
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-xs text-ink-muted">
          موجودی فعلی: <bdi data-numeric="">{count(variant.stock)}</bdi> واحد
        </p>
        <Input
          label="مقدار تغییر (مثبت یا منفی)"
          numeric
          inputMode="text"
          data-autofocus="correction"
          value={delta}
          onChange={(event) => setDelta(event.target.value)}
          autoComplete="off"
          hint="عدد مثبت اضافه و عدد منفی کم می‌کند؛ مثلاً ۳- یعنی سه واحد کم شود."
          {...(touched && deltaProblem ? { error: deltaProblem } : {})}
        />

        {increase ? (
          <fieldset className="space-y-2 rounded-md border border-line p-3">
            <legend className="px-1 text-xs font-bold text-ink">قیمت خرید واحدهای اضافه‌شده</legend>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name={policyName}
                checked={policy === "known"}
                onChange={() => setPolicy("known")}
                className="mt-1 size-4 accent-[color:var(--kz-primary)]"
              />
              <span>قیمت خرید مشخص</span>
            </label>
            {policy === "known" ? (
              <Input
                label="قیمت خرید هر واحد (ریال)"
                numeric
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
                autoComplete="off"
                {...((touched && costProblem) || serverCostError
                  ? { error: serverCostError ?? costProblem }
                  : {})}
              />
            ) : null}
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name={policyName}
                checked={policy === "unknown"}
                onChange={() => setPolicy("unknown")}
                className="mt-1 size-4 accent-[color:var(--kz-primary)]"
              />
              <span>
                قیمت خرید نامعلوم
                <span className="mt-0.5 block text-2xs leading-relaxed text-ink-subtle">
                  این واحدها «ارزش‌گذاری‌نشده» ثبت می‌شوند — نه با ارزش صفر — و سود فروش آن‌ها نامعلوم
                  گزارش می‌شود تا بعداً ارزش‌گذاری شوند.
                </span>
              </span>
            </label>
          </fieldset>
        ) : null}

        {decrease ? (
          <Notice tone="neutral">
            <p className="text-xs leading-relaxed">
              در کاهش، بهای واحدهای خارج‌شده به نسبت از ارزش موجودی کم می‌شود و در گزارش سود به‌عنوان
              <b> زیان موجودی</b> جداگانه نمایش داده می‌شود، نه بهای تمام‌شدهٔ کالای فروش‌رفته. واحدهای
              ارزش‌گذاری‌نشده زودتر خارج می‌شوند.
            </p>
          </Notice>
        ) : null}

        <section aria-label="پیش‌نمایش" className="rounded-md border border-line p-3">
          <dl className="divide-y divide-line">
            <PoolLine label="ارزش فعلی موجودی" value={<Money value={variant.inventoryCostValue} />} />
            {knownPreview ? (
              <>
                <PoolLine label="ارزش افزوده‌شده" value={rial(knownPreview.incomingValue)} />
                <PoolLine label="ارزش موجودی پس از اصلاح" value={rial(knownPreview.newValue)} strong />
                <PoolLine label="میانگین متحرک جدید" value={rial(knownPreview.newAverage)} />
                <PoolLine label="موجودی پس از اصلاح" value={count(knownPreview.newStock)} />
              </>
            ) : unknownPreview ? (
              <>
                <PoolLine label="ارزش موجودی پس از اصلاح (بدون تغییر)" value={rial(unknownPreview.newValue)} strong />
                <PoolLine label="موجودی ارزش‌گذاری‌نشده پس از اصلاح" value={count(unknownPreview.newUnvalued)} />
                <PoolLine label="موجودی پس از اصلاح" value={count(unknownPreview.newStock)} />
              </>
            ) : removal ? (
              <>
                <PoolLine label="بهای حذف‌شده (زیان موجودی، تقریبی)" value={rial(removal.costRemoved)} />
                <PoolLine label="ارزش موجودی پس از اصلاح" value={rial(removal.newValue)} strong />
                <PoolLine
                  label="واحدهای خارج‌شدهٔ بدون قیمت خرید"
                  value={count(removal.unknownQuantity)}
                />
                <PoolLine label="موجودی پس از اصلاح" value={count(removal.newStock)} />
              </>
            ) : (
              <PoolLine label="ارزش موجودی پس از اصلاح" value="—" />
            )}
          </dl>
          {knownPreview?.outOfRange ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              ارزش موجودی از سقف مجاز فراتر می‌رود؛ سرور این اصلاح را نمی‌پذیرد.
            </p>
          ) : null}
        </section>

        <Textarea
          label="دلیل اصلاح (اجباری)"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          hint="دست‌کم ۴ نویسه؛ مثلاً «شمارش انبار، قفسهٔ ۴ب» یا «دو عدد شکسته بود»."
          {...(touched && reasonShort ? { error: "دلیل باید دست‌کم ۴ نویسه باشد." } : {})}
        />

        {refusedBelowReserved ? (
          <Notice tone="warning" title="این کاهش موجودی را کمتر از مقدار رزروشده می‌کند">
            <label className="mt-1 flex items-start gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={allowBelowReserved}
                onChange={(event) => setAllowBelowReserved(event.target.checked)}
                className="mt-0.5 size-4 accent-[color:var(--kz-primary)]"
              />
              می‌پذیرم که این واحدها واقعاً موجود نیستند و سبد یا سفارش مشتریان تحت تأثیر قرار می‌گیرد.
            </label>
          </Notice>
        ) : serverCostError ? null : (
          <CostingFailure error={error} onReload={onReload} />
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// «ارزش‌گذاری موجودی قبلی»
// ---------------------------------------------------------------------------

function ValuationDialog({ variant, onClose, onDone, onReload }: DialogProps) {
  const api = useApi();
  const formId = useId();
  const modeName = useId();
  const { key, settle } = useAttemptKey();
  const [mode, setMode] = useState<"unitCost" | "totalValue">("unitCost");
  const [amount, setAmount] = useState(variant.lastPurchaseUnitCost ?? "");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const [touched, setTouched] = useState(false);
  const confirmRef = useRef<HTMLHeadingElement | null>(null);
  useInitialFocus("valuation");

  useEffect(() => {
    if (step === "confirm") confirmRef.current?.focus();
  }, [step]);

  const a = parseRialInput(amount);
  const amountProblemText =
    a.kind === "empty"
      ? mode === "unitCost"
        ? "قیمت خرید هر واحد لازم است."
        : "ارزش کل لازم است."
      : a.kind === "invalid"
        ? amountProblem(a.reason, mode === "unitCost" ? "قیمت خرید" : "ارزش کل")
        : undefined;
  const preview =
    a.kind === "value"
      ? valuationPreview(
          variant,
          mode === "unitCost" ? { mode, unitCost: a.value } : { mode, totalValue: a.value },
        )
      : null;
  const stale = isApiError(error) && error.code === "INVENTORY_VALUATION_STALE";
  const alreadyValued = isApiError(error) && error.code === "INVENTORY_ALREADY_VALUED";

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (a.kind !== "value" || preview?.outOfRange) return;
    setStep("confirm");
  }

  async function confirm() {
    if (pending || a.kind !== "value") return;
    setPending(true);
    setError(undefined);
    try {
      const result = await postValuation(
        api,
        variant.variantId,
        {
          // The count THIS screen showed. If a sale moved it since, the server
          // answers INVENTORY_VALUATION_STALE instead of valuing different units.
          expectedUnvaluedQuantity: variant.unvaluedQuantity,
          ...(mode === "unitCost" ? { unitCost: a.value.toString() } : { totalValue: a.value.toString() }),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        key,
      );
      onDone(
        <p>
          <bdi data-numeric="">{count(result.valuedUnits ?? variant.unvaluedQuantity)}</bdi> واحد «
          {variantName(variant)}» ارزش‌گذاری شد.{resultSentence(result.after)}
        </p>,
      );
    } catch (caught) {
      setError(caught);
      settle(caught);
    } finally {
      setPending(false);
    }
  }

  const footer =
    step === "edit" ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          انصراف
        </Button>
        <Button type="submit" form={formId} disabled={Boolean(preview?.outOfRange)}>
          بررسی و ادامه
        </Button>
      </>
    ) : stale || alreadyValued ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          بستن
        </Button>
        <Button onClick={onReload}>بارگذاری دوباره</Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => setStep("edit")} disabled={pending}>
          بازگشت و ویرایش
        </Button>
        <Button onClick={() => void confirm()} isLoading={pending}>
          تأیید ارزش‌گذاری
        </Button>
      </>
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={`ارزش‌گذاری موجودی قبلی — ${variantName(variant)}`}
      description="برای واحدهایی که پیش از ثبت قیمت خرید در انبار بوده‌اند. تعداد موجودی تغییر نمی‌کند؛ فقط ارزش آن‌ها معلوم می‌شود."
      footer={footer}
    >
      {step === "edit" ? (
        <form id={formId} onSubmit={review} className="space-y-3" noValidate>
          <p className="text-sm text-ink">
            <bdi data-numeric="">{count(variant.unvaluedQuantity)}</bdi> واحد ارزش‌گذاری‌نشده از{" "}
            <bdi data-numeric="">{count(variant.stock)}</bdi> واحد موجودی.
          </p>
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold text-ink">روش ارزش‌گذاری</legend>
            {(
              [
                ["unitCost", "قیمت خرید هر واحد"],
                ["totalValue", "ارزش کل این واحدها"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name={modeName}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  className="size-4 accent-[color:var(--kz-primary)]"
                />
                {label}
              </label>
            ))}
          </fieldset>
          <Input
            label={mode === "unitCost" ? "قیمت خرید هر واحد (ریال)" : "ارزش کل (ریال)"}
            numeric
            data-autofocus="valuation"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            autoComplete="off"
            {...(touched && amountProblemText ? { error: amountProblemText } : {})}
          />
          <Textarea
            label="یادداشت (اختیاری)"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
          <section aria-label="پیش‌نمایش ارزش موجودی" className="rounded-md border border-line p-3">
            <dl className="divide-y divide-line">
              <PoolLine label="ارزش فعلی موجودی" value={<Money value={variant.inventoryCostValue} />} />
              <PoolLine label="ارزش افزوده‌شده" value={rial(preview?.addedValue ?? null)} />
              <PoolLine label="ارزش موجودی پس از ارزش‌گذاری" value={rial(preview?.newValue ?? null)} strong />
              <PoolLine label="میانگین بهای هر واحد پس از آن" value={rial(preview?.newAverage ?? null)} />
            </dl>
            {preview?.outOfRange ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                ارزش موجودی از سقف مجاز فراتر می‌رود؛ سرور آن را نمی‌پذیرد.
              </p>
            ) : null}
          </section>
        </form>
      ) : (
        <div className="space-y-3">
          <h3 ref={confirmRef} tabIndex={-1} className="text-sm font-bold text-ink focus:outline-none">
            این ارزش‌گذاری را تأیید می‌کنید؟
          </h3>
          <ul className="space-y-2 text-sm leading-relaxed text-ink">
            <li>
              <bdi data-numeric="">{count(variant.unvaluedQuantity)}</bdi> واحد با ارزش کل{" "}
              {rial(preview?.addedValue ?? null)} ارزش‌گذاری می‌شوند.
            </li>
            <li>ارزش موجودی از {formatRialString(variant.inventoryCostValue)} به {rial(preview?.newValue ?? null)} می‌رسد.</li>
            <li>تعداد موجودی تغییر نمی‌کند و این کار فقط یک بار برای این واحدها انجام می‌شود.</li>
          </ul>
          {stale ? (
            <Notice tone="warning" title="تعداد موجودی ارزش‌گذاری‌نشده تغییر کرده است">
              <p className="text-xs leading-relaxed">
                از زمان باز شدن این صفحه، فروش یا اصلاحی تعداد واحدهای ارزش‌گذاری‌نشده را عوض کرده است.
                هیچ چیزی ثبت نشد. «بارگذاری دوباره» را بزنید و با عدد تازه دوباره بررسی کنید.
              </p>
            </Notice>
          ) : alreadyValued ? (
            <Notice tone="info" title="این موجودی قبلاً ارزش‌گذاری شده است">
              <p className="text-xs leading-relaxed">
                واحد ارزش‌گذاری‌نشده‌ای باقی نمانده است. اطلاعات را دوباره بخوانید.
              </p>
            </Notice>
          ) : (
            <CostingFailure error={error} onReload={onReload} />
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Remembered purchase price
// ---------------------------------------------------------------------------

function PurchasePriceDialog({ variant, onClose, onDone, onReload }: DialogProps) {
  const api = useApi();
  const formId = useId();
  const { key, settle } = useAttemptKey();
  const [value, setValue] = useState(variant.lastPurchaseUnitCost ?? "");
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const [touched, setTouched] = useState(false);
  useInitialFocus("price");

  const parsed = parseRialInput(value);
  const problem =
    parsed.kind === "empty"
      ? "قیمت را بنویسید، یا با دکمهٔ «پاک‌کردن» قیمت پیش‌فرض را بردارید."
      : parsed.kind === "invalid"
        ? amountProblem(parsed.reason, "قیمت خرید")
        : undefined;

  async function send(unitCost: string | null) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await putPurchasePrice(api, variant.variantId, unitCost, key);
      onDone(
        <p>
          قیمت خرید پیش‌فرض «{variantName(variant)}»{" "}
          {result.lastPurchaseUnitCost === null ? (
            "پاک شد."
          ) : (
            <>
              <Money value={result.lastPurchaseUnitCost} /> شد.
            </>
          )}{" "}
          ارزش موجودی تغییری نکرد.
        </p>,
      );
    } catch (caught) {
      setError(caught);
      settle(caught);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (parsed.kind !== "value") return;
    void send(parsed.value.toString());
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`قیمت خرید پیش‌فرض — ${variantName(variant)}`}
      description="فقط پیش‌فرضی است که «ثبت ورود کالا»ی بعدی با آن پر می‌شود. ارزش موجودی و بهای فروش‌های گذشته را تغییر نمی‌دهد."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            انصراف
          </Button>
          {variant.lastPurchaseUnitCost !== null ? (
            <Button variant="secondary" onClick={() => void send(null)} disabled={pending}>
              پاک‌کردن
            </Button>
          ) : null}
          <Button type="submit" form={formId} isLoading={pending}>
            ذخیره
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3" noValidate>
        <Input
          label="قیمت خرید هر واحد (ریال)"
          numeric
          data-autofocus="price"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          hint={PURCHASE_COST_SENSITIVE_HINT}
          {...(touched && problem ? { error: problem } : {})}
        />
        <CostingFailure error={error} onReload={onReload} />
      </form>
    </Modal>
  );
}
