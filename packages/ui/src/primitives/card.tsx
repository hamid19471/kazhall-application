import type { HTMLAttributes, JSX, ReactNode } from "react";

import { cx } from "./cx";

export type CardTone = "plain" | "raised" | "outlined" | "muted";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: CardTone;
  /** Render as `<article>`/`<section>`/`<li>` instead of `<div>`. */
  as?: "div" | "article" | "section" | "li";
  /** Adds hover elevation. Use ONLY when the whole card is a link or button. */
  interactive?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  children: ReactNode;
}

const TONES: Record<CardTone, string> = {
  plain: "bg-surface",
  raised: "bg-surface shadow-soft",
  outlined: "bg-surface border border-line",
  muted: "bg-surface-muted",
};

const PADDING = {
  none: "",
  sm: "p-3",
  md: "p-5",
  lg: "p-7",
} as const;

/**
 * A surface container.
 *
 * `as` exists so a card in a product grid can be a real `<li>` inside a `<ul>`,
 * and a standalone card can be an `<article>` — the visual is the same, the
 * semantics are not, and screen-reader users only get the second one.
 */
export function Card({
  tone = "outlined",
  as: Tag = "div",
  interactive = false,
  padding = "md",
  className,
  children,
  ...rest
}: CardProps): JSX.Element {
  return (
    <Tag
      {...rest}
      className={cx(
        "rounded-lg",
        TONES[tone],
        PADDING[padding],
        interactive &&
          "transition-shadow duration-200 ease-kz hover:shadow-raised focus-within:shadow-raised",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Placed at the far end of the line (the LEFT edge in RTL). */
  action?: ReactNode;
  /** Heading level. Pick the one that fits the page outline, not the size. */
  headingLevel?: 2 | 3 | 4;
}

export function CardHeader({
  title,
  description,
  action,
  headingLevel = 3,
  className,
  ...rest
}: CardHeaderProps): JSX.Element {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <div {...rest} className={cx("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <Heading className="text-lg text-ink">{title}</Heading>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
