"use client";

import Link from "next/link";
import type { Route } from "next";

import { Badge, Button, ErrorState, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import {
  AdminPageHeader,
  AdminSection,
  DataTable,
  EmptyRow,
  Gate,
  RequirePermission,
  Td,
  Th,
  Tr,
  count,
} from "@/components/admin/ui";
import { Notice } from "@/components/common";
import { KeyIcon, LockIcon, PlusIcon } from "@/components/icons";
import { fetchRoles } from "@/lib/admin-api";
import type { RawSearchParams } from "@/lib/search-params";

/**
 * ===========================================================================
 * ACCESS CONTROL — the role catalogue
 * ===========================================================================
 *
 * The screen that makes delegation possible. Before permissions existed the
 * owner had exactly two settings for an employee — "can do everything an
 * administrator can" or "cannot enter the console at all" — so handing one
 * person the order queue meant handing them the ability to void paid sales,
 * read every report and reset passwords.
 *
 * Three things it is deliberate about:
 *
 *  - BUILT-IN ROLES ARE READ-ONLY, and the page says WHY rather than just
 *    disabling the buttons. Their capability sets live in the application's
 *    code because a row that could strip `rbac.manage` from the administrator
 *    is a lockout no route can undo.
 *  - A ROLE IN USE CANNOT BE DELETED, and the page offers deactivation
 *    instead — which suspends everything the role grants while keeping the
 *    assignments, so the change is reversible. Deleting would lose them.
 *  - PERMISSIONS ARE SHOWN BY THEIR PERSIAN MEANING. `orders.status.update` is
 *    a machine key; «تغییر وضعیت سفارش» is what an administrator decides
 *    about. The code appears only as secondary text.
 */
export function AdminAccess({ params }: { params: RawSearchParams }) {
  void params;
  return (
    <RequirePermission permissions={["rbac.read"]}>
      <AccessBody />
    </RequirePermission>
  );
}

function AccessBody() {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchRoles(api, { signal }),
    [api],
  );

  const builtIn = (data ?? []).filter((role) => role.isSystem);
  const custom = (data ?? []).filter((role) => !role.isSystem);

  return (
    <>
      <AdminPageHeader
        title="نقش‌ها و دسترسی‌ها"
        description="هر نقش مجموعه‌ای از اختیارات است. کاربران می‌توانند چند نقش داشته باشند و اختیارات آن‌ها با هم جمع می‌شود."
        actions={
          <Gate permissions={["rbac.manage"]}>
            <Link href="/admin/access/roles/new" className="no-underline">
              <Button size="sm" leadingIcon={<PlusIcon className="size-4" />}>
                نقش تازه
              </Button>
            </Link>
          </Gate>
        }
      />

      {/*
        THE OLD SENTENCE PROMISED A DESTINATION THIS PERSONA CANNOT OPEN.
        Assigning a role to a user happens on `/admin/users/:id`, and that page
        requires `users.read` — a capability an RBAC administrator holding
        `rbac.read` + `rbac.manage` does NOT have, and must not be given here:
        the user page carries staff mobile numbers, branch assignment, session
        counts and password controls, none of which is needed to decide which
        capabilities a role grants. So the instruction is corrected rather than
        the access widened; see the note the fallback renders.
      */}
      <Notice tone="info" title="این صفحه چه کاری انجام می‌دهد؟" className="mb-5">
        اینجا تعیین می‌کنید هر نقش چه کارهایی می‌تواند انجام دهد — مثلاً «مشاهدهٔ سفارش‌ها» بدون
        «ابطال سفارش». بررسی این اختیارات روی سرور انجام می‌شود؛ پنهان‌بودن یک دکمه در مرورگر
        هیچ‌گاه جای کنترل دسترسی را نمی‌گیرد.{" "}
        <Gate
          permissions={["users.read"]}
          fallback={
            <>
              اختصاص نقش به یک کاربر در صفحهٔ خودِ آن کاربر انجام می‌شود، و باز کردن آن صفحه —
              علاوه بر <bdi dir="ltr">rbac.manage</bdi> — به اختیار <bdi dir="ltr">users.read</bdi>{" "}
              نیاز دارد که حساب شما ندارد. این عمدی است: آن صفحه شمارهٔ موبایل، شعبه، نشست‌ها و
              بازنشانی گذرواژهٔ کارکنان را هم نشان می‌دهد و برای تعیین اختیارات یک نقش لازم نیست.
              از این صفحه می‌توانید خودِ نقش‌ها و اختیاراتشان را بسازید و تغییر دهید؛ برای
              اختصاص‌دادن یک نقش به یک شخص از مدیر ارشد یا از کسی که فهرست کاربران را می‌بیند
              کمک بگیرید.
            </>
          }
        >
          اختصاص نقش به هر کاربر در صفحهٔ خودِ آن کاربر انجام می‌شود.
        </Gate>
      </Notice>

      {error ? (
        <ErrorState error={error} title="فهرست نقش‌ها خوانده نشد" onRetry={refetch} />
      ) : isLoading || !data ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <span className="kz-sr-only">در حال بارگذاری</span>
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} shape="block" height="3.5rem" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          <AdminSection
            title="نقش‌های سیستمی"
            description="این سه نقش بخشی از ساختار برنامه‌اند: نه حذف می‌شوند، نه غیرفعال، و نه اختیاراتشان از این صفحه تغییر می‌کند. دلیلش این است که گرفتن اختیار «مدیریت دسترسی‌ها» از مدیر ارشد، سامانه را برای همیشه بدون مدیر می‌گذارد و هیچ مسیری برای بازگرداندنش نمی‌ماند."
          >
            <RoleTable roles={builtIn} />
          </AdminSection>

          <AdminSection
            title="نقش‌های سازمانی"
            description="نقش‌هایی که خودتان می‌سازید — مثل مدیر سفارش‌ها، مسئول انبار یا مسئول کاتالوگ."
          >
            <RoleTable roles={custom} empty="هنوز نقش سازمانی نساخته‌اید." />
          </AdminSection>
        </div>
      )}
    </>
  );
}

