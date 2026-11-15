"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { isApiError } from "@kazhal/api-client";
import { Button, Card, Input, Spinner } from "@kazhal/ui";
import { useApi, useSession } from "@kazhal/ui/api/react";

import { PeakIcon } from "./icons";
import { canOperatePos } from "../lib/pos-domain";

/**
 * Cashier sign-in.
 *
 * `POST /auth/login` sets httpOnly `access_token` / `refresh_token` cookies and
 * returns NO tokens. There is nothing to store, nothing to decode and nothing
 * to put in `localStorage`. Authorization is then read back from
 * `GET /auth/me`, which is the only authoritative session source — the JWT is
 * unreadable by design and its claims are stale anyway.
 *
 * Session RESTORE falls out of the same mechanism: an already-signed-in cashier
 * who opens this page is bounced to the till without typing anything, because
 * `useSession()` finds the cookie session on mount.
 */
export function LoginForm() {
  const api = useApi();
  const router = useRouter();
  const { session, isLoading, refresh } = useSession();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const authorized = canOperatePos(session);
  /*
   * A TEMPORARY PASSWORD IS NOT A WORKING SESSION.
   *
   * The administrator typed this password and handed it over, so the API has
   * `users.mustChangePassword` set and answers 403 PASSWORD_CHANGE_REQUIRED on
   * everything except introspection, rotation, sign-out and the change itself.
   * Sending the cashier to `/pos` here is exactly how they ended up staring at
   * a catalogue whose every request failed. They go to the change screen
   * instead — the FIRST thing they see, not the thing they find out about from
   * a row of errors.
   */
  const mustChangePassword = session?.mustChangePassword === true;

  useEffect(() => {
    if (mustChangePassword) {
      router.replace("/change-password");
      return;
    }
    if (authorized) router.replace("/pos");
  }, [authorized, mustChangePassword, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setProblem(null);
    setSubmitting(true);
    try {
      await api.auth.login({ username: username.trim(), password });
      // Roles and branch are re-read from the server; we never infer them from
      // what was typed here.
      refresh();
    } catch (error) {
      if (isApiError(error)) {
        if (error.status === 401 || error.status === 400) {
          setProblem("نام کاربری یا گذرواژه درست نیست.");
        } else if (error.kind === "rate_limited") {
          const seconds = error.retryAfterSeconds;
          setProblem(
            seconds === undefined
              ? "تلاش‌های زیاد. کمی صبر کنید و دوباره تلاش کنید."
              : `تلاش‌های زیاد. ${new Intl.NumberFormat("fa-IR").format(Math.ceil(seconds))} ثانیه صبر کنید.`,
          );
        } else if (error.kind === "network" || error.kind === "timeout") {
          setProblem("ارتباط با سرور برقرار نشد. اتصال شبکه‌ی صندوق را بررسی کنید.");
        } else {
          const detail = error.messages.join(" ");
          setProblem(
            detail === "" ? "ورود انجام نشد. دوباره تلاش کنید." : `ورود انجام نشد. پیام سرور: ${detail}`,
          );
        }
      } else {
        setProblem("ورود انجام نشد. دوباره تلاش کنید.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const signedInButUnauthorized = session !== null && session !== undefined && !authorized;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex flex-1 items-center justify-center px-4 py-12 focus-visible:outline-none"
    >
      <Card as="section" tone="raised" padding="lg" className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-md bg-primary-soft text-primary"
          >
            <PeakIcon className="size-8" />
          </span>
          <h1 className="text-2xl text-ink">ورود صندوق‌دار</h1>
          <p className="text-sm text-ink-muted">
            صندوق فروش حضوری کژال — تجهیزات کوهنوردی، شکار، کمپینگ و ماهیگیری
          </p>
        </div>

        {isLoading && session === undefined ? (
          <p className="flex items-center justify-center gap-2 py-6 text-ink-muted">
            <Spinner size="sm" label={null} />
            در حال بررسی نشست فعلی…
          </p>
        ) : null}

        {signedInButUnauthorized ? (
          <p role="alert" className="mb-5 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
            این حساب دسترسی صندوق فروش ندارد. با حساب فروشنده یا مدیر ارشد وارد شوید.
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          <Input
            label="نام کاربری"
            name="username"
            autoComplete="username"
            required
            value={username}
            numeric={false}
            onChange={(event) => setUsername(event.target.value)}
            autoFocus
            dir="ltr"
            className="text-start"
          />
          <Input
            label="گذرواژه"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            dir="ltr"
            className="text-start"
            {...(problem ? { error: problem } : {})}
          />
          <Button type="submit" size="lg" fullWidth isLoading={submitting}>
            ورود
          </Button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-ink-subtle">
          نشست شما با کوکی امن روی همین دستگاه نگهداری می‌شود. شناسه‌ی صندوق‌دار و شعبه
          از سمت سرور تعیین می‌شود و در هیچ فرمی قابل ویرایش نیست.
        </p>
      </Card>
    </main>
  );
}
