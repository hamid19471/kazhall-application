"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button, Input, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  Checkbox,
  RequirePermission,
  Select,
  count,
  useMutation,
} from "@/components/admin/ui";
import { MutationError } from "@/components/admin/people-shared";
import { useAppSession } from "@/components/providers";
import { can } from "@/lib/permissions";
import { TillIcon } from "@/components/icons";
import { createUser, fetchAssignableRoles, fetchBranches } from "@/lib/admin-api";
import type { AssignableRole } from "@/lib/admin-api";
import { adminCashiersHref, adminUserHref, adminUsersHref } from "@/lib/routes";

/** Every branch the select can offer. The API caps `limit` at 100. */
const BRANCH_OPTION_LIMIT = 100;

/*
 * MIRRORED FROM `CreateStaffUserDto`, on purpose.
 *
 * The username charset is the same `^[a-zA-Z0-9_]+$` the LOGIN form enforces:
 * a creation form that accepts a username the login form rejects produces an
 * account that can never sign in — `first.last` was the concrete instance. The
 * server is still the authority; these bounds only spare the operator a round
 * trip.
 */
const USERNAME_PATTERN = "[A-Za-z0-9_]+";
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;
const MOBILE_PATTERN = "09[0-9]{9}";
const MAX_ROLES = 20;

/** The role a cashier needs. Matched by `name`, which is stable; `titleFa` is not. */
const CASHIER_ROLE_NAME = "sale";

/**
 * CREATE A STAFF ACCOUNT — one form, two entrances.
 *
 * `/admin/users/new` and `/admin/cashiers/new` render THIS component. A second
 * implementation of "create a staff account" is how one of the two ends up
 * without the branch requirement or without the escalation check; `preset`
 * changes only the defaults and the copy, never the request.
 *
 * Note what is NOT here: a "generate password" button. A generated password
 * must be displayed to be usable, and a password on a screen ends up in a
 * screenshot or a chat message. The administrator types one and hands it over
 * out of band.
 */
export function AdminUserCreate({ preset }: { preset?: "cashier" }) {
  return (
    <RequirePermission permissions={["users.create"]}>
      <CreateBody preset={preset} />
    </RequirePermission>
  );
}

