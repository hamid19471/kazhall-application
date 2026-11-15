"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

import { isMissingOrForbidden } from "@kazhal/api-client";
import { Badge, Button, ErrorState, Input, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  Checkbox,
  ConfirmDialog,
  Fact,
  Gate,
  RequirePermission,
  Select,
  StatTile,
  count,
  useMutation,
  when,
} from "@/components/admin/ui";
import {
  AccountKindBadge,
  AccountStatusBadge,
  MutationError,
  RoleBadges,
  SurfaceBadges,
} from "@/components/admin/people-shared";
import { useAppSession } from "@/components/providers";
import { can } from "@/lib/permissions";
import { KeyIcon, LockIcon, LogoutIcon, ShieldIcon } from "@/components/icons";
import {
  fetchBranches,
  fetchPermissionCatalogue,
  fetchAssignableRoles,
  fetchUser,
  resetUserPassword,
  revokeUserSessions,
  setUserActive,
  setUserRoles,
  updateUser,
} from "@/lib/admin-api";
import type {
  AdminUserDetail as AdminUserDetailRow,
  AssignableRole,
} from "@/lib/admin-api";
import { ACCOUNT_SURFACES, audienceLabel } from "@/lib/labels";
import { adminBranchHref, adminUsersHref } from "@/lib/routes";

/** Every branch the select can offer. The API caps `limit` at 100. */
const BRANCH_OPTION_LIMIT = 100;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;

/**
 * ONE ACCOUNT, and everything that can be done to it.
 *
 * WHAT THIS SCREEN NEVER SHOWS. No password, no hash, no token, no session id.
 * The API does not return any of them and this screen must not create a reason
 * for it to start: a password is stored as a one-way hash, so "show me their
 * password" is not a feature that was left out, it is a question with no
 * answer. Sessions are shown only as COUNTS per surface.
 */
export function AdminUserDetail({ userId }: { userId: number }) {
  return (
    <RequirePermission permissions={["users.read"]}>
      <UserBody userId={userId} />
    </RequirePermission>
  );
}

