"use client";

import { useRef, useState } from "react";

import type { ApiError, ImageView, ProductAttribute } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import { Badge, Button, Input, Spinner, cx, formatInteger } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Gate } from "@/components/admin/ui";
import { ProductImage } from "@/components/catalog/product-image";
import { CloseIcon, PlusIcon, RefreshIcon, TrashIcon } from "@/components/icons";
import { useSubmit } from "@/lib/hooks";
import { useCategories } from "@/components/providers";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function CategoryPicker({
  selected,
  onChange,
  readOnly = false,
}: {
  selected: number[];
  onChange: (ids: number[]) => void;
  /**
   * SEMANTIC READ-ONLY, not a disabled control.
   *
   * A grid of greyed-out toggle buttons is worse than useless to someone who
   * may only look: it is harder to read than plain text, it still receives
   * focus in some browsers, and it invites a click that will never do
   * anything. A viewer gets the answer — which categories this product is in —
   * as a short list of badges, and nothing that looks like a control.
   */
  readOnly?: boolean;
}) {
  const { categories, isLoading } = useCategories();

  if (isLoading) return <Spinner label="در حال بارگذاری دسته‌بندی‌ها" />;

  if (readOnly) {
    const chosen = categories.filter((category) => selected.includes(category.id));
    if (chosen.length === 0) {
      return <p className="text-sm text-ink-subtle">بدون دسته‌بندی</p>;
    }
    return (
      <ul className="flex flex-wrap gap-2">
        {chosen.map((category) => (
          <li key={category.id}>
            <Badge tone="neutral">{category.title}</Badge>
          </li>
        ))}
      </ul>
    );
  }

  if (categories.length === 0) {
    return (
      <p className="text-sm text-ink-subtle">
        هیچ دسته‌بندی‌ای ثبت نشده است. کالا بدون دسته‌بندی هم ساخته می‌شود.
      </p>
    );
  }

  function toggle(id: number) {
    onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {categories.map((category) => {
        const active = selected.includes(category.id);
        return (
          <li key={category.id}>
            <button
              type="button"
              onClick={() => toggle(category.id)}
              aria-pressed={active}
              className={cx(
                "rounded-pill border px-3 py-1.5 text-sm transition-colors duration-150 ease-kz",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                active
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-line-strong bg-surface text-ink-muted hover:border-ink-subtle",
              )}
            >
              {category.title}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export function useAttributes() {
  const api = useApi();
  const { data, error, isLoading } = useApiQuery(
    (signal) => api.catalog.listAttributes({ signal }),
    [api],
  );
  return { attributes: data ?? [], error, isLoading };
}

/**
 * The attribute-value set for ONE variant.
 *
 * The server takes a flat `attributeValueIds` array and treats it as the
 * COMPLETE desired set for that variant, so this component owns the whole list
 * rather than emitting deltas. At most one value per attribute is selectable —
 * a variant that is both "قرمز" and "آبی" is not a variant.
 */
export function AttributeValuePicker({
  attributes,
  selected,
  onChange,
  readOnly = false,
}: {
  attributes: ProductAttribute[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** Semantic read-only — the chosen values as text, not as dead buttons. */
  readOnly?: boolean;
}) {
  if (readOnly) {
    const chosen = attributes
      .map((attribute) => ({
        name: attribute.name,
        values: attribute.values.filter((value) => selected.includes(value.id)),
      }))
      .filter((entry) => entry.values.length > 0);

    if (chosen.length === 0) {
      return <p className="text-xs text-ink-subtle">بدون ویژگی</p>;
    }
    return (
      <dl className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {chosen.map((entry) => (
          <div key={entry.name} className="flex items-baseline gap-1.5">
            <dt className="font-semibold text-ink-muted">{entry.name}:</dt>
            <dd className="text-ink">{entry.values.map((value) => value.value).join("، ")}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (attributes.length === 0) {
    return (
      <p className="text-xs text-ink-subtle">
        هیچ ویژگی‌ای در سامانه تعریف نشده است؛ این گونه بدون ویژگی ثبت می‌شود.
      </p>
    );
  }

  function choose(attribute: ProductAttribute, valueId: number) {
    const otherAttributeValues = selected.filter(
      (id) => !attribute.values.some((value) => value.id === id),
    );
    const alreadyChosen = selected.includes(valueId);
    onChange(alreadyChosen ? otherAttributeValues : [...otherAttributeValues, valueId]);
  }

  return (
    <div className="space-y-3">
      {attributes.map((attribute) => (
        <fieldset key={attribute.id}>
          <legend className="mb-1.5 text-xs font-semibold text-ink-muted">{attribute.name}</legend>
          <ul className="flex flex-wrap gap-1.5">
            {attribute.values.map((value) => {
              const active = selected.includes(value.id);
              return (
                <li key={value.id}>
                  <button
                    type="button"
                    onClick={() => choose(attribute, value.id)}
                    aria-pressed={active}
                    className={cx(
                      "rounded-md border px-2.5 py-1 text-xs transition-colors duration-150 ease-kz",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                      active
                        ? "border-primary bg-primary-soft text-primary"
                        : "border-line-strong bg-surface text-ink-muted",
                    )}
                  >
                    {value.value}
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

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * The formats the server stores, and the size it stores them at.
 *
 * `PRODUCT_IMAGE_MAX_BYTES` MUST TRACK the server constant of the same name;
 * the limit is configurable per deployment, so this copy can drift and the
 * server is the only value that decides anything. The same goes for the type
 * list: the browser reads `File.type` from the file NAME, so a `.png` that is
 * really an SVG passes everything below and is still refused by the magic-byte
 * sniff on the route.
 *
 * Neither check is therefore a guarantee, and neither is meant to be. They
 * exist so the two mistakes an operator actually makes — a 40 MB photo straight
 * off a camera, a PDF dragged in by accident — are answered in the same instant
 * they are made, instead of after a long upload that was doomed before it
 * started.
 */
const ACCEPTED_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");
const MAX_MEGABYTES_LABEL = `${formatInteger(PRODUCT_IMAGE_MAX_BYTES / (1024 * 1024))} مگابایت`;

/**
 * `error` code → Persian, for the moments the SERVER'S OWN sentence is missing.
 *
 * The route already answers in Persian, so this map is not the primary source
 * and must never override one: it covers the two cases where there is no
 * response to quote — a request that never arrived (offline, DNS, a proxy that
 * ate the body) and a pre-flight rejection that was never sent at all. It is
 * worded from the same contract as the server's messages so that the operator
 * reads one voice and never learns there are two.
 *
 * The two storage codes are the OPERATOR'S problem but not the operator's
 * fault, so their wording must not imply that another file, or another attempt,
 * would help. Telling someone to retry a missing bucket wastes their afternoon.
 */
const UPLOAD_ERROR_MESSAGES: Record<string, string> = {
  IMAGE_FILE_REQUIRED: "فایلی برای بارگذاری انتخاب نشد یا فایل خالی بود.",
  IMAGE_MALFORMED: "این فایل تصویر سالمی نیست؛ احتمالاً ناقص یا خراب است.",
  IMAGE_TYPE_UNSUPPORTED: "قالب این فایل پشتیبانی نمی‌شود؛ فقط JPEG، PNG و WebP پذیرفته می‌شود.",
  IMAGE_TOO_LARGE: `حجم این تصویر از حد مجاز بیشتر است؛ حداکثر ${MAX_MEGABYTES_LABEL}.`,
  IMAGE_STORAGE_UNAVAILABLE:
    "فضای ذخیره‌سازی تصویرها در دسترس نیست. ایراد از سرور است، نه از این فایل؛ با پشتیبانی فنی تماس بگیرید.",
  IMAGE_STORAGE_BUCKET_MISSING:
    "فضای ذخیره‌سازی تصویرها هنوز آماده نشده است. ایراد از سرور است، نه از این فایل؛ با پشتیبانی فنی تماس بگیرید.",
};

/** 401 and 403 carry no image code — there, the status IS the whole message. */
const UPLOAD_STATUS_MESSAGES: Record<number, string> = {
  401: "نشست شما منقضی شده است. دوباره وارد شوید و تصویر را بفرستید.",
  403: "اجازهٔ بارگذاری تصویر برای کالا را ندارید.",
};

const UPLOAD_FAILED_OFFLINE = "تصویر به سرور نرسید. اتصال شبکه را بررسی کنید و دوباره تلاش کنید.";
const UPLOAD_FAILED_UNKNOWN = "بارگذاری این تصویر انجام نشد. دوباره تلاش کنید.";

/** A file on its way out: the bytes, plus the id its failure row would reuse. */
interface QueuedUpload {
  /** Only ever compared to other ids — a counter, never the file name, which repeats. */
  id: number;
  file: File;
}

/**
 * A file that did not make it, kept together WITH its `File`.
 *
 * Holding the `File` is the entire point of this type: it is what makes «تلاش
 * دوباره» a button rather than an instruction to open the file dialog again and
 * find the same photo among two hundred.
 */
interface FailedUpload extends QueuedUpload {
  message: string;
}

/**
 * The one Persian sentence to show for one failed upload.
 *
 * ORDER MATTERS. The server's own message wins whenever there is one, because
 * it is the only source that knows the configured limit, which format was
 * detected and which of the two storage faults occurred. Everything after it is
 * a fallback for a failure the server never got to describe.
 */
function uploadErrorMessage(cause: unknown): string {
  if (!isApiError(cause)) return UPLOAD_FAILED_UNKNOWN;
  // `body` is set only when the server answered with the error envelope, and
  // that is exactly the case where `messages[0]` is the promised Persian
  // sentence. Without it, `messages[0]` is a synthetic English string the
  // client invented ("Request timed out after 30000ms", "HTTP 502") and must
  // never reach an operator.
  const fromServer = cause.body ? cause.messages[0] : undefined;
  if (fromServer) return fromServer;

  const byCode = cause.code === undefined ? undefined : UPLOAD_ERROR_MESSAGES[cause.code];
  if (byCode) return byCode;

  const byStatus = UPLOAD_STATUS_MESSAGES[cause.status];
  if (byStatus) return byStatus;

  // `status === 0` is the client's marker for "the request never completed" —
  // transport, timeout or abort. That is a retry worth suggesting; an
  // unrecognised HTTP status is not necessarily.
  return cause.status === 0 ? UPLOAD_FAILED_OFFLINE : UPLOAD_FAILED_UNKNOWN;
}

/**
 * The pre-flight verdict: a Persian sentence, or `undefined` for "send it".
 *
 * AN EMPTY `file.type` IS NOT A REJECTION. The browser derives it from the file
 * NAME, so a perfectly good JPEG saved without an extension reports `""` — and
 * refusing that here would block a file the server, which reads the actual
 * bytes, would have accepted. A courtesy check that produces false refusals is
 * worse than no courtesy check, so an unknown type is passed through and the
 * route decides. A type the browser DOES claim, and that is not on the list, is
 * a real mistake worth catching before a long upload.
 */
function preflightRejection(file: File): string | undefined {
  if (file.size === 0) return UPLOAD_ERROR_MESSAGES.IMAGE_FILE_REQUIRED;
  if (file.type !== "" && !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return UPLOAD_ERROR_MESSAGES.IMAGE_TYPE_UNSUPPORTED;
  }
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return UPLOAD_ERROR_MESSAGES.IMAGE_TOO_LARGE;
  return undefined;
}

/**
 * Product images.
 *
 * `POST /products/uploadImage` returns a DETACHED image; it becomes part of a
 * product only when its id appears in the product's `images` array. On update
 * that array is the COMPLETE desired ordered set — attached images not listed
 * are deleted and `[]` clears them all — so this component always emits the
 * full list, in order, and the array index is the persisted `sortOrder`.
 *
 * ## THE ROUTE VALIDATES NOW, AND IT SAYS WHY
 *
 * This comment used to claim the route enforced no size limit and no
 * content-type filter, so there was no 413 or 415 to react to. That is no
 * longer true and must not be believed: the route sniffs magic bytes, enforces
 * a byte limit, and answers with a stable `error` code next to a Persian
 * sentence — `IMAGE_FILE_REQUIRED`, `IMAGE_MALFORMED`, `IMAGE_TYPE_UNSUPPORTED`
 * (415), `IMAGE_TOO_LARGE` (413), and two 503 storage codes that are an
 * operator's problem rather than a bad file. The client-side checks above
 * remain a courtesy that saves a doomed upload, nothing more.
 *
 * ## ONE ROW PER FILE, BECAUSE IT IS ONE REQUEST PER FILE
 *
 * Uploading five images is five independent requests, each of which has already
 * created — or failed to create — its own detached row server-side. Collapsing
 * those five outcomes into a single error threw away the only two facts the
 * operator needed (WHICH file, and what to do about it) and made the remedy
 * "pick all five again" for one 8 MB photo. So the loop never stops early and
 * never throws: everything that uploaded is committed regardless of what failed
 * after it, and every failure is listed by name, holding its own `File` so it
 * can be re-sent on its own.
 */
export function ImageManager({
  images,
  onChange,
  readOnly = false,
}: {
  images: ImageView[];
  onChange: (images: ImageView[]) => void;
  /**
   * Read-only GALLERY. Reordering and removing are product edits that this
   * component performs locally and the save button then persists, so they were
   * the two controls a `products.read`-only viewer could operate while being
   * told the page was read-only. There is no disabled variant of them: a
   * viewer sees the pictures and their order, and no buttons at all.
   */
  readOnly?: boolean;
}) {
  const api = useApi();
  const [failed, setFailed] = useState<FailedUpload[]>([]);
  // Written only from an event handler, never during render. A counter is
  // enough because these ids are only ever compared to each other.
  const lastQueuedId = useRef(0);

  /*
   * ONE `useSubmit` FOR BOTH ENTRY POINTS — the picker and every retry button.
   * Its in-flight ref is what makes "no duplicate submits" true rather than
   * decorative: `isPending` lags by a render and cannot stop the second half of
   * a double click, and a retry fired during a batch would commit against a
   * stale `images` prop and silently drop the images already in flight.
   */
  const { run: upload, isPending } = useSubmit(async (queued: QueuedUpload[]) => {
    if (queued.length === 0) return;

    const uploaded: ImageView[] = [];
    const failures: FailedUpload[] = [];

    for (const entry of queued) {
      const rejected = preflightRejection(entry.file);
      if (rejected) {
        failures.push({ ...entry, message: rejected });
        continue;
      }
      try {
        const result = await api.catalog.uploadImage(entry.file);
        uploaded.push(result.data);
      } catch (cause) {
        failures.push({ ...entry, message: uploadErrorMessage(cause) });
      }
    }

    // Committed FIRST and unconditionally. These rows exist server-side now;
    // discarding them because a later file failed would orphan real storage
    // objects and lose work the operator already paid the upload time for.
    if (uploaded.length > 0) onChange([...images, ...uploaded]);

    setFailed((current) => {
      const repeated = new Map(failures.map((entry) => [entry.id, entry]));
      const attempted = new Set(queued.map((entry) => entry.id));
      const next: FailedUpload[] = [];
      // A retry rewrites its own row IN PLACE, or removes it. A row that jumps
      // to the bottom of the list under the cursor that just clicked it would
      // put the next retry button where the operator is already pressing.
      for (const entry of current) {
        if (!attempted.has(entry.id)) {
          next.push(entry);
          continue;
        }
        const still = repeated.get(entry.id);
        if (still) next.push(still);
      }
      for (const entry of failures) {
        if (!current.some((existing) => existing.id === entry.id)) next.push(entry);
      }
      return next;
    });
  });

  function queueFiles(files: File[]): QueuedUpload[] {
    return files.map((file) => {
      lastQueuedId.current += 1;
      return { id: lastQueuedId.current, file };
    });
  }

  function dismissFailure(id: number) {
    setFailed((current) => current.filter((entry) => entry.id !== id));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= images.length) return;
    const next = [...images];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  if (readOnly) {
    if (images.length === 0) {
      return <p className="text-sm text-ink-subtle">این کالا تصویری ندارد.</p>;
    }
    return (
      <ul className="flex flex-wrap gap-3">
        {images.map((image, index) => (
          <li key={image.id} className="w-28">
            <div className="overflow-hidden rounded-md border border-line">
              <ProductImage url={image.url} alt="" className="aspect-square w-full" />
            </div>
            <p className="mt-1">
              <Badge size="sm" tone={index === 0 ? "primary" : "neutral"}>
                {index === 0 ? "اصلی" : formatInteger(index + 1)}
              </Badge>
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div>
      <ul className="flex flex-wrap gap-3">
        {images.map((image, index) => (
          <li key={image.id} className="w-28">
            <div className="overflow-hidden rounded-md border border-line">
              <ProductImage url={image.url} alt="" className="aspect-square w-full" />
            </div>
            <div className="mt-1 flex items-center justify-between gap-1">
              <Badge size="sm" tone={index === 0 ? "primary" : "neutral"}>
                {index === 0 ? "اصلی" : formatInteger(index + 1)}
              </Badge>
              <span className="flex gap-0.5">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label="انتقال به ابتدا"
                  className="grid size-6 place-items-center rounded text-xs text-ink-muted disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === images.length - 1}
                  aria-label="انتقال به انتها"
                  className="grid size-6 place-items-center rounded text-xs text-ink-muted disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onChange(images.filter((_, position) => position !== index))}
                  aria-label="حذف تصویر"
                  className="grid size-6 place-items-center rounded text-ink-subtle hover:text-danger"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </span>
            </div>
          </li>
        ))}

        {/*
          UPLOADING IS ITS OWN REQUEST, so it needs its own gate.
          `POST /products/uploadImage` stores a detached row before any product
          is saved, and the API accepts it for a catalogue author
          (`products.create`) or a catalogue editor (`products.update`). Anyone
          else gets a 403 from the picker itself, which is a refusal they never
          needed to trigger — so the picker is not offered to them.
        */}
        <Gate permissions={["products.create", "products.update"]} mode="any">
        <li className="w-28">
          <label
            className={cx(
              "grid aspect-square place-items-center rounded-md border-2 border-dashed border-line text-ink-subtle",
              "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]",
              /*
               * A DISABLED input is what actually stops a second batch: the
               * browser refuses to forward a label click to a disabled control,
               * and the control leaves the tab order, so neither a mouse nor a
               * keyboard can open a second file dialog mid-upload. The only
               * thing left to fix is the cursor, which would otherwise keep
               * promising a dialog that will not open.
               */
              isPending
                ? "cursor-progress opacity-60"
                : "cursor-pointer hover:border-primary hover:text-primary",
            )}
          >
            {isPending ? <Spinner label="در حال بارگذاری تصویر" /> : <PlusIcon />}
            <span className="kz-sr-only">افزودن تصویر</span>
            <input
              type="file"
              accept={IMAGE_ACCEPT_ATTRIBUTE}
              multiple
              disabled={isPending}
              className="sr-only"
              onChange={(event) => {
                const picked = queueFiles(Array.from(event.target.files ?? []));
                // Cleared BEFORE the upload is awaited, so re-picking the very
                // same file after a failure still fires a change event.
                event.target.value = "";
                void upload(picked);
              }}
            />
          </label>
        </li>
        </Gate>
      </ul>

      <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
        ترتیب تصویرها همان ترتیبی است که ذخیره می‌شود؛ تصویر اول، تصویر اصلی کالا در فهرست است.
        قالب‌های پذیرفته‌شده: JPEG، PNG و WebP، هرکدام حداکثر {MAX_MEGABYTES_LABEL}.
      </p>

      {/*
        A LIVE REGION THAT IS ALWAYS MOUNTED.

        An upload finishes while the operator is looking at the rest of a long
        form, not at this corner of it, so a failure has to announce itself. The
        container is rendered empty rather than conditionally, because a region
        that appears together with its first message is announced inconsistently
        across screen readers — the reliable form is a region that already
        exists and whose contents change. `assertive` is right here and would be
        wrong almost anywhere else: the operator is about to press «ذخیره» on a
        product that is missing a picture they believe they added.
      */}
      <div aria-live="assertive" className={cx(failed.length > 0 && "mt-3")}>
        {failed.length > 0 ? (
          <ul className="space-y-2">
            {failed.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  {/*
                    `<bdi>` and not `dir="ltr"`: the file name is the operator's
                    only handle on which of five files this row is about, and a
                    Latin name dropped into an RTL sentence reorders around its
                    punctuation — `pic-01.png` reads as `01.png-pic` — without
                    isolation. The paragraph stays RTL; only the name is fenced.
                  */}
                  <p className="text-xs font-semibold text-ink">
                    <bdi className="break-all">{entry.file.name}</bdi>
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{entry.message}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isPending}
                    aria-label={`تلاش دوباره برای بارگذاری ${entry.file.name}`}
                    leadingIcon={<RefreshIcon className="size-3.5" />}
                    onClick={() => void upload([{ id: entry.id, file: entry.file }])}
                  >
                    تلاش دوباره
                  </Button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => dismissFailure(entry.id)}
                    aria-label={`نادیده گرفتن خطای ${entry.file.name}`}
                    className={cx(
                      "grid size-8 place-items-center rounded text-ink-subtle hover:text-danger disabled:opacity-30",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                    )}
                  >
                    <CloseIcon className="size-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** A labelled block used by both product forms. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{label}</p>
      {hint ? <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * The read-only twin of a labelled `<Input>`.
 *
 * Used wherever a form field would be if the viewer could edit. It is a
 * `<dt>/<dd>` pair rather than an `<input readOnly>` for three reasons: an
 * input with a border still reads as "type here"; a disabled input is rendered
 * at reduced contrast by every browser, which fails the contrast requirement
 * on the one screen whose whole job is to be READ; and a real input is still a
 * focus stop and still submits with the form. This is text.
 */
export function ReadOnlyField({
  label,
  hint,
  value,
  numeric = false,
  multiline = false,
  empty = "—",
}: {
  label: string;
  hint?: string;
  value: string | null | undefined;
  /** Tabular figures and LTR direction, for prices, SKUs and ids. */
  numeric?: boolean;
  /** Preserve the author's line breaks, for a description. */
  multiline?: boolean;
  empty?: string;
}) {
  const text = value === null || value === undefined || value.trim() === "" ? null : value;
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{label}</p>
      {hint ? <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{hint}</p> : null}
      {text === null ? (
        <p className="mt-2 text-sm text-ink-subtle">{empty}</p>
      ) : (
        <p
          className={cx(
            "mt-2 text-sm text-ink",
            multiline && "whitespace-pre-wrap leading-relaxed",
          )}
          {...(numeric ? { "data-numeric": "", dir: "ltr" } : {})}
        >
          {text}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Codes — «کد محصول» and «کد گونه»
// ---------------------------------------------------------------------------

/**
 * The outcome of one generation attempt, as the OWNER of the code reports it.
 *
 * A failure is a `message`, not a thrown error, because two of the failures are
 * not errors at all: "you have not typed a product code yet, so there is
 * nothing to hang a variant code from" is a precondition the caller knows and
 * this field does not. Returning it keeps the API call from being made at all,
 * which is the point.
 */
export type CodeGenerateResult = { ok: true; code: string } | { ok: false; message: string };

const GENERATE_FAILED = "کد ساخته نشد. دوباره تلاش کنید.";

/**
 * A code box with a «تولید خودکار کد» button.
 *
 * ## The generated code is a SUGGESTION, not a lock
 *
 * The server allocates from a sequence and does not reserve what it hands out,
 * so a generated code is an ordinary string the moment it lands in the box: the
 * field stays editable, and abandoning the form just leaves a gap in the
 * sequence. Nothing here re-generates on its own — no effect, no re-render
 * path, no "fill it if empty" convenience. A code changes when, and only when,
 * a human clicks the button.
 *
 * ## Overwrite asks first, INSIDE the page
 *
 * Replacing a non-empty code is destructive in the way that matters to an
 * operator: the code may already be written on a label, a shelf tag or a
 * supplier's sheet. So the first click on a filled box does not call the API —
 * it turns the button into «جایگزین شود؟ بله/خیر». `window.confirm` was the
 * alternative and is rejected on purpose: it blocks the whole tab, cannot be
 * styled or translated reliably, is suppressed outright by some browsers, and
 * reads to a screen reader as a context switch away from the field it is about.
 *
 * Typing in the box cancels a pending confirmation — the question was about a
 * value that no longer exists.
 */
export function CodeField({
  label,
  hint,
  value,
  onChange,
  onGenerate,
  disabled = false,
  error,
  placeholder,
  maxLength,
  generateLabel = "تولید خودکار کد",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  /** Performs the request. Must not be called on a render — only from a click. */
  onGenerate: () => Promise<CodeGenerateResult>;
  disabled?: boolean;
  /** A server-side field error, routed here by {@link routeProductError}. */
  error?: string;
  placeholder?: string;
  /** The column width the server stores this code in. */
  maxLength: number;
  generateLabel?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  // A server message about this field wins over a local generation failure:
  // it is the newer and more specific fact about the value in the box.
  const shownError = error ?? localError;

  // `useSubmit` keeps an in-flight ref, so a double click cannot issue a second
  // request even in the render before `isPending` becomes true.
  const { run: generate, isPending } = useSubmit(async () => {
    setLocalError(undefined);
    try {
      const result = await onGenerate();
      if (result.ok) {
        onChange(result.code);
        setConfirming(false);
      } else {
        setLocalError(result.message);
      }
    } catch (cause) {
      setLocalError(isApiError(cause) ? (cause.messages[0] ?? GENERATE_FAILED) : GENERATE_FAILED);
    }
  });

  function onGenerateClick() {
    setLocalError(undefined);
    // FILLED BOX, FIRST CLICK: ask, do not fetch.
    if (value.trim() !== "" && !confirming) {
      setConfirming(true);
      return;
    }
    void generate();
  }

  return (
    <div>
      <Input
        label={label}
        value={value}
        onChange={(event) => {
          setConfirming(false);
          onChange(event.target.value);
        }}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        maxLength={maxLength}
        // The code is alphanumeric, not a number: `numeric` would set
        // `inputMode="numeric"` and offer a digits-only keypad on a phone.
        // Only the DIRECTION is borrowed, so `A-12` does not reorder in RTL.
        style={{ direction: "ltr" }}
        containerClassName="min-w-0"
        {...(placeholder ? { placeholder } : {})}
        {...(hint ? { hint } : {})}
        {...(shownError ? { error: shownError } : {})}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
        {confirming ? (
          <>
            <span className="text-xs text-ink-muted">این فیلد پر است — جایگزین شود؟</span>
            <Button
              size="sm"
              disabled={disabled}
              isLoading={isPending}
              onClick={() => void generate()}
            >
              بله
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || isPending}
              onClick={() => setConfirming(false)}
            >
              خیر
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            isLoading={isPending}
            onClick={onGenerateClick}
          >
            {generateLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server field errors
// ---------------------------------------------------------------------------

/** The places a product form can print a server message. */
export type ProductErrorField =
  | "productCode"
  | "variantCode"
  | "visibility"
  | "initialStock"
  /** The simple product's «قیمت خرید هر واحد». */
  | "purchasePrice"
  /** One variant row's purchase price; the row is `variantIndex` when known. */
  | "variantPurchasePrice";

export interface RoutedProductError {
  /** At most one entry — a single response names a single field. */
  fields: Partial<Record<ProductErrorField, string>>;
  /**
   * For `variantPurchasePrice`: the index into the `variants` array the
   * request SENT (`details.field` is `variants[2].purchasePrice`). Undefined
   * when the server named no index (`variants[].purchasePrice`, which the
   * edit page's single-draft PATCH produces).
   */
  variantIndex?: number;
  /** What no field claimed. Feed it to `<FormError>` unchanged. */
  rest: ApiError | undefined;
}

/** `variants[3].purchasePrice` / `variants[].purchasePrice`. */
const VARIANT_PURCHASE_PRICE_FIELD = /^variants\[(\d*)\]\.purchasePrice$/;

/** `details.field` → the input that should print the message. */
const FIELD_ROUTES: Record<string, ProductErrorField> = {
  productCode: "productCode",
  variantCode: "variantCode",
  branchIds: "visibility",
  visibleOnSite: "visibility",
  branchVisibility: "visibility",
  visibility: "visibility",
  initialStock: "initialStock",
  purchasePrice: "purchasePrice",
};

/**
 * `error` code → field, for responses that carry no `details.field`.
 *
 * ONLY the unambiguous codes are listed. `CODE_REQUIRED`, `CODE_INVALID`,
 * `CODE_HAS_WHITESPACE` and `CODE_TOO_LONG` describe either code depending on
 * which one was sent, so guessing a field from them would print a product
 * message under a variant box. Those fall through to `<FormError>` unless the
 * response names the field.
 */
const CODE_ROUTES: Record<string, ProductErrorField> = {
  PRODUCT_CODE_TAKEN: "productCode",
  VARIANT_CODE_TAKEN: "variantCode",
  VARIANT_CODE_UNRELATED: "variantCode",
  VISIBILITY_INVALID: "visibility",
  VISIBILITY_FORBIDDEN: "visibility",
  BRANCHES_REQUIRED: "visibility",
  BRANCHES_NOT_ALLOWED_FOR_MODE: "visibility",
  BRANCHES_UNUSABLE: "visibility",
  /*
   * BOTH OPENING-QUANTITY REFUSALS NAME THEIR BOX, so both are listed even
   * though the API already sends `field: "initialStock"` on each of them.
   *
   * They are two different corrections and neither is about the number being
   * malformed, which is why leaving them in `<FormError>` was wrong. One says
   * «this product has variants, so each variant carries its own stock» — the
   * fix is the kind toggle directly above the box. The other says «a positive
   * opening quantity needs the inventory capability, create it at zero and
   * top it up» — the fix is to type 0 in the box itself. In both cases the
   * operator's next action is at this field, so the sentence belongs there
   * and not beside the save button at the foot of a long form.
   */
  INITIAL_STOCK_WITH_VARIANTS: "initialStock",
  INITIAL_STOCK_REQUIRES_INVENTORY_ADJUST: "initialStock",
  /*
   * PURCHASE COST (docs/PURCHASE-COST-ACCOUNTING.md §11). The API names the
   * field on every one of these; the code fallback exists for a response that
   * does not, and sends the sentence to the product-level box rather than to
   * the foot of the form. `PURCHASE_COST_NOT_UPDATABLE` is deliberately
   * absent — it is about an existing variant, which has no cost box here.
   */
  PURCHASE_COST_REQUIRED: "purchasePrice",
  PURCHASE_COST_INVALID: "purchasePrice",
  PURCHASE_COST_OUT_OF_RANGE: "purchasePrice",
  PURCHASE_COST_FORBIDDEN: "purchasePrice",
  INITIAL_STOCK_REQUIRES_PURCHASE_COST: "purchasePrice",
};

/**
 * Splits one API failure into "a message for one input" and "everything else".
 *
 * A 409 «این کد قبلاً استفاده شده» printed at the bottom of a long form, next
 * to the save button, makes the operator hunt for the box it is about. The
 * server already says which one (`details.field`) and already says it in
 * Persian (`messages[0]`), so the only work left is putting the sentence where
 * the eye already is.
 *
 * Anything unrecognised is returned as `rest` and rendered exactly as before —
 * an unmapped field must never swallow the message.
 */
export function routeProductError(error: ApiError | undefined): RoutedProductError {
  if (!error) return { fields: {}, rest: undefined };

  const named = error.details?.field;
  const message = error.messages[0];

  const variantMatch = typeof named === "string" ? VARIANT_PURCHASE_PRICE_FIELD.exec(named) : null;
  if (variantMatch && message) {
    const index = variantMatch[1] ? Number(variantMatch[1]) : undefined;
    return {
      fields: { variantPurchasePrice: message },
      ...(index !== undefined ? { variantIndex: index } : {}),
      rest: undefined,
    };
  }

  const field =
    (typeof named === "string" ? FIELD_ROUTES[named] : undefined) ??
    (error.code ? CODE_ROUTES[error.code] : undefined);

  if (!field || !message) return { fields: {}, rest: error };
  return { fields: { [field]: message }, rest: undefined };
}

/** A destructive-ish action button row used by the variant editor. */
export function InlineActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export { Button as AdminButton };
