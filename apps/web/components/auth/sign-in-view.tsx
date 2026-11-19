"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import type { ApiError } from "@kazhal/api-client";
import { isApiError } from "@kazhal/api-client";
import type { Route } from "next";

import { Button, Card, Input, formatInteger, toLatinDigits } from "@kazhal/ui";
import { useApi } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { CheckIcon, ShieldIcon } from "@/components/icons";
import { useAppSession } from "@/components/providers";
import { useCooldown, useSubmit } from "@/lib/hooks";
import {
  OTP_INSTRUCTIONS,
  OTP_SENT_MESSAGE,
  otpSendErrorMessage,
  otpVerifyErrorMessage,
} from "@/lib/otp-messages";
import type { OtpMessage } from "@/lib/otp-messages";
import { sendOtpFailureAction } from "@/lib/otp-send-errors";
import { safeNextPath } from "@/lib/routes";

/**
 * The `<Input>` primitive does not forward a ref, so focus is moved by id.
 * That is deliberate on its part — the id is also what `aria-describedby`
 * wiring hangs off — and a stable id is all this screen actually needs.
 */
const CODE_FIELD_ID = "otp-code";

function focusCodeField(): void {
  if (typeof document === "undefined") return;
  const field = document.getElementById(CODE_FIELD_ID);
  if (field instanceof HTMLInputElement) field.focus();
}

/**
 * OTP sign-in.
 *
 * ## The two contract facts that shape this whole screen
 *
 * **1. Every verification failure is ONE identical 401 `OTP_INVALID`.** No
 * challenge was ever issued, the code is wrong, the code expired, the attempts
 * are exhausted, the code was already used — the server deliberately answers
 * all five the same way, so that nobody can probe which numbers have a live
 * challenge. This UI therefore never tries to explain WHICH failure happened,
 * and it ALWAYS offers "resend a code" after a failure: since "you have no
 * challenge" is indistinguishable from "wrong digits", a screen that only
 * offers "try again" can trap a customer in a loop with no live code.
 *
 * **2. Sending is rate-limited three ways, all 429.** A 60-second per-number
 * cooldown (`OTP_COOLDOWN`), 5 sends per number per hour and 20 per IP per hour
 * (both `OTP_SEND_RATE_LIMITED`). Every one carries
 * `details.retryAfterSeconds`, and there is no `Retry-After` header — so the
 * countdown below is started from the SERVER's figure and never from a number
 * this app made up.
 *
 * ## What this screen may and may not say
 *
 * "Sent" is said ONLY after the server answered success — which it does only
 * once the SMS provider accepted the message. A send failure is reported
 * exactly as the server classified it: `OTP_DELIVERY_FAILED` (nothing was
 * sent) or `OTP_DELIVERY_UNCERTAIN` (not confirmed, may still arrive). No code
 * is ever displayed or hinted at. Every customer-facing string comes from
 * `lib/otp-messages.ts`, keyed by the API's machine-readable error codes.
 */