function UserBody({ userId }: { userId: number }) {
  const api = useApi();
  const { data: user, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchUser(api, userId, { signal }),
    [api, userId],
  );

  if (error) {
    return (
      <>
        <AdminPageHeader title="کاربر" />
        {/*
          403 and 404 stay INDISTINGUISHABLE here, exactly as `ErrorState`
          intends: the lookup route answers "you may not see this" and "this
          does not exist" with different statuses, and copy that told them apart
          would let anybody probe which user ids exist.
        */}
        <ErrorState
          error={error}
          title={isMissingOrForbidden(error) ? "این کاربر در دسترس نیست" : "اطلاعات این کاربر خوانده نشد"}
          description={
            isMissingOrForbidden(error)
              ? "شناسهٔ این نشانی به حسابی که شما بتوانید ببینید اشاره نمی‌کند."
              : "ارتباط با سرور برقرار نشد. هیچ تغییری روی این حساب ثبت نشده است."
          }
          onRetry={refetch}
        />
        <p className="mt-4 text-sm">
          <Link href={adminUsersHref()}>بازگشت به فهرست کاربران</Link>
        </p>
      </>
    );
  }

  if (isLoading || !user) {
    return (
      <>
        <AdminPageHeader title="کاربر" />
        <div role="status" aria-busy="true" className="space-y-4">
          <span className="kz-sr-only">در حال بارگذاری اطلاعات کاربر</span>
          <Skeleton shape="block" height="8rem" />
          <Skeleton shape="block" height="14rem" />
          <Skeleton shape="block" height="14rem" />
        </div>
      </>
    );
  }

  return (
    <>
      <AdminPageHeader
        title={
          user.username ? (
            <bdi dir="ltr" data-numeric="">
              {user.username}
            </bdi>
          ) : (
            <bdi dir="ltr" data-numeric="">
              {user.identifier}
            </bdi>
          )
        }
        description={
          user.isStaff ? (
            <>
              حساب کارمند: ورود با نام کاربری و گذرواژه. نقش‌ها و شعبهٔ این حساب در هر درخواست از
              پایگاه داده خوانده می‌شوند، نه از توکن او — پس هر تغییری در این صفحه از نخستین
              درخواست بعدی او اثر می‌گذارد.
            </>
          ) : (
            <>
              حساب مشتری: ورود با کد یک‌بارمصرف پیامکی. برای این حساب هیچ گذرواژه‌ای ذخیره نشده
              است، چون هیچ‌وقت نام کاربری نداشته.
            </>
          )
        }
        meta={
          <>
            <AccountStatusBadge isActive={user.isActive} />
            <AccountKindBadge user={user} />
            {user.mustChangePassword ? (
              <Badge size="sm" tone="warning">
                باید گذرواژه را عوض کند
              </Badge>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="نشست‌های باز"
          value={count(user.activeSessionCount)}
          hint="شمار نشست‌های فعال این حساب در همهٔ سطوح. یک دستگاه با یک نشست شمرده می‌شود."
          tone={user.activeSessionCount > 0 ? "primary" : "neutral"}
        />
        <StatTile
          label="فروش‌های ثبت‌شده به نام او"
          value={count(user.salesCount)}
          hint="سفارش‌هایی که این حساب به‌عنوان فروشنده روی آن‌ها ثبت شده است. حسابی که فروش دارد هرگز حذف نمی‌شود، فقط غیرفعال می‌شود."
        />
        <StatTile
          label="شمار نقش‌ها"
          value={count(user.roles.length)}
          hint="اختیارات این حساب مجموع اختیارات همین نقش‌ها است."
        />
        <StatTile
          label="شمار اختیارات"
          value={count(user.permissions.length)}
          hint="مجموعهٔ یکتای اختیاراتی که از نقش‌های فعال او به دست می‌آید."
        />
      </div>

      <div className="space-y-4">
        <IdentitySection user={user} onSaved={refetch} />
        <RolesSection
          key={`roles-${user.roles.map((role) => role.id).join("-")}`}
          user={user}
          onSaved={refetch}
        />
        <PermissionsSection user={user} />
        <SessionsSection user={user} onChanged={refetch} />
        <PasswordSection user={user} onChanged={refetch} />
        <LifecycleSection user={user} onChanged={refetch} />
        <MetadataSection user={user} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Identity and branch
// ---------------------------------------------------------------------------

/**
 * The two identifiers and the branch.
 *
 * ONLY CHANGED FIELDS ARE SENT. `PATCH /admin/users/:id` treats a present key
 * as an instruction, and re-sending an unchanged username makes the uniqueness
 * check run against the whole table for no reason — it also turns a no-op save
 * into an audit row that says something changed when nothing did.
 */
function IdentitySection({
  user,
  onSaved,
}: {
  user: AdminUserDetailRow;
  onSaved: () => void;
}) {
  const api = useApi();
  const { session } = useAppSession();
  /*
   * The branch REGISTER is a separate capability from the account directory:
   * `GET /branch` declares `branches.read`, which `users.read` does not imply.
   * Without it the branch SELECT cannot be offered — its options would be
   * empty, and saving an empty select would silently clear the user's branch —
   * so the field is dropped from the form and the fact is stated instead.
   */
  const canReadBranches = can(session, "branches.read");
  const branches = useApiQuery(
    (signal) => fetchBranches(api, { limit: BRANCH_OPTION_LIMIT }, { signal }),
    [api],
    { enabled: canReadBranches },
  );
  const save = useMutation(updateUser);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const mobile = String(form.get("mobile") ?? "").trim();
    const branch = String(form.get("branchId") ?? "");

    const body: { username?: string; mobile?: string | null; branchId?: number | null } = {};

    if (username !== (user.username ?? "")) {
      if (username === "" && user.username !== null) {
        // The API has no way to remove a username, and it should not: a staff
        // account without one could never sign in again.
        setFieldError("نام کاربری یک حساب کارمند را نمی‌توان خالی کرد. برای بستن دسترسی، حساب را غیرفعال کنید.");
        return;
      }
      if (username !== "") body.username = username;
    }
    if (mobile !== (user.mobile ?? "")) body.mobile = mobile === "" ? null : mobile;
    /*
     * ONLY WHEN THE FIELD WAS ACTUALLY RENDERED. With no `branches.read` the
     * select is absent, so `form.get("branchId")` is null — and treating that
     * as the empty option would send `branchId: null` and silently unassign
     * the branch of every account this operator saves.
     */
    if (canReadBranches) {
      const currentBranch = user.branchId === null ? "" : String(user.branchId);
      if (branch !== currentBranch) body.branchId = branch === "" ? null : Number(branch);
    }

    if (Object.keys(body).length === 0) {
      setFieldError("چیزی تغییر نکرده است.");
      return;
    }

    const result = await save.run(api, user.id, body);
    if (result) {
      save.setDone(result.message);
      onSaved();
    }
  }

  return (
    <AdminSection
      title="شناسه و شعبه"
      description="نام کاربری، شمارهٔ موبایل و شعبه‌ای که فروش حضوری این حساب به آن نسبت داده می‌شود."
    >
      <dl className="mb-4 grid gap-2 sm:grid-cols-3">
        <Fact label="نام کاربری" numeric>
          {user.username ? (
            <bdi dir="ltr">{user.username}</bdi>
          ) : (
            <span className="text-ink-muted">ندارد</span>
          )}
        </Fact>
        <Fact label="شمارهٔ موبایل" numeric>
          {user.mobile ? (
            <bdi dir="ltr">{user.mobile}</bdi>
          ) : (
            <span className="text-ink-muted">ندارد</span>
          )}
        </Fact>
        <Fact
          label="شعبه"
          hint={
            user.branchIsActive === false
              ? "این شعبه غیرفعال است و فروش حضوری در آن ثبت نمی‌شود."
              : undefined
          }
        >
          {user.branchId === null ? (
            <span className="text-ink-muted">بدون شعبه</span>
          ) : (
            <Gate
              permissions={["branches.read"]}
              fallback={<span>{user.branchName ?? `شعبهٔ ${user.branchId}`}</span>}
            >
              <Link href={adminBranchHref(user.branchId)} className="no-underline">
                {user.branchName ?? `شعبهٔ ${user.branchId}`}
              </Link>
            </Gate>
          )}
        </Fact>
      </dl>

      <Gate
        permissions={["users.update"]}
        fallback={
          <p className="text-xs text-ink-subtle">
            برای ویرایش این بخش به اختیار <bdi dir="ltr">users.update</bdi> نیاز است.
          </p>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              name="username"
              label="نام کاربری"
              defaultValue={user.username ?? ""}
              minLength={3}
              maxLength={30}
              pattern="[A-Za-z0-9_]+"
              autoComplete="off"
              containerClassName="min-w-0"
              hint={
                user.isStaff
                  ? "۳ تا ۳۰ نویسه، فقط حرف و رقم لاتین و زیرخط — همان چارستی که صفحهٔ ورود می‌پذیرد."
                  : "این حساب مشتری است و گذرواژه ندارد. اگر برای آن نام کاربری بگذارید، در فهرست‌ها «کارمند» شمرده می‌شود ولی تا وقتی گذرواژه‌ای تعیین نشود نمی‌تواند با نام کاربری وارد شود."
              }
            />
            <Input
              name="mobile"
              label="شمارهٔ موبایل"
              defaultValue={user.mobile ?? ""}
              numeric
              maxLength={11}
              pattern="09[0-9]{9}"
              autoComplete="off"
              containerClassName="min-w-0"
              hint="به شکل ۰۹XXXXXXXXX. خالی گذاشتن آن شماره را پاک می‌کند؛ ورود مشتری با همین شماره انجام می‌شود."
            />
            {canReadBranches ? (
              <Select
                name="branchId"
                label="شعبه"
                defaultValue={user.branchId === null ? "" : String(user.branchId)}
                containerClassName="min-w-0"
                options={[
                  { value: "", label: "بدون شعبه" },
                  ...(branches.data?.data ?? []).map((branch) => ({
                    value: String(branch.id),
                    label: branch.isActive ? branch.name : `${branch.name} (غیرفعال)`,
                  })),
                ]}
                hint="صندوق‌دار بدون شعبه پشت صندوق رد می‌شود، چون فروش حضوری به یک شعبه نسبت داده می‌شود."
              />
            ) : (
              <p className="min-w-0 text-xs leading-relaxed text-ink-subtle">
                تغییر شعبه به اختیار <bdi dir="ltr">branches.read</bdi> نیاز دارد، چون فهرست
                شعبه‌ها بدون آن خوانده نمی‌شود. شعبهٔ کنونی این حساب بالاتر آمده و با ذخیرهٔ این
                فرم تغییر نمی‌کند.
              </p>
            )}
          </div>

          <Notice tone="info">
            <p>
              تغییر شعبه از <b>نخستین درخواست بعدی</b> این کاربر اعمال می‌شود: شعبه در هر درخواست از
              پایگاه داده خوانده می‌شود و هیچ‌وقت از توکن او. پس نه لازم است او را از سامانه بیرون
              کنید و نه نشست‌های بازش قطع می‌شود.
            </p>
          </Notice>

          {fieldError ? <Notice tone="warning">{fieldError}</Notice> : null}
          <MutationError error={save.error} />
          {save.done ? <Notice tone="success">{save.done}</Notice> : null}

          <Button type="submit" isLoading={save.isPending}>
            ذخیرهٔ شناسه و شعبه
          </Button>
        </form>
      </Gate>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * ROLE ASSIGNMENT.
 *
 * `PUT .../roles` REPLACES the whole set, so the checklist is the request: an
 * unchecked box is a removal, not an omission. The confirmation therefore names
 * both lists explicitly — "add cashier" and "replace every role with cashier"
 * are the same request here, and only one of them is what the operator meant.
 */
function RolesSection({ user, onSaved }: { user: AdminUserDetailRow; onSaved: () => void }) {
  const api = useApi();
  const { session } = useAppSession();
  /*
   * THE CHECKLIST IS BUILT FROM THE ASSIGNABLE ROLES, NOT THE WHOLE CATALOGUE.
   *
   * It used to read `GET /admin/access/roles` and offer every role in the
   * system, including ones this operator could never confer — so a perfectly
   * reasonable-looking tick produced a 403 `PERMISSION_ESCALATION` on submit,
   * after the operator had already opened the confirmation dialog.
   * `GET /admin/users/assignable-roles` answers the narrower question with the
   * SAME rule the mutation applies, so what is offered is what will be
   * accepted.
   *
   * The request is still gated on `rbac.read`, because CHANGING roles genuinely
   * needs `rbac.read` AND `rbac.manage` on the server and there is no point
   * fetching a list for a control that will not render. Creating a user is the
   * case where that coupling was wrong, and `user-create.tsx` no longer has it.
   */
  const canReadRoles = can(session, "rbac.read");
  const roles = useApiQuery(
    (signal) => fetchAssignableRoles(api, { signal }),
    [api],
    { enabled: canReadRoles },
  );
  const assign = useMutation(setUserRoles);

  const [selected, setSelected] = useState<number[]>(() => user.roles.map((role) => role.id));
  const [confirming, setConfirming] = useState(false);

  const current = new Set(user.roles.map((role) => role.id));
  const chosen = new Set(selected);
  const all = roles.data ?? [];
  const added = all.filter((role) => chosen.has(role.id) && !current.has(role.id));
  const removed = user.roles.filter((role) => !chosen.has(role.id));
  const dirty = added.length > 0 || removed.length > 0;

  /*
   * ROLES THIS ACCOUNT HOLDS THAT THIS OPERATOR COULD NOT CONFER.
   *
   * `PUT /admin/access/users/:id/roles` REPLACES the whole set and checks
   * escalation against the resulting set — so if the account holds a role
   * beyond the operator's authority, EVERY change is refused, including one
   * that only removes something. Saying so up front is the difference between
   * a form that explains itself and one that 403s after a confirmation
   * dialog.
   */
  const assignableIds = new Set(all.map((role) => role.id));
  const beyondAuthority = roles.isLoading
    ? []
    : user.roles.filter((role) => !assignableIds.has(role.id));
  const locked = beyondAuthority.length > 0;

  async function confirm() {
    const result = await assign.run(api, user.id, selected);
    setConfirming(false);
    if (result) {
      assign.setDone(result.message);
      onSaved();
    }
  }

  return (
    <AdminSection
      title="نقش‌ها"
      description="اختیارات این حساب از نقش‌های آن می‌آید؛ هیچ اختیاری به‌طور مستقیم به یک کاربر داده نمی‌شود."
    >
      <div className="mb-4">
        <p className="mb-2 text-xs text-ink-subtle">نقش‌های کنونی</p>
        <RoleBadges roles={user.roles} />
      </div>

      <Gate
        permissions={["rbac.read", "rbac.manage"]}
        fallback={
          <p className="text-xs text-ink-subtle">
            تغییر نقش‌ها به اختیارهای <bdi dir="ltr">rbac.read</bdi> و{" "}
            <bdi dir="ltr">rbac.manage</bdi> با هم نیاز دارد — همان دو اختیاری که سرور روی مسیر
            اختصاص نقش می‌خواهد.
          </p>
        }
      >
        {roles.error ? (
          <Notice tone="warning">
            <p>فهرست نقش‌ها خوانده نشد، پس تغییر نقش در این لحظه ممکن نیست. صفحه را به‌روز کنید.</p>
          </Notice>
        ) : (
          <>
            {locked ? (
              <Notice tone="warning" className="mb-4">
                <p>
                  این حساب نقش‌هایی دارد که شما اختیار واگذاری‌شان را ندارید (
                  {beyondAuthority.map((role) => role.titleFa || role.name).join("، ")}). چون
                  تغییر نقش‌ها کل فهرست را جایگزین می‌کند، سرور هر تغییری روی این حساب را رد
                  می‌کند — حتی برداشتن یک نقش. برای تغییر این حساب از مدیری بخواهید که همهٔ
                  اختیارهای آن را دارد.
                </p>
              </Notice>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              {all.map((role) => (
                <Checkbox
                  key={role.id}
                  label={role.titleFa ?? role.name}
                  disabled={locked}
                  checked={chosen.has(role.id)}
                  description={roleDescription(role)}
                  onChange={(checked) =>
                    setSelected((previous) =>
                      checked
                        ? [...previous.filter((id) => id !== role.id), role.id]
                        : previous.filter((id) => id !== role.id),
                    )
                  }
                />
              ))}
            </div>

            <MutationError
              className="mt-4"
              error={assign.error}
            />
            {assign.done ? (
              <Notice tone="success" className="mt-4">
                {assign.done}
              </Notice>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => setConfirming(true)}
                disabled={!dirty || locked}
                leadingIcon={<ShieldIcon className="size-4" />}
              >
                ذخیرهٔ نقش‌ها
              </Button>
              {dirty ? (
                <span className="text-xs text-ink-muted">
                  {count(added.length)} افزودن، {count(removed.length)} برداشتن
                </span>
              ) : (
                <span className="text-xs text-ink-subtle">تغییری برای ذخیره نیست.</span>
              )}
            </div>
          </>
        )}
      </Gate>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        isPending={assign.isPending}
        tone="danger"
        title="تغییر نقش‌های این کاربر"
        question="این فهرست، جایگزین کاملِ نقش‌های کنونی می‌شود."
        confirmLabel="بله، نقش‌ها را عوض کن"
        consequences={[
          added.length > 0 ? (
            <>
              نقش‌های <b>افزوده‌شده</b>: {added.map((role) => role.titleFa).join("، ")}
            </>
          ) : (
            "هیچ نقشی افزوده نمی‌شود."
          ),
          removed.length > 0 ? (
            <>
              نقش‌های <b>برداشته‌شده</b>: {removed.map((role) => role.titleFa).join("، ")} — هر
              اختیاری که فقط از این نقش‌ها می‌آمد از دست می‌رود.
            </>
          ) : (
            "هیچ نقشی برداشته نمی‌شود."
          ),
          "این تغییر از نخستین درخواست بعدی این کاربر اعمال می‌شود؛ نقش‌ها در هر درخواست از پایگاه داده خوانده می‌شوند و در توکن او ذخیره نشده‌اند.",
          "نشست‌های باز او قطع نمی‌شود، هیچ پولی جابه‌جا نمی‌شود، وضعیت هیچ سفارشی عوض نمی‌شود و موجودی هیچ کالایی تغییر نمی‌کند.",
          "این کار برگشت‌پذیر است: می‌توانید همین فهرست را به حالت قبل برگردانید.",
        ]}
      />
    </AdminSection>
  );
}

function roleDescription(role: AssignableRole): string {
  const parts: string[] = [];
  if (!role.isActive) parts.push("این نقش غیرفعال است و هیچ اختیاری نمی‌دهد");
  if (role.isSystem) parts.push("نقش سامانه‌ای");
  if (role.description) parts.push(role.description);
  parts.push(`${role.permissionCount} اختیار`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Effective permissions
// ---------------------------------------------------------------------------

/**
 * WHAT THIS ACCOUNT CAN ACTUALLY DO.
 *
 * The union over every ACTIVE role, computed server-side — which is why it is
 * shown here rather than reconstructed from the checklist above: a deactivated
 * role stays assigned and contributes nothing, so adding up the role cards
 * would over-report.
 *
 * The Persian label comes from `GET /admin/access/permissions`, never from a
 * copy of those forty strings kept in this app. The raw code stays visible as
 * secondary text because it is what an API refusal names.
 */
function PermissionsSection({ user }: { user: AdminUserDetailRow }) {
  const api = useApi();
  const { session } = useAppSession();
  /*
   * The Persian names are OPTIONAL ENRICHMENT, and `GET
   * /admin/access/permissions` declares `rbac.read`. Without it the codes are
   * still the truth and are still shown — the heading below says why they have
   * no Persian labels instead of implying the catalogue is incomplete.
   */
  const canReadCatalogue = can(session, "rbac.read");
  const catalogue = useApiQuery((signal) => fetchPermissionCatalogue(api, { signal }), [api], {
    enabled: canReadCatalogue,
  });

  const held = new Set(user.permissions);
  const groups = catalogue.data?.groups ?? [];
  const catalogued = new Set(
    groups.flatMap((group) => group.permissions.map((permission) => permission.code)),
  );
  const unknown = user.permissions.filter((code) => !catalogued.has(code));

  return (
    <AdminSection
      title="اختیارات مؤثر"
      description="مجموع اختیارات همهٔ نقش‌های فعال این حساب، روی هم. اگر اختیاری از دو نقش بیاید یک بار شمرده می‌شود."
    >
      {user.permissions.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-subtle">
          این حساب هیچ اختیاری ندارد. اگر نقشی به آن داده شده، ممکن است آن نقش غیرفعال باشد.
        </p>
      ) : catalogue.isLoading ? (
        <Skeleton shape="block" height="10rem" />
      ) : (
        <>
          <div className="space-y-4">
            {groups.map((group) => {
              const rows = group.permissions.filter((permission) => held.has(permission.code));
              if (rows.length === 0) return null;
              return (
                <div key={group.key}>
                  <h3 className="mb-2 text-sm font-bold text-ink">{group.titleFa}</h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {rows.map((permission) => (
                      <li
                        key={permission.code}
                        className="min-w-0 rounded-md border border-line p-2.5"
                      >
                        <p className="text-sm text-ink">{permission.labelFa}</p>
                        <bdi
                          dir="ltr"
                          data-numeric=""
                          className="mt-0.5 block truncate text-2xs text-ink-subtle"
                        >
                          {permission.code}
                        </bdi>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          {/*
            An unlisted code is not noise to hide: it means the server grants
            something this console has no Persian name for, and the operator
            must be able to see it rather than believe the list is complete.
          */}
          {unknown.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-bold text-ink">
                {canReadCatalogue
                  ? "بدون نام فارسی در فهرست اختیارات"
                  : "اختیارات این حساب، با کد"}
              </h3>
              {canReadCatalogue ? null : (
                <p className="mb-2 text-xs leading-relaxed text-ink-subtle">
                  نام فارسی هر اختیار از فهرست اختیارات سرور خوانده می‌شود و آن فهرست به اختیار{" "}
                  <bdi dir="ltr">rbac.read</bdi> نیاز دارد. کدها خودشان همان چیزی هستند که سرور
                  در پیام رد کردن نام می‌برد.
                </p>
              )}
              <p className="flex flex-wrap gap-1.5">
                {unknown.map((code) => (
                  <Badge key={code} size="sm" tone="neutral">
                    <bdi dir="ltr">{code}</bdi>
                  </Badge>
                ))}
              </p>
            </div>
          ) : null}
        </>
      )}
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function SessionsSection({
  user,
  onChanged,
}: {
  user: AdminUserDetailRow;
  onChanged: () => void;
}) {
  const api = useApi();
  const revoke = useMutation(revokeUserSessions);
  const [confirming, setConfirming] = useState(false);

  /*
   * The three known audiences are always rendered, with zero where there is no
   * session: a surface that simply vanishes from the list reads as "no data"
   * rather than "nobody is signed in there".
   */
  const known = ACCOUNT_SURFACES.map((audience) => ({
    audience,
    total: user.sessionsByAudience[audience] ?? 0,
  }));
  const extra = Object.entries(user.sessionsByAudience).filter(
    ([audience]) => !(ACCOUNT_SURFACES as readonly string[]).includes(audience),
  );

  async function confirm() {
    const result = await revoke.run(api, user.id);
    setConfirming(false);
    if (result) {
      revoke.setDone(`${result.message} — ${count(result.revoked)} نشست بسته شد.`);
      onChanged();
    }
  }

  return (
    <AdminSection
      title="نشست‌های باز"
      description="هر سطح کوکی و توکن خودش را دارد، پس ورود به صندوق ورود به پنل مدیریت نیست. اینجا فقط شمار نشست‌ها دیده می‌شود؛ شناسهٔ نشست و توکن هیچ‌وقت نمایش داده نمی‌شود."
    >
      <dl className="grid gap-2 sm:grid-cols-3">
        {known.map((row) => (
          <Fact key={row.audience} label={audienceLabel(row.audience)} numeric>
            {count(row.total)}
          </Fact>
        ))}
        {extra.map(([audience, total]) => (
          <Fact key={audience} label={audienceLabel(audience)} numeric>
            {count(total)}
          </Fact>
        ))}
      </dl>

      <MutationError className="mt-4" error={revoke.error} />
      {revoke.done ? (
        <Notice tone="success" className="mt-4">
          {revoke.done}
        </Notice>
      ) : null}

      <Gate permissions={["users.sessions.revoke"]}>
        <div className="mt-4">
          <Button
            variant="danger"
            onClick={() => setConfirming(true)}
            disabled={user.activeSessionCount === 0}
            leadingIcon={<LogoutIcon className="size-4" />}
          >
            قطع همهٔ نشست‌ها
          </Button>
          {user.activeSessionCount === 0 ? (
            <p className="mt-1.5 text-2xs text-ink-subtle">
              نشست بازی وجود ندارد؛ چیزی برای قطع‌کردن نیست.
            </p>
          ) : null}
        </div>
      </Gate>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        isPending={revoke.isPending}
        title="قطع همهٔ نشست‌های این کاربر"
        question="همهٔ دستگاه‌ها و همهٔ سطوح، یک‌جا."
        confirmLabel="بله، همه را قطع کن"
        consequences={[
          "این کاربر از همهٔ دستگاه‌ها و همهٔ سطوح — فروشگاه اینترنتی، پنل مدیریت و صندوق فروشگاه — بیرون انداخته می‌شود.",
          "حساب او غیرفعال نمی‌شود: می‌تواند بی‌درنگ با همان نام کاربری و همان گذرواژه دوباره وارد شود.",
          "هیچ پولی جابه‌جا نمی‌شود، وضعیت هیچ سفارشی عوض نمی‌شود و موجودی هیچ کالایی تغییر نمی‌کند.",
          "اگر همین لحظه پشت صندوق مشغول فروش باشد، کار نیمه‌تمامش از دست می‌رود و باید دوباره وارد شود.",
          "نقش‌ها، شعبه و گذرواژهٔ او دست‌نخورده می‌ماند.",
        ]}
      />
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * A TEMPORARY PASSWORD THE ADMINISTRATOR CHOOSES.
 *
 * Deliberately not generated: a generated password has to be displayed to be
 * usable, and a password displayed on a screen ends up in a screenshot, a
 * ticket or a chat message. The administrator types one, reads it out, and
 * nothing is stored anywhere except the one-way hash.
 *
 * The field is `type="text"` on purpose — the person typing it must be able to
 * read it back over the phone — and `direction: ltr` is set through `style`
 * because `Input`'s `numeric` prop would also switch the mobile keyboard to a
 * numeric pad, which is wrong for a password.
 */
function PasswordSection({
  user,
  onChanged,
}: {
  user: AdminUserDetailRow;
  onChanged: () => void;
}) {
  const api = useApi();
  const reset = useMutation(resetUserPassword);
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);

  const tooShort = value.length > 0 && value.length < PASSWORD_MIN;
  const ready = value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;

  async function confirm() {
    const result = await reset.run(api, user.id, value);
    setConfirming(false);
    if (result) {
      reset.setDone(`${result.message} — ${count(result.revoked)} نشست بسته شد.`);
      setValue("");
      onChanged();
    }
  }

  return (
    <AdminSection
      title="گذرواژه"
      description="گذرواژهٔ فعلی نمایش داده نمی‌شود و قابل نمایش هم نیست: از آن فقط یک درهم‌سازی یک‌طرفه ذخیره شده و بازگردانی‌اش ممکن نیست."
    >
      {!user.isStaff ? (
        <Notice tone="warning" className="mb-4">
          <p>
            این حساب مشتری است و گذرواژه‌ای ندارد؛ ورود آن با کد یک‌بارمصرف پیامکی انجام می‌شود.
            سرور این درخواست را با خطای <bdi dir="ltr">NOT_A_STAFF_ACCOUNT</bdi> رد می‌کند.
          </p>
        </Notice>
      ) : null}

      <Gate
        permissions={["users.password.reset"]}
        fallback={
          <p className="text-xs text-ink-subtle">
            بازنشانی گذرواژه به اختیار <bdi dir="ltr">users.password.reset</bdi> نیاز دارد.
          </p>
        }
      >
        <div className="max-w-md space-y-3">
          <Input
            label="گذرواژهٔ موقت"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            style={{ direction: "ltr" }}
            hint={`بین ${PASSWORD_MIN} تا ${PASSWORD_MAX} نویسه. سامانه گذرواژه نمی‌سازد و نمایش نمی‌دهد؛ این مقدار را شما انتخاب می‌کنید و رو‌در‌رو یا تلفنی به کاربر می‌گویید.`}
            error={tooShort ? `گذرواژه باید دست‌کم ${PASSWORD_MIN} نویسه باشد.` : undefined}
          />

          <MutationError error={reset.error} />
          {reset.done ? <Notice tone="success">{reset.done}</Notice> : null}

          <Button
            onClick={() => setConfirming(true)}
            disabled={!ready}
            variant="danger"
            leadingIcon={<LockIcon className="size-4" />}
          >
            تعیین گذرواژهٔ موقت
          </Button>
        </div>
      </Gate>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        isPending={reset.isPending}
        title="تعیین گذرواژهٔ موقت"
        question="گذرواژهٔ فعلی این حساب جایگزین می‌شود."
        confirmLabel="بله، گذرواژه را عوض کن"
        consequences={[
          "گذرواژهٔ فعلی این کاربر نه نمایش داده می‌شود و نه قابل نمایش است: فقط درهم‌سازی یک‌طرفهٔ آن ذخیره شده و بازگردانی‌اش ممکن نیست.",
          "گذرواژه‌ای که شما تایپ کردید جای گذرواژهٔ فعلی را می‌گیرد و از همان لحظه گذرواژهٔ قبلی کار نمی‌کند.",
          "همهٔ نشست‌های باز این کاربر، در همهٔ سطوح، در همان تراکنش بسته می‌شود.",
          "این کاربر در نخستین ورود ناچار است خودش گذرواژه را عوض کند؛ همین مقدار را نگه نمی‌دارد.",
          "این مقدار را رو‌در‌رو یا تلفنی به او بگویید؛ در پیام، ایمیل یا یادداشت مکتوب نفرستید. سامانه آن را جایی نگه نمی‌دارد تا بعداً بشود دید.",
          "هیچ پولی جابه‌جا نمی‌شود، وضعیت هیچ سفارشی عوض نمی‌شود و موجودی هیچ کالایی تغییر نمی‌کند.",
        ]}
      />
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * ACTIVATE / DEACTIVATE — and why there is no delete.
 *
 * A sale is attributed to the account that rang it up, so deleting an account
 * would either orphan or rewrite that attribution. Deactivation is the retire
 * operation: it closes every door without touching a single past row.
 */
function LifecycleSection({
  user,
  onChanged,
}: {
  user: AdminUserDetailRow;
  onChanged: () => void;
}) {
  const api = useApi();
  const toggle = useMutation(setUserActive);
  const [confirming, setConfirming] = useState(false);

  async function confirm() {
    const result = await toggle.run(api, user.id, !user.isActive);
    setConfirming(false);
    if (result) {
      toggle.setDone(result.message);
      onChanged();
    }
  }

  return (
    <AdminSection
      title="وضعیت حساب"
      description="غیرفعال‌کردن، جایگزینِ حذف است. حسابی که فروش ثبت‌شده دارد هرگز حذف نمی‌شود، چون فروش به همان حساب نسبت داده شده و پاک‌کردنش سابقه را می‌شکند."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AccountStatusBadge isActive={user.isActive} />
        <span className="text-xs text-ink-muted">
          {count(user.salesCount)} فروش به نام این حساب ثبت شده است.
        </span>
        <SurfaceBadges canAccess={user.canAccess} />
      </div>

      <MutationError error={toggle.error} />
      {toggle.done ? (
        <Notice tone="success" className="mt-3">
          {toggle.done}
        </Notice>
      ) : null}

      {user.isActive ? (
        <Gate
          permissions={["users.deactivate"]}
          fallback={
            <p className="text-xs text-ink-subtle">
              غیرفعال‌کردن حساب به اختیار <bdi dir="ltr">users.deactivate</bdi> نیاز دارد.
            </p>
          }
        >
          <Button className="mt-3" variant="danger" onClick={() => setConfirming(true)}>
            غیرفعال‌کردن حساب
          </Button>
        </Gate>
      ) : (
        <Gate
          permissions={["users.activate"]}
          fallback={
            <p className="text-xs text-ink-subtle">
              فعال‌کردن حساب به اختیار <bdi dir="ltr">users.activate</bdi> نیاز دارد.
            </p>
          }
        >
          <Button className="mt-3" onClick={() => setConfirming(true)}>
            فعال‌کردن دوبارهٔ حساب
          </Button>
        </Gate>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        isPending={toggle.isPending}
        tone={user.isActive ? "danger" : "neutral"}
        title={user.isActive ? "غیرفعال‌کردن این حساب" : "فعال‌کردن دوبارهٔ این حساب"}
        confirmLabel={user.isActive ? "بله، غیرفعال کن" : "بله، فعال کن"}
        consequences={
          user.isActive
            ? [
                "این کاربر از این پس در هیچ‌کدام از سطوح — فروشگاه اینترنتی، پنل مدیریت و صندوق فروشگاه — نمی‌تواند وارد شود.",
                "همهٔ نشست‌های باز او در همان لحظه بسته می‌شود؛ اگر پشت صندوق باشد، بی‌درنگ بیرون می‌افتد.",
                `فروش‌های گذشتهٔ او — ${count(user.salesCount)} سفارش — به نام خودش باقی می‌ماند و سفارش‌ها و سابقهٔ موجودی دست‌نخورده می‌مانند.`,
                "هیچ چیزی حذف نمی‌شود، هیچ پولی جابه‌جا نمی‌شود، وضعیت هیچ سفارشی عوض نمی‌شود و موجودی هیچ کالایی تغییر نمی‌کند.",
                "این کار برگشت‌پذیر است: با فعال‌کردن دوباره، حساب همان نقش‌ها و همان شعبهٔ قبلی را خواهد داشت.",
                "اگر این آخرین مدیر فعال سامانه باشد، سرور با خطای «آخرین مدیر ارشد» درخواست را رد می‌کند و هیچ تغییری ثبت نمی‌شود.",
              ]
            : [
                "این کاربر می‌تواند با همان نام کاربری و همان گذرواژهٔ پیشین دوباره وارد شود.",
                "نقش‌ها و شعبهٔ او همان چیزی است که پیش از غیرفعال‌شدن بود؛ همین صفحه را ببینید و اگر لازم است اصلاح کنید.",
                "نشست‌هایی که هنگام غیرفعال‌شدن بسته شدند بازنمی‌گردند؛ او باید یک بار وارد شود.",
                "هیچ پولی جابه‌جا نمی‌شود، وضعیت هیچ سفارشی عوض نمی‌شود و موجودی هیچ کالایی تغییر نمی‌کند.",
              ]
        }
      />
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * SAFE METADATA ONLY.
 *
 * Dates and counts. The API returns no hash, no token and no session id for
 * this account, and nothing here should ever ask it to start: a session id on
 * an admin screen is a session id in a screenshot.
 */
function MetadataSection({ user }: { user: AdminUserDetailRow }) {
  return (
    <AdminSection title="اطلاعات ثبتی">
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="شناسهٔ کاربر" numeric>
          {count(user.id)}
        </Fact>
        <Fact label="تاریخ ساخت حساب" numeric>
          {when(user.createdAt)}
        </Fact>
        <Fact
          label="آخرین تغییر گذرواژه"
          numeric
          hint="خودِ گذرواژه ذخیره نشده؛ فقط زمان آخرین تغییر آن."
        >
          {when(user.passwordChangedAt)}
        </Fact>
        <Fact label="تاریخ غیرفعال‌شدن" numeric>
          {when(user.deactivatedAt)}
        </Fact>
      </dl>
      <p className="mt-3 flex flex-wrap items-center gap-1.5 text-2xs text-ink-subtle">
        <KeyIcon className="size-4" aria-hidden="true" />
        هیچ درهم‌سازی، توکن یا شناسهٔ نشستی در این صفحه نمایش داده نمی‌شود، چون سرور هیچ‌کدام را
        برنمی‌گرداند.
      </p>
    </AdminSection>
  );
}
