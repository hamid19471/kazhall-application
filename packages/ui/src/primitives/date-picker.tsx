"use client";

import { useContext, useEffect, useId, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarStateContext,
  DateInput,
  DatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  Label,
  Popover,
  Text,
} from "react-aria-components";
import type { DateValue } from "react-aria-components";

import {
  PERSIAN_LOCALE,
  isIsoDay,
  isoDayToPersian,
  persianToIsoDay,
  validateDayRange,
} from "../date/persian-date";
import { cx } from "./cx";

/**
 * The Kazhal date picker: a Persian (Jalali) calendar, in Persian, RTL, with
 * Persian digits — whose VALUE is always a Gregorian `YYYY-MM-DD` day.
 *
 * ============================================================================
 * THE ONE RULE
 * ============================================================================
 * Everything that enters or leaves this component is a Gregorian ISO day
 * (`value`, `defaultValue`, `onChange`, and the hidden `name` field that a
 * plain `<form>` submits). The Persian calendar exists only on screen. The
 * conversion is done by `date/persian-date.ts` and nowhere else.
 *
 * `name` is deliberately NOT forwarded to React Aria's `DatePicker`: its own
 * hidden input would serialise the Persian value (`1405-07-05`), which is
 * exactly what must never be submitted. The hidden input below carries the
 * Gregorian day instead.
 *
 * Built on `react-aria-components`, which provides the keyboard model (arrow
 * keys, Page Up/Down for months, Shift+Page Up/Down for years, Home/End), the
 * screen-reader wiring, touch handling, Escape-to-close and focus restoration.
 * ============================================================================
 */
export interface PersianDatePickerProps {
  /** Visible label. Also names the calendar button, the clear button and the dialog. */
  label: string;
  /** Helper text shown under the field when there is no error. */
  hint?: ReactNode;
  /** Error text. Presence switches the field into its invalid state. */
  error?: string | null;
  /** Mark invalid without a message of its own (e.g. the other end of a range carries it). */
  isInvalid?: boolean;
  /** Name of the hidden form field that submits the Gregorian `YYYY-MM-DD`. */
  name?: string;
  /** Controlled Gregorian `YYYY-MM-DD`, or `null` for empty. */
  value?: string | null;
  /** Uncontrolled initial Gregorian `YYYY-MM-DD`. Invalid values start empty. */
  defaultValue?: string | null;
  /** Called with the Gregorian `YYYY-MM-DD`, or `null` when cleared. */
  onChange?: (value: string | null) => void;
  isRequired?: boolean;
  isDisabled?: boolean;
  /** Earliest selectable Gregorian day. */
  minValue?: string;
  /** Latest selectable Gregorian day. */
  maxValue?: string;
  id?: string;
  containerClassName?: string;
}

