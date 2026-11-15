"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { FormEvent } from "react";

import type {
  AdminProduct,
  AdminVariant,
  ApiError,
  ImageView,
  ProductAttribute,
  UpdateProductBody,
} from "@kazhal/api-client";
import { isApiError, isMissingOrForbidden } from "@kazhal/api-client";
import { Badge, Button, Card, ErrorState, Input, Money, Skeleton, cx, formatInteger, parseRial } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Breadcrumbs, FormError, Notice, PageHeading } from "@/components/common";
import {
  AttributeValuePicker,
  CategoryPicker,
  CodeField,
  Field,
  ImageManager,
  ReadOnlyField,
  routeProductError,
  useAttributes,
} from "@/components/admin/product-shared";
import type { CodeGenerateResult } from "@/components/admin/product-shared";
import {
  HIDDEN_DRAFT_VISIBILITY,
  ProductVisibilitySection,
  visibilityProblem,
  visibilityValueOf,
} from "@/components/admin/product-visibility-section";
import type { ProductVisibilityValue } from "@/components/admin/product-visibility-section";
import { Gate, RequirePermission } from "@/components/admin/ui";
import { useAppSession } from "@/components/providers";
import { can, isSuperAdmin } from "@/lib/permissions";
import { PlusIcon, TrashIcon } from "@/components/icons";
import { useSubmit } from "@/lib/hooks";
import { adminInventoryHref, adminProductHref } from "@/lib/routes";
import type {
  CostedCreateProductBody,
  CostedCreateVariantBody,
  CostedUpsertVariantBody,
} from "@/lib/admin-api";
import { amountProblem, parseQuantityInput, parseRialInput } from "@/lib/costing";
import {
  OPENING_STOCK_NEEDS_MAIN_ADMIN,
  PURCHASE_COST_MISSING,
  PURCHASE_COST_OPTIONAL_HINT,
  PURCHASE_COST_REQUIRED_HINT,
  PURCHASE_COST_SENSITIVE_HINT,
  UnitProfitPreview,
} from "@/components/admin/cost-preview";
import { ProductCostingSection } from "@/components/admin/product-costing";
import { StockIncreaseNotice, isStockIncreaseRefusal } from "@/components/admin/stock-increase";

const TEXTAREA_CLASS =
  "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-ink " +
  "placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 " +
  "focus-visible:outline-[color:var(--kz-focus)]";

const PRODUCT_CODE_HINT =
  "شناسهٔ تجاری خود فروشگاه برای این کالا. در پنل و در صندوق جست‌وجو می‌شود و روی سفارش‌های گذشته عکس‌برداری شده، پس تغییر آن سابقه را خراب نمی‌کند.";
const VARIANT_CODE_HINT = "باید با کد محصول و یک خط تیره شروع شود؛ دکمهٔ کنارش همین کار را می‌کند.";
const PRODUCT_CODE_REQUIRED = "کد محصول لازم است. آن را وارد کنید یا دکمهٔ «تولید خودکار کد» را بزنید.";
const VARIANT_CODE_NEEDS_PARENT =
  "ابتدا کد محصول را وارد یا تولید کنید، سپس کد گونه را بسازید.";
/** The widths `products."productCode"` and `product_variants."variantCode"` have. */
const PRODUCT_CODE_MAX = 32;
const VARIANT_CODE_MAX = 64;

// ---------------------------------------------------------------------------
// What KIND of product is being created
// ---------------------------------------------------------------------------

/**
 * ASKED, NEVER INFERRED.
 *
 * The form used to decide this by looking at whether any variant row had been
 * typed into: fill one in and you got a product with variants, leave them all
 * blank and you got a simple one. That rule was invisible, and it was wrong in
 * both directions — an operator who opened a variant row to see what was in it
 * and then abandoned it shipped a product with one half-meant variant, while an
 * operator who meant to add variants later got a silent default variant they
 * never saw and could not find.
 *
 * It also cannot express the new contract at all. `initialStock` belongs to a
 * SIMPLE product and is refused alongside `variants` (400
 * `INITIAL_STOCK_WITH_VARIANTS`), so the payload has to commit to one shape
 * before it is built — and the only honest source for that commitment is a
 * question the operator answered on purpose.
 */
type ProductKind = "simple" | "variants";

const PRODUCT_KINDS: readonly ProductKind[] = ["simple", "variants"];

const PRODUCT_KIND_LABEL: Record<ProductKind, string> = {
  simple: "محصول ساده",
  variants: "محصول دارای گونه",
};

const PRODUCT_KIND_HINT: Record<ProductKind, string> = {
  simple: "یک قیمت و یک موجودی؛ مشتری هنگام خرید چیزی برای انتخاب ندارد.",
  variants:
    "کالایی که در رنگ، اندازه یا هر ویژگی دیگری عرضه می‌شود. هر گونه کد کالا (SKU)، قیمت و موجودی خودش را دارد.",
};

/** `initialStock`'s upper bound in `CreateProductDto`. The server decides. */
const MAX_INITIAL_STOCK = 1073741823;

const INITIAL_STOCK_LABEL = "موجودی اولیه";

/**
 * THE SENTENCE THE API EXPORTS UNDER `GLOBAL_QUANTITY_NOTICE`, word for word.
 *
 * Stock in this system is one global number per variant: the website and every
 * eligible branch draw down the same units, and branch visibility says where a
 * product may be sold rather than how many each place holds. An operator who
 * types 10 here while three branches are ticked has stocked ten units in total,
 * not thirty — which is the single most expensive thing to learn afterwards, so
 * it is said next to the box rather than in a manual.
 */
const GLOBAL_STOCK_SENTENCE =
  "این موجودی بین سایت و تمام شعب مجاز مشترک است و برای هر شعبه جداگانه محاسبه نمی‌شود.";

/**
 * Client-side refusals for the opening quantity.
 *
 * COURTESY ONLY. `CreateProductDto` validates the same three things and its
 * answer is the one that decides anything; these exist so a typo is answered in
 * the same second it is made rather than after a round trip that also discards
 * nothing else. Each says what to type instead, because "invalid" is not an
 * instruction.
 */
const INITIAL_STOCK_NOT_INTEGER =
  "موجودی اولیه باید عدد صحیح باشد؛ اعشار و حرف پذیرفته نمی‌شود.";
const INITIAL_STOCK_NEGATIVE =
  "موجودی اولیه نمی‌تواند منفی باشد. اگر کالا هنوز به انبار نرسیده، ۰ بگذارید.";
const INITIAL_STOCK_TOO_LARGE = `موجودی اولیه نمی‌تواند از ${formatInteger(MAX_INITIAL_STOCK)} بیشتر باشد.`;

/**
 * Picked «محصول دارای گونه» and filled in nothing.
 *
 * Without this the request would carry neither `variants` nor `initialStock`
 * and the server would build the product a hidden default variant — i.e. a
 * SIMPLE product, which is the opposite of what the radio on screen says. A
 * contradiction between the answer given and the thing created is worth one
 * sentence at save time.
 */
const VARIANT_KIND_NEEDS_A_ROW =
  "برای «محصول دارای گونه» دست‌کم یک گونه باید کامل شود. یا گونهٔ اول را پر کنید، یا نوع کالا را روی «محصول ساده» بگذارید.";

/**
 * The opening quantity as a number, or the Persian sentence refusing it.
 *
 * `parseRial` is the repo's one digit parser and is reused deliberately: it
 * folds Persian digits to ASCII, strips the separators an operator pastes in
 * from a spreadsheet, and rejects anything that is not a whole number — which
 * is exactly the `@IsInt()` the DTO applies, arrived at from the other side.
 */
function parseInitialStock(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = parseRial(raw.trim());
  if (parsed === null) return { ok: false, message: INITIAL_STOCK_NOT_INTEGER };
  if (parsed < 0) return { ok: false, message: INITIAL_STOCK_NEGATIVE };
  if (parsed > MAX_INITIAL_STOCK) return { ok: false, message: INITIAL_STOCK_TOO_LARGE };
  return { ok: true, value: parsed };
}

/**
 * The three visibility fields, shaped for the API.
 *
 * `branchIds` is sent ONLY in `selected` mode: the server requires it there and
 * REFUSES it in the other two, so a form that always sent the array would fail
 * every save made in «هیچ شعبه‌ای» or «همه شعب».
 */
