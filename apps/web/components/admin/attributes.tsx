"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { isApiError } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Input, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice, Pagination } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  Gate,
  Modal,
  RequirePermission,
  Textarea,
  count,
  useMutation,
} from "@/components/admin/ui";
import { pageInfoOf } from "@/components/admin/people-shared";
import { PencilIcon, PlusIcon, SlidersIcon, TrashIcon } from "@/components/icons";
import {
  addAttributeValues,
  createAttribute,
  deleteAttribute,
  deleteAttributeValue,
  fetchAdminAttributes,
  renameAttribute,
  renameAttributeValue,
} from "@/lib/admin-api";
import type { AdminAttributeRow, AdminAttributeValueRow } from "@/lib/admin-api";
import { adminAttributesHref } from "@/lib/routes";
import { pageParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

/** The server's own default for this screen: the vocabulary is read in one go. */
const PAGE_SIZE = 50;

/**
 * ===========================================================================
 * ATTRIBUTES — the variant vocabulary
 * ===========================================================================
 *
 * One card per attribute, its values inline. That mirrors the API exactly:
 * attributes are paginated, values are not, because half a colour list answers
 * no question anybody has.
 *
 * ## WHY THERE IS NO "SAVE ALL" BUTTON
 *
 * Adding, renaming and deleting are three separate calls and three separate
 * acts, and that is the API's design rather than an omission here:
 * `ProductAttribute.values` is `orphanedRowAction: 'delete'`, so a single
 * "replace the values" write would retire every value the form happened not to
 * send — rows live variants reference and that are frozen into sold order lines.
 * A batch editor over that contract would be one forgotten field away from
 * deleting an option nobody asked to delete.
 *
 * ## WHY A RENAME IS NOT A HISTORY REWRITE
 *
 * `order_items.attributesSnapshot` copies the attribute text at sale time, so
 * renaming «سرمه‌ای» to «آبی نفتی» changes the catalogue and leaves every past
 * order reading as it was rung up. The rename dialog says so before it asks for
 * confirmation, because an operator who believes otherwise will avoid a rename
 * they are entitled to make — or make one believing it will tidy up history.
 */
export function AdminAttributes({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["attributes.read"]}>
      <AttributesBody params={params} />
    </RequirePermission>
  );
}

type Dialog =
  | { kind: "create" }
  | { kind: "rename-attribute"; attribute: AdminAttributeRow }
  | { kind: "delete-attribute"; attribute: AdminAttributeRow }
  | { kind: "add-values"; attribute: AdminAttributeRow }
  | { kind: "rename-value"; attribute: AdminAttributeRow; value: AdminAttributeValueRow }
  | { kind: "delete-value"; attribute: AdminAttributeRow; value: AdminAttributeValueRow };