export function PersianDatePicker({
  label,
  hint,
  error,
  isInvalid = false,
  name,
  value,
  defaultValue,
  onChange,
  isRequired = false,
  isDisabled = false,
  minValue,
  maxValue,
  id,
  containerClassName,
}: PersianDatePickerProps): JSX.Element {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const labelId = `${baseId}-label`;
  const clearId = `${baseId}-clear`;
  const triggerId = `${baseId}-trigger`;

  const [uncontrolled, setUncontrolled] = useState<string | null>(() =>
    isIsoDay(defaultValue) ? defaultValue : null,
  );
  const isControlled = value !== undefined;
  const iso = isControlled ? (isIsoDay(value) ? value : null) : uncontrolled;

  function commit(next: string | null) {
    if (!isControlled) setUncontrolled(next);
    onChange?.(next);
  }

  const hasError = Boolean(error);
  const invalid = hasError || isInvalid;

  return (
    <I18nProvider locale={PERSIAN_LOCALE}>
      <DatePicker
        value={isoDayToPersian(iso)}
        onChange={(next: DateValue | null) => commit(persianToIsoDay(next))}
        minValue={isoDayToPersian(minValue) ?? undefined}
        maxValue={isoDayToPersian(maxValue) ?? undefined}
        isRequired={isRequired}
        isDisabled={isDisabled}
        isInvalid={invalid}
        validationBehavior="aria"
        granularity="day"
        shouldForceLeadingZeros
        className={cx("flex min-w-0 flex-col gap-1.5", containerClassName)}
        data-kz-date-picker=""
      >
        <Label id={labelId} className="text-sm font-medium text-ink">
          {label}
          {isRequired ? (
            <span className="text-danger ms-1" aria-hidden="true">
              *
            </span>
          ) : null}
        </Label>

        <Group
          className={cx(
            "flex h-11 w-full min-w-0 items-center rounded-md border bg-surface text-base text-ink",
            "transition-[border-color,box-shadow] duration-150 ease-kz",
            "data-[focus-within]:outline-2 data-[focus-within]:outline-offset-1 data-[focus-within]:outline-[color:var(--kz-focus)]",
            "data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-muted data-[disabled]:text-ink-subtle",
            invalid ? "border-danger" : "border-line-strong hover:border-ink-subtle",
          )}
        >
          <LatinDigitBridge>
          <DateInput className="flex min-w-0 flex-1 items-center overflow-hidden ps-3 tabular-nums">
            {(segment) => (
              <DateSegment
                segment={segment}
                className={cx(
                  "rounded-sm px-0.5 outline-none",
                  "data-[placeholder]:text-ink-subtle",
                  "data-[type=literal]:px-0 data-[type=literal]:text-ink-subtle",
                  "data-[focused]:bg-primary data-[focused]:text-primary-ink",
                )}
              />
            )}
          </DateInput>
          </LatinDigitBridge>

          {iso !== null && !isRequired && !isDisabled ? (
            <Button
              slot={null}
              id={clearId}
              aria-label="پاک‌کردن"
              aria-labelledby={`${clearId} ${labelId}`}
              onPress={() => commit(null)}
              className={iconButtonClass}
            >
              <CloseIcon />
            </Button>
          ) : null}

          <Button
            id={triggerId}
            aria-label="انتخاب از تقویم"
            className={cx(iconButtonClass, "me-1")}
          >
            <CalendarIcon />
          </Button>
        </Group>

        {hasError ? (
          <Text slot="errorMessage" className="text-sm text-danger" role="alert">
            {error}
          </Text>
        ) : hint ? (
          <Text slot="description" className="text-sm text-ink-muted">
            {hint}
          </Text>
        ) : null}

        <Popover
          placement="bottom end"
          offset={6}
          className={cx(
            "max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border border-line bg-surface p-3 text-ink shadow-lg",
            "outline-none",
          )}
        >
          <Dialog aria-label={`تقویم ${label}`} className="outline-none" dir="rtl">
            <Calendar className="w-fit">
              <header className="mb-2 flex items-center gap-1">
                <YearButton delta={-1} label="سال قبل" />
                <Button slot="previous" aria-label="ماه قبل" className={navButtonClass}>
                  <ChevronIcon direction="start" />
                </Button>
                <Heading className="min-w-0 flex-1 text-center text-sm font-semibold text-ink" />
                <Button slot="next" aria-label="ماه بعد" className={navButtonClass}>
                  <ChevronIcon direction="end" />
                </Button>
                <YearButton delta={1} label="سال بعد" />
              </header>
              <CalendarGrid weekdayStyle="narrow" className="border-separate border-spacing-0.5">
                <CalendarGridHeader>
                  {(day) => (
                    <CalendarHeaderCell className="pb-1 text-xs font-medium text-ink-muted">{day}</CalendarHeaderCell>
                  )}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => (
                    <CalendarCell
                      date={date}
                      className={cx(
                        "flex size-9 cursor-pointer items-center justify-center rounded-md text-sm tabular-nums text-ink outline-none",
                        "data-[hovered]:bg-primary-soft",
                        "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-[color:var(--kz-focus)]",
                        "data-[today]:font-bold data-[today]:underline data-[today]:underline-offset-4",
                        "data-[selected]:bg-primary data-[selected]:text-primary-ink",
                        "data-[outside-month]:invisible",
                        "data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-subtle data-[disabled]:opacity-50",
                        "data-[unavailable]:cursor-not-allowed data-[unavailable]:text-ink-subtle data-[unavailable]:line-through",
                      )}
                    />
                  )}
                </CalendarGridBody>
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </DatePicker>

      {name ? <input type="hidden" name={name} value={iso ?? ""} data-kz-iso-day="" /> : null}
    </I18nProvider>
  );
}

export interface PersianDateRangeFieldsProps {
  fromLabel: string;
  toLabel: string;
  /** Hidden field names. Default `from` and `to`, the query-string contract. */
  fromName?: string;
  toName?: string;
  /** Initial Gregorian `YYYY-MM-DD` days, usually straight from the URL. */
  defaultFrom?: string | null;
  defaultTo?: string | null;
  fromHint?: ReactNode;
  toHint?: ReactNode;
  /** Called with the Gregorian range whenever either end changes. */
  onChange?: (range: { from: string | null; to: string | null }) => void;
  containerClassName?: string;
}

