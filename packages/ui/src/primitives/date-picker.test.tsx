import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { REVERSED_RANGE_MESSAGE, readDayRange } from "../date/persian-date";
import { PersianDatePicker, PersianDateRangeFields } from "./date-picker";

/** The Gregorian value the form would submit. */
function hidden(name: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  if (!input) throw new Error(`no hidden field ${name}`);
  return input;
}

function trigger(label: string): HTMLElement {
  return screen.getByRole("button", { name: `انتخاب از تقویم ${label}` });
}

async function openCalendar(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(trigger(label));
  return screen.findByRole("dialog", { name: `تقویم ${label}` });
}

function Rtl({ children }: { children: React.ReactNode }) {
  return <div dir="rtl" lang="fa">{children}</div>;
}

describe("PersianDatePicker — display", () => {
  it("shows a Gregorian ISO value as the Persian day, in Persian digits", () => {
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    const group = screen.getByRole("group", { name: "از تاریخ" });
    const text = group.textContent ?? "";
    expect(text).toContain("۱۴۰۵");
    expect(text).toContain("۰۷");
    expect(text).toContain("۰۵");
    expect(text).not.toMatch(/[0-9]/);
    expect(hidden("from").value).toBe("2026-09-27");
  });

  it("has a visible label and names the calendar button after it", () => {
    render(<PersianDatePicker label="تا تاریخ" name="to" />, { wrapper: Rtl });
    expect(screen.getByText("تا تاریخ")).toBeTruthy();
    expect(trigger("تا تاریخ")).toBeTruthy();
  });

  it("starts empty for an invalid value and submits nothing", () => {
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="1405-13-40" />, { wrapper: Rtl });
    expect(hidden("from").value).toBe("");
  });
});

describe("PersianDatePicker — calendar dialog", () => {
  it("opens a named dialog with a Persian month heading and Persian weekday names", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    const dialog = await openCalendar(user, "از تاریخ");

    const title = within(dialog).getByRole("heading").textContent ?? "";
    expect(title).toContain("مهر");
    expect(title).toContain("۱۴۰۵");
    // The weekday row is hidden from assistive tech (each day cell carries its full
    // name), so it is read from the DOM.
    const headers = Array.from(dialog.querySelectorAll("thead th")).map((cell) => cell.textContent ?? "");
    expect(headers).toHaveLength(7);
    // Week starts on Saturday in fa-IR.
    expect(headers[0]).toMatch(/^ش/);
    expect(headers.join("")).not.toMatch(/[A-Za-z]/);
    expect(within(dialog).getByRole("grid")).toBeTruthy();
  });

  it("selects a Persian day with the keyboard and submits its Gregorian day", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    await openCalendar(user, "از تاریخ");

    // Focus starts on the selected day; in RTL the left arrow moves to the NEXT day.
    expect(document.activeElement?.textContent).toBe("۵");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("۶");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("۱۳");
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hidden("from").value).toBe("2026-10-05");
    expect(hidden("from").value).not.toMatch(/^14/);
  });

  it("selects a day by pointer and closes", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    const dialog = await openCalendar(user, "از تاریخ");
    await user.click(within(dialog).getByRole("button", { name: /مهر ۱, چهارشنبه/ }));
    expect(hidden("from").value).toBe("2026-09-23");
  });

  it("navigates months and years from the keyboard and the header buttons", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    const dialog = await openCalendar(user, "از تاریخ");
    // ICU writes the month heading year-first ("۱۴۰۵ مهر"); compare without word order.
    const heading = () => (within(dialog).getByRole("heading").textContent ?? "").split(" ").sort().join(" ");
    const month = (text: string) => text.split(" ").sort().join(" ");

    await user.keyboard("{PageDown}");
    expect(heading()).toBe(month("آبان ۱۴۰۵"));
    await user.keyboard("{Shift>}{PageDown}{/Shift}");
    expect(heading()).toBe(month("آبان ۱۴۰۶"));

    await user.click(within(dialog).getByRole("button", { name: "ماه قبل" }));
    expect(heading()).toBe(month("مهر ۱۴۰۶"));
    await user.click(within(dialog).getByRole("button", { name: "سال قبل" }));
    expect(heading()).toBe(month("مهر ۱۴۰۵"));
    await user.click(within(dialog).getByRole("button", { name: "سال بعد" }));
    expect(heading()).toBe(month("مهر ۱۴۰۶"));
    await user.click(within(dialog).getByRole("button", { name: "ماه بعد" }));
    expect(heading()).toBe(month("آبان ۱۴۰۶"));
  });

  it("closes on Escape without changing the value and returns focus to the calendar button", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    await openCalendar(user, "از تاریخ");
    await user.keyboard("{ArrowLeft}{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hidden("from").value).toBe("2026-09-27");
    await waitFor(() => expect(document.activeElement).toBe(trigger("از تاریخ")));
  });

  it("returns focus to the calendar button after a selection", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    await openCalendar(user, "از تاریخ");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger("از تاریخ")));
  });
});

