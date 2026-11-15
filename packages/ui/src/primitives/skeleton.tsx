import type { CSSProperties, JSX } from "react";

import { cx } from "./cx";

export interface SkeletonProps {
  className?: string;
  /** Any CSS width/height. Prefer matching the real content's box. */
  width?: string;
  height?: string;
  shape?: "line" | "block" | "circle";
  style?: CSSProperties;
}

/**
 * A loading placeholder.
 *
 * Marked `aria-hidden` on purpose: a screen reader should hear the surrounding
 * `aria-busy`/`role="status"` region announce "loading" ONCE, not read a dozen
 * meaningless boxes. The shimmer direction follows the document direction via
 * the `--kz-shimmer-dir` custom property set in `tokens.css`.
 */
export function Skeleton({
  className,
  width,
  height,
  shape = "line",
  style,
}: SkeletonProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "kz-shimmer block",
        shape === "circle" ? "rounded-pill" : shape === "block" ? "rounded-md" : "rounded-sm",
        shape === "line" && !height && "h-4",
        className,
      )}
      style={{ ...(width ? { width } : {}), ...(height ? { height } : {}), ...style }}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** A paragraph-shaped placeholder; the last line is short, as real text is. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps): JSX.Element {
  return (
    <span className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? "60%" : "100%"} />
      ))}
    </span>
  );
}
