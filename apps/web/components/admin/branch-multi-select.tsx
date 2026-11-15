"use client";

import { useMemo, useState } from "react";

import type { ProductVisibility } from "@kazhal/api-client";
import { Badge, EmptyState, ErrorState, Input, Skeleton, cx, formatInteger } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { AccountStatusBadge } from "@/components/admin/people-shared";
import { StoreIcon } from "@/components/icons";
import { fetchBranches } from "@/lib/admin-api";

/** One branch as `ProductVisibility` reports it: id, name and its LIVENESS. */
export type KnownBranch = ProductVisibility["branches"][number];

/**
 * The branch list is paged server-side and capped at 100 rows per page
 * (`PaginationDto` has `@Max(100)`), so one page is fetched and the text box
 * filters it in the browser. A shop with more than a hundred branches is told
 * so rather than shown a silently shortened list.
 */
const PAGE_LIMIT = 100;

export interface BranchMultiSelectProps {
  /** The chosen branch ids. This component never mutates; it emits the next set. */
  selected: number[];
  onChange: (ids: number[]) => void;
  /**
   * The branches the SERVER already attached to this product, with the
   * `isActive` flag it resolved. They are merged into the fetched list so a
   * selection stays visible even when the branch has since been deactivated —
   * or sits past the first page.
   */
  knownBranches?: KnownBranch[];
  /** Blocks every checkbox, e.g. while the form is saving. */
  disabled?: boolean;
  /** Field-level message, rendered under the list. */
  error?: string;
}

interface Row {
  id: number;
  name: string;
  isActive: boolean;
}

/**
 * A searchable branch picker.
 *
 * ## Why an inactive branch is not selectable
 *
 * A deactivated branch has no till taking sales, so adding one to a product's
 * «شعب منتخب» writes a row that can never put the product in front of a
 * customer. The API refuses it (`BRANCHES_UNUSABLE`), and a control that lets
 * an operator tick a box only to have the save rejected is a worse teacher
 * than a box that explains itself before the click.
 *
 * The converse is NOT symmetrical: a branch that is ALREADY selected and has
 * since been deactivated stays listed and stays de-selectable. Hiding it would
 * silently shorten the selection the operator made, and disabling it would
 * trap the product in a configuration nobody can undo from this screen.
 *
 * ## Why real checkboxes
 *
 * `<label>` + `<input type="checkbox">` gets Tab, Space, the screen reader's
 * checked/unchecked announcement and the browser's own grouping for free. A
 * hand-rolled listbox re-implements all of that, usually incompletely.
 */
export function BranchMultiSelect({
  selected,
  onChange,
  knownBranches = [],
  disabled = false,
  error,
}: BranchMultiSelectProps) {
  const api = useApi();
  const [filter, setFilter] = useState("");

  const {
    data,
    error: loadError,
    isLoading,
    refetch,
  } = useApiQuery(
    (signal) => fetchBranches(api, { page: 1, limit: PAGE_LIMIT }, { signal }),
    [api],
  );

  /**
   * The fetched page, plus any selected branch it does not contain.
   *
   * The second half is what keeps a selection honest: a branch beyond the
   * first page, or one deactivated after it was chosen, is still the
   * operator's choice and must remain visible and removable.
   */
  const rows = useMemo<Row[]>(() => {
    const fetched: Row[] = (data?.data ?? []).map((branch) => ({
      id: branch.id,
      name: branch.name,
      isActive: branch.isActive,
    }));
    const seen = new Set(fetched.map((row) => row.id));
    const missing: Row[] = knownBranches
      .filter((branch) => !seen.has(branch.id))
      .map((branch) => ({ id: branch.id, name: branch.name, isActive: branch.isActive }));
    return [...fetched, ...missing];
  }, [data, knownBranches]);

  const needle = filter.trim();
  const visible = needle === "" ? rows : rows.filter((row) => row.name.includes(needle));
  const overflowed = data !== undefined && data.total > data.data.length;

  function toggle(id: number, checked: boolean) {
    onChange(checked ? [...selected, id] : selected.filter((value) => value !== id));
  }

  if (loadError) {
    return (
      <ErrorState
        error={loadError}
        title="فهرست شعبه‌ها خوانده نشد"
        description="بدون فهرست شعبه‌ها نمی‌توان «شعب منتخب» را تعیین کرد."
        onRetry={refetch}
      />
    );
  }

  if (isLoading || !data) {
    return (
      <div role="status" aria-busy="true" className="space-y-2">
        <span className="kz-sr-only">در حال بارگذاری شعبه‌ها</span>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} shape="block" height="3rem" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<StoreIcon className="size-8" />}
        title="هیچ شعبه‌ای ثبت نشده است"
        description="تا وقتی شعبه‌ای ساخته نشده، «شعب منتخب» معنایی ندارد. می‌توانید «همه شعب» را انتخاب کنید تا هر شعبهٔ آینده هم این کالا را عرضه کند."
      />
    );
  }

  return (
    <div>
      <Input
        type="search"
        label="جست‌وجوی شعبه"
        hint="فهرست همین پایین فیلتر می‌شود؛ انتخاب‌های قبلی با فیلتر پاک نمی‌شوند."
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        maxLength={200}
        containerClassName="min-w-0"
      />

      <p className="mt-2 text-2xs text-ink-subtle">
        <bdi data-numeric="">{formatInteger(selected.length)}</bdi> شعبه انتخاب شده از{" "}
        <bdi data-numeric="">{formatInteger(rows.length)}</bdi> شعبه
      </p>

      {visible.length === 0 ? (
        <p className="mt-3 text-sm text-ink-subtle">شعبه‌ای با این نام پیدا نشد.</p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto pe-1">
          {visible.map((row) => {
            const checked = selected.includes(row.id);
            // An inactive branch is selectable ONLY to be UN-selected.
            const blocked = !row.isActive && !checked;
            return (
              <li key={row.id}>
                <label
                  className={cx(
                    "flex items-start gap-2.5 rounded-md border p-3 transition-colors duration-150 ease-kz",
                    "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]",
                    checked ? "border-primary/50 bg-primary-soft/40" : "border-line bg-surface",
                    blocked || disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || blocked}
                    onChange={(event) => toggle(row.id, event.target.checked)}
                    className={cx(
                      "mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                      {row.name}
                      <AccountStatusBadge isActive={row.isActive} />
                      {checked && !row.isActive ? (
                        <Badge size="sm" tone="warning">
                          انتخاب‌شده
                        </Badge>
                      ) : null}
                    </span>
                    {blocked ? (
                      <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                        این شعبه غیرفعال است و نمی‌توان آن را به محل عرضه افزود؛ ابتدا شعبه را
                        فعال کنید.
                      </span>
                    ) : null}
                    {checked && !row.isActive ? (
                      <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                        این شعبه بعد از انتخاب غیرفعال شده است. تا وقتی فعال نشود کالا در آن عرضه
                        نمی‌شود، ولی می‌توانید همین‌جا از فهرست برداریدش.
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {overflowed ? (
        <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
          فقط <bdi data-numeric="">{formatInteger(data.data.length)}</bdi> شعبه از{" "}
          <bdi data-numeric="">{formatInteger(data.total)}</bdi> شعبه در این فهرست بارگذاری شده
          است. برای شعبه‌های بعدی، نام دقیق‌تری را در صفحهٔ شعبه‌ها بررسی کنید.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