function visibilityBody(value: ProductVisibilityValue) {
  return {
    visibleOnSite: value.visibleOnSite,
    branchVisibility: value.branchVisibility,
    ...(value.branchVisibility === "selected" ? { branchIds: value.branchIds } : {}),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface DraftVariant {
  key: string;
  sku: string;
  /** «کد گونه» — the shop's own code, distinct from the warehouse's `sku`. */
  variantCode: string;
  price: string;
  stock: string;
  /**
   * «قیمت خرید هر واحد» for THIS variant — typed by a super_admin only.
   * Empty means "not given" and is never sent as 0. There is deliberately no
   * product-level cost behind it: variants may cost different amounts.
   */
  purchasePrice: string;
  attributeValueIds: number[];
}

function newDraft(): DraftVariant {
  return {
    key: Math.random().toString(36).slice(2),
    sku: "",
    variantCode: "",
    price: "",
    stock: "0",
    purchasePrice: "",
    attributeValueIds: [],
  };
}

/**
 * One opening quantity and its purchase price, checked the way the server
 * will (docs/PURCHASE-COST-ACCOUNTING.md §6): a positive quantity needs a
 * cost, zero makes the cost optional, and a non-super_admin can send neither
 * a cost nor — therefore — a positive quantity.
 *
 * Returns the problem sentence, or the `purchasePrice` to send (absent when
 * the box is empty — never turned into "0").
 */
function checkOpeningCost(
  stockRaw: string,
  costRaw: string,
  canEnterCost: boolean,
):
  | { ok: true; stock: number; purchasePrice?: string }
  | { ok: false; field: "stock" | "cost"; message: string } {
  const quantity = parseQuantityInput(stockRaw);
  if (quantity.kind === "empty") return { ok: false, field: "stock", message: INITIAL_STOCK_NOT_INTEGER };
  if (quantity.kind === "invalid") {
    return {
      ok: false,
      field: "stock",
      message:
        quantity.reason === "negative"
          ? INITIAL_STOCK_NEGATIVE
          : quantity.reason === "too_large"
            ? INITIAL_STOCK_TOO_LARGE
            : INITIAL_STOCK_NOT_INTEGER,
    };
  }
  if (!canEnterCost) {
    // The cost box is not rendered for this viewer, so a positive quantity
    // cannot carry the price the server requires with it.
    if (quantity.value > 0) {
      return { ok: false, field: "stock", message: OPENING_STOCK_NEEDS_MAIN_ADMIN };
    }
    return { ok: true, stock: 0 };
  }
  const cost = parseRialInput(costRaw);
  if (cost.kind === "invalid") {
    return { ok: false, field: "cost", message: amountProblem(cost.reason, "قیمت خرید") };
  }
  if (cost.kind === "empty") {
    if (quantity.value > 0) return { ok: false, field: "cost", message: PURCHASE_COST_MISSING };
    return { ok: true, stock: quantity.value };
  }
  return { ok: true, stock: quantity.value, purchasePrice: cost.value.toString() };
}

/** "Is the opening quantity in this box positive?" — for choosing a hint. */
function isPositiveQuantity(raw: string): boolean {
  const parsed = parseQuantityInput(raw);
  return parsed.kind === "value" && parsed.value > 0;
}

/** A row the operator has actually started filling in. */
function isDrafted(variant: DraftVariant): boolean {
  return variant.sku.trim() !== "" || variant.variantCode.trim() !== "";
}

/**
 * Create a product.
 *
 * The whole thing — product, categories, images and variants — is ONE
 * transaction server-side, so a partial product cannot exist. Image ids must
 * come from `uploadImage` and must not already belong to another product;
 * that is why images are uploaded first and only their ids are submitted here.
 */
export function AdminProductCreate() {
  return (
    <RequirePermission permissions={["products.create"]}>
      <ProductCreateForm />
    </RequirePermission>
  );
}

function ProductCreateForm() {
  const api = useApi();
  const router = useRouter();
  const { attributes } = useAttributes();

  const { session } = useAppSession();
  /**
   * WHO MAY DECIDE WHERE A PRODUCT IS SOLD.
   *
   * Not a capability — a ROLE. `POST /products` accepts the three visibility
   * fields from `super_admin` alone and answers `VISIBILITY_FORBIDDEN` to
   * anybody else, so a delegated catalogue author gets the section as text and
   * the product is created hidden/draft, which is what the server would have
   * stored anyway.
   */
  const canEditVisibility = isSuperAdmin(session);
  /**
   * WHO MAY TYPE A PURCHASE PRICE — the same role, for the same reason
   * (docs/PURCHASE-COST-ACCOUNTING.md §8). For anybody else the cost boxes are
   * not rendered and `purchasePrice` is never put in the body.
   */
  const canEnterCost = isSuperAdmin(session);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [productCode, setProductCode] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [images, setImages] = useState<ImageView[]>([]);
  const [visibility, setVisibility] = useState<ProductVisibilityValue>(HIDDEN_DRAFT_VISIBILITY);
  /**
   * SIMPLE BY DEFAULT, because most of a shop is simple.
   *
   * The default also decides what a distracted operator ships when they never
   * touch this control, so it is the cheaper mistake of the two: a simple
   * product that should have had variants is fixed by adding them on the edit
   * screen, while a variants product created by accident leaves a half-filled
   * variant row and a SKU somebody has to retire.
   */
  const [kind, setKind] = useState<ProductKind>("simple");
  /**
   * A STRING, and it starts at "0" rather than empty.
   *
   * Empty would make «چند تا؟» an open question at the moment of saving, and
   * the honest answer for a product that is not on the shelf yet is zero — not
   * "unknown". Zero is also the value that never needs `inventory.adjust`, so
   * the default is the one a delegated catalogue editor can always submit.
   */
  const [initialStock, setInitialStock] = useState("0");
  /** The simple product's «قیمت خرید هر واحد». Empty = not given, never 0. */
  const [purchasePrice, setPurchasePrice] = useState("");
  const [costProblem, setCostProblem] = useState<string | undefined>(undefined);
  /** The value «اعمال این قیمت خرید برای همه گونه‌ها» copies into every row. */
  const [bulkCost, setBulkCost] = useState("");
  const [bulkCostProblem, setBulkCostProblem] = useState<string | undefined>(undefined);
  /** Per-row client refusals, keyed by draft key. */
  const [rowProblems, setRowProblems] = useState<Record<string, string>>({});
  /**
   * The draft keys in the order they were SENT. A server refusal names
   * `variants[2].purchasePrice` — an index into the submitted array, which
   * skips rows that were never filled in — so it is mapped back through this.
   */
  const [sentKeys, setSentKeys] = useState<string[]>([]);
  const [variants, setVariants] = useState<DraftVariant[]>([newDraft()]);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Client-side refusals that belong beside one input rather than at the foot. */
  const [codeProblem, setCodeProblem] = useState<string | undefined>(undefined);
  const [visibilityProblemText, setVisibilityProblemText] = useState<string | undefined>(undefined);
  const [stockProblem, setStockProblem] = useState<string | undefined>(undefined);

  const routed = routeProductError(error);
  const productCodeError = codeProblem ?? routed.fields.productCode;
  const visibilityError = visibilityProblemText ?? routed.fields.visibility;
  const initialStockError = stockProblem ?? routed.fields.initialStock;
  const purchasePriceError = costProblem ?? routed.fields.purchasePrice;
  const serverRowKey =
    routed.variantIndex !== undefined ? sentKeys[routed.variantIndex] : undefined;
  const rowError = (key: string): string | undefined =>
    rowProblems[key] ?? (serverRowKey === key ? routed.fields.variantPurchasePrice : undefined);
  /** A variant cost refusal the response did not tie to a row. */
  const unplacedVariantCostError =
    routed.fields.variantPurchasePrice && serverRowKey === undefined
      ? routed.fields.variantPurchasePrice
      : undefined;

  function updateDraft(key: string, patch: Partial<DraftVariant>) {
    setVariants((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
    setRowProblems((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  /**
   * EXPLICIT, AND A COPY. Each row receives the value as its own text and
   * stays editable afterwards; nothing remembers a product-level cost.
   */
  function applyCostToAll() {
    setBulkCostProblem(undefined);
    const parsed = parseRialInput(bulkCost);
    if (parsed.kind === "empty") return setBulkCostProblem("ابتدا قیمت خرید را بنویسید.");
    if (parsed.kind === "invalid") {
      return setBulkCostProblem(amountProblem(parsed.reason, "قیمت خرید"));
    }
    const text = parsed.value.toString();
    setVariants((current) => current.map((item) => ({ ...item, purchasePrice: text })));
    setRowProblems({});
  }

  /**
   * ONE CLICK, ONE CODE. Called from the button's handler and nowhere else —
   * never from an effect, so nothing regenerates behind the operator's back.
   */
  async function generateProductCode(): Promise<CodeGenerateResult> {
    const result = await api.catalog.generateProductCode();
    return { ok: true, code: result.productCode };
  }

  /**
   * A variant code is allocated UNDER a parent, so the parent is a
   * precondition rather than an error: with an empty box there is nothing to
   * ask the server for, and asking anyway would earn a 400 that says less than
   * the sentence below.
   *
   * The response echoes the NORMALISED parent (trimmed, upper-cased, Persian
   * digits folded), which is the form that must be stored beside the child —
   * so it is written back into the product-code box.
   */
  async function generateVariantCode(): Promise<CodeGenerateResult> {
    const parent = productCode.trim();
    if (parent === "") return { ok: false, message: VARIANT_CODE_NEEDS_PARENT };
    const result = await api.catalog.generateVariantCode(parent);
    setProductCode(result.productCode);
    return { ok: true, code: result.variantCode };
  }

  /**
   * Everything the two kinds send IDENTICALLY.
   *
   * The kind-specific key — `initialStock` or `variants` — is added by the
   * branch that owns it and by nothing else, so there is no code path on which
   * both can appear in one body. That is not a style preference: sending them
   * together is a 400, and building one object and then deleting a key from it
   * is how that guarantee gets lost to a later edit.
   */
  function sharedBody(): CostedCreateProductBody {
    return {
      title: title.trim(),
      description: description.trim(),
      productCode: productCode.trim(),
      ...(parseRial(basePrice) !== null ? { basePrice: parseRial(basePrice)! } : {}),
      ...(categoryIds.length > 0 ? { categoryIds } : {}),
      ...(images.length > 0 ? { images: images.map((image) => image.id) } : {}),
      // OMITTED ENTIRELY for anyone but a super_admin: the server then stores
      // the hidden/draft default, which is exactly what the section showed.
      ...(canEditVisibility ? visibilityBody(visibility) : {}),
    };
  }

  async function submit(body: CostedCreateProductBody) {
    try {
      const result = await api.catalog.createProduct(body);
      router.push(adminProductHref(result.data.id));
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  }

  const { run: create, isPending } = useSubmit(async () => {
    setError(undefined);
    setProblem(undefined);
    setCodeProblem(undefined);
    setVisibilityProblemText(undefined);
    setStockProblem(undefined);
    setCostProblem(undefined);
    setRowProblems({});

    if (title.trim() === "") return setProblem("عنوان کالا لازم است.");
    if (description.trim() === "") return setProblem("توضیح کالا لازم است.");
    if (productCode.trim() === "") return setCodeProblem(PRODUCT_CODE_REQUIRED);

    if (canEditVisibility) {
      const visibilityIssue = visibilityProblem(visibility);
      if (visibilityIssue) return setVisibilityProblemText(visibilityIssue);
    }

    /*
     * THE OPENING QUANTITY IS ONLY EVER READ FOR A SIMPLE PRODUCT.
     *
     * Not parsed-and-ignored for the other kind, and not carried into the body
     * "just in case": a `initialStock` sent beside `variants` is a 400, and the
     * box it would be about is not even on screen. The two branches below never
     * both contribute to the payload — that is the whole invariant this screen
     * has to hold.
     */
    if (kind === "simple") {
      const opening = parseInitialStock(initialStock);
      if (!opening.ok) return setStockProblem(opening.message);
      const costed = checkOpeningCost(initialStock, purchasePrice, canEnterCost);
      if (!costed.ok) {
        return costed.field === "stock"
          ? setStockProblem(costed.message)
          : setCostProblem(costed.message);
      }

      await submit({
        ...sharedBody(),
        initialStock: opening.value,
        // A base-10 STRING, and only when the box was filled in — an empty
        // box is "not given", which the server must never read as 0.
        ...(costed.purchasePrice !== undefined ? { purchasePrice: costed.purchasePrice } : {}),
      });
      return;
    }

    const drafted = variants.filter(isDrafted);
    if (drafted.length === 0) return setProblem(VARIANT_KIND_NEEDS_A_ROW);
    for (const variant of drafted) {
      const label = variant.sku.trim() || variant.variantCode.trim();
      if (variant.sku.trim() === "") {
        return setProblem(`برای گونهٔ ${label} کد کالا (SKU) لازم است.`);
      }
      if (variant.variantCode.trim() === "") {
        return setProblem(`برای گونهٔ ${label} کد گونه لازم است.`);
      }
      if (variant.attributeValueIds.length === 0) {
        return setProblem(`برای گونهٔ ${label} دست‌کم یک ویژگی انتخاب کنید.`);
      }
    }

    const checked = new Map<string, { stock: number; purchasePrice?: string }>();
    const problems: Record<string, string> = {};
    for (const variant of drafted) {
      const result = checkOpeningCost(variant.stock, variant.purchasePrice, canEnterCost);
      if (result.ok) checked.set(variant.key, result);
      else problems[variant.key] = result.message;
    }
    if (Object.keys(problems).length > 0) {
      setRowProblems(problems);
      return setProblem(
        "موجودی اولیه یا قیمت خرید برخی گونه‌ها نیاز به اصلاح دارد؛ پیام زیر هر گونه را ببینید.",
      );
    }

    setSentKeys(drafted.map((variant) => variant.key));
    await submit({
      ...sharedBody(),
      // Sent WITHOUT `initialStock`, always. Each row already carries its own
      // opening `stock`, which is the per-variant equivalent and the only one
      // the server accepts once `variants` is present. Likewise each row
      // carries its OWN purchase price — there is no product-level one.
      variants: drafted.map<CostedCreateVariantBody>((variant) => {
        const row = checked.get(variant.key) ?? { stock: 0 };
        return {
          sku: variant.sku.trim(),
          variantCode: variant.variantCode.trim(),
          stock: row.stock,
          attributeValueIds: variant.attributeValueIds,
          ...(parseRial(variant.price) !== null ? { price: parseRial(variant.price)! } : {}),
          ...(row.purchasePrice !== undefined ? { purchasePrice: row.purchasePrice } : {}),
        };
      }),
    });
  });

  return (
    <>
      <Breadcrumbs items={[{ label: "کالاها", href: "/admin/products" }, { label: "کالای تازه" }]} />
      <PageHeading title="کالای تازه" description="کالا، گونه‌ها، دسته‌ها و تصویرها با هم ثبت می‌شوند." />

      <form
        className="mt-6 max-w-3xl space-y-6"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void create();
        }}
      >
        {/*
          FIRST, BECAUSE IT DECIDES WHAT THE REST OF THE FORM IS.
          Answering it changes which fields exist below — the opening quantity
          appears for one kind and the whole variant editor for the other — so
          it cannot sit halfway down a form whose shape it governs.
        */}
        <Card tone="outlined" as="section">
          <ProductKindChoice
            value={kind}
            onChange={(next) => {
              // A refusal about the quantity is about a number the operator is
              // no longer being asked for. Clearing it with the answer that
              // caused it keeps a stale sentence off the next kind's fields.
              setStockProblem(undefined);
              setKind(next);
            }}
            disabled={isPending}
          />
        </Card>

        <Card tone="outlined" as="section" className="space-y-5">
          <Input label="عنوان کالا" required value={title} onChange={(e) => setTitle(e.target.value)} />

          <CodeField
            label="کد محصول"
            hint={PRODUCT_CODE_HINT}
            maxLength={PRODUCT_CODE_MAX}
            value={productCode}
            onChange={setProductCode}
            onGenerate={generateProductCode}
            disabled={isPending}
            {...(productCodeError ? { error: productCodeError } : {})}
          />

          <Field label="توضیح کالا">
            <textarea
              // `Field` renders a visual caption, not a <label>, because it also
              // wraps grouped controls; the textarea therefore names itself.
              aria-label="توضیح کالا"
              required
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </Field>

          <Input
            label="قیمت پایه (ریال)"
            numeric
            value={basePrice}
            onChange={(event) => setBasePrice(event.target.value)}
            /*
             * The old hint explained this box in terms of variants, which is a
             * sentence about something that is not on screen for a simple
             * product — and misleading there, because a simple product's single
             * hidden variant is BORN with this price and has no other.
             */
            hint={
              kind === "simple"
                ? "قیمت فروش این کالا."
                : "اختیاری. گونه‌ای که قیمت خودش را نداشته باشد، این قیمت را می‌گیرد."
            }
          />

          {/*
            THE OPENING QUANTITY — rendered ONLY for «محصول ساده».

            Not disabled for the other kind, and not hidden with CSS: a box
            that exists but cannot be used is still a box the operator reads,
            wonders about and eventually asks somebody about. With variants
            chosen there is no single quantity to type, because each variant
            row carries its own.
          */}
          {kind === "simple" ? (
            <Input
              label={INITIAL_STOCK_LABEL}
              numeric
              required
              /*
               * A `numeric` TEXT box, not `type="number"`.
               *
               * The operator's keyboard emits Persian digits, which a native
               * number input discards silently — it reports an empty value and
               * shows a box that looks filled. `parseRial` folds them, strips
               * the separators pasted out of a spreadsheet and rejects anything
               * that is not a whole number, which is the same `@IsInt()` the
               * DTO applies from the other side. Every other quantity box in
               * this admin is built this way for the same reason.
               */
              value={initialStock}
              onChange={(event) => {
                setStockProblem(undefined);
                setInitialStock(event.target.value);
              }}
              hint={GLOBAL_STOCK_SENTENCE}
              {...(initialStockError ? { error: initialStockError } : {})}
            />
          ) : null}

          {/*
            «قیمت خرید هر واحد» — for a SIMPLE product, and for a super_admin
            only. Anybody else is told, beside the quantity, why a positive
            opening stock is not theirs to enter.
          */}
          {kind === "simple" && canEnterCost ? (
            <div className="space-y-3">
              <Input
                label="قیمت خرید هر واحد (ریال)"
                numeric
                aria-required={isPositiveQuantity(initialStock)}
                value={purchasePrice}
                onChange={(event) => {
                  setCostProblem(undefined);
                  setPurchasePrice(event.target.value);
                }}
                hint={
                  <>
                    {isPositiveQuantity(initialStock)
                      ? PURCHASE_COST_REQUIRED_HINT
                      : PURCHASE_COST_OPTIONAL_HINT}{" "}
                    {PURCHASE_COST_SENSITIVE_HINT}
                  </>
                }
                {...(purchasePriceError ? { error: purchasePriceError } : {})}
              />
              <UnitProfitPreview sellingPrice={basePrice} purchasePrice={purchasePrice} />
            </div>
          ) : null}
          {kind === "simple" && !canEnterCost && isPositiveQuantity(initialStock) ? (
            <Notice tone="warning">{OPENING_STOCK_NEEDS_MAIN_ADMIN}</Notice>
          ) : null}
          {kind === "simple" && !canEnterCost && routed.fields.purchasePrice ? (
            <Notice tone="danger">{routed.fields.purchasePrice}</Notice>
          ) : null}

          <Field label="دسته‌بندی‌ها">
            <CategoryPicker selected={categoryIds} onChange={setCategoryIds} />
          </Field>

          <Field label="تصویرها">
            <ImageManager images={images} onChange={setImages} />
          </Field>
        </Card>

        <Card tone="outlined" as="section">
          <ProductVisibilitySection
            value={visibility}
            knownBranches={[]}
            onChange={(next) => {
              setVisibilityProblemText(undefined);
              setVisibility(next);
            }}
            disabled={isPending}
            canEdit={canEditVisibility}
            {...(visibilityError ? { fieldError: visibilityError } : {})}
          />
        </Card>

        {/*
          THE VARIANT EDITOR IS NOT RENDERED AT ALL FOR A SIMPLE PRODUCT.

          Not disabled, not collapsed: an editor for something the operator has
          just said this product does not have is a whole panel of questions
          with no answers. The rows themselves are kept in state so that
          changing one's mind twice does not retype them — what guarantees they
          are never sent is the submit path, where `drafted` is only ever read
          inside the «محصول دارای گونه» branch.
        */}
        {kind === "variants" ? (
          <Card tone="outlined" as="section">
            <h2 className="text-lg text-ink">گونه‌ها</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
              هر گونه یک کد کالا (SKU) یکتا دارد. موجودی اولیه فقط هنگام ساخت گونه پذیرفته می‌شود؛
              بعد از آن، هر افزایش موجودی از مسیر «ثبت ورود کالا» (با قیمت خرید) ثبت می‌شود تا سابقه داشته باشد.
            </p>

            {canEnterCost ? (
              <div className="mt-4 rounded-md border border-line p-3">
                <p className="text-xs leading-relaxed text-ink-muted">
                  هر گونه قیمت خرید خودش را دارد؛ قیمت خریدی در سطح محصول وجود ندارد. اگر همهٔ گونه‌ها
                  یک قیمت خرید دارند، آن را اینجا بنویسید و دکمه را بزنید تا در تک‌تک گونه‌ها کپی شود —
                  هر گونه بعد از آن هم قابل ویرایش است. {PURCHASE_COST_SENSITIVE_HINT}
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <Input
                    label="قیمت خرید برای کپی (ریال)"
                    numeric
                    value={bulkCost}
                    onChange={(event) => {
                      setBulkCostProblem(undefined);
                      setBulkCost(event.target.value);
                    }}
                    containerClassName="min-w-0 flex-1"
                    {...(bulkCostProblem ? { error: bulkCostProblem } : {})}
                  />
                  <Button type="button" variant="secondary" onClick={applyCostToAll}>
                    اعمال این قیمت خرید برای همه گونه‌ها
                  </Button>
                </div>
              </div>
            ) : (
              <Notice tone="neutral" className="mt-4">
                {OPENING_STOCK_NEEDS_MAIN_ADMIN}
              </Notice>
            )}

            <ul className="mt-4 space-y-4">
              {variants.map((variant, index) => (
                <li key={variant.key} className="rounded-md border border-line p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-ink">
                      گونهٔ <bdi data-numeric="">{formatInteger(index + 1)}</bdi>
                    </p>
                    {variants.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<TrashIcon className="size-4" />}
                        onClick={() =>
                          setVariants((current) => current.filter((item) => item.key !== variant.key))
                        }
                      >
                        حذف
                      </Button>
                    ) : null}
                  </div>

                  <div className="mt-3">
                    <CodeField
                      label="کد گونه"
                      hint={VARIANT_CODE_HINT}
                      maxLength={VARIANT_CODE_MAX}
                      value={variant.variantCode}
                      onChange={(next) =>
                        setVariants((current) =>
                          current.map((item) =>
                            item.key === variant.key ? { ...item, variantCode: next } : item,
                          ),
                        )
                      }
                      onGenerate={generateVariantCode}
                      disabled={isPending}
                    />
                  </div>

                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <Input
                      label="کد کالا (SKU)"
                      value={variant.sku}
                      onChange={(event) =>
                        setVariants((current) =>
                          current.map((item) =>
                            item.key === variant.key ? { ...item, sku: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <Input
                      label="قیمت گونه (ریال)"
                      numeric
                      value={variant.price}
                      onChange={(event) =>
                        setVariants((current) =>
                          current.map((item) =>
                            item.key === variant.key ? { ...item, price: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <Input
                      label="موجودی اولیه"
                      numeric
                      value={variant.stock}
                      onChange={(event) => updateDraft(variant.key, { stock: event.target.value })}
                    />
                  </div>

                  {canEnterCost ? (
                    <div className="mt-3 space-y-3">
                      <Input
                        label="قیمت خرید هر واحد این گونه (ریال)"
                        numeric
                        aria-required={isPositiveQuantity(variant.stock)}
                        value={variant.purchasePrice}
                        onChange={(event) =>
                          updateDraft(variant.key, { purchasePrice: event.target.value })
                        }
                        hint={
                          isPositiveQuantity(variant.stock)
                            ? PURCHASE_COST_REQUIRED_HINT
                            : PURCHASE_COST_OPTIONAL_HINT
                        }
                        {...(rowError(variant.key) ? { error: rowError(variant.key) } : {})}
                      />
                      <UnitProfitPreview
                        sellingPrice={variant.price.trim() !== "" ? variant.price : basePrice}
                        purchasePrice={variant.purchasePrice}
                      />
                    </div>
                  ) : rowError(variant.key) ? (
                    <Notice tone="danger" className="mt-3">
                      {rowError(variant.key)}
                    </Notice>
                  ) : null}

                  <div className="mt-4">
                    <AttributeValuePicker
                      attributes={attributes}
                      selected={variant.attributeValueIds}
                      onChange={(ids) =>
                        setVariants((current) =>
                          current.map((item) =>
                            item.key === variant.key ? { ...item, attributeValueIds: ids } : item,
                          ),
                        )
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>

            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              leadingIcon={<PlusIcon className="size-4" />}
              onClick={() => setVariants((current) => [...current, newDraft()])}
            >
              افزودن گونه
            </Button>

            {/*
              A VARIANT-CODE REFUSAL, KEPT NEXT TO THE VARIANTS.
              The response names the field but not WHICH row on a multi-variant
              create, so the message sits under the list rather than being
              guessed onto one box — and it is never dropped, which is what
              routing it to an input that does not exist here would do.
            */}
            {routed.fields.variantCode ? (
              <Notice tone="danger" className="mt-4">
                {routed.fields.variantCode}
              </Notice>
            ) : null}

            {/*
              An opening-quantity refusal with no box on screen to sit beside.
              This form never sends `initialStock` together with `variants`, so
              it should be unreachable — printed rather than swallowed anyway,
              because a message routed to a field that is not rendered is a
              message the operator never sees at all.
            */}
            {routed.fields.initialStock ? (
              <Notice tone="danger" className="mt-4">
                {routed.fields.initialStock}
              </Notice>
            ) : null}

            {/*
              Cost refusals with no row to sit under: a variant cost the
              response named without an index, or a product-level
              `purchasePrice` refusal (e.g. PURCHASE_COST_FORBIDDEN) while
              the product-level box is not on screen.
            */}
            {unplacedVariantCostError ? (
              <Notice tone="danger" className="mt-4">
                {unplacedVariantCostError}
              </Notice>
            ) : null}
            {routed.fields.purchasePrice ? (
              <Notice tone="danger" className="mt-4">
                {routed.fields.purchasePrice}
              </Notice>
            ) : null}
          </Card>
        ) : null}

        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        <FormError error={routed.rest} />

        <div className="flex gap-3">
          <Button type="submit" size="lg" isLoading={isPending}>
            ثبت کالا
          </Button>
          <Link href="/admin/products" className="no-underline">
            <Button type="button" size="lg" variant="secondary">
              انصراف
            </Button>
          </Link>
        </div>
      </form>
    </>
  );
}

/**
 * «نوع کالا» — a real radio group, keyboard-operable because it is native.
 *
 * `<fieldset>` + `<legend>` rather than `role="radiogroup"` with an
 * `aria-labelledby`: the native pairing is what every screen reader already
 * announces as the group's name before reading each option, and native sibling
 * `<input type="radio">`s are what give the arrow keys their meaning. Nothing
 * here re-implements roving focus, because nothing here has to.
 *
 * The visible card is a `<label>` WRAPPING the input, so the title and its
 * explanation are both part of the click target and the focus ring is drawn
 * with `focus-within` around the whole block rather than around a 16px circle.
 * It is the same shape «نمایش در شعب» uses one card below, deliberately: two
 * radio groups on one screen that behave differently is one too many.
 */
function ProductKindChoice({
  value,
  onChange,
  disabled,
}: {
  value: ProductKind;
  onChange: (kind: ProductKind) => void;
  disabled: boolean;
}) {
  const groupName = useId();

  return (
    <fieldset>
      <legend className="text-lg text-ink">نوع کالا</legend>
      <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
        این پاسخ تعیین می‌کند در ادامهٔ فرم چه چیزی از شما پرسیده شود.
      </p>

      <ul className="mt-3 space-y-2">
        {PRODUCT_KINDS.map((option) => {
          const active = value === option;
          return (
            <li key={option}>
              <label
                className={cx(
                  "flex items-start gap-2.5 rounded-md border p-3 transition-colors duration-150 ease-kz",
                  "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]",
                  active ? "border-primary/50 bg-primary-soft/40" : "border-line bg-surface",
                  disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option}
                  checked={active}
                  disabled={disabled}
                  onChange={() => onChange(option)}
                  className={cx(
                    "mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-ink">
                    {PRODUCT_KIND_LABEL[option]}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                    {PRODUCT_KIND_HINT[option]}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export function AdminProductEdit({ productId }: { productId: number }) {
  return (
    <RequirePermission permissions={["products.read"]}>
      <ProductEditLoader productId={productId} />
    </RequirePermission>
  );
}

function ProductEditLoader({ productId }: { productId: number }) {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => api.catalog.getProductAdmin(productId, { signal }),
    [api, productId],
  );

  if (error) {
    return (
      <ErrorState error={error} {...(isMissingOrForbidden(error) ? {} : { onRetry: refetch })} />
    );
  }

  if (isLoading || !data) {
    return (
      <div role="status" aria-busy="true" className="space-y-4">
        <span className="kz-sr-only">در حال بارگذاری کالا</span>
        <Skeleton shape="block" height="12rem" />
        <Skeleton shape="block" height="18rem" />
      </div>
    );
  }

  return <ProductEditForm key={data.updatedAt} product={data} onSaved={refetch} />;
}

function ProductEditForm({ product, onSaved }: { product: AdminProduct; onSaved: () => void }) {
  const api = useApi();
  const { attributes } = useAttributes();
  const { session } = useAppSession();

  /**
   * THE ONE QUESTION THIS SCREEN ASKS ABOUT THE VIEWER.
   *
   * `products.read` opens the page; `products.update` is what makes any of it
   * an editor. Until now only the SAVE BUTTON consulted this, so a viewer who
   * held read alone got a page that said "این صفحه برای شما فقط خواندنی است"
   * underneath a title box they could retype, a description they could rewrite
   * and an image list they could reorder and empty. Every keystroke was
   * discarded on the next navigation, with no warning, and the sentence on the
   * screen was false while they were typing.
   *
   * Read-only is therefore decided ONCE, here, and every control below is a
   * consequence of it rather than a separate decision that can drift.
   *
   * Hiding is still only a kindness: `PATCH /products/:id` enforces
   * `products.update` on the server, independently, and would refuse the
   * request even if this flag were flipped in a browser console.
   */
  const canUpdate = can(session, "products.update");
  /**
   * VISIBILITY IS A SECOND, NARROWER QUESTION.
   *
   * `products.update` makes someone a catalogue editor; it does not make them
   * the person who decides where the shop offers a product. The API reserves
   * all three visibility fields for `super_admin` — including NARROWING them —
   * so an editor sees the configuration as text and everything else as a form.
   */
  const canEditVisibility = canUpdate && isSuperAdmin(session);

  /**
   * NOT STATE, and never an input on this page.
   *
   * `initialStock` is a CREATE-time field: `UpdateProductDto` omits it and
   * `PATCH /products/:id` answers 400 to a body that carries it. Stock after
   * creation moves only through the inventory ledger, which is the only path
   * that reconciles a change against what customers have already reserved — so
   * what this screen offers is the CURRENT figure and a way to the ledger, not
   * a second box that would silently mean something different from the one on
   * the create form.
   */
  const simpleVariant = simpleProductVariant(product);

  const [title, setTitle] = useState(product.title);
  const [description, setDescription] = useState(product.description ?? "");
  const [productCode, setProductCode] = useState(product.productCode);
  const [basePrice, setBasePrice] = useState(product.basePrice?.toString() ?? "");
  const [categoryIds, setCategoryIds] = useState<number[]>(
    product.categories.map((category) => category.id),
  );
  const [images, setImages] = useState<ImageView[]>(product.images);
  const [visibility, setVisibility] = useState<ProductVisibilityValue>(
    visibilityValueOf(product.visibility),
  );
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [codeProblem, setCodeProblem] = useState<string | undefined>(undefined);
  const [visibilityProblemText, setVisibilityProblemText] = useState<string | undefined>(undefined);

  const routed = routeProductError(error);
  const productCodeError = codeProblem ?? routed.fields.productCode;
  const visibilityError = visibilityProblemText ?? routed.fields.visibility;

  /** See the twin on the create form: one click, one code, never an effect. */
  async function generateProductCode(): Promise<CodeGenerateResult> {
    const result = await api.catalog.generateProductCode();
    return { ok: true, code: result.productCode };
  }

  const { run: save, isPending } = useSubmit(async () => {
    // Belt and braces. No control below can reach this when `canUpdate` is
    // false — but the edit screen has no <form>, so nothing here can be
    // triggered by Enter either, and this guard means that stays true even if
    // a later change adds one.
    if (!canUpdate) return;

    setError(undefined);
    setSaved(false);
    setCodeProblem(undefined);
    setVisibilityProblemText(undefined);

    if (productCode.trim() === "") return setCodeProblem(PRODUCT_CODE_REQUIRED);

    if (canEditVisibility) {
      const visibilityIssue = visibilityProblem(visibility);
      if (visibilityIssue) return setVisibilityProblemText(visibilityIssue);
    }

    const body: UpdateProductBody = {
      title: title.trim(),
      description: description.trim(),
      productCode: productCode.trim(),
      categoryIds,
      // The COMPLETE desired ordered set. Omitting it would leave images
      // untouched; sending the current list is what makes a removal stick.
      images: images.map((image) => image.id),
      ...(parseRial(basePrice) !== null ? { basePrice: parseRial(basePrice)! } : {}),
      // Omitted for a non-super_admin: an omitted field is UNTOUCHED, so an
      // ordinary edit can never narrow or widen where the product is offered.
      ...(canEditVisibility ? visibilityBody(visibility) : {}),
    };

    try {
      await api.catalog.updateProduct(product.id, body);
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  return (
    <>
      <Breadcrumbs
        items={[{ label: "کالاها", href: "/admin/products" }, { label: product.title }]}
      />
      <PageHeading
        title={product.title}
        description={`شناسهٔ کالا ${formatInteger(product.id)} · ${formatInteger(product.bookmarkCount)} نشان‌گذاری`}
      />

      <div className="mt-6 max-w-4xl space-y-6">
        {/*
          SAID ONCE, AT THE TOP, BEFORE ANYTHING ELSE IS READ.
          The old wording sat at the bottom of the card, under the fields it was
          describing, so a viewer met the editable-looking controls first and
          the disclaimer afterwards.
        */}
        {!canUpdate ? (
          <Notice tone="neutral" title="نمایش فقط‌خواندنی">
            <p className="text-xs leading-relaxed">
              شما به این کالا دسترسی مشاهده دارید و می‌توانید همهٔ اطلاعات آن را ببینید، اما
              ویرایش آن به اختیار <bdi dir="ltr">products.update</bdi> نیاز دارد. به همین دلیل
              هیچ فیلد قابل تایپی در این صفحه نمایش داده نمی‌شود؛ آنچه می‌بینید مقدار ذخیره‌شدهٔ
              همین لحظه است.
            </p>
          </Notice>
        ) : null}

        <Card tone="outlined" as="section" className="space-y-5">
          <h2 className="text-lg text-ink">اطلاعات کالا</h2>

          {canUpdate ? (
            <>
              <Input label="عنوان کالا" value={title} onChange={(e) => setTitle(e.target.value)} />

              <CodeField
                label="کد محصول"
                hint={PRODUCT_CODE_HINT}
                maxLength={PRODUCT_CODE_MAX}
                value={productCode}
                onChange={setProductCode}
                onGenerate={generateProductCode}
                disabled={isPending}
                {...(productCodeError ? { error: productCodeError } : {})}
              />

              <Field label="توضیح کالا">
                <textarea
                  aria-label="توضیح کالا"
                  rows={5}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className={TEXTAREA_CLASS}
                />
              </Field>

              <Input
                label="قیمت پایه (ریال)"
                numeric
                value={basePrice}
                onChange={(event) => setBasePrice(event.target.value)}
                hint="گونه‌ای که قیمت خودش را دارد، از این قیمت پیروی نمی‌کند."
              />
            </>
          ) : (
            <>
              <ReadOnlyField label="عنوان کالا" value={product.title} />
              <ReadOnlyField
                label="کد محصول"
                numeric
                value={product.productCode}
                hint={PRODUCT_CODE_HINT}
                empty="بدون کد"
              />
              <ReadOnlyField label="توضیح کالا" value={product.description} multiline />
              <ReadOnlyField
                label="قیمت پایه (ریال)"
                numeric
                value={
                  product.basePrice === null || product.basePrice === undefined
                    ? null
                    : formatInteger(product.basePrice)
                }
                hint="گونه‌ای که قیمت خودش را دارد، از این قیمت پیروی نمی‌کند."
                empty="بدون قیمت پایه"
              />
            </>
          )}

          <Field label="دسته‌بندی‌ها">
            <CategoryPicker
              selected={categoryIds}
              onChange={setCategoryIds}
              readOnly={!canUpdate}
            />
          </Field>

          <Field
            label="تصویرها"
            {...(canUpdate
              ? {
                  hint: "فهرست زیر، مجموعهٔ نهایی تصویرهای این کالاست: هر تصویری که حذف کنید، پس از ذخیره پاک می‌شود.",
                }
              : {})}
          >
            <ImageManager images={images} onChange={setImages} readOnly={!canUpdate} />
          </Field>

          {/*
            SAVED BY THE SAME BUTTON as everything above it, which is why it
            sits inside this card and not in one of its own: `PATCH
            /products/:id` takes the visibility fields in the same body as the
            title, and a separate card with no button of its own would leave an
            operator wondering whether their change had been recorded.
          */}
          <div className="border-t border-line pt-5">
            <ProductVisibilitySection
              value={visibility}
              knownBranches={product.visibility.branches}
              onChange={(next) => {
                setVisibilityProblemText(undefined);
                setVisibility(next);
              }}
              disabled={isPending}
              canEdit={canEditVisibility}
              {...(visibilityError ? { fieldError: visibilityError } : {})}
            />
          </div>

          {saved ? <Notice tone="success">تغییرات ذخیره شد.</Notice> : null}
          {/* This card sends no variants, so a variant-code refusal here would
              have nowhere to land. Printed rather than dropped. */}
          {routed.fields.variantCode ? (
            <Notice tone="danger">{routed.fields.variantCode}</Notice>
          ) : null}
          <FormError error={routed.rest} />

          {canUpdate ? (
            <Button isLoading={isPending} onClick={() => void save()}>
              ذخیرهٔ اطلاعات کالا
            </Button>
          ) : null}
        </Card>

        {/*
          THE STOCK FIGURE A SIMPLE PRODUCT'S OWNER CAME HERE FOR.

          For a product with variants, «موجودی» is a column of numbers and the
          panel below already prints one per row. For a simple product it is a
          single fact about the product itself — and it was the one fact this
          screen did not state, because it lives on a variant that nobody named,
          nobody asked for, and nobody recognises by its `DEFAULT-P…` SKU.
        */}
        {simpleVariant ? <SimpleProductStock variant={simpleVariant} /> : null}

        {/*
          «قیمت خرید و ارزش موجودی» — super_admin ONLY. The component checks
          the role itself and neither renders nor requests anything for
          anybody else, so a delegated catalogue editor never sees a cost
          figure and never collects a 403 for one.
        */}
        <ProductCostingSection productId={product.id} onChanged={onSaved} />

        <VariantEditor
          product={product}
          attributes={attributes}
          onChanged={onSaved}
          canUpdate={canUpdate}
          productCode={productCode}
          onProductCodeNormalised={setProductCode}
        />
      </div>
    </>
  );
}

/**
 * The single hidden variant that IS a simple product — or `undefined`.
 *
 * DECIDED BY THE SERVER'S FLAG, not by shape. `product_variants.isDefault`
 * marks the variant the system created to BE the product, and the admin
 * projection now carries it.
 *
 * Inferring it instead — "exactly one variant, and it has no attribute values"
 * — is wrong for a real case: a product deliberately created with a single
 * optionless variant is indistinguishable from a simple one, and would be
 * shown a simple-product stock panel it should not have. The two are different
 * things and only the server knows which it built.
 */
function simpleProductVariant(product: AdminProduct): AdminVariant | undefined {
  if (product.variants.length !== 1) return undefined;
  const only = product.variants[0];
  return only?.isDefault === true ? only : undefined;
}

/**
 * Current physical stock, plus the way to change it.
 *
 * THE NUMBER IS PHYSICAL, NOT SELLABLE. `variant.stock` is what is on the
 * shelf; it is not reduced by the units already reserved in customers' baskets
 * or allocated to unfulfilled orders, and this card says so rather than letting
 * a manager read it as "how many I can still sell". The screen that separates
 * those numbers from one another is the one the button leads to.
 *
 * NO STOCK CONTROL LIVES HERE. Changing stock is `inventory.adjust` against a
 * ledger that reconciles the change with those reservations, and a second
 * adjustment form on the catalogue screen would be a second place to keep that
 * right. The action is therefore a LINK to the inventory screen, filtered to
 * this exact variant by its SKU — which is what the stockroom search matches.
 */
function SimpleProductStock({ variant }: { variant: AdminVariant }) {
  return (
    <Card tone="outlined" as="section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg text-ink">موجودی</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
            {GLOBAL_STOCK_SENTENCE}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
            این عدد موجودی فیزیکی است؛ رزرو سبدهای خرید و تخصیص سفارش‌ها از آن کسر نشده است. برای
            دیدن تفکیک این عددها و ثبت هر تغییر، به صفحهٔ موجودی بروید.
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge size="sm" tone={variant.stock > 0 ? "info" : "warning"}>
            موجودی فعلی <bdi data-numeric="">{formatInteger(variant.stock)}</bdi>
          </Badge>
          {/*
            GATED ON THE CAPABILITY THE DESTINATION DECLARES, not on the one
            that opened this page. `/admin/inventory` reads `inventory.read`,
            which a catalogue editor need not hold — offering them the button
            sends them to an access-denied page and straight back.
          */}
          <Gate permissions={["inventory.read"]}>
            <Link href={adminInventoryHref({ search: variant.sku })} className="no-underline">
              <Button size="sm" variant="secondary">
                مدیریت موجودی
              </Button>
            </Link>
          </Gate>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Variant management.
 *
 * Two rules from the server shape this whole panel:
 *
 *  1. **Variants are never hard-deleted** — `order_items` reference them. The
 *     only "removal" is `isActive: false`, which retires the variant and keeps
 *     every past order readable. The button therefore says "غیرفعال" and not
 *     "حذف", because that is what it does.
 *  2. **`stock` is refused on an update.** It is honoured only when CREATING a
 *     variant. Every later change has to go through the inventory ledger so it
 *     leaves a movement row and a `balanceAfter` — which is why stock has its
 *     own control below rather than being an editable field in this form.
 */
function VariantEditor({
  product,
  attributes,
  onChanged,
  canUpdate,
  productCode,
  onProductCodeNormalised,
}: {
  product: AdminProduct;
  attributes: ProductAttribute[];
  onChanged: () => void;
  /**
   * `products.update`, decided once by the parent. Activation and deactivation
   * are NOT covered by it and are still gated per DIRECTION on the row itself;
   * stock is not covered by it either and is gated on `inventory.adjust`.
   */
  canUpdate: boolean;
  /**
   * The LIVE contents of the product-code box above, not `product.productCode`.
   *
   * A variant code is allocated under a parent, and the parent an operator
   * means is the one they can see — including an edit they have not saved yet.
   */
  productCode: string;
  /** The server's normalised parent, echoed back into that box. */
  onProductCodeNormalised: (code: string) => void;
}) {
  const api = useApi();
  const { session } = useAppSession();
  /** A variant created here brings its opening units with their cost (§6). */
  const canEnterCost = isSuperAdmin(session);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [drafts, setDrafts] = useState<DraftVariant[]>([]);
  const [draftProblems, setDraftProblems] = useState<Record<string, string>>({});
  /**
   * WHICH ROW ASKED.
   *
   * Every save here is one row's patch, and the response names a field but not
   * a row. Remembering the row that submitted is what keeps a
   * «این کد قبلاً استفاده شده» under the box that caused it instead of under
   * all of them at once.
   */
  const [errorSource, setErrorSource] = useState<string | null>(null);

  const routed = routeProductError(error);
  const variantCodeErrorFor = (key: string): string | undefined =>
    errorSource === key ? routed.fields.variantCode : undefined;
  /** This PATCH names `variants[].purchasePrice` with no index — the row is the one that asked. */
  const draftCostErrorFor = (key: string): string | undefined =>
    draftProblems[key] ??
    (errorSource === key
      ? (routed.fields.variantPurchasePrice ?? routed.fields.purchasePrice)
      : undefined);
  const unhandledError = routed.fields.productCode ?? routed.fields.visibility;

  function submitDraft(draft: DraftVariant) {
    setDraftProblems({});
    const checked = checkOpeningCost(draft.stock, draft.purchasePrice, canEnterCost);
    if (!checked.ok) {
      setDraftProblems({ [draft.key]: checked.message });
      return;
    }
    void apply(draft.key, [
      {
        sku: draft.sku.trim(),
        // REQUIRED when creating a variant, which is what an entry with no
        // `id` is.
        variantCode: draft.variantCode.trim(),
        stock: checked.stock,
        attributeValueIds: draft.attributeValueIds,
        ...(parseRial(draft.price) !== null ? { price: parseRial(draft.price)! } : {}),
        ...(checked.purchasePrice !== undefined ? { purchasePrice: checked.purchasePrice } : {}),
      },
    ]);
  }

  const { run: apply, isPending } = useSubmit(
    async (sourceKey: string, variants: CostedUpsertVariantBody[]) => {
      setError(undefined);
      setErrorSource(sourceKey);
      try {
        await api.catalog.updateProduct(product.id, { variants });
        setDrafts([]);
        onChanged();
      } catch (cause) {
        setError(isApiError(cause) ? cause : undefined);
      }
    },
  );

  /** Shared by every row and draft; reads the product-code box on each click. */
  async function generateVariantCode(): Promise<CodeGenerateResult> {
    const parent = productCode.trim();
    if (parent === "") return { ok: false, message: VARIANT_CODE_NEEDS_PARENT };
    const result = await api.catalog.generateVariantCode(parent);
    onProductCodeNormalised(result.productCode);
    return { ok: true, code: result.variantCode };
  }

  return (
    <Card tone="outlined" as="section">
      <h2 className="text-lg text-ink">گونه‌ها و موجودی</h2>

      <ul className="mt-4 space-y-3">
        {product.variants.map((variant) => (
          <VariantRow
            key={variant.id}
            variant={variant}
            product={product}
            attributes={attributes}
            onApply={(patch) => void apply(`variant-${variant.id}`, [patch])}
            isBusy={isPending}
            onStockChanged={onChanged}
            canUpdate={canUpdate}
            onGenerateVariantCode={generateVariantCode}
            codeError={variantCodeErrorFor(`variant-${variant.id}`)}
          />
        ))}
      </ul>

      {product.variants.length === 0 ? (
        <p className="mt-3 text-sm text-ink-subtle">این کالا هنوز هیچ گونه‌ای ندارد.</p>
      ) : null}

      {/*
        The draft list can only be filled by the gated "افزودن گونه" button
        below, but `canUpdate` is restated here so the SKU, price, stock and
        attribute inputs cannot be reached by any route — a stale draft left in
        state by a permission change included.
      */}
      {(canUpdate ? drafts : []).map((draft) => (
        <div key={draft.key} className="mt-4 rounded-md border border-dashed border-line p-4">
          <p className="text-sm font-bold text-ink">گونهٔ تازه</p>
          <div className="mt-3">
            <CodeField
              label="کد گونه"
              hint={VARIANT_CODE_HINT}
              maxLength={VARIANT_CODE_MAX}
              value={draft.variantCode}
              onChange={(next) =>
                setDrafts((current) =>
                  current.map((item) =>
                    item.key === draft.key ? { ...item, variantCode: next } : item,
                  ),
                )
              }
              onGenerate={generateVariantCode}
              disabled={isPending}
              {...(variantCodeErrorFor(draft.key)
                ? { error: variantCodeErrorFor(draft.key) }
                : {})}
            />
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Input
              label="کد کالا (SKU)"
              value={draft.sku}
              onChange={(event) =>
                setDrafts((current) =>
                  current.map((item) =>
                    item.key === draft.key ? { ...item, sku: event.target.value } : item,
                  ),
                )
              }
            />
            <Input
              label="قیمت گونه (ریال)"
              numeric
              value={draft.price}
              onChange={(event) =>
                setDrafts((current) =>
                  current.map((item) =>
                    item.key === draft.key ? { ...item, price: event.target.value } : item,
                  ),
                )
              }
            />
            <Input
              label="موجودی اولیه"
              numeric
              value={draft.stock}
              onChange={(event) =>
                setDrafts((current) =>
                  current.map((item) =>
                    item.key === draft.key ? { ...item, stock: event.target.value } : item,
                  ),
                )
              }
            />
          </div>
          {canEnterCost ? (
            <div className="mt-3 space-y-3">
              <Input
                label="قیمت خرید هر واحد این گونه (ریال)"
                numeric
                aria-required={isPositiveQuantity(draft.stock)}
                value={draft.purchasePrice}
                onChange={(event) =>
                  setDrafts((current) =>
                    current.map((item) =>
                      item.key === draft.key ? { ...item, purchasePrice: event.target.value } : item,
                    ),
                  )
                }
                hint={
                  <>
                    {isPositiveQuantity(draft.stock)
                      ? PURCHASE_COST_REQUIRED_HINT
                      : PURCHASE_COST_OPTIONAL_HINT}{" "}
                    {PURCHASE_COST_SENSITIVE_HINT}
                  </>
                }
                {...(draftCostErrorFor(draft.key) ? { error: draftCostErrorFor(draft.key) } : {})}
              />
              <UnitProfitPreview
                sellingPrice={draft.price.trim() !== "" ? draft.price : product.basePrice}
                purchasePrice={draft.purchasePrice}
              />
            </div>
          ) : draftCostErrorFor(draft.key) ? (
            <Notice tone="danger" className="mt-3">
              {draftCostErrorFor(draft.key)}
            </Notice>
          ) : (
            <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
              {OPENING_STOCK_NEEDS_MAIN_ADMIN}
            </p>
          )}
          <div className="mt-4">
            <AttributeValuePicker
              attributes={attributes}
              selected={draft.attributeValueIds}
              onChange={(ids) =>
                setDrafts((current) =>
                  current.map((item) =>
                    item.key === draft.key ? { ...item, attributeValueIds: ids } : item,
                  ),
                )
              }
            />
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" isLoading={isPending} onClick={() => submitDraft(draft)}>
              ثبت گونه
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))}
            >
              انصراف
            </Button>
          </div>
        </div>
      ))}

      {/*
        A message this panel has no box for — it edits variants, so a product
        code or visibility refusal has no input here to sit beside. Shown
        whole rather than lost to a field that is not on screen.
      */}
      {unhandledError ? (
        <Notice tone="danger" className="mt-4">
          {unhandledError}
        </Notice>
      ) : null}
      <FormError error={routed.rest} className="mt-4" />

      <Gate permissions={["products.update"]}>
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          leadingIcon={<PlusIcon className="size-4" />}
          onClick={() => setDrafts((current) => [...current, newDraft()])}
        >
          افزودن گونه
        </Button>
      </Gate>
    </Card>
  );
}

function VariantRow({
  variant,
  product,
  attributes,
  onApply,
  isBusy,
  onStockChanged,
  canUpdate,
  onGenerateVariantCode,
  codeError,
}: {
  variant: AdminVariant;
  product: AdminProduct;
  attributes: ProductAttribute[];
  onApply: (patch: CostedUpsertVariantBody) => void;
  isBusy: boolean;
  onStockChanged: () => void;
  canUpdate: boolean;
  onGenerateVariantCode: () => Promise<CodeGenerateResult>;
  /** A server message about THIS row's «کد گونه», routed by the parent. */
  codeError?: string | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(variant.price?.toString() ?? "");
  const [sku, setSku] = useState(variant.sku);
  const [variantCode, setVariantCode] = useState(variant.variantCode);
  const [attributeValueIds, setAttributeValueIds] = useState(
    variant.attributeValues.map((value) => value.id),
  );

  const effective = variant.price !== null ? variant.price : product.basePrice;

  return (
    <li className={cx("rounded-md border p-4", variant.isActive ? "border-line" : "border-line bg-surface-muted")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink" dir="ltr" data-numeric="">
            {variant.sku}
          </p>
          <p className="mt-0.5 text-2xs text-ink-subtle">
            کد گونه: <bdi dir="ltr" data-numeric="">{variant.variantCode || "—"}</bdi>
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {variant.attributeValues.map((value) => value.value).join(" · ") || "بدون ویژگی"}
          </p>
          <p className="mt-1 text-xs text-ink-subtle">
            {variant.price !== null ? (
              <>
                قیمت اختصاصی: <Money value={variant.price} withUnit={false} />
              </>
            ) : (
              <>
                بدون قیمت اختصاصی — قیمت مؤثر <Money value={effective} withUnit={false} />
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex gap-1.5">
            <Badge size="sm" tone={variant.isActive ? "success" : "neutral"}>
              {variant.isActive ? "فعال" : "غیرفعال"}
            </Badge>
            <Badge size="sm" tone={variant.stock > 0 ? "info" : "warning"}>
              موجودی <bdi data-numeric="">{formatInteger(variant.stock)}</bdi>
            </Badge>
          </div>
          {/*
            RETIRING A VARIANT AND REVIVING ONE ARE TWO DIFFERENT CAPABILITIES.
            `PATCH /products/:id` reads `products.update` for an ordinary edit,
            but flipping `isActive` is what takes a product off the shelf — so
            the button is gated on the code for the DIRECTION it performs,
            never on `products.update`. A catalogue editor who may fix a price
            is not thereby allowed to pull the product from sale.
          */}
          <div className="flex flex-wrap justify-end gap-2">
            <Gate permissions={["products.update"]}>
              <Button size="sm" variant="secondary" onClick={() => setEditing((open) => !open)}>
                {editing ? "بستن" : "ویرایش"}
              </Button>
            </Gate>
            <Gate permissions={[variant.isActive ? "products.deactivate" : "products.activate"]}>
              <Button
                size="sm"
                variant="ghost"
                disabled={isBusy}
                onClick={() => onApply({ id: variant.id, isActive: !variant.isActive })}
              >
                {variant.isActive ? "غیرفعال کردن" : "فعال کردن"}
              </Button>
            </Gate>
          </div>
        </div>
      </div>

      {/*
        The SKU box, the price box and the attribute picker live inside this
        block. It was previously reachable only through a gated toggle, which
        made it unreachable in practice but left three editable controls one
        stale state flag away from being rendered to a viewer. `canUpdate` is
        the same decision the toggle makes, restated where the inputs are.
      */}
      {editing && canUpdate ? (
        <div className="mt-4 border-t border-line pt-4">
          <CodeField
            label="کد گونه"
            hint={VARIANT_CODE_HINT}
            maxLength={VARIANT_CODE_MAX}
            value={variantCode}
            onChange={setVariantCode}
            onGenerate={onGenerateVariantCode}
            disabled={isBusy}
            {...(codeError ? { error: codeError } : {})}
          />

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Input label="کد کالا (SKU)" value={sku} onChange={(e) => setSku(e.target.value)} />
            <Input
              label="قیمت گونه (ریال)"
              numeric
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              hint="خالی بگذارید تا قیمت پایهٔ کالا اعمال شود."
            />
          </div>

          <div className="mt-4">
            <AttributeValuePicker
              attributes={attributes}
              selected={attributeValueIds}
              onChange={setAttributeValueIds}
            />
          </div>

          <Button
            size="sm"
            className="mt-4"
            isLoading={isBusy}
            onClick={() =>
              onApply({
                id: variant.id,
                sku: sku.trim(),
                // OMITTED WHEN EMPTY, never sent blank: on an update an absent
                // `variantCode` leaves the stored one alone, while an empty
                // string is a code the server would have to reject.
                ...(variantCode.trim() !== "" ? { variantCode: variantCode.trim() } : {}),
                ...(parseRial(price) !== null ? { price: parseRial(price)! } : {}),
                ...(attributeValueIds.length > 0 ? { attributeValueIds } : {}),
              })
            }
          >
            ذخیرهٔ گونه
          </Button>

          <p className="mt-2 text-2xs text-ink-subtle">
            موجودی از این فرم تغییر نمی‌کند؛ برای آن از بخش زیر استفاده کنید تا حرکت انبار ثبت شود.
          </p>
        </div>
      ) : null}

      <StockAdjuster variant={variant} productId={product.id} onChanged={onStockChanged} />
    </li>
  );
}

/**
 * Reservation-aware stock adjustment.
 *
 * The refusal an operator will actually hit is "this would drop stock below
 * what is already reserved". The server reports it TWICE, from two places: the
 * pre-check answers **409 `STOCK_BELOW_RESERVED`** with
 * `requestedStock`/`physicalStock`/`basketReserved`/`orderAllocated` in
 * `details`, and the authoritative re-check under the variant lock answers
 * **400**. They are the same refusal and are handled identically here — a
 * client that treated the 400 as a validation bug would tell the operator their
 * input was malformed when it was in fact correctly rejected.
 *
 * `allowBelowReserved` is offered only AFTER such a refusal, as an explicit
 * override with its consequence spelled out. Defaulting it on would quietly
 * oversell somebody's basket.
 */
function StockAdjuster({
  variant,
  productId,
  onChanged,
}: {
  variant: AdminVariant;
  productId: number;
  onChanged: () => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"delta" | "set">("delta");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [allowBelowReserved, setAllowBelowReserved] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [result, setResult] = useState<string | null>(null);

  /*
   * AN INCREASE IS NOT THIS FORM'S TO MAKE ANY MORE.
   *
   * Units entering inventory need a purchase cost, so the API refuses a
   * resulting increase with 409 STOCK_INCREASE_REQUIRES_RECEIPT. The form
   * says so before sending: a positive delta, or a «تعیین مقدار دقیق» above
   * the current stock, disables the button and points at «ثبت ورود کالا».
   */
  const parsedValue = parseRial(value);
  const wouldIncrease =
    parsedValue !== null &&
    (mode === "delta" ? parsedValue > 0 : parsedValue > variant.stock);

  const { run: adjust, isPending } = useSubmit(async () => {
    setError(undefined);
    setConflict(null);
    setResult(null);

    const parsed = parseRial(value);
    if (parsed === null || wouldIncrease) return;

    try {
      const response = await api.catalog.adjustVariantStock(variant.id, {
        mode,
        value: parsed,
        ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
        ...(allowBelowReserved ? { allowBelowReserved: true } : {}),
      });
      setResult(
        `موجودی از ${formatInteger(response.data.previousStock)} به ${formatInteger(
          response.data.balanceAfter,
        )} رسید.`,
      );
      setValue("");
      setReason("");
      setAllowBelowReserved(false);
      onChanged();
    } catch (cause) {
      if (!isApiError(cause)) return;
      // BOTH statuses mean the same thing. See the note above.
      const belowReserved =
        cause.code === "STOCK_BELOW_RESERVED" ||
        (cause.status === 400 && cause.code === "STOCK_BELOW_RESERVED");
      if (belowReserved || (cause.status === 409 && cause.details?.basketReserved !== undefined)) {
        setConflict(cause);
        return;
      }
      setError(cause);
    }
  });

  /*
   * THIS PANEL IS A STOCKROOM CONTROL THAT HAPPENS TO SIT IN THE CATALOGUE.
   *
   * It posts to `/products/variants/:variantId/stock/adjust`, which the API
   * guards with `inventory.adjust` — a critical-risk capability — while the
   * page around it opens with `products.read`. Rendering it for a catalogue
   * editor offers them the one button on this screen that moves physical
   * stock and cannot work for them, so it is gated on the capability the
   * ROUTE declares, not on the one that opened the page.
   */
  return (
    <Gate permissions={["inventory.adjust"]}>
    <div className="mt-4 border-t border-line pt-3">
      <Button size="sm" variant="ghost" onClick={() => setOpen((value_) => !value_)}>
        {open ? "بستن کاهش موجودی" : "کاهش موجودی"}
      </Button>

      {open ? (
        <div className="mt-3 space-y-3 rounded-md bg-surface-muted p-3">
          <fieldset>
            <legend className="text-xs font-semibold text-ink-muted">نوع تغییر</legend>
            <div className="mt-1.5 flex gap-2">
              {(["delta", "set"] as const).map((option) => (
                <label
                  key={option}
                  className={cx(
                    "cursor-pointer rounded-md border px-3 py-1.5 text-xs",
                    mode === option
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-line-strong bg-surface text-ink-muted",
                  )}
                >
                  <input
                    type="radio"
                    name={`stock-mode-${variant.id}`}
                    className="sr-only"
                    checked={mode === option}
                    onChange={() => setMode(option)}
                  />
                  {option === "delta" ? "افزایش/کاهش" : "تعیین مقدار دقیق"}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={
                mode === "delta" ? "مقدار کاهش (عدد منفی، مثلاً ۳-)" : "موجودی جدید (کمتر از فعلی)"
              }
              numeric
              // The iOS numeric keypad has no minus key; a decrease needs one.
              inputMode={mode === "delta" ? "text" : "numeric"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="h-9 text-sm"
            />
            <Input
              label="دلیل (اختیاری)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="h-9 text-sm"
              hint="روی حرکت انبار ثبت می‌شود."
            />
          </div>

          {conflict ? (
            <Notice tone="warning" title="این تغییر، موجودی را کمتر از مقدار رزروشده می‌کند">
              <div className="space-y-2">
                <ReservedFacts error={conflict} />
                <label className="flex items-center gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={allowBelowReserved}
                    onChange={(event) => setAllowBelowReserved(event.target.checked)}
                    className="size-4 accent-[color:var(--kz-primary)]"
                  />
                  با آگاهی از اینکه سبد مشتریان تحت تأثیر قرار می‌گیرد، این تغییر را اعمال کن.
                </label>
              </div>
            </Notice>
          ) : null}

          {wouldIncrease || isStockIncreaseRefusal(error) ? (
            <StockIncreaseNotice productId={productId} />
          ) : null}

          {result ? <Notice tone="success">{result}</Notice> : null}
          {isStockIncreaseRefusal(error) ? null : <FormError error={error} />}

          <Button
            size="sm"
            isLoading={isPending}
            disabled={wouldIncrease}
            onClick={() => void adjust()}
          >
            اعمال کاهش موجودی
          </Button>
        </div>
      ) : null}
    </div>
    </Gate>
  );
}

function ReservedFacts({ error }: { error: ApiError }) {
  const details = error.details ?? {};
  const rows: Array<[string, unknown]> = [
    ["موجودی درخواستی", details.requestedStock],
    ["موجودی فعلی", details.physicalStock],
    ["رزرو در سبدها", details.basketReserved],
    ["تخصیص‌یافته به سفارش‌ها", details.orderAllocated],
  ];

  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {rows
        .filter(([, value]) => typeof value === "number")
        .map(([label, value]) => (
          <div key={label} className="flex gap-1">
            <dt className="text-ink-subtle">{label}</dt>
            <dd data-numeric="">{formatInteger(value as number)}</dd>
          </div>
        ))}
    </dl>
  );
}