export function SignInView({ next }: { next?: string }) {
  const api = useApi();
  const router = useRouter();
  const { session, refresh } = useAppSession();

  const [step, setStep] = useState<"mobile" | "code">("mobile");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [mobileError, setMobileError] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<unknown>(undefined);
  /** The code field is incomplete — caught here, before any request. */
  const [codeIncomplete, setCodeIncomplete] = useState(false);
  const [verifyError, setVerifyError] = useState<unknown>(undefined);
  const [requested, setRequested] = useState(false);
  const cooldown = useCooldown();

  const target = safeNextPath(next);

  // Already signed in — send them on rather than showing a form that would just
  // create a second session for the same person.
  useEffect(() => {
    if (session) router.replace(target);
  }, [session, router, target]);

  const { run: send, isPending: isSending } = useSubmit(async () => {
    setSendError(undefined);
    setMobileError(undefined);
    // "Sent" describes THIS request only; a failed resend must not sit under
    // the success notice of an earlier one.
    setRequested(false);

    const normalized = normalizeMobile(mobile);
    if (normalized === null) {
      setMobileError("شمارهٔ موبایل را به شکل ۰۹xxxxxxxxx وارد کنید.");
      return;
    }

    try {
      await api.auth.sendOtp({ mobile: normalized });
      setRequested(true);
      setCodeIncomplete(false);
      setVerifyError(undefined);
      setStep("code");
      // The server's own 60-second per-number cooldown. Starting a local timer
      // here keeps the resend button honest between now and the next 429.
      cooldown.start(60);
      window.setTimeout(focusCodeField, 50);
    } catch (cause) {
      // Every failure is shown, including a transport failure that never
      // produced an HTTP status (`otpSendErrorMessage` covers that case).
      setSendError(cause);
      if (isApiError(cause)) {
        // The ONLY source of a wait time is the server's own figure — see
        // `sendOtpFailureAction` for every case. A cooldown 429 or an
        // UNCERTAIN 503 means a code may be live (or still arriving), so let
        // them type it rather than stranding them on the first step. A FAILED
        // 503 with retryAfterSeconds=0 clears any countdown: resend is open.
        const action = sendOtpFailureAction(cause);
        if (action.cooldownSeconds !== undefined) cooldown.start(action.cooldownSeconds);
        if (action.showCodeStep) {
          setStep("code");
          window.setTimeout(focusCodeField, 50);
        }
      }
    }
  });

  const { run: verify, isPending: isVerifying } = useSubmit(async () => {
    setVerifyError(undefined);
    setCodeIncomplete(false);

    const normalized = normalizeMobile(mobile);
    const digits = toLatinDigits(code).replace(/\D/g, "");
    if (normalized === null || digits.length < 4) {
      setCodeIncomplete(true);
      return;
    }

    try {
      await api.auth.verifyOtp({ mobile: normalized, code: digits });
      refresh();
      router.replace(target);
    } catch (cause) {
      setVerifyError(cause);
      if (isApiError(cause) && cause.code === "OTP_INVALID") {
        // The single, deliberately uninformative failure. Do not try to guess.
        setCode("");
        focusCodeField();
      }
    }
  });

  return (
    <Card tone="raised" padding="lg" className="mx-auto w-full max-w-md">
      <div className="flex items-center gap-2 text-primary">
        <ShieldIcon className="size-6" />
        <h1 className="text-xl text-ink">ورود به کژال</h1>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        با شمارهٔ موبایل وارد شوید. رمز عبوری در کار نیست؛ برای هر ورود یک کد یک‌بارمصرف لازم است.
      </p>

      {step === "mobile" ? (
        <form
          className="mt-6 space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void send();
          }}
        >
          <Input
            label="شمارهٔ موبایل"
            numeric
            required
            autoComplete="tel"
            inputMode="tel"
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
            placeholder="09xxxxxxxxx"
            {...(mobileError ? { error: mobileError } : {})}
            hint="می‌توانید شماره را با ارقام فارسی هم وارد کنید."
          />

          <OtpNotice message={otpSendErrorMessage(sendError)} />

          <Button type="submit" size="lg" fullWidth isLoading={isSending} disabled={cooldown.active}>
            {cooldown.active
              ? `تا ${formatInteger(cooldown.remaining)} ثانیهٔ دیگر امکان درخواست نیست`
              : "درخواست کد ورود"}
          </Button>
        </form>
      ) : (
        <form
          className="mt-6 space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void verify();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">
              شماره: <bdi dir="ltr" data-numeric="">{mobile}</bdi>
            </p>
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                setStep("mobile");
                setCode("");
                setCodeIncomplete(false);
                setVerifyError(undefined);
                setSendError(undefined);
              }}
            >
              تغییر شماره
            </Button>
          </div>

          {requested ? (
            <OtpNotice message={OTP_SENT_MESSAGE} icon={<CheckIcon className="size-5" />} />
          ) : null}

          <Input
            id={CODE_FIELD_ID}
            label="کد ورود"
            numeric
            required
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="۶ رقم"
          />

          <OtpNotice
            message={
              codeIncomplete
                ? otpVerifyErrorMessage({ status: 400, kind: "validation" })
                : otpVerifyErrorMessage(verifyError)
            }
          />

          <Button type="submit" size="lg" fullWidth isLoading={isVerifying}>
            ورود
          </Button>

          {/*
            ALWAYS available after a failure — see the note at the top of this
            file: "you never had a challenge" and "your digits were wrong" are
            the same 401, so a screen without a resend can dead-end a customer.
          */}
          <Button
            variant="secondary"
            fullWidth
            isLoading={isSending}
            disabled={cooldown.active}
            onClick={() => void send()}
          >
            {cooldown.active
              ? `درخواست کد تازه تا ${formatInteger(cooldown.remaining)} ثانیهٔ دیگر`
              : "درخواست کد تازه"}
          </Button>

          <OtpNotice message={otpSendErrorMessage(sendError)} />
        </form>
      )}

      {/*
        How the code works. Deliberately claims nothing about THIS request —
        whether a message was sent is said only by the notices above, from the
        server's answer.
      */}
      <ul className="mt-6 list-inside list-disc space-y-1 rounded-md border border-line bg-surface-muted px-4 py-3 text-xs leading-relaxed text-ink-muted">
        {OTP_INSTRUCTIONS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {reviewLoginEnabled() ? <ReviewPasswordSignIn target={target} /> : null}
    </Card>
  );
}

