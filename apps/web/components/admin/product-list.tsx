"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent, ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Money,
  Skeleton,
  formatInteger,
} from "@kazhal/ui";
import type { BadgeTone } from "@kazhal/ui";
import type { ProductVisibility } from "@kazhal/api-client";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, PageHeading, Pagination } from "@/components/common";
import { BRANCH_MODE_LABEL } from "@/components/admin/product-visibility-section";
import { useCategories } from "@/components/providers";
import {
  AccessDenied,
  FilterBar,
  Gate,
  RequirePermission,
  Select,
  count,
  forbiddenPermissions,
} from "@/components/admin/ui";
import { pageInfoOf } from "@/components/admin/people-shared";
import { ProductImage } from "@/components/catalog/product-image";
import { BoxIcon, PlusIcon } from "@/components/icons";
import { fetchAdminProducts, STOCK_STATES } from "@/lib/admin-api";
import type { AdminProductRow } from "@/lib/admin-api";
import { stockStateLabel } from "@/lib/labels";
import { adminInventoryHref, adminProductHref, adminProductsHref } from "@/lib/routes";

const PAGE_SIZE = 20;

/**
 * The admin catalogue list.
 *
 * It reads `GET /products/admin`, NOT the public `GET /products` the storefront
 * uses. The public row answers "may a customer buy this, and for how much"; this
 * one answers "is this product in a state I need to do something about", which
 * needs the counts a storefront must never see — inactive variants and physical
 * stock — and the four availability booleans the surface indicator is built from.
 *
 * ## WHERE THE EXTRA FILTERS COME FROM
 *
 * The route's `page.tsx` passes `page` and `search` as props and nothing else, so
 * the three filters added here are read from the URL with `useSearchParams`. The
 * route is dynamic already (it awaits `searchParams` on the server), so this adds
 * no rendering deopt — and the URL stays the single owner of every filter, which
 * is what keeps a filtered catalogue view shareable and restorable by a refresh.
 *
 * ## THERE IS NO PRODUCT-LEVEL "ACTIVE" SWITCH IN THIS SCHEMA
 *
 * `products` has no active flag. A product is unavailable exactly when every one
 * of its variants is inactive, which is why the `sellable` filter is described
 * in terms of variants and why this screen offers no product on/off toggle: a
 * toggle would have to deactivate every variant one at a time and would claim an
 * atomicity the API does not provide.
 */
export function AdminProductList({ page, search }: { page: number; search?: string }) {
  return (
    <RequirePermission permissions={["products.read"]}>
      <ProductListBody page={page} search={search} />
    </RequirePermission>
  );
}

