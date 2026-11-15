"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, Input, Spinner } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { AdminPageHeader } from "@/components/admin/ui";
import { FormError, Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import { useSubmit } from "@/lib/hooks";
import { adminLoginHref } from "@/lib/routes";

/**
 * SELF-SERVICE PASSWORD CHANGE.
 *
 * Reachable while `mustChangePassword` is set — it is the only route that
 * clears the flag, so gating it would be a lockout with no way out. When the
 * flag IS set the shell has already redirected the operator here and renders
 * this screen BARE: nothing else in the console may fetch, so nothing else is
 * on screen to try.
 *
 * On success the API invalidates EVERY session this user holds, in every
 * audience and on every device, including this one. That is the point of a
 * password change and not a side effect to work around, so:
 *
 *  - a VOLUNTARY change says so before the operator commits and sends them to
 *    the sign-in page afterwards, rather than letting the next request fail
 *    with a dead cookie;
 *  - a FORCED change — the one a delegated user hits on their very first
 *    sign-in — replaces the session automatically and puts them in the console
 *    they were trying to reach. Making somebody type the password they chose
 *    four seconds ago, on the screen that told them to choose it, is friction
 *    with nothing behind it.
 *
 * Either way NOTHING CLIENT-SIDE IS LEFT HOLDING `mustChangePassword: true`:
 * the old session does not exist anywhere, and the destination re-reads
 * `/auth/admin/me` from scratch.
 */

const ADMIN_HOME = "/admin";

/**
 * WHY THE PAUSE BEFORE SIGNING BACK IN.
 *
 * A JWT `iat` is in whole SECONDS; `users.passwordChangedAt` has millisecond
 * precision. `isIssuedBeforePasswordChange` resolves that ambiguity
 * FAIL-CLOSED on purpose (apps/api/src/modules/auth/auth.types.ts): a token
 * whose second STARTED before the change instant is rejected even if it was
 * minted a few hundred milliseconds after it. That must not be weakened — the
 * alternative leaves every token minted during the change's second alive for
 * its full lifetime, in exactly the second a compromised session is meant to
 * be cut off.
 *
 * Signing in immediately lands inside that window nearly every time: the login
 * succeeds and sets cookies, and the first request behind it answers 401. A
 * gap of more than one whole second of real time guarantees the new token's
 * second begins after the change instant, whatever the browser's clock says
 * relative to the server's.
 */
const REISSUE_DELAY_MS = 1_150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Phase = "form" | "working" | "signing-in" | "stranded";

export function AdminChangePassword() {
  const api = useApi();
  const router = useRouter();
  const { session, isResolved, refresh } = useAppSession();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(undefined);
  const [localProblem, setLocalProblem] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("form");

  /*
   * STICKY, because the session is deliberately gone by the time these are
   * needed: the identifier is the username the automatic sign-in submits and
   * the one a password manager associates the new credential with, and
   * `forced` is what decides whether this flow ends in the console or at the
   * sign-in page. A flow that re-read the flag after the call would forget
   * which flow it was in halfway through.
   *
   * Adjusted DURING RENDER, the documented React pattern for state derived
   * from a value that has changed — the same one the drawer in `admin-shell`
   * uses. An effect would paint one frame with the stale value first, and that
   * frame is the one where the session has just been destroyed.
   */
  const [identifier, setIdentifier] = useState<string | null>(null);
  if (session?.identifier && session.identifier !== identifier) {
    setIdentifier(session.identifier);
  }
  const [forced, setForced] = useState(false);
  if (session?.mustChangePassword === true && !forced) setForced(true);

  const { run, isPending } = useSubmit(async () => {
    setError(undefined);
    setLocalProblem(undefined);

    // Checked here as well as by the server, because a mismatch is a TYPO and
    // making the user find out after their session has been destroyed would be
    // cruel. Everything else — length, "must differ", the current password —
    // is the server's answer, which is the one that counts.
    if (next !== confirm) {
      setLocalProblem("گذرواژهٔ تازه و تکرار آن یکسان نیستند.");
      return;
    }
    if (next.length < 8 || next.length > 64) {
      setLocalProblem("گذرواژه باید بین ۸ تا ۶۴ نویسه باشد.");
      return;
    }

    setPhase("working");
    try {
      await api.auth.changePassword({ currentPassword: current, newPassword: next });
    } catch (caught) {
      setPhase("form");
      setError(caught);
      return;
    }

    // Past this point the old session does not exist anywhere, so every branch
    // below has to land the operator somewhere usable.
    if (!forced || identifier === null) {
      refresh();
      router.replace(adminLoginHref());
      return;
    }

    setPhase("signing-in");
    try {
      await sleep(REISSUE_DELAY_MS);
      await api.auth.login({ username: identifier, password: next });
      refresh();
      router.replace(ADMIN_HOME);
    } catch {
      // The password WAS changed; saying otherwise would send the operator
      // back to a temporary one that no longer works.
      setPhase("stranded");
    }
  });

  if (phase === "stranded") {
    return (
      <div className="mx-auto w-full max-w-md">
        <AdminPageHeader title="تغییر گذرواژه" description="گذرواژهٔ شما تغییر کرد." />
        <Notice tone="success" title="گذرواژه با موفقیت تغییر کرد" className="mb-4">
          ورود خودکار انجام نشد. با نام کاربری خود و گذرواژهٔ تازه دوباره وارد شوید.
        </Notice>
        <Link href={adminLoginHref()} className="text-sm font-bold">
          رفتن به صفحهٔ ورود
        </Link>
      </div>
    );
  }

  // The shell renders this route bare once the session is gone, which covers
  // both the middle of the flow above and somebody arriving here signed out.
  if (phase === "form" && isResolved && !session && identifier === null) {
    return (
      <div className="mx-auto w-full max-w-md">
        <AdminPageHeader
          title="تغییر گذرواژه"
          description="برای تغییر گذرواژه ابتدا وارد شوید."
        />
        <Link href={adminLoginHref()} className="text-sm font-bold">
          رفتن به صفحهٔ ورود
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <AdminPageHeader
        title="تغییر گذرواژه"
        description="گذرواژهٔ فعلی برای تأیید هویت لازم است؛ داشتن نشست باز به‌تنهایی کافی نیست."
      />

      {forced ? (
        <Notice tone="warning" title="تغییر گذرواژه اجباری است" className="mb-4">
          گذرواژه‌ای که با آن وارد شدید موقت است و مدیر سیستم آن را برای شما تعیین کرده
          است. چون این گذرواژه دست شخص دیگری هم بوده، تا وقتی آن را با گذرواژهٔ خودتان
          جایگزین نکنید هیچ بخش دیگری از پنل مدیریت در دسترس نیست.
        </Notice>
      ) : null}

      <Notice tone="info" className="mb-4">
        {forced
          ? "با تغییر گذرواژه، همهٔ نشست‌های شما در فروشگاه، پنل مدیریت و صندوق — روی همهٔ دستگاه‌ها — بسته می‌شود. سپس همین مرورگر به‌طور خودکار دوباره وارد پنل می‌شود."
          : "با تغییر گذرواژه، همهٔ نشست‌های شما در فروشگاه، پنل مدیریت و صندوق — روی همهٔ دستگاه‌ها — بسته می‌شود. پس از تغییر باید دوباره وارد شوید."}
      </Notice>

      <Card tone="raised" padding="lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          {/*
            A REAL username field, read-only.
            A password manager needs a username beside the password fields to
            know WHICH credential is being replaced; without one it either
            saves nothing or overwrites the wrong entry. Read-only because the
            account being changed is the signed-in one and is not a choice.
          */}
          <Input
            label="نام کاربری"
            name="username"
            autoComplete="username"
            readOnly
            dir="ltr"
            value={identifier ?? ""}
          />
          <Input
            label="گذرواژهٔ فعلی"
            name="current-password"
            type="password"
            dir="ltr"
            autoComplete="current-password"
            required
            autoFocus
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <Input
            label="گذرواژهٔ تازه"
            name="new-password"
            type="password"
            dir="ltr"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={64}
            hint="بین ۸ تا ۶۴ نویسه. باید با گذرواژهٔ فعلی متفاوت باشد."
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Input
            label="تکرار گذرواژهٔ تازه"
            name="confirm-new-password"
            type="password"
            dir="ltr"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            {...(localProblem ? { error: localProblem } : {})}
          />

          <FormError error={error} />

          <Button type="submit" size="lg" fullWidth isLoading={isPending}>
            {forced ? "تغییر گذرواژه و ادامه" : "تغییر گذرواژه و خروج از همهٔ نشست‌ها"}
          </Button>
        </form>

        {phase === "signing-in" ? (
          <p role="status" className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-muted">
            <Spinner size="sm" label={null} />
            گذرواژه تغییر کرد. در حال ورود دوباره به پنل…
          </p>
        ) : null}
      </Card>
    </div>
  );
}
