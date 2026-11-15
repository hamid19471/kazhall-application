"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { isApiError } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Input, Money, toLatinDigits } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice, Pagination } from "@/components/common";
import { useCategories } from "@/components/providers";
import {
  AdminPageHeader,
  AdminSection,
  DataTable,
  EmptyRow,
  FilterBar,
  Gate,
  Modal,
  RequirePermission,
  Select,
  StatTile,
  TableSkeleton,
  Td,
  Textarea,
  Th,
  Tr,
  count,
  useMutation,
} from "@/components/admin/ui";
import { idParam, pageInfoOf } from "@/components/admin/people-shared";
import { StockIncreaseNotice, isStockIncreaseRefusal } from "@/components/admin/stock-increase";
import { ClipboardIcon, LayersIcon, RefreshIcon, SlidersIcon } from "@/components/icons";
import { adjustVariantStock, fetchInventory, STOCK_STATES } from "@/lib/admin-api";
import type { InventoryStockRow, StockStateFilter } from "@/lib/admin-api";
import { stockStateLabel } from "@/lib/labels";
import { adminAuditHref, adminInventoryHref, adminMovementsHref } from "@/lib/routes";
import { boolParam, enumParam, pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 20;

/**
 * THE GLOBAL-STOCK DISCLOSURE, KEYED BY THE SERVER'S OWN `scope` FIELD.
 *
 * The sentence is NOT hardcoded into the JSX. The list endpoint puts
 * `scope: "global"` on the wire precisely so this screen can render the
 * disclosure from the API's claim rather than from an assumption that ages
 * badly: the day stock becomes per-branch, the server stops saying `global` and
 * this screen stops promising a shared pool — instead of confidently printing a
 * sentence that has silently become false.
 *
 * An unrecognised scope is reported as unrecognised. Guessing would be the one
 * behaviour worse than saying nothing.
 */
const SCOPE_DISCLOSURE: Record<string, string> = {
  global:
    "موجودی در این سامانه بین فروشگاه اینترنتی و همهٔ شعبه‌ها مشترک است و به تفکیک شعبه نگهداری نمی‌شود.",
};

/**
 * ===========================================================================
 * INVENTORY — the stockroom
 * ===========================================================================
 *
 * ONE ROW IS ONE VARIANT, never one product: the variant is the only sellable
 * unit, so a product whose black SKU is exhausted while its white one is full is
 * neither "in stock" nor "out of stock" at product level.
 *
 * ## THE FIVE NUMBERS
 *
 * physicalStock    what is actually on the shelf
 * basketReserved   units customers' baskets are holding (four-hour reservations)
 * orderAllocated   units created-but-unpaid orders are holding
 * availableForWeb  physicalStock − basketReserved − orderAllocated
 * availableForPos  physicalStock − orderAllocated
 *
 * The gap between the last two is the whole point of keeping them apart: a till
 * sale MAY take a unit a basket is holding, and a web sale may not. A screen
 * that showed one "available" figure would be wrong for one of the two counters
 * every time. The legend above the table says all of this in Persian, because a
 * `title` attribute is invisible to a touch user and to anybody who does not
 * already suspect there is something to hover over.
 *
 * ## NO PER-BRANCH FIGURE APPEARS ANYWHERE
 *
 * There is none to show. `stock_movements.branchId` records WHERE a sale was
 * rung up and does not scope the stock, so deriving a "branch stock" column from
 * it would be an invented number.
 */
export function AdminInventory({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["inventory.read"]}>
      <InventoryBody params={params} />
    </RequirePermission>
  );
}