function ProductListBody({ page, search }: { page: number; search?: string }) {
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { categories } = useCategories();

  const categoryId = positiveInt(searchParams.get("categoryId"));
  const sellable = triState(searchParams.get("sellable"));
  const stockState = oneOf(searchParams.get("stockState"), STOCK_STATES);

  const filters = {
    page,
    limit: PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(sellable === undefined ? {} : { sellable }),
    ...(stockState ? { stockState } : {}),
  };

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchAdminProducts(api, filters, { signal }),
    [api, JSON.stringify(filters)],
  );

  const forbidden = forbiddenPermissions(error);

  /** The filters as the URL spells them, for the paging links. */
  const urlFilters = {
    search,
    categoryId,
    sellable: sellable === undefined ? undefined : String(sellable),
    stockState,
  };

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };
    router.push(
      adminProductsHref({
        search: read("search")?.slice(0, 200),
        categoryId: read("categoryId"),
        sellable: read("sellable"),
        stockState: read("stockState"),
      }),
    );
  }

  return (
    <>
      <PageHeading
        title="کالاها"
        description="ساخت و ویرایش کالا، گونه‌ها و قیمت. نشانگر «کجا دیده می‌شود» می‌گوید مشتری همین حالا می‌تواند این کالا را از کدام مسیر بخرد."
        action={
          <Gate permissions={["products.create"]}>
            <Link href="/admin/products/new" className="no-underline">
              <Button leadingIcon={<PlusIcon className="size-4" />}>کالای تازه</Button>
            </Link>
          </Gate>
        }
      />

      <Notice tone="info" className="mt-4" title="«قابل عرضه» با «قابل خرید» یکی نیست">
        <p>
          یک کالا وقتی روی سایت یا صندوق <b>قابل عرضه</b> است که دست‌کم یک گونهٔ فعال داشته باشد.
          اینکه مشتری واقعاً بتواند بخرد، به موجودی قابل فروش هم بستگی دارد — و موجودی قابل فروش
          سایت و صندوق یکی نیست، چون فروش حضوری می‌تواند واحدی را که در سبد خرید کسی رزرو شده
          بردارد و فروش اینترنتی نمی‌تواند.
        </p>
        <p className="mt-1.5">
          در این سامانه هیچ کلید «فعال/غیرفعال» در سطح کالا وجود ندارد: کالا دقیقاً وقتی از دسترس
          خارج است که <b>همهٔ</b> گونه‌هایش غیرفعال باشند. برای همین این صفحه چنین کلیدی ارائه
          نمی‌کند.
        </p>
      </Notice>

      <div className="mt-5">
        <FilterBar onSubmit={applyFilters} onReset={() => router.push(adminProductsHref({}))}>
          <Input
            key={search ?? ""}
            name="search"
            type="search"
            label="جست‌وجو در عنوان کالا یا کد کالا (SKU)"
            defaultValue={search ?? ""}
            maxLength={200}
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
            key={`sellable-${sellable === undefined ? "" : String(sellable)}`}
            name="sellable"
            label="وضعیت عرضه"
            defaultValue={sellable === undefined ? "" : String(sellable)}
            options={[
              { value: "", label: "همه" },
              { value: "true", label: "قابل عرضه (دست‌کم یک گونهٔ فعال)" },
              { value: "false", label: "غیرقابل عرضه (همهٔ گونه‌ها غیرفعال)" },
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
            hint="بر اساس مجموع موجودی گونه‌های فعال. آستانهٔ «رو به اتمام» یک معیار نمایشی است."
          />
        </FilterBar>
      </div>

      <div className="mt-4">
        {/*
          A 403 IS NOT A NETWORK FAILURE. The page gate above catches the
          ordinary case before anything is fetched, but a role changed while
          this screen was open still produces a refusal at runtime — and
          reporting that as «ارتباط با سرور برقرار نشد» beside a retry button
          sends the operator round a loop that can never succeed.
        */}
        {error ? (
          forbidden ? (
            <AccessDenied
              permissions={forbidden.length > 0 ? forbidden : ["products.read"]}
              title="اختیار دیدن فهرست کالاها را ندارید"
              description="سرور این درخواست را رد کرد. تلاش دوباره نتیجه‌ای ندارد؛ از مدیر ارشد بخواهید اختیار زیر را به نقش شما اضافه کند."
            />
          ) : (
            <ErrorState
              error={error}
              title="فهرست کالاها خوانده نشد"
              description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
              onRetry={refetch}
            />
          )
        ) : isLoading || !data ? (
          <div role="status" aria-busy="true" className="space-y-2">
            <span className="kz-sr-only">در حال بارگذاری کالاها</span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} shape="block" height="5.5rem" />
            ))}
          </div>
        ) : data.data.length === 0 ? (
          <EmptyState
            icon={<BoxIcon className="size-8" />}
            title={
              search || categoryId || sellable !== undefined || stockState
                ? "کالایی با این فیلترها پیدا نشد"
                : "هنوز کالایی ثبت نشده است"
            }
            description={
              search || categoryId || sellable !== undefined || stockState
                ? "فیلترها را بازتر کنید یا عبارت دیگری را امتحان کنید."
                : "اولین کالا را بسازید تا در فروشگاه دیده شود."
            }
            action={
              <Gate permissions={["products.create"]}>
                <Link href="/admin/products/new" className="no-underline">
                  <Button>ساخت کالا</Button>
                </Link>
              </Gate>
            }
          />
        ) : (
          <>
            <ul className="space-y-2">
              {data.data.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}
            </ul>

            <Pagination
              className="mt-8"
              pageInfo={pageInfoOf(data)}
              buildHref={(target) =>
                adminProductsHref({
                  ...urlFilters,
                  ...(target > 1 ? { page: target } : {}),
                })
              }
            />
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// One product
// ---------------------------------------------------------------------------

function ProductRow({ product }: { product: AdminProductRow }) {
  const surface = surfaceOf(product);
  const retired = product.variantCount - product.activeVariantCount;

  return (
    <Card as="li" tone="outlined" padding="sm" interactive className="relative">
      <div className="flex flex-wrap items-center gap-3">
        <ProductImage
          url={product.primaryImage?.url}
          alt=""
          className="size-14 shrink-0 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-ink">
            <Link
              href={adminProductHref(product.id)}
              className="text-ink no-underline before:absolute before:inset-0 before:content-['']"
            >
              {product.title}
            </Link>
          </p>
          <p className="mt-0.5 truncate text-2xs text-ink-subtle">
            {product.productCode ? (
              <>
                کد <bdi dir="ltr" data-numeric="">{product.productCode}</bdi>
                {" · "}
              </>
            ) : null}
            شناسه <bdi data-numeric="">{formatInteger(product.id)}</bdi>
            {product.categories.length > 0
              ? ` · ${product.categories.map((category) => category.title).join("، ")}`
              : " · بدون دسته‌بندی"}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
            <span>
              <bdi data-numeric="">{count(product.activeVariantCount)}</bdi> گونهٔ فعال از{" "}
              <bdi data-numeric="">{count(product.variantCount)}</bdi>
              {retired > 0 ? ` (${count(retired)} بازنشسته)` : ""}
            </span>
            <span>
              موجودی گونه‌های فعال: <bdi data-numeric="">{count(product.totalStock)}</bdi>
            </span>
          </p>
          {product.visibility ? <OfferedOn visibility={product.visibility} /> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <PriceRange product={product} />
          <SurfaceBadge surface={surface} />
          <Gate permissions={["inventory.read"]}>
            <Link
              href={adminInventoryHref({ search: product.title })}
              className="relative z-10 text-2xs"
            >
              موجودی گونه‌ها ←
            </Link>
          </Gate>
        </div>
      </div>
    </Card>
  );
}

/**
 * One price, or a range.
 *
 * `maxEffectivePrice === effectivePrice` means every active variant costs the
 * same, and printing "از … تا …" there would invent a range the shop does not
 * offer. `variantCount > 1` is NOT that signal: two variants at one price are
 * one price.
 */
function PriceRange({ product }: { product: AdminProductRow }) {
  if (product.effectivePrice === null) {
    return (
      <span className="text-2xs text-ink-subtle">
        {product.activeVariantCount === 0 ? "بدون گونهٔ فعال" : "بدون قیمت"}
      </span>
    );
  }

  const single =
    product.maxEffectivePrice === null || product.maxEffectivePrice === product.effectivePrice;

  if (single) return <Money value={product.effectivePrice} className="text-sm font-bold" />;

  return (
    <span className="flex items-center gap-1 text-sm font-bold">
      <Money value={product.effectivePrice} withUnit={false} />
      <span aria-hidden="true" className="text-ink-subtle">
        —
      </span>
      <Money value={product.maxEffectivePrice} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// WHERE WILL IT APPEAR
// ---------------------------------------------------------------------------

type Surface = "both" | "web" | "pos" | "none";

/**
 * The one derived fact this screen exists to show.
 *
 * OFFERABLE (`sellableOn*`) and BUYABLE (`has*AvailableStock`) are different
 * questions and the API answers both, so this combines them rather than picking
 * one: a product with an active variant and no free stock is listed and cannot
 * be bought, which is a different problem from a product with no active variant
 * at all — and only the first is fixed by a stock adjustment.
 *
 * `sellableOnWeb` and `sellableOnPos` are always equal (there is no per-surface
 * activation flag in the schema), so in practice the two surfaces differ only by
 * their availability — a basket reservation blocks a web sale and does not block
 * a till sale. The badge's hint says exactly that instead of implying the shop
 * chose to offer the product on one counter and not the other.
 */
function surfaceOf(product: AdminProductRow): Surface {
  const web = product.sellableOnWeb && product.hasWebAvailableStock;
  const pos = product.sellableOnPos && product.hasPosAvailableStock;
  if (web && pos) return "both";
  if (web) return "web";
  if (pos) return "pos";
  return "none";
}

const SURFACE_COPY: Record<Surface, { label: string; tone: BadgeTone; hint: ReactNode }> = {
  both: {
    label: "هر دو",
    tone: "success",
    hint: "هم در سایت و هم در صندوق قابل خرید است.",
  },
  web: {
    label: "سایت",
    tone: "info",
    hint: "در سایت قابل خرید است، ولی در صندوق موجودی آزاد ندارد.",
  },
  pos: {
    label: "صندوق",
    tone: "warning",
    hint: "فقط در فروش حضوری قابل خرید است — معمولاً چون موجودی باقی‌مانده در سبد خرید مشتری‌ها رزرو شده و فروش حضوری می‌تواند آن را بردارد.",
  },
  none: {
    label: "هیچ‌کدام",
    tone: "danger",
    hint: "نه در سایت و نه در صندوق قابل خرید نیست: یا هیچ گونهٔ فعالی ندارد، یا موجودی آزادی برایش نمانده است.",
  },
};

/**
 * «محل عرضه» in one line — the CHOICE, beside the derived availability.
 *
 * `SurfaceBadge` above answers "can a customer buy this right now", which is
 * computed from active variants and free stock. This answers a different and
 * entirely deliberate question: where the shop has DECIDED to offer the
 * product. The two disagree often and usefully — a product configured for the
 * website with no free stock is listed and unbuyable, and only one of those is
 * fixed by a stock adjustment.
 *
 * ⚠ It says nothing about inventory. Branch selection never splits stock; every
 * listed branch sells from the same global quantity.
 */
function OfferedOn({ visibility }: { visibility: ProductVisibility }) {
  if (visibility.hiddenDraft) {
    return (
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-subtle">
        <span>محل عرضه:</span>
        <Badge size="sm" tone="neutral">
          پیش‌نویس
        </Badge>
        <span>نه در سایت، نه در هیچ شعبه‌ای.</span>
      </p>
    );
  }

  const names = visibility.branches.map((branch) => branch.name);

  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-subtle">
      <span>محل عرضه:</span>
      <Badge size="sm" tone={visibility.visibleOnSite ? "info" : "neutral"}>
        سایت: {visibility.visibleOnSite ? "بله" : "خیر"}
      </Badge>
      <Badge size="sm" tone={visibility.branchVisibility === "none" ? "neutral" : "success"}>
        شعب: {BRANCH_MODE_LABEL[visibility.branchVisibility]}
      </Badge>
      {visibility.branchVisibility === "selected" ? (
        <span className="min-w-0 truncate">
          {names.length > 0 ? names.join("، ") : "بدون شعبهٔ انتخاب‌شده"}
        </span>
      ) : null}
    </p>
  );
}

function SurfaceBadge({ surface }: { surface: Surface }) {
  const copy = SURFACE_COPY[surface];
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className="text-2xs text-ink-subtle">کجا دیده می‌شود:</span>
        <Badge size="sm" tone={copy.tone}>
          {copy.label}
        </Badge>
      </span>
      <span className="max-w-[22ch] text-end text-2xs leading-relaxed text-ink-subtle">
        {copy.hint}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// URL readers
//
// `lib/search-params.ts` parses the SERVER's `RawSearchParams`; these read the
// same values out of the client-side `URLSearchParams` the route hands this
// component, with the same rules — an out-of-range or unknown value is dropped
// rather than forwarded to an API that would answer 400.
// ---------------------------------------------------------------------------

function positiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** Tri-state: `true`, `false`, or absent — absent means "both". */
function triState(raw: string | null): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | undefined {
  if (raw === null) return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}
