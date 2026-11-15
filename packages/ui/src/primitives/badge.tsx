import type { HTMLAttributes, JSX, ReactNode } from "react";

import { cx } from "./cx";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "accent";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: "sm" | "md";
  /**
   * Text announced INSTEAD of the visible label, for badges whose colour
   * carries meaning the label alone does not (e.g. an order-status pill).
   */
  srLabel?: string;
  children: ReactNode;
}

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink-muted border-line",
  primary: "bg-primary-soft text-primary border-primary/25",
  success: "bg-success-soft text-success border-success/25",
  warning: "bg-warning-soft text-warning border-warning/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  info: "bg-info-soft text-info border-info/25",
  accent: "bg-accent-soft text-accent border-accent/30",
};

/**
 * A status pill.
 *
 * Colour is never the only signal: the label always carries the meaning in
 * text, and `srLabel` exists for the cases where the visible text is an
 * abbreviation. That keeps the component usable for colour-blind users and in
 * forced-colors mode.
 *
 * `relative` is LOAD-BEARING, not decoration. `.kz-sr-only` is
 * `position: absolute`, so it resolves against the nearest POSITIONED ancestor.
 * With none nearby it escapes whatever scroll container it sits in and is laid
 * out at its static position against some distant ancestor — which in RTL put
 * the category strip's hidden labels 440px to the left of the viewport and gave
 * the whole document a horizontal scrollbar. Positioning the badge keeps its
 * own hidden label inside it, where the scroller can clip it.
 */
export function Badge({
  tone = "neutral",
  size = "md",
  srLabel,
  className,
  children,
  ...rest
}: BadgeProps): JSX.Element {
  return (
    <span
      {...rest}
      className={cx(
        "relative inline-flex items-center gap-1 rounded-pill border font-medium",
        size === "sm" ? "px-2 py-0.5 text-2xs" : "px-2.5 py-1 text-xs",
        TONES[tone],
        className,
      )}
    >
      {srLabel ? <span className="kz-sr-only">{srLabel}</span> : null}
      <span aria-hidden={srLabel ? "true" : undefined}>{children}</span>
    </span>
  );
}
