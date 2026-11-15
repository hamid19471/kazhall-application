"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { Badge, Button, Card, Input, Skeleton, Spinner, cx } from "@kazhal/ui";
import type { BadgeTone } from "@kazhal/ui";
import type { UserRole } from "@kazhal/api-client";

import { useAppSession } from "@/components/providers";
import { can, canAny, hasRole } from "@/lib/permissions";
import { AlertIcon, CloseIcon, FilterIcon, SearchIcon } from "@/components/icons";

/**
 * ===========================================================================
 * THE ADMIN UI KIT
 * ===========================================================================
 *
 * Everything every management screen needs and `@kazhal/ui` does not have: a
 * page header with actions, a responsive table container, a native select, a
 * textarea, a focus-trapping dialog, and a permission gate.
 *
 * It lives in `apps/web/components/admin/` rather than in `@kazhal/ui` because
 * the till (`apps/store`) shares that package and has no management screens.
 *
 * TWO RULES EVERYTHING HERE FOLLOWS:
 *
 *  1. LOGICAL PROPERTIES ONLY. Both apps render `<html dir="rtl">`, so `ms-`,
 *     `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`, `border-s-` — never
 *     `ml-`, `pr-`, `left-`, `text-left`, which silently mirror wrong.
 *  2. NO PAGE-LEVEL HORIZONTAL SCROLL. Wide content scrolls inside its OWN
 *     container (`DataTable`), and nothing anywhere sets `overflow-x: hidden`
 *     on the body — hiding a layout defect is not fixing it, and it makes the
 *     clipped content unreachable rather than merely ugly.
 */

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

