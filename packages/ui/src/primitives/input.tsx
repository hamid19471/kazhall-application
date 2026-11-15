"use client";

import { useId } from "react";
import type { InputHTMLAttributes, JSX, ReactNode } from "react";

import { cx } from "./cx";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: ReactNode;
  /** Helper text shown under the field when there is no error. */
  hint?: ReactNode;
  /** Error text. Presence switches the field into its invalid state. */
  error?: ReactNode;
  /** Visually hide the label but keep it for assistive tech. */
  hideLabel?: boolean;
  id?: string;
  /**
   * Force LTR entry inside the RTL page. Use for phone numbers, postal codes,
   * SKUs, prices and anything else that is a number rather than prose.
   */
  numeric?: boolean;
  containerClassName?: string;
}

/**
 * A labelled text input.
 *
 * The wiring that matters:
 *  - the label is a real `<label htmlFor>`, never a placeholder
 *  - `aria-describedby` points at the hint AND the error, so both are announced
 *  - `aria-invalid` + `role="alert"` on the error, so a submit failure is spoken
 *  - `numeric` sets `dir="ltr"` + `inputMode` so Persian users can type digits
 *    into a field that still reads left-to-right, inside an RTL page
 */
export function Input({
  label,
  hint,
  error,
  hideLabel = false,
  id: providedId,
  numeric = false,
  className,
  containerClassName,
  required,
  ...rest
}: InputProps): JSX.Element {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = Boolean(error);

  const describedBy =
    [hint ? hintId : undefined, hasError ? errorId : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cx("flex flex-col gap-1.5", containerClassName)}>
      <label
        htmlFor={id}
        className={cx("text-sm font-medium text-ink", hideLabel && "kz-sr-only")}
      >
        {label}
        {required ? (
          <span className="text-danger ms-1" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <input
        {...rest}
        id={id}
        required={required}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        dir={numeric ? "ltr" : undefined}
        inputMode={rest.inputMode ?? (numeric ? "numeric" : undefined)}
        data-numeric={numeric ? "" : undefined}
        className={cx(
          "h-11 w-full rounded-md border bg-surface px-3 text-base text-ink",
          "placeholder:text-ink-subtle",
          "transition-[border-color,box-shadow] duration-150 ease-kz",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--kz-focus)]",
          "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle",
          hasError ? "border-danger" : "border-line-strong hover:border-ink-subtle",
          numeric && "text-start",
          className,
        )}
      />

      {hasError ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
