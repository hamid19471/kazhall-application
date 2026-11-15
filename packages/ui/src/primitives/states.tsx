import type { JSX, ReactNode } from "react";

import { isApiError, isMissingOrForbidden } from "@kazhal/api-client";

import { Button } from "./button";
import { cx } from "./cx";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative illustration or icon. Always `aria-hidden` — keep meaning in text. */
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Nothing here yet — not a failure. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-line px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="text-ink-subtle">
          {icon}
        </span>
      ) : null}
      <p className="text-lg font-semibold text-ink">{title}</p>
      {description ? <p className="max-w-prose text-sm text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  /** An `ApiError` (or anything). Its messages and code are read safely. */
  error?: unknown;
  /** Overrides the message derived from `error`. */
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

const GENERIC_TITLE = "مشکلی پیش آمد";
const GENERIC_BODY = "لطفاً دوباره تلاش کنید. اگر تکرار شد، کمی بعد سر بزنید.";
const NOT_FOUND_TITLE = "پیدا نشد";
const NOT_FOUND_BODY = "این مورد در دسترس نیست.";
const OFFLINE_TITLE = "ارتباط برقرار نشد";
const OFFLINE_BODY = "اتصال اینترنت خود را بررسی کنید و دوباره تلاش کنید.";

/**
 * The failure state.
 *
 * Two behaviours are deliberate and must not be "improved":
 *
 *  1. **403 and 404 render identically.** The API answers "you may not see this"
 *     and "this does not exist" with different codes; a UI that shows different
 *     copy hands an attacker an existence oracle. `isMissingOrForbidden` folds
 *     them into one message.
 *  2. **Server messages are shown, server codes are not.** `error.messages` is
 *     already human-readable Persian from the API; `error.code` is a machine
 *     string (`INSUFFICIENT_STOCK`) and is rendered only as a small, muted
 *     technical hint for support, never as the headline.
 */
export function ErrorState({
  error,
  title,
  description,
  onRetry,
  retryLabel = "تلاش دوباره",
  className,
}: ErrorStateProps): JSX.Element {
  const derived = describeError(error);
  const heading = title ?? derived.title;
  const body = description ?? derived.body;

  return (
    <div
      role="alert"
      className={cx(
        "flex flex-col items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-6 py-10 text-center",
        className,
      )}
    >
      <p className="text-lg font-semibold text-ink">{heading}</p>
      {body ? <p className="max-w-prose text-sm text-ink-muted">{body}</p> : null}
      {derived.code ? (
        <p className="text-2xs text-ink-subtle" dir="ltr">
          {derived.code}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

interface DerivedError {
  title: string;
  body: string;
  code?: string;
}

function describeError(error: unknown): DerivedError {
  if (!isApiError(error)) {
    return { title: GENERIC_TITLE, body: GENERIC_BODY };
  }

  // Non-enumerating: "forbidden" and "missing" must be indistinguishable.
  if (isMissingOrForbidden(error)) {
    return { title: NOT_FOUND_TITLE, body: NOT_FOUND_BODY };
  }

  if (error.kind === "network" || error.kind === "timeout") {
    return { title: OFFLINE_TITLE, body: OFFLINE_BODY };
  }

  if (error.kind === "rate_limited") {
    const seconds = error.retryAfterSeconds;
    return {
      title: "درخواست‌های زیاد",
      body:
        seconds === undefined
          ? "کمی صبر کنید و دوباره تلاش کنید."
          : `لطفاً ${new Intl.NumberFormat("fa-IR").format(Math.ceil(seconds))} ثانیه صبر کنید.`,
      ...(error.code ? { code: error.code } : {}),
    };
  }

  // ValidationPipe returns an ARRAY of messages; show them all.
  const body = error.messages.join("\n");
  return {
    title: error.kind === "server" ? GENERIC_TITLE : (error.messages[0] ?? GENERIC_TITLE),
    body: error.messages.length > 1 ? body : error.kind === "server" ? GENERIC_BODY : "",
    ...(error.code ? { code: error.code } : {}),
  };
}
