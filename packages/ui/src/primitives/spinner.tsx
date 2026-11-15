import type { JSX } from "react";

import { cx } from "./cx";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Announced to assistive tech. Set `null` inside a button that already has a label. */
  label?: string | null;
}

const SIZES = {
  sm: "size-4 border-2",
  md: "size-6 border-2",
  lg: "size-9 border-[3px]",
} as const;

/**
 * A CSS-only spinner. Respects `prefers-reduced-motion` through the global
 * base-layer rule in `tokens.css` (the animation collapses to a static ring
 * rather than disappearing, so the "busy" affordance survives).
 */
export function Spinner({ size = "md", className, label = "در حال بارگذاری" }: SpinnerProps): JSX.Element {
  return (
    <span
      role={label === null ? "presentation" : "status"}
      aria-live={label === null ? undefined : "polite"}
      className={cx("inline-flex items-center justify-center", className)}
    >
      <span
        aria-hidden="true"
        className={cx(
          "inline-block animate-spin rounded-full border-line-strong border-t-primary",
          SIZES[size],
        )}
      />
      {label === null ? null : <span className="kz-sr-only">{label}</span>}
    </span>
  );
}
