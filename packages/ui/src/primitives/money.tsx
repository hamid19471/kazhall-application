import type { JSX } from "react";

import { formatRial, formatRialString, type DigitSystem } from "../format/money";
import { cx } from "./cx";

export interface MoneyProps {
  /**
   * Integer Rial, exactly as the API sends it.
   *
   * A STRING is the precision-safe form and is what every aggregate money
   * figure now arrives as — `bigint` columns and `SUM()`s over them, which
   * node-postgres keeps as strings so nothing rounds. It is formatted digit by
   * digit and never parsed.
   *
   * A `number` is still accepted for the catalogue prices a person typed,
   * which are small by construction. A non-finite number renders the fallback.
   */
  value: string | number | null | undefined;
  digits?: DigitSystem;
  withUnit?: boolean;
  unit?: string;
  className?: string;
  /** Rendered when `value` is null/undefined. Default `"—"`. */
  fallback?: string;
  /** Strike-through styling for a previous price. Also marks it up as `<s>`. */
  struck?: boolean;
}

/**
 * A price.
 *
 * Wrapped in `<bdi>` so the bidirectional algorithm cannot let the digits and
 * the unit reorder when a price sits inside a Persian sentence — the classic
 * "۱۲۳ ریال" turning into "ریال ۱۲۳" bug. `data-numeric` switches on tabular
 * figures so prices line up in a column.
 */
export function Money({
  value,
  digits = "persian",
  withUnit = true,
  unit,
  className,
  fallback = "—",
  struck = false,
}: MoneyProps): JSX.Element {
  if (value === null || value === undefined) {
    return <span className={cx("text-ink-subtle", className)}>{fallback}</span>;
  }

  /*
   * The string branch never converts. `formatRialString` returns its own
   * fallback for anything that is not a base-10 integer, so a malformed figure
   * shows the same dash as an absent one rather than "NaN" or a rounded value.
   */
  const text =
    typeof value === "string"
      ? formatRialString(value, { digits, withUnit, fallback, ...(unit ? { unit } : {}) })
      : Number.isFinite(value)
        ? formatRial(value, { digits, withUnit, ...(unit ? { unit } : {}) })
        : "";

  if (text === "" || text === fallback) {
    return <span className={cx("text-ink-subtle", className)}>{fallback}</span>;
  }
  const content = (
    <bdi data-numeric="" className={cx(struck && "line-through", className)}>
      {text}
    </bdi>
  );

  return struck ? <s className="text-ink-subtle">{content}</s> : content;
}
