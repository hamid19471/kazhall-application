"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { isMissingOrForbidden } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Input, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  DataTable,
  EmptyRow,
  Fact,
  Gate,
  RequirePermission,
  StatTile,
  Td,
  Textarea,
  Th,
  Tr,
  count,
  useMutation,
  when,
} from "@/components/admin/ui";
import {
  AccountStatusBadge,
  MutationError,
  UserLink,
  UsersListLink,
  asApiError,
} from "@/components/admin/people-shared";
import { StoreIcon, TrashIcon } from "@/components/icons";
import {
  deleteBranch,
  fetchBranch,
  setBranchActive,
  updateBranch,
} from "@/lib/admin-api";
import type { AdminBranchDetail as AdminBranchDetailRow } from "@/lib/admin-api";
import { roleNameLabel } from "@/lib/labels";
import { adminBranchesHref } from "@/lib/routes";

const NAME_MIN = 2;

/**
 * ONE SHOP.
 *
 * The two operations that matter here are not symmetric and must not look it:
 *
 *  - DEACTIVATING stops NEW sales at this shop's till and nothing else. Staff
 *    stay assigned, orders stay put, history is untouched, and it is undoable.
 *  - DELETING removes the row, and is therefore only offered when nothing
 *    references it — no staff, no orders. A branch name is recorded ON each
 *    past order (`branchNameSnapshot`), so deleting the row does not erase
 *    history, but the assignment of staff would be lost and the server refuses
 *    it anyway.
 */
export function AdminBranchDetail({ branchId }: { branchId: number }) {
  return (
    <RequirePermission permissions={["branches.read"]}>
      <BranchBody branchId={branchId} />
    </RequirePermission>
  );
}