function AttributesBody({ params }: { params: RawSearchParams }) {
  const api = useApi();
  const page = pageParam(params);

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchAdminAttributes(api, { page, limit: PAGE_SIZE }, { signal }),
    [api, page],
  );

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  function closeAndRefresh(message: string) {
    setDialog(null);
    setFlash(message);
    refetch();
  }

  return (
    <>
      <AdminPageHeader
        title="ویژگی‌ها"
        description="واژگانی که گونه‌های کالا با آن از هم جدا می‌شوند. هر ویژگی یک محور است و هر مقدار یک گزینه روی آن محور."
        meta={
          data ? (
            <Badge tone="neutral" size="sm">
              <bdi data-numeric="">{count(data.total)}</bdi> ویژگی
            </Badge>
          ) : null
        }
        actions={
          <Gate permissions={["attributes.create"]}>
            <Button
              size="sm"
              onClick={() => setDialog({ kind: "create" })}
              leadingIcon={<PlusIcon className="size-4" />}
            >
              ویژگی تازه
            </Button>
          </Gate>
        }
      />

      <Notice
        tone="info"
        title="ویژگی‌ها به حوزهٔ خاصی محدود نیستند"
        icon={<SlidersIcon className="size-5" />}
      >
        <p>
          رنگ، سایز، ظرفیت، جنس و وزن فقط <b>مثال</b> هستند، نه فهرستی ثابت. هر محوری که گونه‌های
          کالای شما را از هم جدا می‌کند می‌تواند یک ویژگی باشد — طول کابل، درجهٔ حرارت کیسه‌خواب،
          تعداد نفر چادر یا هر چیز دیگر. سامانه دربارهٔ معنای این محورها هیچ فرضی ندارد.
        </p>
      </Notice>

      {flash ? (
        <Notice tone="success" className="mt-3">
          <p>{flash}</p>
        </Notice>
      ) : null}

      <div className="mt-5">
        {error ? (
          <ErrorState
            error={error}
            title="فهرست ویژگی‌ها خوانده نشد"
            description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
            onRetry={refetch}
          />
        ) : isLoading || !data ? (
          <div role="status" aria-busy="true" className="space-y-3">
            <span className="kz-sr-only">در حال بارگذاری ویژگی‌ها</span>
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} shape="block" height="9rem" />
            ))}
          </div>
        ) : data.data.length === 0 ? (
          <AdminSection title="هنوز ویژگی‌ای ثبت نشده است">
            <p className="text-sm leading-relaxed text-ink-muted">
              تا زمانی که ویژگی‌ای وجود نداشته باشد، هر کالا فقط یک گونهٔ بدون مشخصه دارد. اولین
              ویژگی را بسازید تا بتوانید گونه‌های متفاوت یک کالا را از هم جدا کنید.
            </p>
          </AdminSection>
        ) : (
          <>
            <div className="space-y-4">
              {data.data.map((attribute) => (
                <AttributeCard
                  key={attribute.id}
                  attribute={attribute}
                  onAct={(next) => setDialog(next)}
                />
              ))}
            </div>

            <Pagination
              className="mt-6"
              pageInfo={pageInfoOf(data)}
              buildHref={(target) =>
                adminAttributesHref(target > 1 ? { page: target } : {})
              }
            />
          </>
        )}
      </div>

      {dialog?.kind === "create" ? (
        <CreateAttributeDialog
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("ویژگی تازه با مقادیرش ساخته شد.")}
        />
      ) : null}

      {dialog?.kind === "rename-attribute" ? (
        <RenameAttributeDialog
          attribute={dialog.attribute}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("نام ویژگی تغییر کرد.")}
        />
      ) : null}

      {dialog?.kind === "add-values" ? (
        <AddValuesDialog
          attribute={dialog.attribute}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("مقادیر تازه اضافه شدند.")}
        />
      ) : null}

      {dialog?.kind === "rename-value" ? (
        <RenameValueDialog
          attribute={dialog.attribute}
          value={dialog.value}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("نام مقدار از این پس تغییر کرد؛ سفارش‌های گذشته دست‌نخورده‌اند.")}
        />
      ) : null}

      {dialog?.kind === "delete-attribute" ? (
        <DeleteAttributeDialog
          attribute={dialog.attribute}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("ویژگی و همهٔ مقادیرش حذف شدند.")}
        />
      ) : null}

      {dialog?.kind === "delete-value" ? (
        <DeleteValueDialog
          attribute={dialog.attribute}
          value={dialog.value}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("مقدار حذف شد.")}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// One attribute
// ---------------------------------------------------------------------------

/**
 * `variantCount` is per VALUE and the API gives no per-attribute total, so the
 * card reports the two things it can prove: how many values exist and how many
 * of them no variant uses. Summing the per-value counts would invent a number
 * (one variant can sit under several values of different attributes) — and the
 * unused count is the one that actually predicts which deletes will succeed.
 */
function AttributeCard({
  attribute,
  onAct,
}: {
  attribute: AdminAttributeRow;
  onAct: (dialog: Dialog) => void;
}) {
  const unused = attribute.values.filter((value) => value.variantCount === 0).length;

  return (
    <AdminSection
      title={
        <span className="flex flex-wrap items-center gap-2">
          {attribute.name}
          <Badge tone="neutral" size="sm">
            <bdi data-numeric="">{count(attribute.values.length)}</bdi> مقدار
          </Badge>
          {unused > 0 ? (
            <Badge tone="warning" size="sm">
              <bdi data-numeric="">{count(unused)}</bdi> مقدار بی‌استفاده
            </Badge>
          ) : null}
        </span>
      }
      description={
        <>
          شناسهٔ ویژگی <bdi data-numeric="">{count(attribute.id)}</bdi> — عدد کنار هر مقدار، تعداد
          گونه‌های کالایی است که همین حالا از آن استفاده می‌کنند.
        </>
      }
      actions={
        <>
          <Gate permissions={["attributes.update"]}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAct({ kind: "rename-attribute", attribute })}
              leadingIcon={<PencilIcon className="size-4" />}
            >
              تغییر نام ویژگی
            </Button>
          </Gate>
          <Gate permissions={["attributes.create"]}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onAct({ kind: "add-values", attribute })}
              leadingIcon={<PlusIcon className="size-4" />}
            >
              افزودن مقدار
            </Button>
          </Gate>
          <Gate permissions={["attributes.delete"]}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAct({ kind: "delete-attribute", attribute })}
              leadingIcon={<TrashIcon className="size-4" />}
            >
              حذف ویژگی
            </Button>
          </Gate>
        </>
      }
    >
      {attribute.values.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          این ویژگی هیچ مقداری ندارد و تا وقتی مقداری نداشته باشد در ساخت گونه به کار نمی‌آید.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {attribute.values.map((value) => (
            <li
              key={value.id}
              className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-surface-muted py-1.5 pe-2 ps-3"
            >
              <span className="min-w-0 text-sm text-ink">{value.value}</span>
              <Badge tone={value.variantCount > 0 ? "info" : "neutral"} size="sm">
                <bdi data-numeric="">{count(value.variantCount)}</bdi> گونه
              </Badge>
              <Gate permissions={["attributes.update"]}>
                <button
                  type="button"
                  onClick={() => onAct({ kind: "rename-value", attribute, value })}
                  aria-label={`تغییر نام مقدار ${value.value}`}
                  className="rounded-md p-1 text-ink-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
                >
                  <PencilIcon className="size-4" />
                </button>
              </Gate>
              <Gate permissions={["attributes.delete"]}>
                <button
                  type="button"
                  onClick={() => onAct({ kind: "delete-value", attribute, value })}
                  aria-label={`حذف مقدار ${value.value}`}
                  className="rounded-md p-1 text-ink-subtle hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
                >
                  <TrashIcon className="size-4" />
                </button>
              </Gate>
            </li>
          ))}
        </ul>
      )}
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Create an attribute
// ---------------------------------------------------------------------------

