"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { isApiError } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Input } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice, Pagination } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  DataTable,
  EmptyRow,
  Gate,
  Modal,
  RequirePermission,
  TableSkeleton,
  Td,
  Th,
  Tr,
  count,
  useMutation,
  when,
} from "@/components/admin/ui";
import { pageInfoOf } from "@/components/admin/people-shared";
import { PencilIcon, PlusIcon, RefreshIcon, TagIcon, TrashIcon } from "@/components/icons";
import {
  createCategory,
  deleteCategory,
  fetchAdminCategories,
  renameCategory,
} from "@/lib/admin-api";
import type { AdminCategoryRow } from "@/lib/admin-api";
import {
  adminCategoriesHref,
  adminProductsInCategoryHref,
} from "@/lib/routes";
import { pageParam, textParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 20;

/**
 * ===========================================================================
 * CATEGORIES
 * ===========================================================================
 *
 * The whole screen is four operations on a title: list, create, rename, delete.
 * Which products are IN a category is NOT editable here, because the API does
 * not model it that way — `categoryIds` on product create/update is the complete
 * desired set for one product, so membership is owned by the product screen.
 * Offering a "move products" control here would have to fake it with N product
 * updates and would be lying about atomicity.
 *
 * ## THE LIST IS FLAT, AND THE SCREEN SAYS SO
 *
 * `categories` has no `parentId` column. There is no tree to read, so this
 * screen offers none — no indentation, no "parent" select, and no naming
 * convention (`کمپینگ / چادر`) standing in for one. A faked hierarchy is worse
 * than none: it cannot be filtered on, the storefront cannot walk it, and the
 * first person to rename a category breaks it silently. The notice at the top
 * states the limitation and names what it would actually take to lift it.
 */
export function AdminCategories({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["categories.read"]}>
      <CategoriesBody params={params} />
    </RequirePermission>
  );
}

