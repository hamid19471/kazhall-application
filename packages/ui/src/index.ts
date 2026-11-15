/**
 * `@kazhal/ui` — the shared design system for `apps/web` and `apps/store`.
 *
 * Wired into both apps through tsconfig `paths` (`@kazhal/ui`, `@kazhal/ui/*`),
 * NOT through `dependencies` — no `package.json` or lockfile change is involved.
 *
 * ```ts
 * import { Button, Card, Money, ErrorState } from "@kazhal/ui";
 * import { ApiProvider, useSession } from "@kazhal/ui/api/react";
 * ```
 *
 * The stylesheet is separate and must be imported once, from each app's
 * `globals.css`, AFTER `@import "tailwindcss"`:
 *
 * ```css
 * @import "tailwindcss";
 * @import "../../../packages/ui/src/styles/tokens.css";
 * @source "../../../packages/ui/src";
 * ```
 *
 * The `@source` line is required: Tailwind v4 only scans files under the CSS
 * entry's own project by default, so without it every utility used by the
 * components below would be tree-shaken out of the app's bundle.
 *
 * RTL: both apps render `<html lang="fa" dir="rtl">`. Components here use
 * logical Tailwind utilities only (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`,
 * `text-start`). Do not introduce `ml-`, `pr-`, `left-` or `text-left`.
 */

export { cx, type ClassValue } from "./primitives/cx";
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./primitives/button";
export { Input, type InputProps } from "./primitives/input";
export { Card, CardHeader, type CardHeaderProps, type CardProps, type CardTone } from "./primitives/card";
export { Badge, type BadgeProps, type BadgeTone } from "./primitives/badge";
export { Spinner, type SpinnerProps } from "./primitives/spinner";
export { Skeleton, SkeletonText, type SkeletonProps, type SkeletonTextProps } from "./primitives/skeleton";
export {
  EmptyState,
  ErrorState,
  type EmptyStateProps,
  type ErrorStateProps,
} from "./primitives/states";
export { Money, type MoneyProps } from "./primitives/money";
export {
  PersianDatePicker,
  PersianDateRangeFields,
  type PersianDatePickerProps,
  type PersianDateRangeFieldsProps,
} from "./primitives/date-picker";
export {
  BUSINESS_TIME_ZONE,
  PERSIAN_LOCALE,
  REVERSED_RANGE_MESSAGE,
  formatIsoDayPersian,
  isIsoDay,
  isoDayToPersian,
  parseIsoDay,
  persianDay,
  persianToIsoDay,
  readDayRange,
  tehranDayEnd,
  tehranDayStart,
  todayIsoDay,
  validateDayRange,
  type DayRange,
} from "./date/persian-date";

export {
  MAX_RIAL,
  addRialStrings,
  compareRialStrings,
  formatDate,
  formatDateTime,
  formatInteger,
  formatPercent,
  formatRial,
  formatRialString,
  formatToman,
  isZeroRialString,
  parseRial,
  rialToToman,
  toLatinDigits,
  toPersianDigits,
  type DigitSystem,
  type MoneyFormatOptions,
  type RialStringOptions,
} from "./format/money";