export function AdminPageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Primary/secondary buttons. Wraps below the title on narrow screens. */
  actions?: ReactNode;
  /** Badges or counts shown beside the title. */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl text-ink">{title}</h1>
          {meta}
        </div>
        {description ? (
          <p className="mt-1.5 max-w-[60ch] text-sm leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function AdminSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    /*
     * `min-w-0` IS LOAD-BEARING, not tidiness.
     *
     * A grid or flex ITEM defaults to `min-width: auto`, which means it
     * refuses to shrink below its content's intrinsic width. Put a `DataTable`
     * — whose table carries a `min-width` so the columns stay readable —
     * inside a section inside a `grid lg:grid-cols-2`, and at 360px the
     * section becomes 520px wide and the whole PAGE scrolls sideways, even
     * though the table has a perfectly good scroll container of its own.
     *
     * Measured: the dashboard's two side-by-side cards were 428px and 524px
     * wide in a 360px viewport before this line.
     */
    <Card as="section" tone="outlined" padding="md" className={cx('min-w-0', className)}>
      {title || actions ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title ? <h2 className="text-lg text-ink">{title}</h2> : null}
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-ink-subtle">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

/**
 * A labelled fact. The unit of every detail panel in the console.
 *
 * `data-numeric` on the value is not decoration: it switches the value to
 * tabular figures and keeps Latin digits, SKUs and order numbers LTR inside
 * RTL prose, which is what stops `POS-20260911-000025` rendering back to
 * front.
 */
export function Fact({
  label,
  children,
  numeric = false,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  numeric?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md bg-surface-muted p-3">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd
        className="mt-1 break-words text-sm font-bold text-ink"
        {...(numeric ? { "data-numeric": "" } : {})}
      >
        {children}
      </dd>
      {hint ? <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

/** A headline number. Used on the dashboard and above every long table. */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  /** What the number MEANS. Required by the brief, and by common sense. */
  hint?: ReactNode;
  tone?: "neutral" | "primary" | "warning" | "danger" | "success";
  href?: ReactNode;
}) {
  const ring: Record<string, string> = {
    neutral: "border-line",
    primary: "border-primary/40 bg-primary-soft/40",
    warning: "border-warning/40 bg-warning-soft/50",
    danger: "border-danger/40 bg-danger-soft/50",
    success: "border-success/40 bg-success-soft/50",
  };
  return (
    <div className={cx("min-w-0 rounded-lg border bg-surface p-4", ring[tone])}>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1.5 break-words text-xl font-extrabold text-ink" data-numeric="">
        {value}
      </p>
      {hint ? (
        <p className="mt-1.5 text-2xs leading-relaxed text-ink-subtle">{hint}</p>
      ) : null}
      {href ? <p className="mt-2 text-xs">{href}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A table that scrolls INSIDE ITSELF.
 *
 * `min-w-*` on the table plus `overflow-x-auto` on this wrapper is the whole
 * trick: the table keeps a readable minimum width and the PAGE never gains a
 * horizontal scrollbar, at any viewport down to 320px. `tabIndex={0}` makes
 * the scroll region reachable by keyboard, which an `overflow` container is
 * not by default — a keyboard user otherwise cannot reach the right-hand
 * columns at all.
 */
export function DataTable({
  children,
  minWidth = "44rem",
  caption,
}: {
  children: ReactNode;
  minWidth?: string;
  /** Announced to screen readers; visually hidden. */
  caption?: string;
}) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={caption ?? "جدول"}
      // `relative` is load-bearing: the visually hidden <caption> is
      // absolutely positioned, and an overflow box only clips absolutely
      // positioned descendants when it is itself positioned. Without it the
      // caption escaped this scroller and widened the whole page on phones
      // (a 390px admin order page scrolled to 647px).
      className="relative w-full min-w-0 overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
    >
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        {caption ? <caption className="kz-sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  numeric = false,
}: {
  children: ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cx(
        "whitespace-nowrap bg-surface-muted p-3 text-xs font-semibold text-ink-muted",
        numeric ? "text-end" : "text-start",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  numeric = false,
}: {
  children: ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    <td
      className={cx("p-3 align-middle", numeric ? "text-end" : "text-start", className)}
      {...(numeric ? { "data-numeric": "" } : {})}
    >
      {children}
    </td>
  );
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cx("border-t border-line", className)}>{children}</tr>;
}

/** The "nothing here" row. Spans the whole table so the layout does not break. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <td colSpan={colSpan} className="p-8 text-center text-sm text-ink-subtle">
        {children}
      </td>
    </tr>
  );
}

export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="kz-sr-only">در حال بارگذاری</span>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-2">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <Skeleton key={columnIndex} height="2.5rem" className="flex-1" shape="block" />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form controls the design system does not have
// ---------------------------------------------------------------------------

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> {
  label: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  containerClassName?: string;
}

/**
 * A NATIVE `<select>`, deliberately.
 *
 * A custom listbox would need its own keyboard model, its own screen-reader
 * semantics and its own mobile behaviour, and would be worse than the
 * platform's at all three. The only styling applied is the token palette and a
 * consistent height.
 */
export function Select({
  label,
  hideLabel = false,
  hint,
  error,
  options,
  className,
  containerClassName,
  ...rest
}: SelectProps) {
  const generatedId = useId();
  const id = rest.name ? `${rest.name}-${generatedId}` : generatedId;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", containerClassName)}>
      <label htmlFor={id} className={cx("text-xs text-ink-muted", hideLabel && "kz-sr-only")}>
        {label}
      </label>
      <select
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cx(
          "h-11 w-full rounded-md border bg-surface px-3 text-sm text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="text-2xs leading-relaxed text-ink-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  containerClassName?: string;
}

export function Textarea({
  label,
  hint,
  error,
  className,
  containerClassName,
  ...rest
}: TextareaProps) {
  const generatedId = useId();
  const id = rest.name ? `${rest.name}-${generatedId}` : generatedId;

  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", containerClassName)}>
      <label htmlFor={id} className="text-xs text-ink-muted">
        {label}
      </label>
      <textarea
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        className={cx(
          "min-h-[6rem] w-full rounded-md border bg-surface p-3 text-sm leading-relaxed text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
      />
      {hint ? <p className="text-2xs leading-relaxed text-ink-subtle">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A real checkbox with a real label. Used for permission checklists. */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
  tone,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  tone?: BadgeTone;
  }) {
  const id = useId();
  return (
    <div
      className={cx(
        "flex items-start gap-2.5 rounded-md border p-3 transition-colors duration-150 ease-kz",
        checked ? "border-primary/50 bg-primary-soft/40" : "border-line bg-surface",
        disabled && "opacity-60",
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]"
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
          {label}
          {tone ? (
            <Badge tone={tone} size="sm">
              {tone === "danger" ? "پرخطر" : "حساس"}
            </Badge>
          ) : null}
        </span>
        {description ? (
          <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{description}</span>
        ) : null}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The filter strip above a list.
 *
 * `collapsible` is what makes the reconciliation page usable by an ordinary
 * store manager: the technical filters are still there, one click away, but
 * they are not the first thing the page asks of somebody who just wants to see
 * what needs doing.
 */
export function FilterBar({
  children,
  onSubmit,
  onReset,
  collapsible = false,
  defaultOpen = false,
  summary,
}: {
  children: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onReset?: () => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  summary?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const body = (
    <form
      onSubmit={onSubmit}
      className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {children}
      {(onSubmit || onReset) && (
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          {onSubmit ? (
            <Button type="submit" size="sm">
              اعمال فیلتر
            </Button>
          ) : null}
          {onReset ? (
            <Button type="button" size="sm" variant="ghost" onClick={onReset}>
              پاک‌کردن فیلترها
            </Button>
          ) : null}
        </div>
      )}
    </form>
  );

  if (!collapsible) return <div className="mb-5">{body}</div>;

  /*
   * The TRIGGER's label is deliberately short, and the longer explanation
   * lives beneath it as text.
   *
   * `Button` carries `whitespace-nowrap` — correct for a button, and the
   * reason a descriptive label belongs outside one: a sentence-length trigger
   * measured 443px wide in a 360px viewport, so its own text was clipped.
   */
  return (
    <div className="mb-5">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        leadingIcon={<FilterIcon className="size-4" />}
      >
        {open ? "بستن فیلترهای پیشرفته" : "فیلترهای پیشرفته"}
      </Button>
      {!open && summary ? (
        <p className="mt-1 max-w-[60ch] text-2xs leading-relaxed text-ink-subtle">
          {summary}
        </p>
      ) : null}
      {open ? <div className="mt-3">{body}</div> : null}
    </div>
  );
}

/** A search box that submits its own form. Uncontrolled, keyed by the URL term. */
export function SearchField({
  name = "search",
  defaultValue,
  label,
  placeholder,
}: {
  name?: string;
  defaultValue?: string;
  label: string;
  placeholder?: string;
}) {
  return (
    <Input
      key={defaultValue ?? ""}
      name={name}
      type="search"
      label={label}
      defaultValue={defaultValue ?? ""}
      placeholder={placeholder}
      maxLength={200}
      containerClassName="min-w-0"
    />
  );
}

export { SearchIcon };

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * A modal that behaves like one.
 *
 * Traps Tab, closes on Escape and on the scrim, restores focus to whatever
 * opened it, and locks the body scroll. `max-h-[90dvh]` + an internal scroll
 * region is what keeps it inside a 568px-tall phone instead of running off the
 * bottom with its confirm button unreachable — `dvh` rather than `vh` because
 * mobile browsers' collapsing toolbars make `vh` a lie.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  tone = "neutral",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select, textarea',
    )?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="بستن"
        onClick={onClose}
        className="absolute inset-0 bg-ink/45"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cx(
          "relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-xl border bg-surface shadow-raised sm:max-w-lg sm:rounded-xl",
          tone === "danger" ? "border-danger/40" : "border-line",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line p-4">
          <div className="min-w-0">
            <h2
              id={titleId}
              className={cx("text-base", tone === "danger" ? "text-danger" : "text-ink")}
            >
              {tone === "danger" ? (
                <AlertIcon className="me-1.5 inline size-4 align-[-2px]" aria-hidden="true" />
              ) : null}
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="shrink-0 rounded-md p-1 text-ink-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]"
          >
            <CloseIcon className="size-5" />
          </button>
        </div>
        {children ? <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div> : null}
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-muted p-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The confirmation every destructive action goes through.
 *
 * `consequences` is the point of it: "are you sure?" is not a question anybody
 * can answer, while "this will return 3 units to stock and remove ۱۲٬۰۰۰٬۰۰۰
 * ریال from today's takings" is. Each bullet is one sentence about ONE
 * consequence — money, stock, status, reversibility — so the caller cannot
 * ship a dialog that says "are you sure" and nothing else.
 *
 * `confirmPhrase` adds a typed confirmation for the genuinely irreversible.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  question,
  consequences,
  confirmLabel = "تأیید",
  cancelLabel = "انصراف",
  tone = "danger",
  isPending = false,
  confirmPhrase,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  question?: ReactNode;
  consequences: ReactNode[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "neutral" | "danger";
  isPending?: boolean;
  /** When set, the operator must type it exactly before confirming. */
  confirmPhrase?: string;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const [wasOpen, setWasOpen] = useState(open);

  /*
   * A typed confirmation must not survive a cancel: reopening the dialog with
   * the phrase already filled in turns the safeguard into a formality.
   * Adjusted during render rather than in an effect — `setState` in an effect
   * body causes the cascading render React warns about, and here it would also
   * mean one frame in which the confirm button is already unlocked.
   */
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setTyped("");
  }

  const locked = Boolean(confirmPhrase) && typed.trim() !== confirmPhrase;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(question !== undefined ? { description: question } : {})}
      tone={tone}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            isLoading={isPending}
            disabled={locked}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <ul className="space-y-2">
        {consequences.map((consequence, index) => (
          <li key={index} className="flex gap-2 text-sm leading-relaxed text-ink">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-pill bg-ink-subtle" />
            <span className="min-w-0">{consequence}</span>
          </li>
        ))}
      </ul>
      {children ? <div className="mt-4">{children}</div> : null}
      {confirmPhrase ? (
        <div className="mt-4">
          <Input
            label={`برای تأیید، عبارت «${confirmPhrase}» را بنویسید`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
        </div>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Permission gating
// ---------------------------------------------------------------------------

/**
 * Renders `children` only when the caller holds the capability.
 *
 * A COURTESY, NOT A CONTROL. The API re-checks on every request. Use it to
 * keep a screen honest — do not use it to decide anything, and never skip a
 * 403 handler because of it.
 */
export function Gate({
  permissions,
  mode = "all",
  children,
  fallback = null,
}: {
  permissions: string[];
  mode?: "all" | "any";
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { session } = useAppSession();
  const allowed =
    mode === "all" ? can(session, ...permissions) : canAny(session, ...permissions);
  return <>{allowed ? children : fallback}</>;
}

/** The whole-page version, for a route the caller may not open at all. */
export function RequirePermission({
  permissions,
  mode = "all",
  children,
}: {
  permissions: string[];
  mode?: "all" | "any";
  children: ReactNode;
}) {
  const { session, isLoading } = useAppSession();

  if (isLoading) {
    return (
      <div role="status" aria-busy="true" className="flex justify-center py-16">
        <Spinner size="lg" />
        <span className="kz-sr-only">در حال بارگذاری</span>
      </div>
    );
  }

  const allowed =
    mode === "all" ? can(session, ...permissions) : canAny(session, ...permissions);
  if (allowed) return <>{children}</>;

  return <AccessDenied permissions={permissions} />;
}

/**
 * The whole-page version for a route gated on a ROLE rather than a capability.
 *
 * There is exactly one: sales reporting. The owner's rule —
 *
 *   "Sales reports are available only to the main administrator, represented
 *    by the built-in `super_admin` role."
 *
 * — is deliberately not a delegable capability, so there is no permission code
 * to name. `reports.read` was retired by API migration 0028; the server gates
 * `/reports/*` on `@Roles(super_admin)` plus `@Audiences('admin')`.
 *
 * WHY THE PAGE NEEDS THIS AT ALL, given the API refuses anyway: without it a
 * delegated administrator who types `/admin/reports` gets the full reporting
 * chrome — filter bar, table headers, skeletons — and then three separate 403
 * error panels as each query fails. That reads as a broken page rather than a
 * closed door. This renders the same "you may not" card every other gated
 * screen uses, before a single request is made.
 */
export function RequireRole({
  roles,
  children,
  reason,
}: {
  roles: UserRole[];
  children: ReactNode;
  /** What the viewer is told instead of a capability code. */
  reason?: ReactNode;
}) {
  const { session, isLoading } = useAppSession();

  if (isLoading) {
    return (
      <div role="status" aria-busy="true" className="flex justify-center py-16">
        <Spinner size="lg" />
        <span className="kz-sr-only">در حال بارگذاری</span>
      </div>
    );
  }

  if (hasRole(session, ...roles)) return <>{children}</>;

  return (
    <AccessDenied
      permissions={[]}
      title="این بخش تنها برای مدیر ارشد است"
      description={
        reason ??
        "گزارش فروش تنها در اختیار مدیر ارشد سامانه است و به هیچ نقش دیگری واگذار نمی‌شود. این محدودیت یک اختیار قابل‌اعطا نیست، بنابراین افزودن دسترسی به نقش شما هم آن را باز نمی‌کند."
      }
    />
  );
}

/**
 * The access-denied card itself, without the session check.
 *
 * `RequirePermission` renders it when the session is missing the capability
 * BEFORE anything is fetched. A screen that instead discovers the refusal at
 * RUNTIME — a 403 from the API, because the session list drifted or a role was
 * changed mid-visit — renders the same card from the server's own
 * `details.missingPermissions`, so the operator reads one explanation and not
 * two. Neither path offers a retry: repeating a request the server has already
 * refused changes nothing and hides the reason behind a spinner.
 */
export function AccessDenied({
  permissions,
  title = "دسترسی لازم را ندارید",
  description = "برای دیدن این صفحه به اختیار زیر نیاز دارید. از مدیر ارشد بخواهید آن را به نقش شما اضافه کند.",
}: {
  permissions: string[];
  title?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <Card tone="outlined" padding="lg" className="text-center">
      <AlertIcon className="mx-auto size-8 text-warning" aria-hidden="true" />
      <h1 className="mt-3 text-lg text-ink">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{description}</p>
      <p className="mt-3 flex flex-wrap justify-center gap-1.5">
        {permissions.map((permission) => (
          <Badge key={permission} size="sm" tone="neutral">
            <bdi dir="ltr">{permission}</bdi>
          </Badge>
        ))}
      </p>
    </Card>
  );
}

/**
 * True when this rejection is the server refusing on capability grounds.
 *
 * Distinguishing it from "the server could not be reached" is the whole point:
 * a 403 must never be reported as a network failure with a retry button, which
 * loops forever and tells the operator nothing they can act on.
 */
export function forbiddenPermissions(error: unknown): string[] | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    details?: { missingPermissions?: unknown };
  };
  if (candidate.status !== 403) return null;
  const missing = candidate.details?.missingPermissions;
  if (Array.isArray(missing)) return missing.map((code) => String(code));
  /*
   * A 403 the guard did not raise — `PASSWORD_CHANGE_REQUIRED` is the one that
   * exists — is NOT a capability problem and must keep its own handling.
   */
  return candidate.code === "PERMISSION_DENIED" ? [] : null;
}

// ---------------------------------------------------------------------------
// Small helpers every list screen repeats
// ---------------------------------------------------------------------------

/** Persian digits for a count. Never `toLocaleString` at the call site. */
export function count(value: number): string {
  return new Intl.NumberFormat("fa-IR").format(value);
}

/** A Jalali date-time, or an em dash. */
export function when(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/** Yes/no as a badge, so a table column reads at a glance. */
export function BoolBadge({
  value,
  yes = "بله",
  no = "خیر",
  yesTone = "success",
  noTone = "neutral",
}: {
  value: boolean;
  yes?: string;
  no?: string;
  yesTone?: BadgeTone;
  noTone?: BadgeTone;
}) {
  return (
    <Badge size="sm" tone={value ? yesTone : noTone}>
      {value ? yes : no}
    </Badge>
  );
}

/**
 * A submit-once guard shared by every mutation in the console.
 *
 * `apps/web/lib/hooks.ts` already has `useSubmit`; this adds the two things
 * every admin form also needs — the error and a success message — so twelve
 * screens do not each invent their own trio of state variables.
 */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [done, setDone] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(true);
      setError(undefined);
      setDone(null);
      try {
        return await fn(...args);
      } catch (caught) {
        setError(caught);
        return undefined;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [fn],
  );

  return { run, isPending, error, done, setDone, setError };
}