/** One value per line: the API wants an array and a human types a list. */
function parseValues(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const value = line.trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function CreateAttributeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const [name, setName] = useState("");
  const [raw, setRaw] = useState("");
  const values = parseValues(raw);

  const { run, isPending, error } = useMutation(() =>
    createAttribute(api, { name: name.trim(), values }),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (result) onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="ساخت ویژگی تازه"
      description="یک ویژگی دست‌کم به یک مقدار نیاز دارد، چون ویژگی بی‌مقدار در ساخت گونه به کار نمی‌آید."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button
            form="create-attribute"
            type="submit"
            isLoading={isPending}
            disabled={name.trim() === "" || values.length === 0}
          >
            ساخت ویژگی
          </Button>
        </>
      }
    >
      <form id="create-attribute" onSubmit={submit} className="space-y-3">
        <Input
          label="نام ویژگی"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          autoComplete="off"
          hint="مثلاً «رنگ»، «ظرفیت» یا «درجهٔ حرارت». نام‌ها یکتا هستند."
        />
        <Textarea
          label="مقادیر — هر مقدار در یک خط"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          hint={
            values.length === 0
              ? "دست‌کم یک مقدار لازم است. خطوط خالی و تکراری نادیده گرفته می‌شوند."
              : `${count(values.length)} مقدار خوانده شد: ${values.join("، ")}`
          }
        />
        <AttributeFailure error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Rename an attribute
// ---------------------------------------------------------------------------

function RenameAttributeDialog({
  attribute,
  onClose,
  onDone,
}: {
  attribute: AdminAttributeRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState(attribute.name);
  const { run, isPending, error } = useMutation(() =>
    renameAttribute(api, attribute.id, { name: name.trim() }),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (result) onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`تغییر نام ویژگی «${attribute.name}»`}
      description="مقادیر این ویژگی و گونه‌هایی که از آن استفاده می‌کنند دست‌نخورده می‌مانند."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button
            form="rename-attribute"
            type="submit"
            isLoading={isPending}
            disabled={name.trim() === "" || name.trim() === attribute.name}
          >
            ثبت نام تازه
          </Button>
        </>
      }
    >
      <form id="rename-attribute" onSubmit={submit} className="space-y-3">
        <Input
          label="نام تازهٔ ویژگی"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          autoComplete="off"
        />
        <HistoryWarning />
        <AttributeFailure error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add values
// ---------------------------------------------------------------------------

function AddValuesDialog({
  attribute,
  onClose,
  onDone,
}: {
  attribute: AdminAttributeRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const [raw, setRaw] = useState("");
  const values = parseValues(raw);

  const { run, isPending, error } = useMutation(() =>
    addAttributeValues(api, attribute.id, { values }),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (result) onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`افزودن مقدار به «${attribute.name}»`}
      description="مقادیر تازه اضافه می‌شوند و مقادیر فعلی دست‌نخورده می‌مانند؛ این کار هیچ مقداری را حذف نمی‌کند."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button
            form="add-values"
            type="submit"
            isLoading={isPending}
            disabled={values.length === 0}
          >
            افزودن
          </Button>
        </>
      }
    >
      <form id="add-values" onSubmit={submit} className="space-y-3">
        <Textarea
          label="مقادیر تازه — هر مقدار در یک خط"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          hint={
            values.length === 0
              ? "دست‌کم یک مقدار بنویسید. خطوط خالی و تکراری نادیده گرفته می‌شوند."
              : `${count(values.length)} مقدار خوانده شد: ${values.join("، ")}`
          }
        />
        <p className="text-xs leading-relaxed text-ink-subtle">
          مقادیر فعلی:{" "}
          {attribute.values.length === 0
            ? "—"
            : attribute.values.map((value) => value.value).join("، ")}
        </p>
        <AttributeFailure error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Rename a value
// ---------------------------------------------------------------------------

/**
 * The warning is rendered BEFORE the confirm button, not after the fact.
 *
 * A rename here is a catalogue edit, not a correction of history. The operator
 * has to know that before pressing the button: told afterwards, the only thing
 * they can do about a rename they did not intend is another rename.
 */
function RenameValueDialog({
  attribute,
  value,
  onClose,
  onDone,
}: {
  attribute: AdminAttributeRow;
  value: AdminAttributeValueRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState(value.value);
  const { run, isPending, error } = useMutation(() =>
    renameAttributeValue(api, value.id, { value: text.trim() }),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (result) onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`تغییر نام مقدار «${value.value}»`}
      description={`این مقدار روی محور «${attribute.name}» قرار دارد.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button
            form="rename-value"
            type="submit"
            isLoading={isPending}
            disabled={text.trim() === "" || text.trim() === value.value}
          >
            ثبت نام تازه
          </Button>
        </>
      }
    >
      <form id="rename-value" onSubmit={submit} className="space-y-3">
        <Input
          label="نام تازهٔ مقدار"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={200}
          autoComplete="off"
        />
        <Notice tone="warning" title="نام تازه فقط از این پس اعمال می‌شود">
          <p>
            سفارش‌های گذشته بازنویسی <b>نمی‌شوند</b>. هر ردیف فروش، متن ویژگی را همان‌طور که در لحظهٔ
            فروش بوده نگه می‌دارد؛ پس فاکتورها و سابقهٔ سفارش‌ها همان «{value.value}» را نشان خواهند
            داد.
          </p>
          <p className="mt-1.5">
            این تغییر روی{" "}
            <bdi data-numeric="">{count(value.variantCount)}</bdi> گونهٔ کالا در کاتالوگ، سایت و
            صندوق دیده می‌شود. موجودی، قیمت و هیچ سفارشی تغییر نمی‌کند.
          </p>
        </Notice>
        <AttributeFailure error={error} />
      </form>
    </Modal>
  );
}

/** The same promise, for an attribute NAME rather than one of its values. */
function HistoryWarning() {
  return (
    <Notice tone="warning" title="نام تازه فقط از این پس اعمال می‌شود">
      <p>
        سفارش‌های گذشته بازنویسی نمی‌شوند: نام ویژگی و مقدار آن در لحظهٔ فروش روی ردیف سفارش کپی
        می‌شود و همان‌جا می‌ماند. موجودی و مبالغ هم تغییری نمی‌کنند.
      </p>
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

function DeleteAttributeDialog({
  attribute,
  onClose,
  onDone,
}: {
  attribute: AdminAttributeRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const { run, isPending, error } = useMutation(() => deleteAttribute(api, attribute.id));
  const inUse = attribute.values.filter((value) => value.variantCount > 0);

  async function confirm() {
    const result = await run();
    if (result) onDone();
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={confirm}
      isPending={isPending}
      title={`حذف ویژگی «${attribute.name}»`}
      question="این محور و همهٔ مقادیرش از واژگان کاتالوگ برداشته می‌شوند."
      confirmLabel="حذف ویژگی"
      consequences={[
        `همهٔ ${count(attribute.values.length)} مقدار این ویژگی هم با آن حذف می‌شوند.`,
        "هیچ کالا و هیچ گونه‌ای حذف نمی‌شود، هیچ پولی جابه‌جا نمی‌شود و موجودی انبار تغییر نمی‌کند.",
        "سفارش‌های گذشته دست‌نخورده می‌مانند: متن ویژگی در لحظهٔ فروش روی ردیف سفارش کپی شده است.",
        inUse.length > 0
          ? `تا وقتی گونه‌ای از مقادیر این ویژگی استفاده کند، سرور حذف را رد می‌کند — ${count(inUse.length)} مقدار همین حالا در حال استفاده است.`
          : "در حال حاضر هیچ گونه‌ای از مقادیر این ویژگی استفاده نمی‌کند، پس حذف باید انجام شود.",
        "برگشت‌پذیر نیست: برای بازگرداندن باید ویژگی و همهٔ مقادیرش را از نو بسازید.",
      ]}
    >
      <AttributeFailure error={error} />
    </ConfirmDialog>
  );
}

function DeleteValueDialog({
  attribute,
  value,
  onClose,
  onDone,
}: {
  attribute: AdminAttributeRow;
  value: AdminAttributeValueRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const { run, isPending, error } = useMutation(() => deleteAttributeValue(api, value.id));

  async function confirm() {
    const result = await run();
    if (result) onDone();
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={confirm}
      isPending={isPending}
      title={`حذف مقدار «${value.value}»`}
      question={`این گزینه از محور «${attribute.name}» برداشته می‌شود.`}
      confirmLabel="حذف مقدار"
      consequences={[
        value.variantCount > 0
          ? `${count(value.variantCount)} گونهٔ کالا همین حالا از این مقدار استفاده می‌کند، پس سرور حذف را رد می‌کند و چیزی تغییر نمی‌کند.`
          : "هیچ گونه‌ای از این مقدار استفاده نمی‌کند، پس حذف باید انجام شود.",
        "هیچ کالا و هیچ گونه‌ای حذف نمی‌شود، هیچ پولی جابه‌جا نمی‌شود و موجودی انبار تغییر نمی‌کند.",
        "سفارش‌های گذشته دست‌نخورده می‌مانند و همین متن را نشان می‌دهند.",
        "برگشت‌پذیر نیست: مقدار حذف‌شده با همان شناسه بازنمی‌گردد و باید از نو ساخته شود.",
      ]}
    >
      <AttributeFailure error={error} />
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Branches on `error.code`. `ATTRIBUTE_IN_USE` carries a `variantCount` and
 * nothing else — the API has no endpoint that lists WHICH variants block the
 * delete, so this reports the count and says so rather than implying the
 * operator can go and find them from here.
 */
function AttributeFailure({ error }: { error: unknown }) {
  if (!error) return null;

  const api = isApiError(error) ? error : null;
  const details = api?.details;

  if (api?.code === "ATTRIBUTE_IN_USE") {
    const blocked = typeof details?.["variantCount"] === "number" ? details["variantCount"] : null;
    return (
      <Notice tone="warning" title="این مورد در حال استفاده است و حذف نشد">
        <p>
          {blocked === null ? (
            <>گونه‌هایی از کالا هنوز از آن استفاده می‌کنند.</>
          ) : (
            <>
              <bdi data-numeric="">{count(blocked)}</bdi> گونهٔ کالا هنوز از آن استفاده می‌کند.
            </>
          )}{" "}
          سرور حذف را رد کرد و هیچ تغییری ثبت نشد.
        </p>
        <p className="mt-1.5">
          فهرست این گونه‌ها از سمت API در دسترس نیست، پس این صفحه فقط می‌تواند تعداد را صادقانه
          گزارش کند. برای پیدا کردن آن‌ها باید در صفحهٔ کالاها بگردید و گونه‌ها را یکی‌یکی به مقدار
          دیگری تغییر دهید.
        </p>
      </Notice>
    );
  }

  if (api?.code === "ATTRIBUTE_ALREADY_EXISTS") {
    return (
      <Notice tone="danger" title="ویژگی دیگری همین نام را دارد">
        <p>نام‌ها یکتا هستند. نام دیگری بگذارید؛ چیزی ثبت نشد.</p>
      </Notice>
    );
  }

  if (api?.code === "ATTRIBUTE_VALUE_ALREADY_EXISTS") {
    const values = Array.isArray(details?.["values"])
      ? (details["values"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    return (
      <Notice tone="danger" title="این مقدار از قبل روی همین ویژگی وجود دارد">
        <p>
          {values.length > 0
            ? `${values.join("، ")} قبلاً ثبت شده است. `
            : "یکی از مقادیر قبلاً ثبت شده است. "}
          هیچ مقداری اضافه نشد — درخواست به‌طور کامل رد شد، نه بخشی از آن.
        </p>
      </Notice>
    );
  }

  if (api?.status === 403) {
    return (
      <Notice tone="danger" title="حساب شما اجازهٔ این کار را ندارد">
        <p>
          سرور این درخواست را رد کرد و هیچ تغییری ثبت نشد. از مدیر ارشد بخواهید اختیار لازم را به
          نقش شما اضافه کند.
        </p>
      </Notice>
    );
  }

  if (api?.status === 404) {
    return (
      <Notice tone="warning" title="این مورد دیگر وجود ندارد">
        <p>
          ممکن است همین حالا شخص دیگری آن را حذف کرده باشد. صفحه را به‌روز کنید تا وضعیت واقعی را
          ببینید.
        </p>
      </Notice>
    );
  }

  return <FormError error={error} />;
}
