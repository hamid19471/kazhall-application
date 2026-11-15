"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import type { ApiError } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import { Badge, Button, Card, cx } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { BoxIcon, ChartIcon, PinIcon, ShieldIcon, UserIcon } from "@/components/icons";
import { useAppSession } from "@/components/providers";
import { useSubmit } from "@/lib/hooks";
import { ROLE_LABEL } from "@/lib/labels";

/**
 * The account dashboard.
 *
 * The identity shown here comes from `GET /auth/me` and nowhere else. The
 * access token is httpOnly and unreadable by design, and its `roles` are stale
 * the moment they are minted — the server re-reads them from the database on
 * every request — so decoding it, even if it were possible, would be wrong as
 * well as forbidden.
 */
export function AccountHome() {
  const { session, hasRole } = useAppSession();
  if (!session) return null;

  return (
    <div className="space-y-6">
      <Card tone="raised">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid size-12 place-items-center rounded-pill bg-primary-soft text-primary">
              <UserIcon className="size-6" />
            </span>
            <div>
              <p className="text-lg font-bold text-ink" dir="ltr">
                {session.identifier}
              </p>
              <p className="mt-1 flex flex-wrap gap-1.5">
                {session.roles.map((role) => (
                  <Badge key={role} tone={role === "super_admin" ? "primary" : "neutral"} size="sm">
                    {ROLE_LABEL[role] ?? role}
                  </Badge>
                ))}
              </p>
            </div>
          </div>
          <SessionActions />
        </div>
      </Card>

      <ul className="grid gap-3 sm:grid-cols-2">
        <Tile
          href="/account/orders"
          icon={<BoxIcon className="size-6" />}
          title="سفارش‌های من"
          body="وضعیت پول و وضعیت کالای هر سفارش، جدا از هم."
        />
        <Tile
          href="/account/addresses"
          icon={<PinIcon className="size-6" />}
          title="نشانی‌های من"
          body="نشانی‌هایی که هنگام ثبت سفارش می‌توانید انتخاب کنید."
        />
        {hasRole("super_admin") ? (
          <Tile
            href="/admin"
            icon={<ChartIcon className="size-6" />}
            title="بخش مدیریت"
            body="کالاها، صف مغایرت‌های پرداخت و گزارش فروش."
          />
        ) : null}
      </ul>
    </div>
  );
}

function Tile({
  href,
  icon,
  title,
  body,
}: {
  href: "/account/orders" | "/account/addresses" | "/admin";
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cx(
          "flex h-full gap-3 rounded-lg border border-line bg-surface p-4 no-underline",
          "transition-shadow duration-200 ease-kz hover:shadow-raised",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
        )}
      >
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-primary">
          {icon}
        </span>
        <span>
          <span className="block font-bold text-ink">{title}</span>
          <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{body}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Sign out — of this device, or of everywhere.
 *
 * `logout` is idempotent server-side (it answers `revoked: 0` when there was no
 * valid cookie), so a double click is harmless. `logout-all` revokes every
 * refresh token for the account, which is the control a customer needs after
 * using a shared computer — it is offered explicitly and labelled for what it
 * does, not hidden behind the same button.
 */
function SessionActions() {
  const api = useApi();
  const router = useRouter();
  const { refresh } = useAppSession();
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [confirmAll, setConfirmAll] = useState(false);

  const { run: signOut, isPending } = useSubmit(async () => {
    setError(undefined);
    try {
      await api.auth.logout();
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    } finally {
      refresh();
      router.replace("/");
    }
  });

  const { run: signOutEverywhere, isPending: isPendingAll } = useSubmit(async () => {
    setError(undefined);
    try {
      await api.auth.logoutAll();
      refresh();
      router.replace("/");
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
      refresh();
    }
  });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" isLoading={isPending} onClick={() => void signOut()}>
          خروج
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)}>
          خروج از همهٔ دستگاه‌ها
        </Button>
      </div>

      {confirmAll ? (
        <Notice
          tone="warning"
          icon={<ShieldIcon className="size-5" />}
          title="خروج از همهٔ دستگاه‌ها؟"
          action={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="danger"
                isLoading={isPendingAll}
                onClick={() => void signOutEverywhere()}
              >
                بله، خارج شو
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmAll(false)}>
                انصراف
              </Button>
            </div>
          }
        >
          <p>
            همهٔ نشست‌های فعال این حساب — روی هر مرورگر و هر دستگاهی — بسته می‌شوند و برای ورود
            دوباره به کد یک‌بارمصرف نیاز دارید.
          </p>
        </Notice>
      ) : null}

      <FormError error={error} />
    </div>
  );
}
