"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useMemo, useState } from "react";

import { Badge, Button, ErrorState, Input, Skeleton } from "@kazhal/ui";
import { isApiError, isMissingOrForbidden } from "@kazhal/api-client";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  Fact,
  Gate,
  RequirePermission,
  count,
} from "@/components/admin/ui";
import {
  PermissionPicker,
  PermissionPickerSkeleton,
  PermissionSummary,
  usePermissionCatalogue,
  usePermissionIndex,
} from "@/components/admin/permission-picker";
import { FormError, Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import { LockIcon, TrashIcon } from "@/components/icons";
import {
  deleteRole,
  fetchRole,
  setRoleActive,
  setRolePermissions,
  updateRole,
} from "@/lib/admin-api";
import { permissionsOf } from "@/lib/permissions";
import { useSubmit } from "@/lib/hooks";

export function AdminRoleDetail({ roleId }: { roleId: number }) {
  return (
    <RequirePermission permissions={["rbac.read"]}>
      <RoleBody roleId={roleId} />
    </RequirePermission>
  );
}

function RoleBody({ roleId }: { roleId: number }) {
  const api = useApi();
  const role = useApiQuery((signal) => fetchRole(api, roleId, { signal }), [api, roleId]);
  const catalogue = usePermissionCatalogue();

  if (role.error) {
    return (
      <>
        <AdminPageHeader title="نقش" />
        <ErrorState
          error={role.error}
          title="این نقش پیدا نشد"
          {...(isMissingOrForbidden(role.error) ? {} : { onRetry: role.refetch })}
        />
      </>
    );
  }

  if (role.isLoading || !role.data) {
    return (
      <>
        <AdminPageHeader title="نقش" />
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="kz-sr-only">در حال بارگذاری</span>
          <Skeleton shape="block" height="6rem" />
          <Skeleton shape="block" height="20rem" />
        </div>
      </>
    );
  }

  const data = role.data;

  return (
    <>
      <AdminPageHeader
        title={data.titleFa}
        description={data.description ?? undefined}
        meta={
          <>
            <Badge size="sm" tone={data.isActive ? "success" : "neutral"}>
              {data.isActive ? "فعال" : "غیرفعال"}
            </Badge>
            {data.isSystem ? (
              <Badge size="sm" tone="primary">
                سیستمی
              </Badge>
            ) : null}
            <bdi dir="ltr" className="text-xs text-ink-subtle">
              {data.name}
            </bdi>
          </>
        }
      />

      {data.isSystem ? (
        <Notice tone="info" title="این نقش سیستمی است" className="mb-5">
          <LockIcon className="me-1 inline size-4 align-[-2px]" aria-hidden="true" />
          اختیارات این نقش در کد برنامه تعریف شده و از این صفحه تغییر نمی‌کند. دلیلش یک قفل‌شدگی
          واقعی است: اگر اختیار «مدیریت نقش‌ها و دسترسی‌ها» از مدیر ارشد گرفته شود، هیچ مسیری
          برای بازگرداندن آن نمی‌ماند، چون همان اختیار لازمهٔ انجام این کار است. برای واگذاری
          بخشی از کارها، یک نقش سازمانی تازه بسازید.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Fact label="تعداد کاربران دارندهٔ این نقش" numeric>
          {data.userCount > 0 ? (
            <Link href={`/admin/users?roleId=${data.id}` as Route} className="no-underline">
              {count(data.userCount)}
            </Link>
          ) : (
            count(data.userCount)
          )}
        </Fact>
        <Fact label="تعداد اختیارات" numeric>
          {count(data.permissionCount)}
        </Fact>
        <Fact label="نام فنی" hint="در سابقهٔ رخدادها ثبت می‌شود و تغییرپذیر نیست.">
          <bdi dir="ltr">{data.name}</bdi>
        </Fact>
      </div>

      {!data.isSystem ? (
        <Gate permissions={["rbac.manage"]}>
          <IdentityEditor role={data} onSaved={role.refetch} />
          <LifecycleEditor role={data} onSaved={role.refetch} />
        </Gate>
      ) : null}

      <AdminSection
        className="mt-4"
        title="اختیارات این نقش"
        description={
          data.isSystem
            ? "این مجموعه فقط قابل مشاهده است."
            : "هر تیک یک اختیار است. توضیح زیر هر عنوان، دقیقاً همان کاری است که دارندهٔ این نقش خواهد توانست انجام دهد."
        }
      >
        {catalogue.error ? (
          <ErrorState
            error={catalogue.error}
            title="فهرست اختیارات خوانده نشد"
            onRetry={catalogue.refetch}
          />
        ) : catalogue.isLoading || !catalogue.data ? (
          <PermissionPickerSkeleton />
        ) : data.isSystem ? (
          <PermissionSummary codes={data.permissions} groups={catalogue.data.groups} />
        ) : (
          <Gate
            permissions={["rbac.manage"]}
            fallback={
              <PermissionSummary codes={data.permissions} groups={catalogue.data.groups} />
            }
          >
            <PermissionEditor
              roleId={data.id}
              roleTitle={data.titleFa}
              current={data.permissions}
              groups={catalogue.data.groups}
              onSaved={role.refetch}
            />
          </Gate>
        )}
      </AdminSection>
    </>
  );
}

// ---------------------------------------------------------------------------

function IdentityEditor({
  role,
  onSaved,
}: {
  role: { id: number; titleFa: string; description: string | null };
  onSaved: () => void;
}) {
  const api = useApi();
  const [titleFa, setTitleFa] = useState(role.titleFa);
  const [description, setDescription] = useState(role.description ?? "");
  const [error, setError] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);

  const { run, isPending } = useSubmit(async () => {
    setError(undefined);
    setSaved(false);
    try {
      await updateRole(api, role.id, { titleFa: titleFa.trim(), description: description.trim() });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(caught);
    }
  });

  return (
    <AdminSection className="mt-4" title="نام و توضیح">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Input
          label="نام نمایشی"
          value={titleFa}
          maxLength={80}
          required
          onChange={(event) => setTitleFa(event.target.value)}
        />
        <Input
          label="توضیح کوتاه"
          value={description}
          maxLength={400}
          hint="در فهرست نقش‌ها دیده می‌شود."
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="sm:col-span-2">
          {saved ? (
            <Notice tone="success" className="mb-3">
              ذخیره شد.
            </Notice>
          ) : null}
          <FormError error={error} />
          <Button type="submit" size="sm" isLoading={isPending}>
            ذخیرهٔ نام و توضیح
          </Button>
        </div>
      </form>
    </AdminSection>
  );
}

function LifecycleEditor({
  role,
  onSaved,
}: {
  role: { id: number; titleFa: string; isActive: boolean; userCount: number };
  onSaved: () => void;
}) {
  const api = useApi();
  const router = useRouter();
  const [confirming, setConfirming] = useState<"toggle" | "delete" | null>(null);
  const [error, setError] = useState<unknown>(undefined);

  const toggle = useSubmit(async () => {
    setError(undefined);
    try {
      await setRoleActive(api, role.id, !role.isActive);
      setConfirming(null);
      onSaved();
    } catch (caught) {
      setError(caught);
      setConfirming(null);
    }
  });

  const remove = useSubmit(async () => {
    setError(undefined);
    try {
      await deleteRole(api, role.id);
      setConfirming(null);
      router.replace("/admin/access");
    } catch (caught) {
      setError(caught);
      setConfirming(null);
    }
  });

  const inUse = role.userCount > 0;

  return (
    <AdminSection
      className="mt-4"
      title="وضعیت نقش"
      description="غیرفعال‌کردن، همهٔ اختیارات این نقش را موقتاً از دارندگانش می‌گیرد بدون آنکه نقش از آن‌ها حذف شود — پس کاملاً برگشت‌پذیر است."
    >
      <FormError error={error} className="mb-3" />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={role.isActive ? "secondary" : "primary"}
          onClick={() => setConfirming("toggle")}
        >
          {role.isActive ? "غیرفعال‌کردن نقش" : "فعال‌کردن نقش"}
        </Button>

        {inUse ? (
          <p className="w-full text-xs leading-relaxed text-ink-muted">
            این نقش در اختیار{" "}
            <bdi data-numeric="">{count(role.userCount)}</bdi> کاربر است و به همین دلیل حذف
            نمی‌شود — حذف آن، نقش را از همهٔ آن کاربران هم برمی‌داشت و این کار برگشت‌پذیر نبود.
            اگر می‌خواهید دسترسی‌هایش را ببندید، آن را غیرفعال کنید.
          </p>
        ) : (
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirming("delete")}
            leadingIcon={<TrashIcon className="size-4" />}
          >
            حذف نقش
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirming === "toggle"}
        onClose={() => setConfirming(null)}
        onConfirm={() => void toggle.run()}
        isPending={toggle.isPending}
        tone={role.isActive ? "danger" : "neutral"}
        title={role.isActive ? `غیرفعال‌کردن نقش «${role.titleFa}»` : `فعال‌کردن نقش «${role.titleFa}»`}
        confirmLabel={role.isActive ? "غیرفعال کن" : "فعال کن"}
        consequences={
          role.isActive
            ? [
                <>
                  از همین لحظه، همهٔ اختیارات این نقش از{" "}
                  <bdi data-numeric="">{count(role.userCount)}</bdi> کاربر دارندهٔ آن گرفته
                  می‌شود.
                </>,
                "نقش از کاربران حذف نمی‌شود؛ فقط اثری ندارد. با فعال‌کردن دوباره، همان دسترسی‌ها برمی‌گردد.",
                "هیچ پولی جابه‌جا نمی‌شود و هیچ تغییری در موجودی یا سفارش‌ها رخ نمی‌دهد.",
                "این اقدام با نام شما در دفتر رخدادهای مدیریتی ثبت می‌شود.",
              ]
            : [
                <>
                  اختیارات این نقش بلافاصله به{" "}
                  <bdi data-numeric="">{count(role.userCount)}</bdi> کاربر دارندهٔ آن بازمی‌گردد.
                </>,
                "هیچ پولی جابه‌جا نمی‌شود و هیچ تغییری در موجودی یا سفارش‌ها رخ نمی‌دهد.",
                "این اقدام با نام شما در دفتر رخدادهای مدیریتی ثبت می‌شود.",
              ]
        }
      />

      <ConfirmDialog
        open={confirming === "delete"}
        onClose={() => setConfirming(null)}
        onConfirm={() => void remove.run()}
        isPending={remove.isPending}
        title={`حذف کامل نقش «${role.titleFa}»`}
        confirmLabel="حذف کن"
        confirmPhrase={role.titleFa}
        consequences={[
          "نقش از فهرست حذف می‌شود و دیگر قابل اختصاص نیست.",
          "هیچ کاربری در حال حاضر این نقش را ندارد، پس دسترسی کسی تغییر نمی‌کند. اگر در همین لحظه کسی آن را بگیرد، سرور حذف را رد می‌کند.",
          "این کار برگشت‌پذیر نیست: برای بازگرداندن باید نقش را از نو بسازید و اختیاراتش را دوباره تیک بزنید.",
          "این اقدام با نام شما در دفتر رخدادهای مدیریتی ثبت می‌شود.",
        ]}
      />
    </AdminSection>
  );
}

/**
 * THE PERMISSION EDITOR.
 *
 * The confirmation is the point of this component, not the checkboxes. A save
 * lists exactly which capabilities are being GRANTED and which REVOKED, each
 * by its Persian consequence sentence — «این نقش خواهد توانست یک فروش
 * پرداخت‌شده را باطل کند» — because "you changed 4 permissions" is not
 * something an owner can consent to.
 *
 * The set is replaced wholesale rather than patched, matching the API: what
 * the role can do is always exactly what was last confirmed, and a lost
 * revocation cannot hide inside a partial update.
 */
function PermissionEditor({
  roleId,
  roleTitle,
  current,
  groups,
  onSaved,
}: {
  roleId: number;
  roleTitle: string;
  current: string[];
  groups: Parameters<typeof PermissionPicker>[0]["groups"];
  onSaved: () => void;
}) {
  const api = useApi();
  const { session } = useAppSession();
  const index = usePermissionIndex(groups);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(current));
  const [seed, setSeed] = useState(current);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);

  /*
   * Re-seeded when the SERVER's answer changes, so a successful save leaves
   * the form showing what was actually stored rather than what was typed.
   *
   * Compared by identity: `current` is a fresh array from each refetch, which
   * is exactly the signal wanted — "the server said something new". Adjusted
   * during render rather than in an effect, so the checklist never paints one
   * frame of stale ticks.
   */
  if (seed !== current) {
    setSeed(current);
    setSelected(new Set(current));
  }

  const actorPermissions = permissionsOf(session);
  const beyondAuthority = useMemo(() => {
    const blocked = new Set<string>();
    for (const group of groups) {
      for (const permission of group.permissions) {
        if (!actorPermissions.has(permission.code)) blocked.add(permission.code);
      }
    }
    return blocked;
  }, [groups, actorPermissions]);

  const granted = [...selected].filter((code) => !current.includes(code));
  const revoked = current.filter((code) => !selected.has(code));
  const dirty = granted.length > 0 || revoked.length > 0;
  const highRisk = granted.some((code) => index.get(code)?.risk === "critical");

  const save = useSubmit(async () => {
    setError(undefined);
    setSaved(false);
    try {
      await setRolePermissions(api, roleId, [...selected]);
      setConfirming(false);
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(caught);
      setConfirming(false);
    }
  });

  return (
    <>
      {saved ? (
        <Notice tone="success" className="mb-4">
          اختیارات این نقش ذخیره شد. تغییر از درخواست بعدیِ کاربرانِ دارندهٔ این نقش اثر می‌گذارد.
        </Notice>
      ) : null}
      <FormError error={error} className="mb-4" />
      {isApiError(error) && error.code === "PERMISSION_ESCALATION" ? (
        <Notice tone="danger" title="اختیاری بیش از حد دسترسی خودتان" className="mb-4">
          نمی‌توانید اختیاری را بدهید یا بگیرید که خودتان آن را ندارید. این محدودیت روی سرور
          اعمال می‌شود و هدفش جلوگیری از بالا بردن سطح دسترسی از راه ساختن نقش است.
        </Notice>
      ) : null}

      <PermissionPicker
        groups={groups}
        selected={selected}
        beyondAuthority={beyondAuthority}
        onChange={(code, checked) =>
          setSelected((previous) => {
            const next = new Set(previous);
            if (checked) next.add(code);
            else next.delete(code);
            return next;
          })
        }
      />

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button disabled={!dirty} onClick={() => setConfirming(true)}>
          ذخیرهٔ اختیارات
        </Button>
        {dirty ? (
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(current))}>
            بازگرداندن تغییرها
          </Button>
        ) : null}
        <span className="text-xs text-ink-subtle" data-numeric="">
          {dirty
            ? `${count(granted.length)} افزودن، ${count(revoked.length)} حذف`
            : "تغییری ثبت نشده است"}
        </span>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void save.run()}
        isPending={save.isPending}
        tone={highRisk ? "danger" : "neutral"}
        title={`تغییر اختیارات نقش «${roleTitle}»`}
        question="پس از تأیید، دارندگان این نقش دقیقاً همین اختیارات را خواهند داشت."
        confirmLabel="تأیید و ذخیره"
        {...(highRisk ? { confirmPhrase: roleTitle } : {})}
        consequences={[
          ...granted.map((code) => (
            <span key={`g-${code}`}>
              <b className="text-success">افزودن — </b>
              {index.get(code)?.descriptionFa ?? code}
            </span>
          )),
          ...revoked.map((code) => (
            <span key={`r-${code}`}>
              <b className="text-danger">حذف — </b>
              دارندگان این نقش دیگر نمی‌توانند: {index.get(code)?.labelFa ?? code}
            </span>
          )),
          "تغییر از درخواست بعدیِ هر کاربر اثر می‌گذارد؛ نیازی به خروج و ورود دوباره نیست.",
          "این تغییر با نام شما در دفتر رخدادهای مدیریتی ثبت می‌شود و قابل حذف نیست.",
        ]}
      />
    </>
  );
}
