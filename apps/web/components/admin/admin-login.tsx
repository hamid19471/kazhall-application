"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { ApiError } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import { Button, Card, Input } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { LogoMark, ShieldIcon } from "@/components/icons";
import { useAppSession } from "@/components/providers";
import { useSubmit } from "@/lib/hooks";
import { can } from "@/lib/permissions";
import { safeNextPath } from "@/lib/routes";

/**
 * Staff sign-in for the admin area.
 *
 * ## Why this screen exists separately from `/auth/sign-in`
 *
 * The two audiences authenticate differently and always will. Customers hold a
 * mobile number and receive a one-time code; `site` accounts are created by the
 * OTP flow and never have a password. Staff hold a username and a password and
 * are created by an administrator. The customer screen therefore has no
 * password field, and pointing a locked-out administrator at it left the admin
 * area with no reachable way in at all.
 *
 * ## What this screen does NOT do
 *
 * It does not authorise anything. `POST /auth/admin/login` issues the same
 * httpOnly cookies as every other session, every `/admin` route declares the
 * CAPABILITY it needs server-side, and the guard re-expands the caller's
 * capabilities from the database on every request. The check below decides
 * what to RENDER — it is a courtesy so somebody who cannot use the console
 * gets a plain explanation instead of a screen full of 403s, and removing it
 * would not grant anyone a single extra byte of data.
 *
 * WHAT IT USED TO CHECK, AND WHY THAT WAS A BUG. It tested for the
 * `super_admin` ROLE. The whole point of permission-based authorisation is
 * that a delegated role — an order manager holding `admin.access` and
 * `orders.read` and nothing else — can use this console; the server let them
 * in and set their cookies, and then THIS SCREEN told them they were not
 * allowed and refused to move. The gate is now the same capability the server
 * gates the door on: `admin.access`.
 *
 * It also carries no credentials. Nothing is prefilled, no seed account is
 * named, and no hint is embedded — the review credentials live in
 * `apps/api/docs/DEV-SEED.md`, not in a production bundle.
 */
export function AdminLoginView({ next }: { next?: string }) {
  const api = useApi();
  const router = useRouter();
  const { session, refresh, isResolved } = useAppSession();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [denied, setDenied] = useState(false);

  // `next` arrives through the query string, where anyone can put anything.
  // Only a same-origin PATH survives; see `safeNextPath`.
  const target = safeNextPath(next ?? "/admin");

  // Already signed in AND permitted — go, rather than offering a form that
  // would only create a second session for the same person.
  useEffect(() => {
    if (isResolved && session && can(session, "admin.access")) {
      router.replace(target);
    }
  }, [isResolved, session, router, target]);

  const { run, isPending } = useSubmit(async () => {
    setError(undefined);
    setDenied(false);
    try {
      await api.auth.login({ username: username.trim(), password });
      // Re-read the session from `/auth/me` rather than trusting the login
      // response: roles and branch are resolved from the database there, and
      // that is the same answer every subsequent request will be judged by.
      refresh();
      const me = await api.auth.me();
      // `admin.access` is exactly what `AuthService.assertEligible` checks
      // before minting the cookie, so this cannot disagree with the server
      // about who may be here — which a role-name test did.
      if (!can(me, "admin.access")) {
        setDenied(true);
        return;
      }
      router.replace(target);
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-6 flex items-center justify-center gap-2">
        <LogoMark className="size-8 text-primary" />
        <span className="text-xl font-extrabold text-ink">کژال</span>
      </div>

      <Card tone="raised" padding="lg">
        <div className="flex items-center gap-2 text-primary">
          <ShieldIcon className="size-6" />
          <h1 className="text-xl text-ink">ورود به بخش مدیریت</h1>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          این صفحه برای کارکنان است. با نام کاربری و رمز عبور خود وارد شوید.
          مشتریان از صفحهٔ ورود با شمارهٔ موبایل استفاده می‌کنند.
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run();
          }}
        >
          <Input
            label="نام کاربری"
            required
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />

          <Input
            label="رمز عبور"
            type="password"
            required
            autoComplete="current-password"
            dir="ltr"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {denied ? (
            <Notice tone="danger" title="این حساب به بخش مدیریت دسترسی ندارد">
              <p>
                ورود انجام شد، اما هیچ‌کدام از نقش‌های این حساب اجازهٔ «ورود به پنل مدیریت» را
                ندارد. از مدیر ارشد بخواهید این اختیار را به نقش شما اضافه کند. اگر صندوق‌دار
                هستید، از نرم‌افزار صندوق استفاده کنید.
              </p>
            </Notice>
          ) : null}

          <FormError error={error} />

          <Button type="submit" size="lg" fullWidth isLoading={isPending}>
            ورود
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-subtle">
          <Link href="/">بازگشت به فروشگاه</Link>
        </p>
      </Card>
    </div>
  );
}
