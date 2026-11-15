import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";

import { cx } from "./cx";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction without collapsing the layout. */
  isLoading?: boolean;
  /** Rendered before the label in reading order (i.e. on the RIGHT in RTL). */
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  children: ReactNode;
}

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap " +
  "transition-[background-color,color,border-color,box-shadow] duration-150 ease-kz " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)] " +
  "disabled:cursor-not-allowed disabled:opacity-55";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-ink shadow-soft hover:bg-primary-hover active:bg-primary-active " +
    "disabled:hover:bg-primary",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-surface-muted active:bg-surface-sunken " +
    "disabled:hover:bg-surface",
  ghost: "bg-transparent text-ink hover:bg-surface-muted active:bg-surface-sunken",
  danger: "bg-danger text-white shadow-soft hover:brightness-110 active:brightness-95",
  link: "bg-transparent text-primary underline underline-offset-4 hover:text-primary-hover px-0",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm rounded-md",
  md: "h-11 px-5 text-base rounded-md",
  lg: "h-13 px-7 text-lg rounded-lg",
};

/**
 * The button.
 *
 * Accessibility notes that are easy to get wrong and are handled here:
 *  - `isLoading` sets `aria-busy` and `disabled`, and keeps the label mounted so
 *    the accessible name never disappears mid-action.
 *  - the focus ring is `outline`, not `ring`, so it survives `overflow:hidden`
 *    parents and stays visible in forced-colors mode.
 *  - `type` defaults to `"button"`; the HTML default of `"submit"` inside a form
 *    is a classic accidental-submit bug.
 *  - icons are placed by reading order, so they land on the correct side in RTL
 *    without any `ltr:`/`rtl:` variants.
 */
export function Button({
  variant = "primary",
  size = "md",
  isLoading = false,
  leadingIcon,
  trailingIcon,
  fullWidth = false,
  className,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || isLoading}
      aria-busy={isLoading || undefined}
      className={cx(
        BASE,
        VARIANTS[variant],
        variant === "link" ? "h-auto" : SIZES[size],
        fullWidth && "w-full",
        className,
      )}
    >
      {isLoading ? <Spinner size="sm" label={null} /> : leadingIcon}
      <span>{children}</span>
      {isLoading ? null : trailingIcon}
    </button>
  );
}
