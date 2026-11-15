"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Route } from "next";

import { Button, ErrorState, Input } from "@kazhal/ui";
import { isApiError } from "@kazhal/api-client";
import { useApi } from "@kazhal/ui/api/react";

import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  RequirePermission,
  count,
} from "@/components/admin/ui";
import {
  PermissionPicker,
  PermissionPickerSkeleton,
  usePermissionCatalogue,
  usePermissionIndex,
} from "@/components/admin/permission-picker";
import { FormError, Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import { createRole } from "@/lib/admin-api";
import { permissionsOf } from "@/lib/permissions";
import { useSubmit } from "@/lib/hooks";

/** Machine names are lower-case, underscore-separated, 3–40 — same as the API. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

/**
 * Starting points, not a fixed menu.
 *
 * A blank checklist of forty capabilities is a form nobody finishes correctly.
 * Each preset is one of the delegations the owner actually asked for, and every
 * one of them includes `admin.access` — without it the holder cannot open the
 * console at all, which is the single most likely way to create a role that
 * "does not work" and looks like a bug.
 */
const PRESETS: Array<{ key: string; label: string; description: string; codes: string[] }> = [
  {
    key: "orders",
    label: "مدیر سفارش‌ها",
    description: "سفارش‌ها را می‌بیند و وضعیتشان را جلو می‌برد، اما ابطال و مرجوعی نمی‌کند.",
    codes: ["admin.access", "dashboard.read", "orders.read", "orders.actions.read", "orders.status.update"],
  },
  {
    key: "inventory",
    label: "مسئول انبار",
    description: "موجودی را می‌بیند و اصلاح می‌کند و دفتر گردش را می‌خواند.",
    codes: [
      "admin.access",
      "dashboard.read",
      "inventory.read",
      "inventory.adjust",
      "inventory.movements.read",
      "products.read",
    ],
  },
  {
    key: "catalogue",
    label: "مسئول کاتالوگ",
    description: "کالاها، دسته‌بندی‌ها و ویژگی‌ها را می‌سازد و ویرایش می‌کند. به موجودی و سفارش دست نمی‌زند.",
    codes: [
      "admin.access",
      "products.read",
      "products.create",
      "products.update",
      "products.activate",
      "products.deactivate",
      "categories.read",
      "categories.create",
      "categories.update",
      "attributes.read",
      "attributes.create",
      "attributes.update",
    ],
  },
  {
    key: "readonly",
    label: "ناظر (فقط مشاهده)",
    description: "همه‌چیز را می‌بیند و هیچ‌چیز را تغییر نمی‌دهد.",
    codes: [
      "admin.access",
      "dashboard.read",
      "products.read",
      "categories.read",
      "attributes.read",
      "inventory.read",
      "inventory.movements.read",
      "orders.read",
      "orders.actions.read",
      "reconciliation.read",
      "users.read",
      "branches.read",
      "rbac.read",
    ],
  },
];

export function AdminRoleCreate() {
  return (
    <RequirePermission permissions={["rbac.read", "rbac.manage"]}>
      <CreateBody />
    </RequirePermission>
  );
}

function CreateBody() {
  const api = useApi();
  const router = useRouter();
  const { session } = useAppSession();
  const catalogue = usePermissionCatalogue();
  const index = usePermissionIndex(catalogue.data?.groups);

  const [name, setName] = useState("");
  const [titleFa, setTitleFa] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(["admin.access"]));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const actorPermissions = permissionsOf(session);
  const beyondAuthority = useMemo(() => {
    const blocked = new Set<string>();
    for (const group of catalogue.data?.groups ?? []) {
      for (const permission of group.permissions) {
        if (!actorPermissions.has(permission.code)) blocked.add(permission.code);
      }
    }
    return blocked;
  }, [catalogue.data, actorPermissions]);

  const codes = [...selected];
  const highRisk = codes.some((code) => index.get(code)?.risk === "critical");
  const canEnterAdmin = selected.has("admin.access");

  const submit = useSubmit(async () => {
    setError(undefined);
    try {
      const result = await createRole(api, {
        name: name.trim(),
        titleFa: titleFa.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        permissions: codes,
      });
      setConfirming(false);
      router.replace(`/admin/access/roles/${result.data.id}` as Route);
    } catch (caught) {
      setError(caught);
      setConfirming(false);
    }
  });

  function validate(): boolean {
    setProblem(undefined);
    if (!NAME_PATTERN.test(name.trim())) {
      setProblem(
        "نام فنی باید ۳ تا ۴۰ نویسه باشد: حروف کوچک انگلیسی، رقم و زیرخط، و با یک حرف شروع شود — مثلاً order_manager.",
      );
      return false;
    }
    if (titleFa.trim().length < 2) {
      setProblem("نام نمایشی را وارد کنید.");
      return false;
    }
    if (codes.length === 0) {
      setProblem("حداقل یک اختیار را انتخاب کنید؛ نقش بی‌اختیار هیچ کاری انجام نمی‌دهد.");
      return false;
    }
    return true;
  }

  return (
    <>
      <AdminPageHeader
        title="نقش تازه"
        description="یک نقش سازمانی بسازید و فقط همان اختیاراتی را به آن بدهید که لازم است."
      />

      <Notice tone="info" className="mb-5">
        برای اینکه دارندهٔ این نقش بتواند وارد پنل مدیریت شود، اختیار «ورود به پنل مدیریت» باید
        تیک داشته باشد. بدون آن، حتی با داشتن سایر اختیارات، ورود ممکن نیست.
      </Notice>

      <AdminSection title="مشخصات نقش">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="نام نمایشی (فارسی)"
            value={titleFa}
            maxLength={80}
            required
            placeholder="مدیر سفارش‌ها"
            onChange={(event) => setTitleFa(event.target.value)}
          />
          <Input
            label="نام فنی"
            value={name}
            dir="ltr"
            maxLength={40}
            required
            placeholder="order_manager"
            hint="ثابت می‌ماند و در دفتر رخدادها ثبت می‌شود. بعداً قابل تغییر نیست."
            onChange={(event) => setName(event.target.value.toLowerCase())}
          />
          <Input
            label="توضیح کوتاه"
            containerClassName="sm:col-span-2"
            value={description}
            maxLength={400}
            placeholder="مشاهده و پیگیری سفارش‌ها بدون دسترسی به گزارش مالی."
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </AdminSection>

      <AdminSection
        className="mt-4"
        title="شروع سریع"
        description="یک الگو را انتخاب کنید و بعد تیک‌ها را دقیق کنید. الگوها پیشنهادند، نه فهرست بسته."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => {
                setSelected(new Set(preset.codes));
                if (!titleFa.trim()) setTitleFa(preset.label);
              }}
              className="rounded-md border border-line bg-surface p-3 text-start transition-colors duration-150 ease-kz hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
            >
              <span className="block text-sm font-bold text-ink">{preset.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                {preset.description}
              </span>
              <span className="mt-1 block text-2xs text-ink-subtle" data-numeric="">
                {count(preset.codes.length)} اختیار
              </span>
            </button>
          ))}
        </div>
      </AdminSection>

      <AdminSection className="mt-4" title="اختیارات">
        {catalogue.error ? (
          <ErrorState
            error={catalogue.error}
            title="فهرست اختیارات خوانده نشد"
            onRetry={catalogue.refetch}
          />
        ) : catalogue.isLoading || !catalogue.data ? (
          <PermissionPickerSkeleton />
        ) : (
          <PermissionPicker
            groups={catalogue.data.groups}
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
        )}
      </AdminSection>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            if (validate()) setConfirming(true);
          }}
        >
          ساختن نقش
        </Button>
        <span className="text-xs text-ink-subtle" data-numeric="">
          {count(codes.length)} اختیار انتخاب شده
        </span>
      </div>

      {problem ? (
        <Notice tone="danger" className="mt-3">
          {problem}
        </Notice>
      ) : null}
      {!canEnterAdmin && codes.length > 0 ? (
        <Notice tone="warning" className="mt-3">
          «ورود به پنل مدیریت» تیک ندارد. با این نقش نمی‌شود وارد پنل شد — اگر این عمدی نیست،
          تیکش را بزنید.
        </Notice>
      ) : null}
      <FormError error={error} className="mt-3" />
      {isApiError(error) && error.code === "ROLE_NAME_TAKEN" ? (
        <Notice tone="danger" className="mt-3">
          نام فنی تکراری است. یک نام دیگر انتخاب کنید.
        </Notice>
      ) : null}
      {isApiError(error) && error.code === "PERMISSION_ESCALATION" ? (
        <Notice tone="danger" className="mt-3">
          نمی‌توانید اختیاری بدهید که خودتان آن را ندارید. این محدودیت روی سرور اعمال می‌شود.
        </Notice>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void submit.run()}
        isPending={submit.isPending}
        tone={highRisk ? "danger" : "neutral"}
        title={`ساختن نقش «${titleFa.trim()}»`}
        question="دارندگان این نقش خواهند توانست کارهای زیر را انجام دهند."
        confirmLabel="بساز"
        {...(highRisk ? { confirmPhrase: titleFa.trim() } : {})}
        consequences={[
          ...codes.map((code) => (
            <span key={code}>{index.get(code)?.descriptionFa ?? code}</span>
          )),
          "این نقش تا زمانی که به کسی اختصاص ندهید هیچ اثری ندارد.",
          "ساختن نقش با نام شما در دفتر رخدادهای مدیریتی ثبت می‌شود.",
        ]}
      />
    </>
  );
}