function CreateBody({ preset }: { preset?: "cashier" }) {
  const api = useApi();
  const router = useRouter();
  const { session } = useAppSession();
  const cashier = preset === "cashier";

  /*
   * THE ROLE LIST NO LONGER COSTS `rbac.read`.
   *
   * This form used to populate its role checklist from
   * `GET /admin/access/roles`, which is gated on `rbac.read` — a capability
   * that has nothing to do with creating a user. A delegated manager holding
   * `users.create` could therefore open this page and never submit it, and the
   * form said so and disabled its own button. The obvious workaround was to
   * grant them `rbac.read`, which hands over the entire access-control
   * catalogue, every custom role and every user's effective permissions, as an
   * accidental dependency of being allowed to hire a cashier.
   *
   * `GET /admin/users/assignable-roles` answers the narrower question this
   * form actually has — "which roles may I confer?" — on `users.create` alone,
   * and returns only the roles the create endpoint would accept, with counts
   * rather than permission codes. The unauthorised `rbac.read` request is
   * simply never made.
   *
   * THE BRANCH LIST IS A DIFFERENT STORY and stays as it was: `GET /branch`
   * needs `branches.read`, a branch is OPTIONAL on a staff account, and the
   * form degrades to "no branch" rather than refusing to submit.
   */
  const canReadBranches = can(session, "branches.read");

  const roles = useApiQuery(
    (signal) => fetchAssignableRoles(api, { signal }),
    [api],
  );
  const branches = useApiQuery(
    (signal) => fetchBranches(api, { limit: BRANCH_OPTION_LIMIT }, { signal }),
    [api],
    { enabled: canReadBranches },
  );
  const create = useMutation(createUser);

  /*
   * `null` means "the operator has not touched the checklist yet", which is
   * what lets the cashier preset pre-select `sale` WITHOUT an effect that
   * fights the operator: once they tick anything, their choice wins, even if
   * that means unticking the preset.
   */
  const [picked, setPicked] = useState<number[] | null>(null);
  const [mustChange, setMustChange] = useState(true);
  const [invalid, setInvalid] = useState<string | null>(null);

  const allRoles = roles.data ?? [];
  const presetRole = cashier
    ? allRoles.find((role) => role.name === CASHIER_ROLE_NAME)
    : undefined;
  const selected = picked ?? (presetRole ? [presetRole.id] : []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvalid(null);

    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const mobile = String(form.get("mobile") ?? "").trim();
    const branch = String(form.get("branchId") ?? "");

    if (selected.length === 0) {
      setInvalid(
        "دست‌کم یک نقش انتخاب کنید. حسابی بی‌نقش هیچ اختیاری ندارد و روی هیچ سطحی نمی‌تواند وارد شود.",
      );
      return;
    }
    if (selected.length > MAX_ROLES) {
      setInvalid(`بیش از ${count(MAX_ROLES)} نقش برای یک حساب پذیرفته نمی‌شود.`);
      return;
    }
    // Only when the select was actually rendered; see `canReadBranches` above.
    if (cashier && canReadBranches && branch === "") {
      setInvalid(
        "برای صندوق‌دار انتخاب شعبه لازم است: فروش حضوری به یک شعبه نسبت داده می‌شود و صندوق‌دار بدون شعبه پشت صندوق رد می‌شود.",
      );
      return;
    }

    const result = await create.run(api, {
      username,
      password,
      mobile: mobile === "" ? null : mobile,
      branchId: branch === "" ? null : Number(branch),
      roleIds: selected,
      mustChangePassword: mustChange,
    });

    if (result) router.push(adminUserHref(result.data.id));
  }

  return (
    <>
      <AdminPageHeader
        title={cashier ? "صندوق‌دار تازه" : "کاربر تازه"}
        description={
          cashier ? (
            <>
              این فرم یک <b>حساب کارمند</b> می‌سازد که می‌تواند پشت صندوق فروش ثبت کند. صندوق‌دار
              بدون شعبه پشت صندوق رد می‌شود، چون هر فروش حضوری به یک شعبه نسبت داده می‌شود — پس
              انتخاب شعبه در این فرم اجباری است.
            </>
          ) : (
            <>
              این فرم یک <b>حساب کارمند</b> می‌سازد: حسابی با نام کاربری و گذرواژه. حساب مشتری
              اینجا ساخته نمی‌شود؛ مشتری خودش با شمارهٔ موبایل و کد یک‌بارمصرف ثبت‌نام می‌کند.
            </>
          )
        }
      />

      <Notice tone="info" className="mb-5" icon={<TillIcon className="size-5" />}>
        <p>
          گذرواژهٔ اولیه را <b>شما</b> تایپ می‌کنید و رو‌در‌رو یا تلفنی به کارمند می‌گویید. سامانه
          گذرواژه نمی‌سازد و هیچ‌جا نمایش نمی‌دهد؛ از گذرواژه فقط یک درهم‌سازی یک‌طرفه ذخیره می‌شود
          که بازگردانی‌اش ممکن نیست.
        </p>
      </Notice>

      <form onSubmit={submit} className="space-y-4">
        <AdminSection title="شناسه و گذرواژه">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="username"
              label="نام کاربری"
              required
              autoComplete="off"
              spellCheck={false}
              minLength={USERNAME_MIN}
              maxLength={USERNAME_MAX}
              pattern={USERNAME_PATTERN}
              style={{ direction: "ltr" }}
              hint="۳ تا ۳۰ نویسه، فقط حرف و رقم لاتین و زیرخط. همان چارستی که صفحهٔ ورود می‌پذیرد."
              containerClassName="min-w-0"
            />
            <Input
              name="password"
              label="گذرواژهٔ اولیه"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              style={{ direction: "ltr" }}
              hint={`بین ${PASSWORD_MIN} تا ${PASSWORD_MAX} نویسه. پوشیده نمایش داده نمی‌شود تا بتوانید همان را بخوانید و تحویل دهید.`}
              containerClassName="min-w-0"
            />
            <Input
              name="mobile"
              label="شمارهٔ موبایل (اختیاری)"
              numeric
              maxLength={11}
              pattern={MOBILE_PATTERN}
              autoComplete="off"
              hint="به شکل ۰۹XXXXXXXXX و در کل سامانه یگانه. برای ورود کارمند لازم نیست."
              containerClassName="min-w-0"
            />
            {canReadBranches ? (
              <Select
                name="branchId"
                label={cashier ? "شعبه (اجباری برای صندوق‌دار)" : "شعبه"}
                required={cashier}
                containerClassName="min-w-0"
                options={[
                  { value: "", label: cashier ? "— شعبه را انتخاب کنید —" : "بدون شعبه" },
                  ...(branches.data?.data ?? []).map((branch) => ({
                    value: String(branch.id),
                    label: branch.isActive ? branch.name : `${branch.name} (غیرفعال)`,
                  })),
                ]}
                hint={
                  cashier
                    ? "شعبهٔ غیرفعال هم پشت صندوق رد می‌شود؛ شعبه‌ای را انتخاب کنید که فعال باشد."
                    : "شعبه فقط برای فروش حضوری معنا دارد. حساب‌های اداری می‌توانند بدون شعبه بمانند."
                }
              />
            ) : (
              <Notice tone={cashier ? "warning" : "info"} className="min-w-0">
                <p>
                  فهرست شعبه‌ها به اختیار <bdi dir="ltr">branches.read</bdi> نیاز دارد و برای شما
                  خوانده نمی‌شود، پس این حساب <b>بدون شعبه</b> ساخته می‌شود.
                  {cashier
                    ? " صندوق‌دار بدون شعبه پشت صندوق رد می‌شود؛ پس از ساخت حساب، کسی که این اختیار را دارد باید شعبه را در صفحهٔ همان کاربر تعیین کند."
                    : " حساب‌های اداری به شعبه نیازی ندارند."}
                </p>
              </Notice>
            )}
          </div>

          <div className="mt-3">
            <Checkbox
              label="در نخستین ورود، گذرواژه را عوض کند"
              description="پیش‌فرض و گزینهٔ درست: گذرواژه‌ای که شخص دیگری انتخاب کرده نباید گذرواژهٔ دائمی بماند. تا وقتی این کار انجام نشود، صندوق‌دار پشت صندوق با پیام «باید گذرواژه را تغییر دهد» روبه‌رو می‌شود."
              checked={mustChange}
              onChange={setMustChange}
            />
          </div>
        </AdminSection>

        <AdminSection
          title="نقش‌ها"
          description="اختیارات حساب تازه، مجموع اختیارات همین نقش‌ها است. دست‌کم یک نقش لازم است."
        >
          {roles.isLoading ? (
            <Skeleton shape="block" height="8rem" />
          ) : roles.error ? (
            <Notice tone="warning">
              <p>فهرست نقش‌ها خوانده نشد. بدون آن نمی‌توان حساب ساخت؛ صفحه را به‌روز کنید.</p>
            </Notice>
          ) : allRoles.length === 0 ? (
            <Notice tone="warning">
              <p>
                هیچ نقشی برای واگذاری در دسترس شما نیست. یک نقش تنها زمانی واگذارشدنی است که همهٔ
                اختیارهایش را خودتان هم داشته باشید؛ این قاعده مانع از آن می‌شود که کسی حسابی
                پرقدرت‌تر از خودش بسازد. از مدیر ارشد بخواهید نقش مناسبی برای شما تعریف کند.
              </p>
            </Notice>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {allRoles.map((role) => (
                <Checkbox
                  key={role.id}
                  // `titleFa` is nullable on a CUSTOM role (only built-ins are
                  // guaranteed a Persian title), and a null label would render
                  // an unlabelled checkbox. The machine name is the honest
                  // fallback — it is what the operator will see in the audit
                  // trail anyway.
                  label={role.titleFa ?? role.name}
                  description={roleDescription(role, presetRole?.id === role.id)}
                  checked={selected.includes(role.id)}
                  onChange={(checked) =>
                    setPicked(
                      checked
                        ? [...selected.filter((id) => id !== role.id), role.id]
                        : selected.filter((id) => id !== role.id),
                    )
                  }
                />
              ))}
            </div>
          )}
        </AdminSection>

        {invalid ? <Notice tone="warning">{invalid}</Notice> : null}
        <MutationError error={create.error} />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            isLoading={create.isPending}
            disabled={allRoles.length === 0}
          >
            {cashier ? "ساخت حساب صندوق‌دار" : "ساخت حساب"}
          </Button>
          <Link href={cashier ? adminCashiersHref() : adminUsersHref()} className="text-sm">
            انصراف
          </Link>
        </div>
      </form>
    </>
  );
}

function roleDescription(role: AssignableRole, isPreset: boolean): string {
  const parts: string[] = [];
  if (isPreset) parts.push("برای صندوق‌داری همین نقش لازم است و از پیش انتخاب شده");
  // `assignable-roles` never lists an inactive role, so this branch is
  // unreachable here — kept because the shape allows it and a silent change of
  // that contract should show up as a visible label, not as nothing.
  if (!role.isActive) parts.push("این نقش غیرفعال است و هیچ اختیاری نمی‌دهد");
  if (role.isSystem) parts.push("نقش سامانه‌ای");
  if (role.description) parts.push(role.description);
  parts.push(`${role.permissionCount} اختیار`);
  return parts.join(" · ");
}
