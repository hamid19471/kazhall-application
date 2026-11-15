"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import type { ApiError, PublicProduct, PublicVariant } from "@kazhal/api-client";
import { isApiError, isMissingOrForbidden } from "@kazhal/api-client";
import { Badge, Button, Card, ErrorState, Money, Skeleton, cx, formatDateTime, formatInteger } from "@kazhal/ui";
import { useApi, useApiQuery, useRealtimeEvent, useRealtimeInterest, useRealtimeResync } from "@kazhal/ui/api/react";

import { Breadcrumbs, FormError, Notice } from "@/components/common";
import { ProductImage } from "@/components/catalog/product-image";
import { BasketIcon, CheckIcon, ClockIcon, HeartIcon, MinusIcon, PlusIcon } from "@/components/icons";
import { useAppSession, useCart } from "@/components/providers";
import { useSubmit } from "@/lib/hooks";
import { isProductSoldOut } from "@/lib/sellability";
import { categoryHref, signInHref } from "@/lib/routes";

/** How many units a customer may put in the basket in one go, absent a better bound. */
const MAX_QUANTITY = 10;

export function ProductDetail({ productId }: { productId: number }) {
  const api = useApi();

  const interest = useMemo(() => ({ kind: "product" as const, productId }), [productId]);
  useRealtimeInterest(interest);

  /*
   * `isLoading` IS DELIBERATELY NOT DESTRUCTURED.
   *
   * Nothing on this page may render from it. `refetch()` sets it again, so
   * gating anything on it re-runs the "still loading" branch on every
   * background refresh — and that is what used to unmount `ProductBody`,
   * discarding the customer's chosen variant, quantity and active image every
   * time a till sale invalidated availability. The skeleton is keyed on the
   * ABSENCE OF DATA instead (see below), so the first load shows it and a
   * refresh leaves the loaded subtree mounted.
   *
   * `aria-busy` is unaffected: it lives on `ProductDetailSkeleton`, which only
   * exists while there is no data, and never on the loaded page — a refetch
   * must not announce the whole product as busy to a screen reader.
   */
  const { data, error, refetch } = useApiQuery(
    (signal) => api.catalog.getProduct(productId, { signal }),
    [api, productId],
  );

  // Realtime is advisory. Both handlers do exactly one thing — refetch — so the
  // rendered price and availability always come from an HTTP response.
  useRealtimeResync(useCallback(() => refetch(), [refetch]));
  useRealtimeEvent(
    "availability:invalidated",
    useCallback(
      (payload) => {
        /*
         * Matched on PRODUCT first, which is both cheaper and more complete.
         *
         * Matching on variant alone (the previous rule) missed the one case
         * this page most needs: a variant CREATED or reinstated on this product
         * is not in `data.variants` yet, so its `catalogue` frame was ignored
         * and the page kept showing a stale option list. The product id is on
         * the frame now, so "is this my product?" is answerable directly.
         *
         * The variant check is kept as a fallback for a frame whose product id
         * could not be resolved server-side.
         */
        if (payload.productId === productId) {
          refetch();
          return;
        }
        if (data?.variants.some((variant) => variant.id === payload.variantId)) refetch();
      },
      [data, refetch, productId],
    ),
  );

  if (error) {
    // 403 and 404 must be indistinguishable for a lookup by id, or the id space
    // becomes enumerable. `ErrorState` already folds them; this only decides
    // whether to offer a retry, which would be pointless for "not found".
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16">
        <ErrorState
          error={error}
          {...(isMissingOrForbidden(error) ? {} : { onRetry: refetch })}
        />
        <p className="mt-6 text-center">
          <Link href="/products" className="text-sm">
            بازگشت به فهرست کالاها
          </Link>
        </p>
      </div>
    );
  }

  /*
   * THE SKELETON IS FOR THE FIRST LOAD ONLY.
   *
   * `refetch()` sets the query's `isLoading` again, so gating the skeleton on
   * it meant every `availability:invalidated` frame naming any variant of this
   * product unmounted `ProductBody` — and `ProductBody` is where the
   * customer's CHOSEN VARIANT lives (`selectedId`), along with the quantity
   * and the active image. A till sale therefore reset the page to "choose a
   * variant" instead of showing the new availability for the variant being
   * looked at, which is the one thing this page is supposed to get right.
   * That flag is no longer even read here; see the query above.
   *
   * Keyed on `data` instead: the body stays mounted across refreshes and only
   * its `product` prop changes, so the selection survives and the availability
   * updates underneath it.
   */
  if (!data) return <ProductDetailSkeleton />;

  return <ProductBody product={data} onChanged={refetch} />;
}

