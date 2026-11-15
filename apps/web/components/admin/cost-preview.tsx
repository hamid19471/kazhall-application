"use client";

import { cx, formatRialString } from "@kazhal/ui";

import { formatPercentString, grossProfitPerUnit, marginPercent, parseRialInput } from "@/lib/costing";

/**
 * SHARED COPY for every purchase-cost input.
 *
 * Cost is super_admin-only BY ROLE (docs/PURCHASE-COST-ACCOUNTING.md §8), and
 * it is never echoed in a product, inventory, cart or till payload — the
 * operator should know that before they type it, not discover it afterwards.
 */
export const PURCHASE_COST_SENSITIVE_HINT =
  "این رقم حساس است و فقط مدیر کل (super_admin) آن را می‌بیند؛ در سایت، صندوق فروشگاه و صفحه‌های کالا و موجودیِ سایر مدیران نمایش داده نمی‌شود.";

export const PURCHASE_COST_REQUIRED_HINT =
  "چون موجودی اولیه بیشتر از صفر است، قیمت خرید هر واحد لازم است. «۰» یعنی کالا رایگان به دست شما رسیده؛ خالی گذاشتن یعنی «نامعلوم» و پذیرفته نمی‌شود.";

export const PURCHASE_COST_OPTIONAL_HINT =
  "اختیاری. با موجودی صفر، این رقم فقط به‌عنوان پیش‌فرضِ «ثبت ورود کالا»ی بعدی به خاطر سپرده می‌شود و ارزشی به موجودی اضافه نمی‌کند.";

export const PURCHASE_COST_MISSING = "برای ثبت موجودی اولیه، قیمت خرید هر واحد را وارد کنید.";

/**
 * The same refusal the server gives a non-super_admin who sends opening stock:
 * a positive opening quantity needs a purchase price, and only the main
 * administrator may enter one.
 */
export const OPENING_STOCK_NEEDS_MAIN_ADMIN =
  "ثبت موجودی اولیه به قیمت خرید نیاز دارد و قیمت خرید را فقط مدیر کل ثبت می‌کند. کالا را با موجودی ۰ بسازید و از مدیر کل بخواهید موجودی را با «ثبت ورود کالا» وارد کند.";

function bigOf(raw: string | number | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? BigInt(raw) : null;
  const parsed = parseRialInput(raw);
  return parsed.kind === "value" ? parsed.value : null;
}

function rial(value: bigint | null): string {
  return value === null ? "—" : formatRialString(value.toString());
}

/**
 * The live «سود ناخالص» preview beside a purchase price.
 *
 * GROSS, and it says so: selling price − purchase price, before any expense
 * this system does not model. A missing figure prints "—" rather than a zero
 * that would read as "no profit".
 */
export function UnitProfitPreview({
  sellingPrice,
  purchasePrice,
  className,
}: {
  /** The typed or stored selling price. Empty / invalid → "—". */
  sellingPrice: string | number | null | undefined;
  purchasePrice: string;
  className?: string;
}) {
  const sell = bigOf(sellingPrice);
  const cost = bigOf(purchasePrice);
  const profit = sell !== null && cost !== null ? grossProfitPerUnit(sell, cost) : null;
  const margin = profit !== null && sell !== null ? marginPercent(profit, sell) : null;
  const loss = profit !== null && profit < BigInt(0);

  return (
    <div
      className={cx("rounded-md border border-line bg-surface-muted p-3", className)}
      aria-live="polite"
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <PreviewCell label="قیمت فروش" value={rial(sell)} />
        <PreviewCell label="قیمت خرید" value={rial(cost)} />
        <PreviewCell
          label="سود ناخالص هر واحد"
          value={rial(profit)}
          className={loss ? "text-danger" : undefined}
        />
        <PreviewCell
          label="حاشیه سود ناخالص"
          value={formatPercentString(margin)}
          className={loss ? "text-danger" : undefined}
        />
      </dl>
      <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
        پیش‌بینی سود ناخالص است، نه سود خالص: هزینه‌هایی مانند اجاره، حقوق، ارسال و کارمزد در آن
        نیست.
        {loss ? " قیمت فروش از قیمت خرید کمتر است." : null}
      </p>
    </div>
  );
}

function PreviewCell({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string | undefined;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd className={cx("mt-0.5 break-words font-bold text-ink", className)} data-numeric="">
        {value}
      </dd>
    </div>
  );
}