/** One OTP outcome, rendered with the tone its message carries. */
function OtpNotice({ message, icon }: { message: OtpMessage | undefined; icon?: ReactNode }) {
  if (!message) return null;
  return (
    <Notice tone={message.tone} title={message.title} {...(icon ? { icon } : {})}>
      <p>{message.body}</p>
    </Notice>
  );
}

/**
 * Normalize a typed mobile number to the server's canonical `09XXXXXXXXX`.
 *
 * The server accepts `09…`, `9…`, `+989…`, `00989…` and `989…`, with spaces,
 * hyphens, brackets and Persian/Arabic-Indic digits, and normalizes before it
 * looks anything up — so this is only here to catch an obvious typo before
 * spending one of the customer's five hourly sends on it. Anything this cannot
 * confidently normalize is sent as typed and judged by the server.
 */
export function normalizeMobile(raw: string): string | null {
  const digits = toLatinDigits(raw).replace(/[\s()\-.]/g, "");
  const withoutPrefix = digits
    .replace(/^\+98/, "0")
    .replace(/^0098/, "0")
    .replace(/^98(?=9\d{9}$)/, "0");
  const candidate = withoutPrefix.startsWith("9") && withoutPrefix.length === 10
    ? `0${withoutPrefix}`
    : withoutPrefix;
  return /^09\d{9}$/.test(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Review-only password sign-in
// ---------------------------------------------------------------------------

/**
 * Is the review-only password form available?
 *
 * TWO independent conditions, both of which must hold, and neither of which is
 * ever true by accident:
 *
 *  1. `NODE_ENV !== "production"`. Next inlines this at BUILD time, so a
 *     production bundle has the whole branch compiled out — the form cannot be
 *     switched on later by setting an environment variable on a running server.
 *  2. `NEXT_PUBLIC_ENABLE_REVIEW_LOGIN === "true"`, which is unset by default
 *     and appears in no committed env file.
 *
 * This is NOT an authentication bypass. It posts
 * `POST /auth/storefront/review-login`, the storefront audience's password
 * door, against accounts that genuinely hold a password, and the server applies
 * exactly the same checks staff logins get — including its own server-side
 * gate, which answers 403 unless `NODE_ENV !== "production"` and
 * `KAZHAL_ENABLE_REVIEW_LOGIN=true` on the API. Production customer authentication
 * remains OTP-only, and nothing here touches, weakens, logs or reveals an OTP.
 *
 * It exists only because no SMS provider has been supplied yet, so no reviewer
 * can receive a code. It should be deleted the day one is.
 */
export function reviewLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_ENABLE_REVIEW_LOGIN === "true"
  );
}

function ReviewPasswordSignIn({ target }: { target: Route }) {
  const api = useApi();
  const router = useRouter();
  const { refresh } = useAppSession();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const { run, isPending } = useSubmit(async () => {
    setError(undefined);
    try {
      await api.auth.login({ username: username.trim(), password });
      refresh();
      router.replace(target);
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
    }
  });

  return (
    <section className="mt-6 rounded-md border border-dashed border-warning/60 bg-warning-soft/40 p-4">
      <h2 className="text-sm font-bold text-ink">ورود آزمایشی (فقط برای بررسی)</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        این بخش فقط در محیط توسعه و بررسی فعال است و در نسخهٔ نهایی وجود ندارد.
        ورود مشتریان در محیط واقعی تنها با کد یک‌بارمصرف انجام می‌شود.
      </p>

      <form
        className="mt-4 space-y-3"
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

        <FormError error={error} />

        <Button type="submit" variant="secondary" fullWidth isLoading={isPending}>
          ورود آزمایشی
        </Button>
      </form>
    </section>
  );
}
