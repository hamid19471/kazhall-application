"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { isApiError } from "@kazhal/api-client";
import { Button, Card, Input, Spinner } from "@kazhal/ui";
import { useApi, useSession } from "@kazhal/ui/api/react";

import { PeakIcon } from "./icons";

/**
 * ===========================================================================
 * THE FORCED PASSWORD CHANGE, AS A SCREEN
 * ===========================================================================
 *
 * A cashier whose account was just created signs in with the password the
 * administrator typed and handed over. `users.mustChangePassword` is set, and
 * the API answers 403 `PASSWORD_CHANGE_REQUIRED` on every route except
 * introspection (`/auth/pos/me`), rotation, sign-out and the change itself.
 *
 * WHAT THIS REPLACES. Before this screen existed the till happily showed the
 * ordinary catalogue and then every single request behind it failed. The
 * backend was right; the experience was a working-looking screen that silently
 * did nothing.
 *
 * ## Why this route is NOT inside the `(pos)` route group
 *
 * `PosShell` is a session gate: when `/auth/pos/me` answers "signed out" it
 * sends the browser to `/login`. This screen DESTROYS ITS OWN SESSION on
 * purpose — that is what a password change is — so running it under that gate
 * would mean the shell yanks the cashier to the sign-in form in the middle of
 * the flow, one moment before it was about to sign them back in. It therefore
 * lives beside `/login`, outside the group, and owns its own frame and its own
 * aftermath.
 *
 * That separation is also what makes a redirect loop impossible. `PosShell`
 * only ever redirects TO here, this screen never redirects back to a gated
 * route while the flag is set, and the only protected call it makes is
 * `/auth/pos/me`, which is explicitly reachable while the flag is set.
 *
 * ## What happens after a successful change
 *
 * Every session of this user, in every audience and on every device, is dead —
 * `users.passwordChangedAt` is the cut-off and the API clears this surface's
 * cookies on the way out. So the session is REPLACED, not patched: this screen
 * signs in again with the password just chosen and lands on the till. Nothing
 * client-side is left carrying `mustChangePassword: true`, because nothing
 * client-side survives; `/pos` mounts a new provider and reads `/auth/me`
 * fresh.
 */

const POS_HOME = "/pos";
const LOGIN = "/login";

/**
 * WHY THE PAUSE BEFORE SIGNING BACK IN — and why it is not a flake workaround.
 *
 * A JWT `iat` is in whole SECONDS; `users.passwordChangedAt` has millisecond
 * precision. `isIssuedBeforePasswordChange` resolves that ambiguity FAIL-CLOSED
 * (apps/api/src/modules/auth/auth.types.ts): a token whose second STARTED
 * before the change instant is rejected, even if it was in fact minted a few
 * hundred milliseconds after it. That is deliberate and must not be weakened —
 * the alternative leaves every token minted during the change's second alive
 * for its full lifetime, in exactly the second a compromised session is meant
 * to be cut off.
 *
 * Signing in immediately lands inside that window almost every time: the login
 * itself succeeds and sets cookies, and then the very first request fails 401.
 * Waiting past one whole second of REAL time guarantees the new token's second
 * begins after the change instant — `floor(t/1000)*1000 >= t - 999`, so a gap
 * of more than 999 ms puts the boundary on the safe side no matter how the
 * browser's clock is set relative to the server's.
 */
const REISSUE_DELAY_MS = 1_150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Phase = "form" | "changing" | "signing-in" | "done" | "stranded";