function RoleTable({
  roles,
  empty = "نقشی یافت نشد.",
}: {
  roles: Array<{
    id: number;
    name: string;
    titleFa: string;
    description: string | null;
    isSystem: boolean;
    isActive: boolean;
    userCount: number;
    permissionCount: number;
  }>;
  empty?: string;
}) {
  return (
    <DataTable minWidth="38rem" caption="فهرست نقش‌ها">
      <thead>
        <tr>
          <Th>نقش</Th>
          <Th>وضعیت</Th>
          <Th numeric>تعداد اختیارات</Th>
          <Th numeric>تعداد کاربران</Th>
          <Th>
            <span className="kz-sr-only">اقدام</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {roles.length === 0 ? (
          <EmptyRow colSpan={5}>{empty}</EmptyRow>
        ) : (
          roles.map((role) => (
            <Tr key={role.id}>
              <Td>
                <span className="flex items-center gap-2">
                  {role.isSystem ? (
                    <LockIcon className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  ) : (
                    <KeyIcon className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    <span className="block font-bold text-ink">{role.titleFa}</span>
                    <bdi dir="ltr" className="block text-2xs text-ink-subtle">
                      {role.name}
                    </bdi>
                    {role.description ? (
                      <span className="mt-0.5 block max-w-[44ch] text-2xs leading-relaxed text-ink-muted">
                        {role.description}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  <Badge size="sm" tone={role.isActive ? "success" : "neutral"}>
                    {role.isActive ? "فعال" : "غیرفعال"}
                  </Badge>
                  {role.isSystem ? (
                    <Badge size="sm" tone="primary">
                      سیستمی
                    </Badge>
                  ) : null}
                </span>
              </Td>
              <Td numeric>{count(role.permissionCount)}</Td>
              <Td numeric>
                {/*
                  The COUNT comes from this page's own `rbac.read` query; the
                  LINK opens the account directory, which declares `users.read`.
                  The number is therefore always shown and only the navigation
                  is withheld.
                */}
                {role.userCount > 0 ? (
                  <Gate permissions={["users.read"]} fallback={count(role.userCount)}>
                    <Link
                      href={`/admin/users?roleId=${role.id}` as Route}
                      className="no-underline"
                    >
                      {count(role.userCount)}
                    </Link>
                  </Gate>
                ) : (
                  count(role.userCount)
                )}
              </Td>
              <Td>
                <Link href={`/admin/access/roles/${role.id}` as Route} className="text-xs">
                  {role.isSystem ? "مشاهدهٔ اختیارات" : "ویرایش"}
                </Link>
              </Td>
            </Tr>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