function InventoryBody({ params }: { params: RawSearchParams }) {
  const api = useApi();
  const router = useRouter();
  const { categories } = useCategories();

  const page = pageParam(params);
  const search = textParam(params, "search");
  const categoryId = idParam(params, "categoryId");
  const stockState = enumParam<StockStateFilter>(params, "stockState", STOCK_STATES);
  const includeInactive = boolParam(params, "includeInactive") ?? false;

  const filters = {
    page,
    limit: PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(stockState ? { stockState } : {}),
    ...(includeInactive ? { includeInactive: true } : {}),
  };

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchInventory(api, filters, { signal }),
    [api, JSON.stringify(filters)],
  );

  const [adjusting, setAdjusting] = useState<InventoryStockRow | null>(null);
  const [flash, setFlash] = useState<ReactNode | null>(null);

  /*
   * Filters live in the URL, so a filtered stockroom view is a link somebody can
   * send to a colleague. Applying one always returns to page 1: page 4 of a
   * narrower result set is usually empty, and an empty table reads as "nothing
   * matched" rather than as "you are past the end".
   */
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };
    router.push(
      adminInventoryHref({
        search: read("search")?.slice(0, 200),
        categoryId: read("categoryId"),
        stockState: read("stockState"),
        includeInactive: form.get("includeInactive") === "on" ? "true" : undefined,
      }),
    );
  }

  return (
    <>
      <AdminPageHeader
        title="موجودی"
        description="یک ردیف برای هر گونهٔ کالا — چون گونه تنها واحدی است که فروخته می‌شود. برای دیدن اینکه هر عدد از کجا آمده، دفتر گردش موجودی را ببینید."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={refetch}
              leadingIcon={<RefreshIcon className="size-4" />}
            >
              به‌روزرسانی
            </Button>
            {/*
              THE LEDGER IS ITS OWN CAPABILITY. `/admin/inventory/movements`
              gates on `inventory.movements.read`, which `inventory.read` does
              not include — offering the button to a stock viewer sends them to
              an access-denied page and back.
            */}
            <Gate permissions={["inventory.movements.read"]}>
              <Link href={adminMovementsHref()} className="no-underline">
                <Button variant="secondary" size="sm" leadingIcon={<ClipboardIcon className="size-4" />}>
                  دفتر گردش موجودی
                </Button>
              </Link>
            </Gate>
          </>
        }
      />

      {data ? <ScopeNotice scope={data.scope} /> : null}

      {flash ? (
        <Notice tone="success" className="mt-3">
          {flash}
        </Notice>
      ) : null}

      {data ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatTile
            label="گونه‌های رو به اتمام"
            value={count(data.summary.lowStockCount)}
            tone={data.summary.lowStockCount > 0 ? "warning" : "neutral"}
            hint="موجودی قابل فروش در سایت این گونه‌ها از آستانهٔ نمایشی کمتر یا برابر است. این آستانه فقط برای مرتب‌کردن توجه شماست، نه نقطهٔ سفارش مجددی که مالک فروشگاه تعیین کرده باشد؛ هیچ فروشی به خاطر آن رد نمی‌شود."
          />
          <StatTile
            label="گونه‌های ناموجود"
            value={count(data.summary.outOfStockCount)}
            tone={data.summary.outOfStockCount > 0 ? "danger" : "neutral"}
            hint="موجودی قابل فروش در سایت صفر یا کمتر است؛ یعنی رزرو سبدها و تخصیص سفارش‌ها کسر شده‌اند. ممکن است کالا روی قفسه باشد ولی همه‌اش برای مشتری دیگری کنار گذاشته شده باشد."
          />
          <StatTile
            label="گونه‌های شمرده‌شده"
            value={count(data.summary.trackedVariantCount)}
            hint="تعداد گونه‌هایی که این سه عدد روی آن‌ها حساب شده است — یعنی همان مجموعه‌ای که فیلترهای فعلی برمی‌گردانند، نه فقط این صفحه."
          />
        </div>
      ) : null}

      <div className="mt-5">
        <FilterBar onSubmit={applyFilters} onReset={() => router.push(adminInventoryHref({}))}>
          <Input
            key={search ?? ""}
            name="search"
            type="search"
            label="جست‌وجو در عنوان کالا یا کد کالا (SKU)"
            defaultValue={search ?? ""}
            maxLength={200}
            containerClassName="min-w-0"
          />
          <Select
            key={`category-${categoryId ?? ""}`}
            name="categoryId"
            label="دسته‌بندی"
            defaultValue={categoryId ? String(categoryId) : ""}
            options={[
              { value: "", label: "همهٔ دسته‌ها" },
              ...categories.map((category) => ({
                value: String(category.id),
                label: category.title,
              })),
            ]}
          />
          <Select
            key={`state-${stockState ?? ""}`}
            name="stockState"
            label="وضعیت موجودی"
            defaultValue={stockState ?? ""}
            options={[
              { value: "", label: "همه" },
              ...STOCK_STATES.map((value) => ({ value, label: stockStateLabel(value) })),
            ]}
            hint="این سه وضعیت روی «قابل فروش در سایت» سنجیده می‌شوند، نه روی موجودی قفسه."
          />
          <div className="flex min-w-0 items-start gap-2.5 self-end rounded-md border border-line bg-surface p-3">
            <input
              key={`inactive-${String(includeInactive)}`}
              id="include-inactive"
              name="includeInactive"
              type="checkbox"
              defaultChecked={includeInactive}
              className="mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]"
            />
            <label htmlFor="include-inactive" className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-sm font-bold text-ink">گونه‌های بازنشسته هم نشان داده شوند</span>
              <span className="mt-1 block text-2xs leading-relaxed text-ink-muted">
                گونهٔ بازنشسته فروخته نمی‌شود ولی ممکن است هنوز کالای واقعی روی قفسه داشته باشد.
              </span>
            </label>
          </div>
        </FilterBar>
      </div>

      <StockLegend />

      <div className="mt-4">
        {error ? (
          <ErrorState
            error={error}
            title="فهرست موجودی خوانده نشد"
            description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
            onRetry={refetch}
          />
        ) : isLoading || !data ? (
          <TableSkeleton rows={8} columns={6} />
        ) : (
          <>
            <DataTable minWidth="76rem" caption="موجودی گونه‌های کالا">
              <thead>
                <tr>
                  <Th>کالا و گونه</Th>
                  <Th numeric>قیمت مؤثر</Th>
                  <Th numeric>موجودی فیزیکی</Th>
                  <Th numeric>رزرو سبد خرید</Th>
                  <Th numeric>تخصیص سفارش</Th>
                  <Th numeric>قابل فروش در سایت</Th>
                  <Th numeric>قابل فروش در صندوق</Th>
                  <Th>وضعیت</Th>
                  <Th className="w-px">اقدام</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 ? (
                  <EmptyRow colSpan={9}>
                    هیچ گونه‌ای با این فیلترها پیدا نشد. اگر گونه‌های بازنشسته را کنار گذاشته‌اید،
                    تیک مربوط را بزنید.
                  </EmptyRow>
                ) : (
                  data.data.map((row) => (
                    <StockRow
                      key={row.variantId}
                      row={row}
                      onAdjust={() => setAdjusting(row)}
                    />
                  ))
                )}
              </tbody>
            </DataTable>

            <Pagination
              className="mt-6"
              pageInfo={pageInfoOf(data)}
              buildHref={(target) =>
                adminInventoryHref({
                  search,
                  categoryId,
                  stockState,
                  includeInactive: includeInactive ? "true" : undefined,
                  ...(target > 1 ? { page: target } : {}),
                })
              }
            />
          </>
        )}
      </div>

      <AdminSection
        className="mt-6"
        title="«چرا» کجا ثبت می‌شود"
        description="یک محدودیت شناخته‌شدهٔ ساختار داده، نه چیزی که این صفحه پنهانش کند."
      >
        <p className="text-sm leading-relaxed text-ink-muted">
          هنگام اصلاح دستی موجودی، نوشتن دلیل <b>اجباری</b> است و آن متن در دفتر رخدادهای مدیریتی
          ثبت می‌شود. اما دفتر گردش موجودی خودش ستونی برای متن آزاد ندارد: آن‌جا فقط «چه کسی، چه
          مقدار و چه زمانی» نگهداری می‌شود. پس برای خواندن دلیل‌ها باید به دفتر رخدادها بروید.
        </p>
        <p className="mt-3 flex flex-wrap gap-3 text-xs font-bold">
          <Gate permissions={["audit.read"]}>
            <Link href={adminAuditHref({ action: "stock.adjusted" })}>دیدن دلیل اصلاح‌های موجودی ←</Link>
          </Gate>
          <Gate permissions={["inventory.movements.read"]}>
            <Link href={adminMovementsHref()}>دیدن دفتر گردش موجودی ←</Link>
          </Gate>
        </p>
      </AdminSection>

      {adjusting ? (
        <AdjustDialog
          row={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={(message) => {
            setAdjusting(null);
            setFlash(message);
            refetch();
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The disclosure and the legend
// ---------------------------------------------------------------------------

function ScopeNotice({ scope }: { scope: string }) {
  const sentence = SCOPE_DISCLOSURE[scope];

  if (!sentence) {
    return (
      <Notice tone="warning" title="دامنهٔ موجودی برای این صفحه ناشناخته است">
        <p>
          سرور دامنهٔ موجودی را «<bdi dir="ltr">{scope}</bdi>» اعلام کرد که این نسخه از پنل آن را
          نمی‌شناسد. تا روشن‌شدن موضوع، دربارهٔ مشترک یا تفکیک‌شده بودن موجودی ادعایی نمی‌کنیم.
        </p>
      </Notice>
    );
  }

  return (
    <Notice tone="info" title="موجودی مشترک است" icon={<LayersIcon className="size-5" />}>
      <p>{sentence}</p>
      <p className="mt-1.5">
        به همین دلیل در هیچ‌کجای این صفحه عدد موجودی به تفکیک شعبه نشان داده نمی‌شود؛ چنین عددی در
        پایگاه داده وجود ندارد که نشان داده شود.
      </p>
    </Notice>
  );
}

/**
 * The legend, rendered as visible prose above the table.
 *
 * Deliberately not `title` attributes on the column headers: those never appear
 * on a touch device, are not announced by most screen readers, and require the
 * reader to already suspect that a number means something other than what its
 * label says. These five definitions are the single most important thing on the
 * screen — every wrong decision an operator can make here starts with confusing
 * two of them.
 */
function StockLegend() {
  const items: Array<{ term: string; definition: ReactNode }> = [
    {
      term: "موجودی فیزیکی",
      definition: "آن‌چه واقعاً روی قفسه است؛ عددی که یک شمارش انبار باید با آن بخواند.",
    },
    {
      term: "رزرو سبد خرید",
      definition:
        "واحدهایی که سبد خرید مشتریان برای چهار ساعت نگه داشته است. هنوز فروخته نشده‌اند و هنوز روی قفسه‌اند، ولی برای مشتری دیگری کنار گذاشته شده‌اند.",
    },
    {
      term: "تخصیص سفارش",
      definition:
        "واحدهایی که سفارش‌های ثبت‌شده اما پرداخت‌نشده نگه داشته‌اند. تا تعیین تکلیف آن سفارش‌ها، این واحدها قابل فروش دوباره نیستند.",
    },
    {
      term: "قابل فروش در سایت",
      definition: "موجودی فیزیکی منهای هر دو مورد بالا — یعنی آن‌چه یک مشتری اینترنتی می‌تواند بخرد.",
    },
    {
      term: "قابل فروش در صندوق",
      definition:
        "موجودی فیزیکی منهای فقط تخصیص سفارش‌ها. عمداً از عدد سایت بیشتر است: فروش حضوری می‌تواند واحدی را که در سبد کسی رزرو شده بردارد، ولی نمی‌تواند سفارش ثبت‌شده را جابه‌جا کند.",
    },
  ];

  return (
    <section
      aria-label="معنای عددهای موجودی"
      className="mt-4 rounded-lg border border-line bg-surface-muted p-4"
    >
      <h2 className="text-sm font-bold text-ink">این پنج عدد یکی نیستند</h2>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <div key={item.term} className="min-w-0">
            <dt className="text-xs font-bold text-ink">{item.term}</dt>
            <dd className="mt-0.5 text-2xs leading-relaxed text-ink-muted">{item.definition}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

/**
 * `price === null` means the variant INHERITS the product's base price.
 *
 * The test is explicitly against `null` and never against falsiness: zero is a
 * real price — a free gift line, a promotional item — and reporting it as
 * "inherited" would tell the operator the product's base price applies when it
 * does not.
 */
function StockRow({ row, onAdjust }: { row: InventoryStockRow; onAdjust: () => void }) {
  const inherits = row.price === null;

  return (
    <Tr className={row.isActive ? undefined : "bg-surface-muted/60"}>
      <Td>
        <span className="block text-sm font-bold text-ink">{row.productTitle}</span>
        <bdi dir="ltr" data-numeric="" className="mt-0.5 block text-2xs text-ink-subtle">
          {row.sku}
        </bdi>
        <span className="mt-1 flex flex-wrap gap-1">
          {!row.isActive ? (
            <Badge size="sm" tone="neutral">
              بازنشسته
            </Badge>
          ) : null}
          {row.isDefault ? (
            <Badge size="sm" tone="neutral">
              گونهٔ پیش‌فرض
            </Badge>
          ) : null}
        </span>
      </Td>
      <Td numeric>
        <Money value={row.effectivePrice} className="text-sm" />
        <span className="mt-0.5 block text-2xs text-ink-subtle">
          {inherits ? "ارث‌بری از قیمت پایهٔ کالا" : "قیمت اختصاصی این گونه"}
        </span>
      </Td>
      <Td numeric>{count(row.physicalStock)}</Td>
      <Td numeric className={row.basketReserved > 0 ? "text-warning" : undefined}>
        {count(row.basketReserved)}
      </Td>
      <Td numeric className={row.orderAllocated > 0 ? "text-warning" : undefined}>
        {count(row.orderAllocated)}
      </Td>
      <Td numeric className="font-bold">
        {count(row.availableForWeb)}
      </Td>
      <Td numeric className="font-bold">
        {count(row.availableForPos)}
      </Td>
      <Td>
        <Badge
          size="sm"
          tone={row.outOfStock ? "danger" : row.lowStock ? "warning" : "success"}
        >
          {row.outOfStock ? "ناموجود" : row.lowStock ? "رو به اتمام" : "موجود"}
        </Badge>
      </Td>
      <Td>
        <div className="flex flex-col items-end gap-1">
          <Gate permissions={["inventory.adjust"]}>
            <Button
              size="sm"
              variant="secondary"
              onClick={onAdjust}
              leadingIcon={<SlidersIcon className="size-4" />}
            >
              اصلاح موجودی
            </Button>
          </Gate>
          <Gate permissions={["inventory.movements.read"]}>
            <Link
              href={adminMovementsHref({ variantId: row.variantId })}
              className="whitespace-nowrap text-2xs"
            >
              گردش این گونه ←
            </Link>
          </Gate>
        </div>
      </Td>
    </Tr>
  );
}

// ---------------------------------------------------------------------------
// The adjustment
// ---------------------------------------------------------------------------

/** The two spellings of the SAME refusal — see `adjustVariantStock`. */
function isBelowReservedRefusal(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.code === "STOCK_BELOW_RESERVED") return true;
  /*
   * The authoritative re-check under the variant lock throws a plain 400 whose
   * body carries NO machine code — the refusal is identical, only its detection
   * is not. Matching the server's English wording is fragile and is done here
   * ONLY so the override is offered in both cases; if the wording changes the
   * operator still sees the server's own message through `FormError` below, so
   * the failure mode is a missing hint rather than a silent wrong answer.
   */
  return error.status === 400 && error.messages.some((message) => /reserved/i.test(message));
}

function isNegativeRefusal(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 400 &&
    error.messages.some((message) => /negative/i.test(message))
  );
}

/**
 * The one write on this screen.
 *
 * It shows the RESULTING balance before it is sent, because "set 12" and
 * "add 12" are the same keystrokes and a completely different outcome, and
 * because the reservation warning is only meaningful against the result.
 *
 * The override checkbox is revealed by the PREVIEW (the result would fall below
 * what customers are holding) or by a REFUSAL that has already come back. It is
 * never ticked automatically: pushing stock below the reserved quantity is a
 * statement that the units are genuinely not on the shelf, and only a human can
 * make it.
 */
function AdjustDialog({
  row,
  onClose,
  onDone,
}: {
  row: InventoryStockRow;
  onClose: () => void;
  onDone: (message: ReactNode) => void;
}) {
  const api = useApi();
  const [mode, setMode] = useState<"set" | "delta">("set");
  const [rawValue, setRawValue] = useState(String(row.physicalStock));
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);

  /*
   * Persian digits are what a Persian keyboard produces, and `Number("۱۲")` is
   * `NaN` — so an operator typing the number they see on their own keyboard
   * would be told their input is invalid. `toLatinDigits` is the design
   * system's own converter; the separators are stripped because a pasted
   * figure often carries them.
   */
  const parsed = Number(toLatinDigits(rawValue).replace(/[٬,\s]/g, ""));
  const valid = rawValue.trim() !== "" && Number.isInteger(parsed);
  const resulting = !valid ? null : mode === "set" ? parsed : row.physicalStock + parsed;

  const reserved = row.basketReserved + row.orderAllocated;
  const wouldGoNegative = resulting !== null && resulting < 0;
  const wouldGoBelowReserved = resulting !== null && resulting >= 0 && resulting < reserved;
  /*
   * AN INCREASE IS REFUSED BY THE API (409 STOCK_INCREASE_REQUIRES_RECEIPT):
   * every unit entering inventory needs a purchase cost, which only «ثبت ورود
   * کالا» / «اصلاح موجودی» on the product's costing section can carry. The
   * dialog says so before sending instead of letting the request fail.
   */
  const wouldIncrease = resulting !== null && resulting > row.physicalStock;

  const { run, isPending, error } = useMutation(() =>
    adjustVariantStock(api, row.variantId, {
      mode,
      value: parsed,
      reason: reason.trim(),
      ...(override ? { allowBelowReserved: true } : {}),
    }),
  );

  const refusedBelowReserved = isBelowReservedRefusal(error);
  const refusedNegative = isNegativeRefusal(error);
  const refusedIncrease = isStockIncreaseRefusal(error);
  /* Derived, never set from an effect: the checkbox appears the moment either
   * the preview or the server says it is needed, and stays while that is true. */
  const showOverride = wouldGoBelowReserved || refusedBelowReserved;

  const reasonTooShort = reason.trim().length < 4;
  const blocked =
    !valid || wouldGoNegative || wouldIncrease || reasonTooShort || (showOverride && !override);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (!result) return;
    const after = result.data.availability;
    onDone(
      <p>
        موجودی «{row.productTitle}» اصلاح شد: از{" "}
        <bdi data-numeric="">{count(result.data.previousStock)}</bdi> به{" "}
        <bdi data-numeric="">{count(result.data.balanceAfter)}</bdi> عدد.
        {after ? (
          <>
            {" "}
            قابل فروش در سایت اکنون <bdi data-numeric="">{count(after.availableForWeb)}</bdi> و در
            صندوق <bdi data-numeric="">{count(after.availableForPos)}</bdi> عدد است.
          </>
        ) : null}
      </p>,
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`اصلاح موجودی «${row.productTitle}»`}
      description={`کد کالا ${row.sku} — این کار موجودی واقعی قفسه را تغییر می‌دهد و در دفتر گردش موجودی ثبت می‌شود.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button form="adjust-stock" type="submit" isLoading={isPending} disabled={blocked}>
            ثبت اصلاح
          </Button>
        </>
      }
    >
      <form id="adjust-stock" onSubmit={submit} className="space-y-3">
        <dl className="grid grid-cols-2 gap-2 rounded-md bg-surface-muted p-3 text-xs sm:grid-cols-4">
          <Cell label="موجودی فیزیکی" value={count(row.physicalStock)} />
          <Cell label="رزرو سبد خرید" value={count(row.basketReserved)} />
          <Cell label="تخصیص سفارش" value={count(row.orderAllocated)} />
          <Cell label="قابل فروش در سایت" value={count(row.availableForWeb)} />
        </dl>

        <Select
          label="نوع اصلاح"
          value={mode}
          /*
           * Switching mode RESETS the value, and that is not tidiness: "59"
           * means "the shelf holds 59" in one mode and "add 59 more" in the
           * other. Carrying the number across would turn a mis-click into a
           * doubled stock figure.
           */
          onChange={(event) => {
            const next = event.target.value === "delta" ? "delta" : "set";
            setMode(next);
            setRawValue(next === "set" ? String(row.physicalStock) : "");
          }}
          options={[
            { value: "set", label: "تعیین مقدار دقیق کمتر از فعلی (نتیجهٔ شمارش انبار)" },
            { value: "delta", label: "کم کردن نسبت به موجودی فعلی" },
          ]}
          hint={
            mode === "set"
              ? "عددی که می‌نویسید، موجودی جدید قفسه می‌شود؛ فقط کمتر از موجودی فعلی پذیرفته است."
              : "عدد منفی بنویسید؛ مثلاً ۳- یعنی سه عدد کم شود. افزایش از این فرم ممکن نیست."
          }
        />

        <Input
          label={mode === "set" ? "موجودی جدید" : "مقدار تغییر (مثبت یا منفی)"}
          value={rawValue}
          onChange={(event) => setRawValue(event.target.value)}
          numeric
          /*
           * `text`, not `numeric`, while subtracting: the numeric soft keyboard
           * on iOS has no minus key at all, so a cashier reducing stock on a
           * phone would be unable to type the value the field is asking for.
           */
          inputMode={mode === "delta" ? "text" : "numeric"}
          autoComplete="off"
          {...(valid ? {} : { error: "یک عدد صحیح بنویسید." })}
        />

        <div className="rounded-md border border-line p-3">
          <p className="text-xs text-ink-muted">موجودی پس از این اصلاح</p>
          <p className="mt-1 text-lg font-extrabold text-ink" data-numeric="">
            {resulting === null ? "—" : count(resulting)}
          </p>
          {resulting !== null && !wouldGoNegative ? (
            <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">
              با فرض ثابت‌ماندن رزروها، قابل فروش در سایت{" "}
              <bdi data-numeric="">{count(Math.max(0, resulting - reserved))}</bdi> و در صندوق{" "}
              <bdi data-numeric="">{count(Math.max(0, resulting - row.orderAllocated))}</bdi> عدد
              خواهد شد.
            </p>
          ) : null}
        </div>

        {wouldIncrease || refusedIncrease ? <StockIncreaseNotice productId={row.productId} /> : null}

        {wouldGoNegative ? (
          <Notice tone="danger" title="موجودی فیزیکی نمی‌تواند منفی شود">
            <p>
              نتیجهٔ این اصلاح <bdi data-numeric="">{count(resulting ?? 0)}</bdi> می‌شود. سرور چنین
              مقداری را در هیچ حالتی نمی‌پذیرد — حتی با تیک نادیده‌گرفتن رزروها.
            </p>
          </Notice>
        ) : null}

        {showOverride ? (
          <Notice tone="warning" title="این مقدار کمتر از چیزی است که مشتری‌ها نگه داشته‌اند">
            <p>
              همین حالا <bdi data-numeric="">{count(reserved)}</bdi> عدد از این کالا نگه داشته شده
              است (<bdi data-numeric="">{count(row.basketReserved)}</bdi> در سبد خرید مشتریان و{" "}
              <bdi data-numeric="">{count(row.orderAllocated)}</bdi> روی سفارش‌های ثبت‌شده). با ثبت
              این مقدار، واحدهایی که برای مشتری کنار گذاشته شده بودند دیگر روی قفسه نیستند و آن
              مشتریان تحت تأثیر قرار می‌گیرند.
            </p>
            <p className="mt-1.5">
              سرور این کار را رد می‌کند مگر اینکه صراحتاً آن را بپذیرید. این یک راه فرار نیست:
              کسری انبار دقیقاً همان حالتی است که موجودی واقعاً باید زیر مقدار رزروشده برود.
            </p>
            <label className="mt-2 flex items-start gap-2.5 rounded-md border border-warning/40 bg-surface p-3">
              <input
                type="checkbox"
                checked={override}
                onChange={(event) => setOverride(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]"
              />
              <span className="text-sm text-ink">
                می‌پذیرم که این واحدها واقعاً موجود نیستند و موجودی زیر مقدار رزروشده ثبت شود.
              </span>
            </label>
          </Notice>
        ) : null}

        <Textarea
          label="دلیل اصلاح (اجباری)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          hint="دست‌کم ۴ نویسه. مثلاً «شمارش انبار ۱۴۰۵/۰۶/۲۰، قفسهٔ ۴ب» یا «دو عدد شکسته بود». این متن در دفتر رخدادهای مدیریتی ثبت می‌شود، نه روی دفتر گردش موجودی."
          {...(reasonTooShort && reason.length > 0 ? { error: "دلیل باید دست‌کم ۴ نویسه باشد." } : {})}
        />

        <p className="text-2xs leading-relaxed text-ink-subtle">
          دفتر گردش موجودی «چه کسی، چه مقدار و چه زمانی» را نگه می‌دارد اما ستونی برای متن دلیل
          ندارد؛ این یک محدودیت شناخته‌شدهٔ ساختار داده است. دلیل شما در دفتر رخدادها ذخیره می‌شود.
        </p>

        {refusedIncrease ? null : refusedNegative ? (
          <Notice tone="danger" title="سرور این اصلاح را رد کرد: موجودی منفی می‌شد">
            <p>هیچ تغییری ثبت نشد. عدد را اصلاح کنید و دوباره تلاش کنید.</p>
          </Notice>
        ) : refusedBelowReserved ? (
          <Notice tone="warning" title="سرور این اصلاح را رد کرد: کمتر از مقدار رزروشده بود">
            <p>
              هیچ تغییری ثبت نشد. اگر واقعاً این واحدها روی قفسه نیستند، تیک بالا را بزنید و دوباره
              ثبت کنید. ممکن است در این فاصله رزرو تازه‌ای هم اضافه شده باشد.
            </p>
          </Notice>
        ) : isApiError(error) && error.status === 403 ? (
          <Notice tone="danger" title="حساب شما اجازهٔ اصلاح موجودی را ندارد">
            <p>سرور این درخواست را رد کرد و هیچ تغییری ثبت نشد.</p>
          </Notice>
        ) : isApiError(error) && error.status === 404 ? (
          <Notice tone="warning" title="این گونه دیگر وجود ندارد">
            <p>فهرست را به‌روز کنید تا وضعیت واقعی را ببینید.</p>
          </Notice>
        ) : (
          <FormError error={error} />
        )}
      </form>
    </Modal>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-bold text-ink" data-numeric="">
        {value}
      </dd>
    </div>
  );
}