/**
 * An optional, inclusive `from`–`to` day range: two pickers and one rule.
 *
 * Renders the two fields as siblings (a fragment), so each takes its own cell
 * in a filter grid. A reversed range marks both fields invalid and shows the
 * Persian message under `to`; it is never swapped. Submit handlers read the
 * values with `readDayRange` and must refuse when it reports an error.
 *
 * To follow the URL (Back/Forward, reload, "clear filters"), key the component
 * by the current range so it remounts with the new defaults.
 */
export function PersianDateRangeFields({
  fromLabel,
  toLabel,
  fromName = "from",
  toName = "to",
  defaultFrom,
  defaultTo,
  fromHint,
  toHint,
  onChange,
  containerClassName,
}: PersianDateRangeFieldsProps): JSX.Element {
  const [from, setFrom] = useState<string | null>(() => (isIsoDay(defaultFrom) ? defaultFrom : null));
  const [to, setTo] = useState<string | null>(() => (isIsoDay(defaultTo) ? defaultTo : null));
  const error = validateDayRange({ from: from ?? undefined, to: to ?? undefined });

  return (
    <>
      <PersianDatePicker
        name={fromName}
        label={fromLabel}
        hint={fromHint}
        value={from}
        isInvalid={error !== null}
        onChange={(next) => {
          setFrom(next);
          onChange?.({ from: next, to });
        }}
        containerClassName={containerClassName}
      />
      <PersianDatePicker
        name={toName}
        label={toLabel}
        hint={toHint}
        value={to}
        error={error}
        onChange={(next) => {
          setTo(next);
          onChange?.({ from, to: next });
        }}
        containerClassName={containerClassName}
      />
    </>
  );
}

const NON_PERSIAN_DIGIT = /[0-9\u0660-\u0669]/;

function toPersianDigitText(text: string): string {
  return text
    .replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)))
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x06f0));
}

/**
 * Lets people type Latin (`1405`) or Arabic-Indic (`١٤٠٥`) digits into the
 * Persian-digit segments.
 *
 * React Aria parses a typed segment with the locale's own numbering system, so
 * under `fa-IR` it accepts only Persian digits and silently drops `1`. Many
 * keyboards type Latin digits even in a Persian layout. A capture-phase
 * `beforeinput` listener on the wrapper sees the keystroke first, cancels it,
 * and re-dispatches the same input with the digits rewritten, so React Aria's
 * own parsing, auto-advance and validation stay in charge. Only digits are
 * touched; the calendar is never computed here.
 */
function LatinDigitBridge({ children }: { children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onBeforeInput = (event: Event) => {
      const input = event as InputEvent;
      if (typeof input.data !== "string" || !NON_PERSIAN_DIGIT.test(input.data)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      input.target?.dispatchEvent(
        new InputEvent("beforeinput", {
          data: toPersianDigitText(input.data),
          inputType: input.inputType,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    };
    element.addEventListener("beforeinput", onBeforeInput, true);
    return () => element.removeEventListener("beforeinput", onBeforeInput, true);
  }, []);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}

/** Move the visible month by whole years, keeping the focused day. */
function YearButton({ delta, label }: { delta: 1 | -1; label: string }): JSX.Element {
  const state = useContext(CalendarStateContext);
  return (
    <Button
      slot={null}
      aria-label={label}
      onPress={() => state?.setFocusedDate(state.focusedDate.add({ years: delta }))}
      className={navButtonClass}
    >
      <ChevronIcon direction={delta < 0 ? "start" : "end"} double />
    </Button>
  );
}

const iconButtonClass = cx(
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-muted outline-none",
  "data-[hovered]:bg-surface-muted data-[hovered]:text-ink",
  "data-[pressed]:bg-surface-sunken",
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-[color:var(--kz-focus)]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
);

const navButtonClass = cx(iconButtonClass, "size-8");

/**
 * Chevron that points toward the logical START (previous) or END (next) of an
 * RTL page: "start" is on the right, so it points right.
 */
function ChevronIcon({ direction, double = false }: { direction: "start" | "end"; double?: boolean }): JSX.Element {
  const path = direction === "start" ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6";
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
      {double ? (
        <path
          d={direction === "start" ? "M4 6l6 6-6 6" : "M20 6l-6 6 6 6"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function CalendarIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}