function BranchBody({ branchId }: { branchId: number }) {
  const api = useApi();
  const { data: branch, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchBranch(api, branchId, { signal }),
    [api, branchId],
  );

  if (error) {
    return (
      <>
        <AdminPageHeader title="شعبه" />
        {/*
          403 and 404 are rendered identically, as `ErrorState` intends: telling
          them apart on a lookup route hands anybody a way to probe which branch
          ids exist.
        */}
        <ErrorState
          error={error}
          title={isMissingOrForbidden(error) ? "این شعبه در دسترس نیست" : "اطلاعات شعبه خوانده نشد"}
          description={
            isMissingOrForbidden(error)
              ? "شناسهٔ این نشانی به شعبه‌ای که شما بتوانید ببینید اشاره نمی‌کند."
              : "ارتباط با سرور برقرار نشد. هیچ تغییری روی این شعبه ثبت نشده است."
          }
          onRetry={refetch}
        />
        <p className="mt-4 text-sm">
          <Link href={adminBranchesHref()}>بازگشت به فهرست شعبه‌ها</Link>
        </p>
      </>
    );
  }

  if (isLoading || !branch) {
    return (
      <>
        <AdminPageHeader title="شعبه" />
        <div role="status" aria-busy="true" className="space-y-4">
          <span className="kz-sr-only">در حال بارگذاری اطلاعات شعبه</span>
          <Skeleton shape="block" height="8rem" />
          <Skeleton shape="block" height="12rem" />
        </div>
      </>
    );
  }

  return (
    <>
      <AdminPageHeader
        title={branch.name}
        description="فروش صندوق این شعبه به نام همین شعبه ثبت می‌شود. موجودی انبار مشترک است و به تفکیک شعبه نگهداری نمی‌شود."
        meta={<AccountStatusBadge isActive={branch.isActive} />}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="کارکنان فعال"
          value={count(branch.activeStaffCount)}
          hint={`از مجموع ${count(branch.totalStaffCount)} کارمندی که به این شعبه تخصیص یافته‌اند (شامل حساب‌های غیرفعال).`}
          href={
            <UsersListLink query={{ branchId: branch.id }}>
              دیدن کارکنان این شعبه ←
            </UsersListLink>
          }
        />
        <StatTile
          label="سفارش‌های ثبت‌شده"
          value={count(branch.orderCount)}
          hint="همهٔ سفارش‌هایی که به این شعبه ارجاع دارند، از هر وضعیتی. تا وقتی این عدد صفر نشود، شعبه حذف‌شدنی نیست."
        />
        <StatTile
          label="سفارش‌های در جریان"
          value={count(branch.openOrderCount)}
          hint="نه تمام‌شده و نه برگشت‌خورده. غیرفعال‌کردن شعبه این‌ها را لغو نمی‌کند."
          tone={branch.openOrderCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="تاریخ ساخت"
          value={when(branch.createdAt)}
          hint="از این تاریخ فروش این شعبه قابل ثبت بوده است."
        />
      </div>

      <div className="space-y-4">
        <DetailsSection branch={branch} onSaved={refetch} />
        <LifecycleSection branch={branch} onChanged={refetch} />
        <StaffSection branch={branch} />
        <DeleteSection branch={branch} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Name, address, phone
// ---------------------------------------------------------------------------

/**
 * RENAMING DOES NOT REWRITE HISTORY.
 *
 * Each order stores the branch name AS IT WAS at the moment of sale
 * (`branchNameSnapshot`), so a past receipt keeps saying «شعبهٔ ونک» after the
 * shop is renamed. That is correct — a receipt is a record of what happened —
 * and the form says so, because the opposite assumption ("renaming fixes the
 * old receipts") is the one that gets acted on.
 */
function DetailsSection({
  branch,
  onSaved,
}: {
  branch: AdminBranchDetailRow;
  onSaved: () => void;
}) {
  const api = useApi();
  const save = useMutation(updateBranch);
  const [invalid, setInvalid] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvalid(null);
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const address = String(form.get("address") ?? "").trim();
    const phone = String(form.get("phone") ?? "").trim();

    if (name.length < NAME_MIN) {
      setInvalid("نام شعبه دست‌کم دو نویسه لازم دارد.");
      return;
    }

    const body: { name?: string; address?: string; phone?: string } = {};
    if (name !== branch.name) body.name = name;
    if (address !== (branch.address ?? "")) body.address = address;
    // An empty phone is OMITTED, not sent: the API validates it as a real
    // Iranian number and `""` is not one. Clearing a phone is therefore not
    // something this endpoint can do, and the hint below says so rather than
    // letting the operator think an empty field removed it.
    if (phone !== "" && phone !== (branch.phone ?? "")) body.phone = phone;

    if (Object.keys(body).length === 0) {
      setInvalid("چیزی تغییر نکرده است.");
      return;
    }

    const result = await save.run(api, branch.id, body);
    if (result) {
      save.setDone(result.message);
      onSaved();
    }
  }

  return (
    <AdminSection title="مشخصات شعبه">
      <dl className="mb-4 grid gap-2 sm:grid-cols-3">
        <Fact label="نام">{branch.name}</Fact>
        <Fact label="نشانی">{branch.address ?? "—"}</Fact>
        <Fact label="تلفن" numeric>
          {branch.phone ? <bdi dir="ltr">{branch.phone}</bdi> : "—"}
        </Fact>
      </dl>

      <Gate
        permissions={["branches.update"]}
        fallback={
          <p className="text-xs text-ink-subtle">
            ویرایش مشخصات شعبه به اختیار <bdi dir="ltr">branches.update</bdi> نیاز دارد.
          </p>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="name"
              label="نام شعبه"
              defaultValue={branch.name}
              required
              minLength={NAME_MIN}
              maxLength={120}
              containerClassName="min-w-0"
              hint="در کل سامانه یگانه است."
            />
            <Input
              name="phone"
              label="تلفن"
              defaultValue={branch.phone ?? ""}
              numeric
              maxLength={20}
              containerClassName="min-w-0"
              hint="شمارهٔ تلفن ایران. خالی گذاشتن این فیلد شمارهٔ ثبت‌شده را پاک نمی‌کند؛ برای تغییر، شمارهٔ تازه را بنویسید."
            />
          </div>
          <Textarea
            name="address"
            label="نشانی"
            defaultValue={branch.address ?? ""}
            maxLength={500}
            hint="خالی گذاشتن این فیلد نشانی را پاک می‌کند."
          />

          <Notice tone="info">
            <p>
              تغییر نام شعبه <b>سابقه را بازنویسی نمی‌کند</b>: روی هر سفارش گذشته، نام شعبه همان‌طور
              که در لحظهٔ فروش بوده ثبت شده و همان می‌ماند. گزارش‌ها و رسیدهای قدیمی نام تازه را
              نشان نمی‌دهند، و این درست است — رسید، سند همان روز است.
            </p>
          </Notice>

          {invalid ? <Notice tone="warning">{invalid}</Notice> : null}
          <MutationError error={save.error} />
          {save.done ? <Notice tone="success">{save.done}</Notice> : null}

          <Button type="submit" isLoading={save.isPending}>
            ذخیرهٔ مشخصات
          </Button>
        </form>
      </Gate>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------

function LifecycleSection({
  branch,
  onChanged,
}: {
  branch: AdminBranchDetailRow;
  onChanged: () => void;
}) {
  const api = useApi();
  const toggle = useMutation(setBranchActive);
  const [confirming, setConfirming] = useState(false);

  async function confirm() {
    const result = await toggle.run(api, branch.id, !branch.isActive);
    setConfirming(false);
    if (result) {
      toggle.setDone(result.message);
      onChanged();
    }
  }

  const deactivating = branch.isActive;

  return (
    <AdminSection
      title="وضعیت فعالیت شعبه"
      description="غیرفعال‌کردن شعبه، جلوی فروش تازه در صندوق آن را می‌گیرد و کار دیگری نمی‌کند."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AccountStatusBadge isActive={branch.isActive} />
        <span className="text-xs text-ink-muted">
          {count(branch.activeStaffCount)} کارمند فعال به این شعبه تخصیص دارد.
        </span>
      </div>

      <MutationError error={toggle.error} />
      {toggle.done ? (
        <Notice tone="success" className="mt-3">
          {toggle.done}
        </Notice>
      ) : null}

      <Gate
        permissions={deactivating ? ["branches.deactivate"] : ["branches.activate"]}
        fallback={
          <p className="text-xs text-ink-subtle">
            این کار به اختیار{" "}
            <bdi dir="ltr">{deactivating ? "branches.deactivate" : "branches.activate"}</bdi> نیاز
            دارد.
          </p>
        }
      >
        <Button
          className="mt-3"
          variant={deactivating ? "danger" : "primary"}
          onClick={() => setConfirming(true)}
          leadingIcon={<StoreIcon className="size-4" />}
        >
          {deactivating ? "غیرفعال‌کردن شعبه" : "فعال‌کردن دوبارهٔ شعبه"}
        </Button>
      </Gate>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        isPending={toggle.isPending}
        tone={deactivating ? "danger" : "neutral"}
        title={deactivating ? `غیرفعال‌کردن شعبهٔ «${branch.name}»` : `فعال‌کردن شعبهٔ «${branch.name}»`}
        confirmLabel={deactivating ? "بله، شعبه را ببند" : "بله، شعبه را باز کن"}
        consequences={
          deactivating
            ? [
                "صندوق‌دارانی که به این شعبه تخصیص دارند، از این پس نمی‌توانند فروش حضوری را نهایی کنند؛ سرور درخواست فروش را با خطای «شعبه غیرفعال است» (BRANCH_INACTIVE) رد می‌کند.",
                `کارکنان به‌طور خودکار جابه‌جا نمی‌شوند: ${count(branch.activeStaffCount)} کارمند فعال همچنان به همین شعبه تخصیص دارند و اگر باید فروش را ادامه دهند، باید دستی به شعبهٔ دیگری منتقل شوند.`,
                "سفارش‌های گذشته، پرداخت‌ها و سابقهٔ گردش موجودی دست‌نخورده می‌مانند و هیچ پولی جابه‌جا نمی‌شود.",
                branch.openOrderCount > 0
                  ? `${count(branch.openOrderCount)} سفارش این شعبه هنوز در جریان است؛ غیرفعال‌کردن شعبه هیچ‌کدام را لغو نمی‌کند و وضعیتشان را عوض نمی‌کند.`
                  : "هیچ سفارشی از این شعبه در جریان نیست.",
                "موجودی هیچ کالایی تغییر نمی‌کند؛ موجودی در این سامانه مشترک است و اصلاً به شعبه بند نیست.",
                "این کار برگشت‌پذیر است: هر وقت بخواهید شعبه را دوباره فعال می‌کنید.",
              ]
            : [
                "صندوق‌داران تخصیص‌یافته به این شعبه می‌توانند دوباره در صندوق آن فروش ثبت کنند.",
                "هیچ سفارش، پرداخت یا موجودی‌ای تغییر نمی‌کند و هیچ پولی جابه‌جا نمی‌شود.",
                "کارکنان این شعبه همان‌هایی هستند که پیش‌تر تخصیص یافته بودند؛ کسی خودبه‌خود اضافه یا کم نمی‌شود.",
                "صندوق‌داری که حسابش غیرفعال است یا باید گذرواژه‌اش را عوض کند، همچنان نمی‌تواند بفروشد.",
              ]
        }
      >
        {deactivating && branch.activeStaffCount > 0 ? (
          <Notice tone="warning">
            <p>
              اگر می‌خواهید پیش از بستن شعبه، کارکنان را جابه‌جا کنید:{" "}
              <UsersListLink query={{ branchId: branch.id }}>
                فهرست کارکنان این شعبه را باز کنید
              </UsersListLink>
              .
            </p>
          </Notice>
        ) : null}
      </ConfirmDialog>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

function StaffSection({ branch }: { branch: AdminBranchDetailRow }) {
  return (
    <AdminSection
      title="کارکنان تخصیص‌یافته"
      description="تخصیص شعبه روی خود کاربر ثبت می‌شود، پس جابه‌جایی از صفحهٔ همان کاربر انجام می‌شود."
      actions={
        <UsersListLink query={{ branchId: branch.id }} className="text-xs">
          مدیریت در فهرست کاربران ←
        </UsersListLink>
      }
    >
      <DataTable minWidth="34rem" caption="کارکنان این شعبه">
        <thead>
          <tr>
            <Th>کارمند</Th>
            <Th>نقش‌ها</Th>
            <Th>وضعیت حساب</Th>
            <Th>
              <span className="kz-sr-only">اقدام</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {branch.staff.length === 0 ? (
            <EmptyRow colSpan={4}>
              هیچ کارمندی به این شعبه تخصیص نیافته است. تا وقتی کسی تخصیص نیابد، در صندوق این شعبه
              فروشی ثبت نمی‌شود.
            </EmptyRow>
          ) : (
            branch.staff.map((member) => (
              <Tr key={member.id}>
                <Td>
                  <UserLink id={member.id} className="no-underline">
                    <bdi dir="ltr" data-numeric="" className="text-sm font-bold text-primary">
                      {member.identifier}
                    </bdi>
                  </UserLink>
                  {member.mobile ? (
                    <bdi dir="ltr" data-numeric="" className="mt-0.5 block text-2xs text-ink-subtle">
                      {member.mobile}
                    </bdi>
                  ) : null}
                </Td>
                <Td>
                  {member.roles.length === 0 ? (
                    <span className="text-2xs text-ink-subtle">بدون نقش</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {member.roles.map((role) => (
                        <Badge key={role} size="sm" tone="neutral">
                          {roleNameLabel(role)}
                        </Badge>
                      ))}
                    </span>
                  )}
                </Td>
                <Td>
                  <AccountStatusBadge isActive={member.isActive} />
                </Td>
                <Td>
                  <UserLink id={member.id} className="whitespace-nowrap text-xs">
                    مدیریت حساب ←
                  </UserLink>
                </Td>
              </Tr>
            ))
          )}
        </tbody>
      </DataTable>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * DELETE, offered only when it is actually available.
 *
 * The server refuses with 409 `BRANCH_IN_USE` the moment any staff member or
 * any order references the branch, so showing the button in that state would
 * be offering an action that cannot succeed. The counts are read from the same
 * record the server checks — and the race is still handled, because between
 * this render and the click somebody else may have assigned a cashier.
 */
function DeleteSection({ branch }: { branch: AdminBranchDetailRow }) {
  const api = useApi();
  const router = useRouter();
  const remove = useMutation(deleteBranch);
  const [confirming, setConfirming] = useState(false);

  const deletable = branch.totalStaffCount === 0 && branch.orderCount === 0;

  async function confirm() {
    const result = await remove.run(api, branch.id);
    setConfirming(false);
    if (result) router.push(adminBranchesHref());
  }

  const conflict = asApiError(remove.error);
  const details = conflict?.details as
    | { staffCount?: number; orderCount?: number }
    | undefined;

  return (
    <AdminSection
      title="حذف شعبه"
      description="حذف، آخرین گزینه است و فقط برای شعبه‌ای که هرگز استفاده نشده معنا دارد."
    >
      {deletable ? (
        <>
          <p className="mb-3 text-sm leading-relaxed text-ink-muted">
            به این شعبه نه کارمندی تخصیص یافته و نه سفارشی به نامش ثبت شده است، پس حذف آن هیچ
            سابقه‌ای را نمی‌شکند.
          </p>

          <MutationError
            error={remove.error}
            extra={{
              BRANCH_IN_USE: details ? (
                <>
                  سرور اعلام کرد در این لحظه {count(details.staffCount ?? 0)} کارمند و{" "}
                  {count(details.orderCount ?? 0)} سفارش به این شعبه ارجاع دارند. صفحه را به‌روز
                  کنید تا وضعیت تازه را ببینید.
                </>
              ) : undefined,
            }}
          />

          <Gate
            permissions={["branches.deactivate"]}
            fallback={
              <p className="text-xs text-ink-subtle">
                حذف شعبه به اختیار <bdi dir="ltr">branches.deactivate</bdi> نیاز دارد.
              </p>
            }
          >
            <Button
              variant="danger"
              onClick={() => setConfirming(true)}
              leadingIcon={<TrashIcon className="size-4" />}
            >
              حذف شعبه
            </Button>
          </Gate>
        </>
      ) : (
        <Notice tone="info">
          <p>
            این شعبه حذف‌شدنی نیست: {count(branch.totalStaffCount)} کارمند به آن تخصیص یافته و{" "}
            {count(branch.orderCount)} سفارش به نامش ثبت شده است. شعبه‌ای که کارکنان یا سفارش‌ها به
            آن ارجاع دارند حذف نمی‌شود، چون حذفش آن ارجاع‌ها را می‌شکند. راه بازنشسته‌کردن یک شعبه،
            <b> غیرفعال‌کردن</b> آن است: فروش تازه متوقف می‌شود و سابقه سر جای خودش می‌ماند.
          </p>
        </Notice>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        isPending={remove.isPending}
        tone="danger"
        title={`حذف شعبهٔ «${branch.name}»`}
        question="این کار برگشت‌پذیر نیست."
        confirmLabel="بله، حذف کن"
        confirmPhrase={branch.name}
        consequences={[
          "ردیف این شعبه از پایگاه داده پاک می‌شود و راهی برای بازگرداندنش نیست.",
          "این گزینه فقط وقتی نشان داده می‌شود که نه کارمندی به این شعبه تخصیص یافته باشد و نه سفارشی به نامش ثبت شده باشد، پس هیچ سابقه‌ای از دست نمی‌رود.",
          "هیچ پولی جابه‌جا نمی‌شود، وضعیت هیچ سفارشی عوض نمی‌شود و موجودی هیچ کالایی تغییر نمی‌کند.",
          "اگر در همین فاصله کسی کارمندی به این شعبه تخصیص داده یا سفارشی ثبت کرده باشد، سرور درخواست را رد می‌کند و شعبه دست‌نخورده می‌ماند.",
          "اگر فقط می‌خواهید این شعبه دیگر فروش نداشته باشد، به‌جای حذف آن را غیرفعال کنید.",
        ]}
      />
    </AdminSection>
  );
}