// ---------------------------------------------------------------------------

function ProductBody({ product, onChanged }: { product: PublicProduct; onChanged: () => void }) {
  const variants = product.variants;
  const [selectedId, setSelectedId] = useState<number | null>(
    variants.length === 1 ? (variants[0]?.id ?? null) : null,
  );
  const [activeImage, setActiveImage] = useState(0);

  const selected = variants.find((variant) => variant.id === selectedId) ?? null;

  // The attribute groups a customer picks from, derived from the variants that
  // actually exist. A product whose variants carry no attributes (the common
  // single-SKU case) produces no groups and no picker at all.
  const groups = useMemo(() => buildAttributeGroups(variants), [variants]);

  const images = product.images.length > 0 ? product.images : [];
  const shown = images[Math.min(activeImage, images.length - 1)] ?? null;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-6 md:px-6 md:py-10">
      <Breadcrumbs
        items={[
          { label: "خانه", href: "/" },
          { label: "کالاها", href: "/products" },
          ...(product.categories[0]
            ? [{ label: product.categories[0].title, href: categoryHref(product.categories[0].id) }]
            : []),
          { label: product.title },
        ]}
      />

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <Gallery
          images={images}
          activeIndex={activeImage}
          onSelect={setActiveImage}
          shownUrl={shown?.url ?? null}
          title={product.title}
        />

        <div className="min-w-0">
          {product.categories.length > 0 ? (
            <ul className="mb-3 flex flex-wrap gap-2">
              {product.categories.map((category) => (
                <li key={category.id}>
                  <Link href={categoryHref(category.id)} className="no-underline">
                    <Badge tone="accent">{category.title}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <h1 className="text-2xl text-ink">{product.title}</h1>

          <PriceBlock product={product} selected={selected} />

          {groups.length > 0 ? (
            <VariantPicker
              groups={groups}
              variants={variants}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}

          <VariantFacts product={product} variant={selected} />

          <AddToBasket
            product={product}
            selected={selected}
            requiresSelection={groups.length > 0 && selected === null}
            onAdded={onChanged}
          />

          <BookmarkButton productId={product.id} />

          {product.description ? (
            <section className="mt-8 border-t border-line pt-6">
              <h2 className="text-lg text-ink">توضیحات</h2>
              <p className="mt-3 leading-relaxed whitespace-pre-line text-ink-muted">
                {product.description}
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

/**
 * THE PRICE RULE.
 *
 * When a variant is selected and that variant carries its own `price`, that
 * price is what the customer pays and it is the ONLY figure shown. Falling back
 * to `basePrice` there — the obvious `variant.price ?? product.basePrice`
 * one-liner — is how a shop quotes 1,200,000 and charges 1,800,000.
 *
 * `variant.price === null` is a different fact: it means the variant genuinely
 * inherits the product's base price, and the fallback is then correct.
 *
 * With nothing selected we show a RANGE across the variants rather than a
 * single number, because there is no single number yet.
 */
function PriceBlock({ product, selected }: { product: PublicProduct; selected: PublicVariant | null }) {
  if (selected) {
    const effective = selected.price !== null ? selected.price : product.basePrice;
    const inheritsBase = selected.price === null;

    return (
      <div className="mt-5 rounded-lg bg-surface-muted p-4">
        {effective === null ? (
          <p className="text-base text-ink-muted">قیمت این گونه هنوز اعلام نشده است.</p>
        ) : (
          <>
            <Money value={effective} className="text-2xl font-extrabold text-ink" />
            <p className="mt-1 text-xs text-ink-subtle">
              {inheritsBase
                ? "قیمت پایهٔ این کالا برای گونهٔ انتخابی اعمال می‌شود."
                : "قیمت مخصوص گونهٔ انتخابی."}
            </p>
          </>
        )}
      </div>
    );
  }

  const prices = product.variants
    .map((variant) => (variant.price !== null ? variant.price : product.basePrice))
    .filter((value): value is number => value !== null);

  const min = prices.length > 0 ? Math.min(...prices) : product.basePrice;
  const max = prices.length > 0 ? Math.max(...prices) : product.basePrice;

  return (
    <div className="mt-5 rounded-lg bg-surface-muted p-4">
      {min === null ? (
        <p className="text-base text-ink-muted">قیمت اعلام نشده است.</p>
      ) : min === max ? (
        <Money value={min} className="text-2xl font-extrabold text-ink" />
      ) : (
        <p className="flex flex-wrap items-baseline gap-2 text-ink">
          <Money value={min} withUnit={false} className="text-2xl font-extrabold" />
          <span className="text-ink-subtle">تا</span>
          <Money value={max} className="text-2xl font-extrabold" />
        </p>
      )}
      {product.variants.length > 1 ? (
        <p className="mt-1 text-xs text-ink-subtle">قیمت نهایی پس از انتخاب گونه مشخص می‌شود.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

interface AttributeGroup {
  id: number;
  name: string;
  values: Array<{ id: number; value: string }>;
}

function buildAttributeGroups(variants: PublicVariant[]): AttributeGroup[] {
  const byAttribute = new Map<number, AttributeGroup>();

  for (const variant of variants) {
    for (const value of variant.attributeValues) {
      const attribute = value.attribute;
      if (!attribute) continue;
      let group = byAttribute.get(attribute.id);
      if (!group) {
        group = { id: attribute.id, name: attribute.name, values: [] };
        byAttribute.set(attribute.id, group);
      }
      if (!group.values.some((existing) => existing.id === value.id)) {
        group.values.push({ id: value.id, value: value.value });
      }
    }
  }

  return [...byAttribute.values()];
}

/**
 * The picker.
 *
 * Selection is per ATTRIBUTE VALUE and a variant is matched only when every
 * group has a choice, so a two-axis product (size × colour) cannot be added to
 * the basket half-chosen. Combinations that no variant offers are disabled
 * rather than hidden — a customer needs to see that the shop stocks the colour,
 * just not in their size.
 */
function VariantPicker({
  groups,
  variants,
  selectedId,
  onSelect,
}: {
  groups: AttributeGroup[];
  variants: PublicVariant[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [choices, setChoices] = useState<Record<number, number>>(() => {
    const selected = variants.find((variant) => variant.id === selectedId);
    if (!selected) return {};
    const initial: Record<number, number> = {};
    for (const value of selected.attributeValues) {
      if (value.attribute) initial[value.attribute.id] = value.id;
    }
    return initial;
  });

  function choose(attributeId: number, valueId: number) {
    const next = { ...choices, [attributeId]: valueId };
    setChoices(next);
    const complete = groups.every((group) => next[group.id] !== undefined);
    if (!complete) {
      onSelect(null);
      return;
    }
    const match = variants.find((variant) =>
      groups.every((group) =>
        variant.attributeValues.some(
          (value) => value.attribute?.id === group.id && value.id === next[group.id],
        ),
      ),
    );
    onSelect(match?.id ?? null);
  }

  /** Is there any variant offering this value, given the other choices? */
  function isAvailable(group: AttributeGroup, valueId: number): boolean {
    return variants.some((variant) => {
      const matchesThis = variant.attributeValues.some(
        (value) => value.attribute?.id === group.id && value.id === valueId,
      );
      if (!matchesThis) return false;
      return groups.every((other) => {
        if (other.id === group.id) return true;
        const chosen = choices[other.id];
        if (chosen === undefined) return true;
        return variant.attributeValues.some(
          (value) => value.attribute?.id === other.id && value.id === chosen,
        );
      });
    });
  }

  return (
    <div className="mt-6 space-y-5">
      {groups.map((group) => (
        <fieldset key={group.id}>
          <legend className="mb-2 text-sm font-bold text-ink">{group.name}</legend>
          <ul className="flex flex-wrap gap-2">
            {group.values.map((value) => {
              const active = choices[group.id] === value.id;
              const available = isAvailable(group, value.id);
              return (
                <li key={value.id}>
                  <button
                    type="button"
                    disabled={!available}
                    onClick={() => choose(group.id, value.id)}
                    aria-pressed={active}
                    className={cx(
                      "min-w-14 rounded-md border px-3 py-2 text-sm font-medium transition-colors duration-150 ease-kz",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                      "disabled:cursor-not-allowed disabled:opacity-45 disabled:line-through",
                      active
                        ? "border-primary bg-primary-soft text-primary"
                        : "border-line-strong bg-surface text-ink hover:border-ink-subtle",
                    )}
                  >
                    {value.value}
                    {!available ? <span className="kz-sr-only"> — در دسترس نیست</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}

/**
 * The facts about the product and the chosen variant.
 *
 * THREE CODES, THREE LABELS. They are different identifiers and a customer
 * quoting the wrong one at support wastes everybody's time:
 *
 *   «کد محصول»      `product.productCode` — the shop's id for the FAMILY,
 *                   the same on every colour and size. Shown even before a
 *                   variant is chosen, because it identifies the page.
 *   «کد گونه»       `variant.variantCode` — the shop's id for THIS exact
 *                   variant. Always begins with the product code.
 *   «کد کالا (SKU)» `variant.sku` — the WAREHOUSE's (often a vendor's)
 *                   string, which follows no rule of ours. The «(SKU)» is
 *                   what keeps it from reading as a synonym of the other two.
 *
 * `availability.indicative` is `true` on every response — the server is saying
 * "advisory, not a promise" — so the number is never rendered. The customer is
 * told "موجود" or "ناموجود" and, when the server sends one, the instant that
 * answer was computed. Anything more precise would be a claim the API has
 * explicitly refused to make.
 */
function VariantFacts({
  product,
  variant,
}: {
  product: PublicProduct;
  variant: PublicVariant | null;
}) {
  const availability = variant?.availability;

  return (
    <dl className="mt-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div className="flex gap-2">
        <dt className="text-ink-subtle">کد محصول</dt>
        <dd className="font-medium text-ink">
          <bdi dir="ltr" data-numeric="">
            {product.productCode}
          </bdi>
        </dd>
      </div>
      {variant ? (
        <>
          <div className="flex gap-2">
            <dt className="text-ink-subtle">کد گونه</dt>
            <dd className="font-medium text-ink">
              <bdi dir="ltr" data-numeric="">
                {variant.variantCode}
              </bdi>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-subtle">کد کالا (SKU)</dt>
            <dd className="font-medium text-ink">
              <bdi dir="ltr" data-numeric="">
                {variant.sku}
              </bdi>
            </dd>
          </div>
        </>
      ) : null}
      {availability ? (
        <div className="flex gap-2">
          <dt className="text-ink-subtle">وضعیت</dt>
          <dd>
            {availability.inStock ? (
              <Badge tone="success">موجود</Badge>
            ) : (
              <Badge tone="neutral">ناموجود</Badge>
            )}
          </dd>
        </div>
      ) : null}
      {availability?.asOf ? (
        <div className="flex gap-2 sm:col-span-2">
          <dt className="text-ink-subtle">آخرین بررسی موجودی</dt>
          <dd className="text-ink-muted">{formatDateTime(availability.asOf)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Add to basket
// ---------------------------------------------------------------------------

function AddToBasket({
  product,
  selected,
  requiresSelection,
  onAdded,
}: {
  product: PublicProduct;
  selected: PublicVariant | null;
  requiresSelection: boolean;
  onAdded: () => void;
}) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const { session } = useAppSession();
  const { mutate } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [added, setAdded] = useState(false);

  /*
   * "NO SELLABLE SKU AT ALL" IS SOLD OUT, not "nothing selected yet".
   *
   * The public projection omits retired variants entirely, so a product whose
   * every variant has been deactivated arrives here with `variants: []` — and
   * with none to select, `selected` is null. Reading sold-out from the
   * selection alone therefore answered `false` for exactly the product that is
   * least buyable, and the page offered an enabled "افزودن به سبد" whose only
   * possible outcome was a refusal from `POST /cart` after the customer had
   * already committed to the click.
   *
   * This matters most right after a void or a return: those put physical units
   * back, so a retired variant can hold stock again — visible to inventory
   * management, sellable nowhere. See docs/ARCHITECTURE.md §7.
   */
  const soldOut = isProductSoldOut({
    sellableVariantCount: product.variants.length,
    selectedInStock: selected?.availability?.inStock ?? null,
  });

  // The server's advisory ceiling, used ONLY to bound the stepper. It is not
  // displayed as a count, and the server re-checks it under a lock anyway.
  const advisoryMax = selected?.availability?.availableForBasket;
  const max = Math.max(
    1,
    Math.min(MAX_QUANTITY, advisoryMax !== undefined && advisoryMax > 0 ? advisoryMax : MAX_QUANTITY),
  );

  /*
   * The whole mutation runs inside `mutate`, which brackets it on the cart's
   * authoritative channel. That bracket — not the old explicit `refresh()` —
   * is what issues the follow-up `GET /cart`, and it does so on the failure
   * path too: a refusal usually means the server already knows something about
   * this variant that the page does not. Because the read is issued AFTER the
   * mutation settles, it cannot be overtaken by a `GET /cart` that a POS
   * `availability:updated` kicked off while the POST was still in flight.
   */
  const { run, isPending } = useSubmit(() =>
    mutate(async () => {
      setError(undefined);
      setAdded(false);
      try {
        await api.cart.add({
          productId: product.id,
          ...(selected ? { variantId: selected.id } : {}),
          quantity,
        });
        setAdded(true);
        onAdded();
      } catch (cause) {
        if (isApiError(cause) && cause.status === 401) {
          router.push(signInHref(pathname));
          return;
        }
        setError(isApiError(cause) ? cause : undefined);
      }
    }),
  );

  return (
    <div className="mt-6 border-t border-line pt-6">
      {!session ? (
        <Notice tone="info" className="mb-4">
          برای افزودن به سبد و رزرو موجودی، ابتدا با شمارهٔ موبایل خود وارد شوید.
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-md border border-line-strong bg-surface">
          <button
            type="button"
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            disabled={quantity <= 1}
            aria-label="کاهش تعداد"
            className="grid size-11 place-items-center text-ink-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
          >
            <MinusIcon className="size-4" />
          </button>
          <span
            className="w-10 text-center text-base font-bold text-ink"
            data-numeric=""
            aria-live="polite"
            aria-label={`تعداد: ${formatInteger(quantity)}`}
          >
            {formatInteger(quantity)}
          </span>
          <button
            type="button"
            onClick={() => setQuantity((value) => Math.min(max, value + 1))}
            disabled={quantity >= max}
            aria-label="افزایش تعداد"
            className="grid size-11 place-items-center text-ink-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
          >
            <PlusIcon className="size-4" />
          </button>
        </div>

        <Button
          size="lg"
          className="flex-1"
          isLoading={isPending}
          disabled={requiresSelection || soldOut}
          leadingIcon={<BasketIcon className="size-5" />}
          onClick={() => void run()}
        >
          {soldOut ? "ناموجود" : requiresSelection ? "ابتدا گونه را انتخاب کنید" : "افزودن به سبد"}
        </Button>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-subtle">
        <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
        با افزودن به سبد، موجودی این کالا تا چهار ساعت برای شما نگه داشته می‌شود.
      </p>

      {added ? (
        <Notice tone="success" icon={<CheckIcon className="size-5" />} className="mt-4">
          <span className="flex flex-wrap items-center gap-2">
            به سبد اضافه شد.
            <Link href="/cart" className="font-semibold">
              رفتن به سبد خرید
            </Link>
          </span>
        </Notice>
      ) : null}

      <FormError error={error} className="mt-4" />
    </div>
  );
}

/**
 * The bookmark toggle.
 *
 * `POST /products/bookmark` TOGGLES and answers with the resulting state, but
 * the public product view carries no "is this bookmarked by me" field — so on
 * first render this button genuinely does not know. It says "افزودن به
 * علاقه‌مندی‌ها" and only claims a state after the server has told it one.
 * Guessing "not bookmarked" and rendering a filled heart after one click would
 * be a lie half the time.
 */
function BookmarkButton({ productId }: { productId: number }) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const { session } = useAppSession();
  const [state, setState] = useState<boolean | null>(null);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const { run, isPending } = useSubmit(async () => {
    setError(undefined);
    try {
      const result = await api.catalog.toggleBookmark(productId);
      setState(result.data.bookmarked);
    } catch (cause) {
      if (isApiError(cause) && cause.status === 401) {
        router.push(signInHref(pathname));
        return;
      }
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  if (!session) return null;

  return (
    <div className="mt-4">
      <Button
        variant="ghost"
        size="sm"
        isLoading={isPending}
        onClick={() => void run()}
        leadingIcon={<HeartIcon filled={state === true} className="size-4" />}
      >
        {state === null
          ? "افزودن به علاقه‌مندی‌ها"
          : state
            ? "در علاقه‌مندی‌های شماست"
            : "از علاقه‌مندی‌ها حذف شد"}
      </Button>
      <FormError error={error} className="mt-3" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

function Gallery({
  images,
  activeIndex,
  onSelect,
  shownUrl,
  title,
}: {
  images: Array<{ id: number; url: string }>;
  activeIndex: number;
  onSelect: (index: number) => void;
  shownUrl: string | null;
  title: string;
}) {
  return (
    <div>
      <Card padding="none" tone="outlined" className="overflow-hidden">
        <ProductImage
          url={shownUrl}
          alt={title}
          priority
          sizes="(min-width: 1024px) 36rem, 100vw"
          className="aspect-square w-full"
        />
      </Card>

      {images.length > 1 ? (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {images.map((image, index) => (
            <li key={image.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={index === activeIndex}
                aria-label={`تصویر ${formatInteger(index + 1)} از ${formatInteger(images.length)}`}
                className={cx(
                  "block size-18 overflow-hidden rounded-md border-2 transition-colors duration-150 ease-kz",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                  index === activeIndex ? "border-primary" : "border-line hover:border-line-strong",
                )}
              >
                <ProductImage url={image.url} alt="" className="size-full" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProductDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-6 md:px-6 md:py-10" role="status" aria-busy="true">
      <span className="kz-sr-only">در حال بارگذاری کالا</span>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <Skeleton shape="block" className="aspect-square w-full" />
        <div className="space-y-4">
          <Skeleton width="35%" height="1rem" />
          <Skeleton width="80%" height="2rem" />
          <Skeleton width="45%" height="2.5rem" />
          <Skeleton width="100%" height="3rem" />
          <Skeleton width="100%" height="3rem" />
        </div>
      </div>
    </div>
  );
}