function CategoriesBody({ params }: { params: RawSearchParams }) {
  const api = useApi();
  const router = useRouter();

  const page = pageParam(params);
  const search = textParam(params, "search");

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) =>
      fetchAdminCategories(api, { page, limit: PAGE_SIZE, ...(search ? { search } : {}) }, { signal }),
    [api, page, search],
  );

  /** Which dialog is open, and on which row. One state so two cannot stack. */
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "rename"; row: AdminCategoryRow } | { kind: "delete"; row: AdminCategoryRow } | null
  >(null);

  const [flash, setFlash] = useState<string | null>(null);

  function closeAndRefresh(message: string) {
    setDialog(null);
    setFlash(message);
    refetch();
  }

  /*
   * The search box is uncontrolled and keyed by the URL's own term: the URL owns
   * the filter, so a refresh, a shared link and the back button all show the
   * same result set. Submitting always returns to page 1 — staying on page 4 of
   * a narrower result set is how an operator lands on an empty table and reads
   * it as "nothing matched".
   */
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get("search");
    const value = typeof typed === "string" ? typed.trim().slice(0, 200) : "";
    router.push(adminCategoriesHref(value === "" ? {} : { search: value }));
  }

  return (
    <>
      <AdminPageHeader
        title="دسته‌بندی‌ها"
        description="گروه‌بندی کالاها برای فروشگاه اینترنتی و صندوق. این‌که هر کالا در کدام دسته‌ها باشد، از صفحهٔ خود آن کالا تعیین می‌شود."
        meta={
          data ? (
            <Badge tone="neutral" size="sm">
              <bdi data-numeric="">{count(data.total)}</bdi> دسته
            </Badge>
          ) : null
        }
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
            <Gate permissions={["categories.create"]}>
              <Button
                size="sm"
                onClick={() => setDialog({ kind: "create" })}
                leadingIcon={<PlusIcon className="size-4" />}
              >
                دستهٔ تازه
              </Button>
            </Gate>
          </>
        }
      />

      <Notice
        tone="info"
        title="دسته‌بندی‌ها در این سامانه تک‌سطحی‌اند"
        icon={<TagIcon className="size-5" />}
      >
        <p>
          جدول دسته‌بندی‌ها در پایگاه داده هیچ ستون «والد» ندارد، پس زیرشاخه در این سامانه قابل ثبت
          نیست و این صفحه هم آن را پیشنهاد نمی‌کند.
        </p>
        <p className="mt-1.5">
          اگر ساختار درختی لازم است، این یک تصمیم دربارهٔ ساختار داده است، نه یک تنظیم در این صفحه:
          افزودن ستون <bdi dir="ltr">parentId</bdi>، یک مهاجرت پایگاه داده و تغییر در سرویس‌های API.
          تا آن زمان این‌جا با تو‌رفتگی یا نام‌گذاری قراردادی سلسله‌مراتب ساختگی نمی‌سازیم؛ چیزی که
          در داده وجود ندارد نباید در صفحه وجود داشته باشد.
        </p>
      </Notice>

      {flash ? (
        <Notice tone="success" className="mt-3">
          <p>{flash}</p>
        </Notice>
      ) : null}

      <form onSubmit={submitSearch} role="search" className="mt-5 flex max-w-md items-end gap-2">
        <Input
          key={search ?? ""}
          name="search"
          type="search"
          label="جست‌وجو در عنوان دسته"
          defaultValue={search ?? ""}
          containerClassName="flex-1"
          maxLength={200}
        />
        <Button type="submit" variant="secondary">
          جست‌وجو
        </Button>
        {search ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push(adminCategoriesHref({}))}
          >
            پاک‌کردن
          </Button>
        ) : null}
      </form>

      <div className="mt-5">
        {error ? (
          <ErrorState
            error={error}
            title="فهرست دسته‌بندی‌ها خوانده نشد"
            description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
            onRetry={refetch}
          />
        ) : isLoading || !data ? (
          <TableSkeleton rows={6} columns={4} />
        ) : (
          <>
            <DataTable minWidth="42rem" caption="فهرست دسته‌بندی‌ها">
              <thead>
                <tr>
                  <Th>عنوان دسته</Th>
                  <Th numeric>تعداد کالا</Th>
                  <Th>تاریخ ساخت</Th>
                  <Th className="w-px">اقدام</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 ? (
                  <EmptyRow colSpan={4}>
                    {search
                      ? "دسته‌ای با این عبارت پیدا نشد."
                      : "هنوز دسته‌بندی‌ای ساخته نشده است. کالا بدون دسته هم ثبت می‌شود."}
                  </EmptyRow>
                ) : (
                  data.data.map((row) => (
                    <Tr key={row.id}>
                      <Td>
                        <span className="text-sm font-bold text-ink">{row.title}</span>
                        <span className="mt-0.5 block text-2xs text-ink-subtle">
                          شناسه <bdi data-numeric="">{count(row.id)}</bdi>
                        </span>
                      </Td>
                      <Td numeric>
                        {/*
                          The COUNT comes from this page's own
                          `categories.read` query; the LINK opens the catalogue,
                          which declares `products.read`. The number is shown
                          either way and only the navigation is withheld.
                        */}
                        {row.productCount === 0 ? (
                          <span className="text-ink-subtle">۰</span>
                        ) : (
                          <Gate
                            permissions={["products.read"]}
                            fallback={<bdi data-numeric="">{count(row.productCount)}</bdi>}
                          >
                            <Link
                              href={adminProductsInCategoryHref(row.id)}
                              className="text-primary no-underline"
                            >
                              <bdi data-numeric="">{count(row.productCount)}</bdi>
                            </Link>
                          </Gate>
                        )}
                      </Td>
                      <Td>
                        <span className="text-2xs text-ink-muted" data-numeric="">
                          {when(row.createdAt)}
                        </span>
                      </Td>
                      <Td>
                        <div className="flex justify-end gap-1.5">
                          <Gate permissions={["categories.update"]}>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: "rename", row })}
                              leadingIcon={<PencilIcon className="size-4" />}
                            >
                              تغییر نام
                            </Button>
                          </Gate>
                          <Gate permissions={["categories.delete"]}>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: "delete", row })}
                              leadingIcon={<TrashIcon className="size-4" />}
                            >
                              حذف
                            </Button>
                          </Gate>
                        </div>
                      </Td>
                    </Tr>
                  ))
                )}
              </tbody>
            </DataTable>

            <Pagination
              className="mt-6"
              pageInfo={pageInfoOf(data)}
              buildHref={(target) =>
                adminCategoriesHref({
                  ...(search ? { search } : {}),
                  ...(target > 1 ? { page: target } : {}),
                })
              }
            />
          </>
        )}
      </div>

      <AdminSection
        className="mt-6"
        title="چه کاری از این صفحه انجام نمی‌شود"
        description="تا کسی وقت نگذارد و دنبال دکمه‌ای نگردد که وجود ندارد."
      >
        <ul className="space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>
            جابه‌جا کردن کالاها بین دسته‌ها: عضویت کالا در دسته از صفحهٔ کالا تعیین می‌شود، چون API
            مجموعهٔ کامل دسته‌های یک کالا را یک‌جا می‌گیرد.
          </li>
          <li>
            ساخت زیردسته: در پایگاه داده ستون والد وجود ندارد (بالای همین صفحه توضیح داده شده).
          </li>
          <li>
            حذف دسته‌ای که کالا دارد: سرور آن را رد می‌کند. اول کالاها را از دسته خارج کنید.
          </li>
        </ul>
      </AdminSection>

      {dialog?.kind === "create" ? (
        <CreateCategoryDialog
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("دستهٔ تازه ساخته شد.")}
        />
      ) : null}

      {dialog?.kind === "rename" ? (
        <RenameCategoryDialog
          row={dialog.row}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("نام دسته تغییر کرد.")}
        />
      ) : null}

      {dialog?.kind === "delete" ? (
        <DeleteCategoryDialog
          row={dialog.row}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh("دسته حذف شد. هیچ کالایی حذف نشد.")}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Mounted only while open, so the field starts empty on every open without an
 * effect resetting it — `react-hooks/set-state-in-effect` is an error in this
 * repo, and a keyed remount is the honest version of the same intent anyway.
 */
function CreateCategoryDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const [title, setTitle] = useState("");
  const { run, isPending, error } = useMutation(() => createCategory(api, { title: title.trim() }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (result) onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="ساخت دستهٔ تازه"
      description="فقط یک عنوان لازم است. کالاها بعداً از صفحهٔ خودشان به این دسته اضافه می‌شوند."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button form="create-category" type="submit" isLoading={isPending} disabled={title.trim() === ""}>
            ساخت دسته
          </Button>
        </>
      }
    >
      <form id="create-category" onSubmit={submit} className="space-y-3">
        <Input
          label="عنوان دسته"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          autoComplete="off"
          hint="عنوان‌ها بدون توجه به بزرگی و کوچکی حروف یکتا هستند؛ دستهٔ هم‌نام پذیرفته نمی‌شود."
        />
        <CategoryFailure error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

function RenameCategoryDialog({
  row,
  onClose,
  onDone,
}: {
  row: AdminCategoryRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const [title, setTitle] = useState(row.title);
  const { run, isPending, error } = useMutation(() =>
    renameCategory(api, row.id, { title: title.trim() }),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run();
    if (result) onDone();
  }

  const unchanged = title.trim() === "" || title.trim() === row.title;

  return (
    <Modal
      open
      onClose={onClose}
      title={`تغییر نام «${row.title}»`}
      description="فقط عنوان عوض می‌شود. عضویت کالاها، موجودی و سفارش‌ها دست‌نخورده می‌مانند."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            انصراف
          </Button>
          <Button form="rename-category" type="submit" isLoading={isPending} disabled={unchanged}>
            ثبت نام تازه
          </Button>
        </>
      }
    >
      <form id="rename-category" onSubmit={submit} className="space-y-3">
        <Input
          label="عنوان تازه"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          autoComplete="off"
        />
        <p className="text-xs leading-relaxed text-ink-subtle">
          <bdi data-numeric="">{count(row.productCount)}</bdi> کالا در این دسته است. نام تازه از این
          پس در سایت و صندوق دیده می‌شود.
        </p>
        <CategoryFailure error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * The delete, with its consequences spelled out.
 *
 * The refusal is the interesting path: the server answers 409 `CATEGORY_IN_USE`
 * with `details.productCount`, and the only useful thing to hand the manager at
 * that moment is a link to the products that are blocking it. Re-reading the
 * count from the failure rather than from the row we listed matters, because the
 * list may be minutes old and somebody else may have added a product since.
 */
function DeleteCategoryDialog({
  row,
  onClose,
  onDone,
}: {
  row: AdminCategoryRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const { run, isPending, error } = useMutation(() => deleteCategory(api, row.id));

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
      title={`حذف دستهٔ «${row.title}»`}
      question="این دسته از فهرست گروه‌بندی‌ها برداشته می‌شود."
      confirmLabel="حذف دسته"
      consequences={[
        "فقط همین گروه‌بندی حذف می‌شود؛ هیچ کالایی حذف نمی‌شود و هیچ کالایی از کاتالوگ خارج نمی‌شود.",
        "هیچ پولی جابه‌جا نمی‌شود و وضعیت هیچ سفارشی تغییر نمی‌کند.",
        "موجودی انبار دست‌نخورده می‌ماند؛ این کار هیچ حرکتی در دفتر موجودی ثبت نمی‌کند.",
        "تا وقتی حتی یک کالا در این دسته باشد، سرور حذف را رد می‌کند و چیزی تغییر نمی‌کند.",
        "برگشت‌پذیر نیست: عضویت کالاها در این دسته جای دیگری ثبت نشده و پس از حذف بازسازی نمی‌شود — باید دسته را از نو بسازید و کالاها را یکی‌یکی به آن برگردانید.",
      ]}
    >
      <CategoryFailure error={error} categoryId={row.id} />
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Branches on `error.code`, never on the human message — the API writes those in
 * English. An unknown failure falls through to the server's own text rather than
 * being softened into "مشکلی پیش آمد", which is how a real defect gets reported
 * as a vague complaint.
 */
function CategoryFailure({ error, categoryId }: { error: unknown; categoryId?: number }) {
  if (!error) return null;

  const api = isApiError(error) ? error : null;
  const details = api?.details;

  if (api?.code === "CATEGORY_TITLE_TAKEN") {
    const taken = typeof details?.["title"] === "string" ? (details["title"] as string) : null;
    return (
      <Notice tone="danger" title="دستهٔ دیگری همین عنوان را دارد">
        <p>
          {taken ? <>عنوان «{taken}» قبلاً استفاده شده است. </> : null}
          عنوان‌ها بدون توجه به بزرگی و کوچکی حروف مقایسه می‌شوند. عنوان دیگری بگذارید؛ چیزی ثبت
          نشد.
        </p>
      </Notice>
    );
  }

  if (api?.code === "CATEGORY_IN_USE") {
    const blocked = typeof details?.["productCount"] === "number" ? details["productCount"] : null;
    const target =
      typeof details?.["categoryId"] === "number" ? (details["categoryId"] as number) : categoryId;
    return (
      <Notice tone="warning" title="این دسته خالی نیست و حذف نشد">
        <p>
          {blocked === null ? (
            <>هنوز کالاهایی در این دسته هستند.</>
          ) : (
            <>
              <bdi data-numeric="">{count(blocked)}</bdi> کالا هنوز در این دسته است.
            </>
          )}{" "}
          سرور حذف را رد کرد و هیچ تغییری ثبت نشد. اول این کالاها را از دسته خارج کنید، سپس دوباره
          تلاش کنید.
        </p>
        {target !== undefined ? (
          <Gate permissions={["products.read"]}>
            <p className="mt-2">
              <Link href={adminProductsInCategoryHref(target)} className="text-xs font-bold">
                دیدن کالاهای این دسته ←
              </Link>
            </p>
          </Gate>
        ) : null}
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
      <Notice tone="warning" title="این دسته دیگر وجود ندارد">
        <p>
          ممکن است همین حالا شخص دیگری آن را حذف کرده باشد. فهرست را به‌روز کنید تا وضعیت واقعی را
          ببینید.
        </p>
      </Notice>
    );
  }

  return <FormError error={error} />;
}