export function PosChangePassword() {
  const api = useApi();
  const router = useRouter();
  const { session, isLoading, refresh } = useSession();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * STICKY, because the session is deliberately gone by the time these are
   * needed: the identifier is what the automatic sign-in submits and what a
   * password manager associates the new credential with, and `forced` decides
   * which explanation the screen is giving.
   *
   * Adjusted DURING RENDER rather than in an effect — the documented React
   * pattern for deriving state from a prop that has changed. An effect would
   * paint one frame with the stale value first, and the frame in question is
   * the one where the session has just been destroyed.
   */
  const [identifier, setIdentifier] = useState<string | null>(null);
  if (session?.identifier && session.identifier !== identifier) {
    setIdentifier(session.identifier);
  }
  const [forced, setForced] = useState(false);
  if (session?.mustChangePassword === true && !forced) setForced(true);

  // Only while the form is idle. Once the flow starts the session disappearing
  // is the EXPECTED next step, not a reason to bounce to the sign-in screen.
  useEffect(() => {
    if (phase !== "form") return;
    if (session === null) router.replace(LOGIN);
  }, [phase, session, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "changing" || phase === "signing-in") return;
    setProblem(null);

    // Checked here as well as on the server because a mismatch is a TYPO, and
    // finding out after the session has been destroyed would be cruel.
    if (next !== confirm) {
      setProblem("گذرواژه‌ی تازه و تکرار آن یکسان نیستند.");
      return;
    }
    if (next.length < 8 || next.length > 64) {
      setProblem("گذرواژه باید بین ۸ تا ۶۴ نویسه باشد.");
      return;
    }

    setPhase("changing");
    try {
      await api.auth.changePassword({ currentPassword: current, newPassword: next });
    } catch (error) {
      setPhase("form");
      setProblem(describe(error));
      return;
    }

    // From here the old session no longer exists anywhere. Whatever happens
    // next, the cashier must not be left looking at a form that still believes
    // it is signed in.
    const username = identifier;
    if (username === null) {
      setPhase("stranded");
      return;
    }

    setPhase("signing-in");
    try {
      await sleep(REISSUE_DELAY_MS);
      await api.auth.login({ username, password: next });
      refresh();
      setPhase("done");
      router.replace(POS_HOME);
    } catch {
      // The password WAS changed — saying otherwise would send the cashier
      // back to the temporary one, which no longer works.
      setPhase("stranded");
    }
  }

  const busy = phase === "changing" || phase === "signing-in";

  if (phase === "stranded") {
    return (
      <Frame>
        <p role="status" className="mb-5 rounded-md bg-success-soft px-4 py-3 text-sm text-success">
          گذرواژه‌ی شما با موفقیت تغییر کرد.
        </p>
        <p className="text-sm leading-relaxed text-ink-muted">
          ورود خودکار به صندوق انجام نشد. با نام کاربری خود و گذرواژه‌ی تازه دوباره وارد شوید.
        </p>
        <p className="mt-6">
          <Link
            href={LOGIN}
            className="inline-flex h-13 w-full items-center justify-center rounded-md bg-primary px-7 text-lg font-semibold text-primary-ink no-underline"
          >
            رفتن به صفحه‌ی ورود
          </Link>
        </p>
      </Frame>
    );
  }

  if (session === undefined && isLoading) {
    return (
      <Frame>
        <p className="flex items-center justify-center gap-2 py-6 text-ink-muted">
          <Spinner size="sm" label={null} />
          در حال بررسی نشست فعلی…
        </p>
      </Frame>
    );
  }

  if (session === null && phase === "form") {
    return (
      <Frame>
        <p className="text-sm leading-relaxed text-ink-muted">
          برای تغییر گذرواژه ابتدا وارد شوید.
        </p>
        <p className="mt-6">
          <Link
            href={LOGIN}
            className="inline-flex h-13 w-full items-center justify-center rounded-md bg-primary px-7 text-lg font-semibold text-primary-ink no-underline"
          >
            رفتن به صفحه‌ی ورود
          </Link>
        </p>
      </Frame>
    );
  }

  return (
    <Frame>
      {forced ? (
        <div
          role="alert"
          className="mb-5 rounded-md bg-warning-soft px-4 py-3 text-sm leading-relaxed text-warning"
        >
          <p className="font-semibold">تغییر گذرواژه اجباری است</p>
          <p className="mt-1">
            گذرواژه‌ای که با آن وارد شدید، موقت است و مدیر سیستم آن را برای شما تعیین کرده
            است. چون این گذرواژه دست شخص دیگری هم بوده، تا وقتی آن را با گذرواژه‌ی خودتان
            جایگزین نکنید هیچ بخشی از صندوق فروش — از جمله فهرست کالاها و ثبت فروش — کار
            نمی‌کند.
          </p>
        </div>
      ) : null}

      <p className="mb-5 rounded-md bg-surface-muted px-4 py-3 text-sm leading-relaxed text-ink-muted">
        برای تأیید هویت، گذرواژه‌ی فعلی هم لازم است؛ باز بودن نشست به‌تنهایی کافی نیست. پس
        از تغییر، همه‌ی نشست‌های شما روی همه‌ی دستگاه‌ها بسته می‌شود و همین صندوق به‌طور خودکار
        دوباره وارد می‌شود.
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        {/*
          A REAL username field, read-only.
          Password managers need a username next to the password fields to know
          WHICH credential is being replaced; without one they either save
          nothing or overwrite the wrong entry. It is read-only because the
          account being changed is the signed-in one and is not a choice.
        */}
        <Input
          label="نام کاربری"
          name="username"
          autoComplete="username"
          readOnly
          value={identifier ?? ""}
          numeric={false}
          dir="ltr"
          className="text-start"
        />
        <Input
          label="گذرواژه‌ی موقت فعلی"
          name="current-password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          dir="ltr"
          className="text-start"
        />
        <Input
          label="گذرواژه‌ی تازه"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={64}
          hint="بین ۸ تا ۶۴ نویسه و متفاوت با گذرواژه‌ی فعلی."
          value={next}
          onChange={(event) => setNext(event.target.value)}
          dir="ltr"
          className="text-start"
        />
        <Input
          label="تکرار گذرواژه‌ی تازه"
          name="confirm-new-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          dir="ltr"
          className="text-start"
          {...(problem ? { error: problem } : {})}
        />

        <Button type="submit" size="lg" fullWidth isLoading={busy}>
          {phase === "signing-in" ? "در حال ورود دوباره…" : "تغییر گذرواژه و ادامه"}
        </Button>
      </form>

      {phase === "signing-in" ? (
        <p role="status" className="mt-5 text-center text-sm text-ink-muted">
          گذرواژه تغییر کرد. صندوق در حال ورود دوباره است…
        </p>
      ) : null}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
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
          <h1 className="text-2xl text-ink">تغییر گذرواژه‌ی صندوق‌دار</h1>
        </div>
        {children}
      </Card>
    </main>
  );
}

/** Server-worded where the server has something to say; never echoes input. */
function describe(error: unknown): string {
  if (!isApiError(error)) return "تغییر گذرواژه انجام نشد. دوباره تلاش کنید.";
  if (error.status === 401) return "گذرواژه‌ی فعلی درست نیست.";
  if (error.kind === "network" || error.kind === "timeout") {
    return "ارتباط با سرور برقرار نشد. اتصال شبکه‌ی صندوق را بررسی کنید.";
  }
  const detail = error.messages.join(" ");
  return detail === "" ? "تغییر گذرواژه انجام نشد. دوباره تلاش کنید." : detail;
}