describe("PersianDatePicker — clearing, required and typing", () => {
  it("clears an optional value with a named button", async () => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" defaultValue="2026-09-27" />, { wrapper: Rtl });
    await user.click(screen.getByRole("button", { name: "پاک‌کردن از تاریخ" }));
    expect(hidden("from").value).toBe("");
    expect(screen.queryByRole("button", { name: "پاک‌کردن از تاریخ" })).toBeNull();
  });

  it("marks a required field and offers no clear button", () => {
    render(<PersianDatePicker label="تاریخ تحویل" name="day" defaultValue="2026-09-27" isRequired />, { wrapper: Rtl });
    expect(screen.queryByRole("button", { name: /پاک‌کردن/ })).toBeNull();
    for (const segment of screen.getAllByRole("spinbutton")) {
      expect(segment.getAttribute("aria-required")).toBe("true");
    }
  });

  it("leaves an optional field not required", () => {
    render(<PersianDatePicker label="از تاریخ" name="from" />, { wrapper: Rtl });
    for (const segment of screen.getAllByRole("spinbutton")) {
      expect(segment.getAttribute("aria-required")).not.toBe("true");
    }
  });

  it.each([
    ["Persian digits", "۱۴۰۵", "۰۷", "۰۵"],
    ["Latin digits", "1405", "07", "05"],
    ["Arabic-Indic digits", "١٤٠٥", "٠٧", "٠٥"],
  ])("accepts a typed Persian date in %s", async (_name, year, month, day) => {
    const user = userEvent.setup();
    render(<PersianDatePicker label="از تاریخ" name="from" />, { wrapper: Rtl });
    const segments = screen.getAllByRole("spinbutton");
    const byType = (type: string) => segments.find((s) => s.getAttribute("data-type") === type)!;
    await user.click(byType("year"));
    await user.keyboard(year);
    await user.click(byType("month"));
    await user.keyboard(month);
    await user.click(byType("day"));
    await user.keyboard(day);
    expect(hidden("from").value).toBe("2026-09-27");
  });

  it("reports changes as Gregorian ISO days (controlled)", async () => {
    const seen: (string | null)[] = [];
    function Controlled() {
      const [value, setValue] = useState<string | null>("2026-09-27");
      return (
        <PersianDatePicker
          label="از تاریخ"
          value={value}
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Controlled />, { wrapper: Rtl });
    await openCalendar(user, "از تاریخ");
    await user.keyboard("{ArrowRight}{Enter}");
    await user.click(screen.getByRole("button", { name: "پاک‌کردن از تاریخ" }));
    expect(seen).toEqual(["2026-09-26", null]);
  });

  it("shows an error message and links it to the field", () => {
    render(<PersianDatePicker label="از تاریخ" name="from" error="تاریخ نادرست است." />, { wrapper: Rtl });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("تاریخ نادرست است.");
    const described = screen
      .getAllByRole("spinbutton")[0]!
      .getAttribute("aria-describedby")
      ?.split(" ");
    expect(described).toContain(alert.id);
  });
});

describe("PersianDateRangeFields", () => {
  function renderRange(from?: string, to?: string) {
    let submitted: ReturnType<typeof readDayRange> | null = null;
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted = readDayRange(new FormData(event.currentTarget));
        }}
      >
        <input type="hidden" name="channel" value="pos" />
        <PersianDateRangeFields fromLabel="از تاریخ" toLabel="تا تاریخ" defaultFrom={from} defaultTo={to} />
        <button type="submit">اعمال</button>
      </form>,
      { wrapper: Rtl },
    );
    return { submitted: () => submitted };
  }

  it("submits the Gregorian range under from/to, next to the other filters", async () => {
    const user = userEvent.setup();
    const { submitted } = renderRange("2026-09-27", "2026-09-27");
    await user.click(screen.getByRole("button", { name: "اعمال" }));
    expect(submitted()).toEqual({ from: "2026-09-27", to: "2026-09-27", error: null });
    expect(new FormData(document.querySelector("form")!).get("channel")).toBe("pos");
  });

  it("refuses a reversed range with a Persian message and does not swap it", async () => {
    const user = userEvent.setup();
    const { submitted } = renderRange("2026-09-28", "2026-09-27");
    expect(screen.getByRole("alert").textContent).toBe(REVERSED_RANGE_MESSAGE);
    for (const group of screen.getAllByRole("group")) {
      expect(group.getAttribute("data-invalid")).toBe("true");
    }
    await user.click(screen.getByRole("button", { name: "اعمال" }));
    expect(submitted()).toEqual({ from: "2026-09-28", to: "2026-09-27", error: REVERSED_RANGE_MESSAGE });
  });

  it("clears the message once the range is fixed", async () => {
    const user = userEvent.setup();
    renderRange("2026-09-28", "2026-09-27");
    await user.click(screen.getByRole("button", { name: "پاک‌کردن از تاریخ" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(hidden("from").value).toBe("");
    expect(hidden("to").value).toBe("2026-09-27");
  });

  it("restores from new defaults when remounted by key (Back/Forward, reload, clear filters)", () => {
    const { rerender } = render(
      <PersianDateRangeFields key="a" fromLabel="از تاریخ" toLabel="تا تاریخ" defaultFrom="2026-09-01" defaultTo="2026-09-27" />,
      { wrapper: Rtl },
    );
    expect(hidden("from").value).toBe("2026-09-01");
    act(() => {
      rerender(<PersianDateRangeFields key="b" fromLabel="از تاریخ" toLabel="تا تاریخ" />);
    });
    expect(hidden("from").value).toBe("");
    expect(hidden("to").value).toBe("");
  });
});
