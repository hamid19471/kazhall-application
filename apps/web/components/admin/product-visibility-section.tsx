"use client";

import { useId } from "react";

import type { BranchVisibilityMode, ProductVisibility } from "@kazhal/api-client";
import { Badge, Button, cx, formatInteger } from "@kazhal/ui";

import { Notice } from "@/components/common";
import { BranchMultiSelect } from "@/components/admin/branch-multi-select";

/**
 * The three fields the API takes, carried together because they are only ever
 * meaningful together: `branchIds` is REQUIRED when `branchVisibility` is
 * `"selected"` and REFUSED otherwise, so a form that owned them separately
 * could produce a combination the server has to reject.
 */
export interface ProductVisibilityValue {
  visibleOnSite: boolean;
  branchVisibility: BranchVisibilityMode;
  branchIds: number[];
}

/** What `POST /products` stores when a caller sends none of the three. */
export const HIDDEN_DRAFT_VISIBILITY: ProductVisibilityValue = {
  visibleOnSite: false,
  branchVisibility: "none",
  branchIds: [],
};

export const BRANCH_MODE_LABEL: Record<BranchVisibilityMode, string> = {
  none: "هیچ شعبه‌ای",
  all: "همه شعب",
  selected: "شعب منتخب",
};

const BRANCH_MODE_HINT: Record<BranchVisibilityMode, string> = {
  none: "هیچ صندوقی این کالا را نمی‌فروشد.",
  all: "همهٔ شعبه‌های فعال — و هر شعبه‌ای که بعداً ساخته شود.",
  selected: "فقط شعبه‌هایی که پایین انتخاب می‌کنید.",
};

const BRANCH_MODES: readonly BranchVisibilityMode[] = ["none", "all", "selected"];

/** The one shape the server and this form both call «موجودی سراسری». */
const GLOBAL_STOCK_NOTICE =
  "موجودی کالا سراسری است و به تفکیک شعبه نگهداری نمی‌شود. انتخاب شعبه فقط تعیین می‌کند کالا کجا قابل عرضه باشد؛ همهٔ شعب از یک موجودی واحد می‌فروشند.";

/** `AdminProduct.visibility` → the editable triple this section owns. */
export function visibilityValueOf(visibility: ProductVisibility): ProductVisibilityValue {
  return {
    visibleOnSite: visibility.visibleOnSite,
    branchVisibility: visibility.branchVisibility,
    branchIds: visibility.branches.map((branch) => branch.id),
  };
}

/**
 * The ONE client-side rule, returned as a message rather than a boolean so the
 * caller can both block the submit and show the same sentence.
 *
 * Everything else about visibility — whether a branch is usable, whether the
 * caller may change any of it at all — is the server's decision, re-checked on
 * every request and reported as a field error.
 */
export function visibilityProblem(value: ProductVisibilityValue): string | undefined {
  if (value.branchVisibility === "selected" && value.branchIds.length === 0) {
    return "برای «شعب منتخب» دست‌کم یک شعبه انتخاب کنید، یا حالت «هیچ شعبه‌ای» را بگذارید.";
  }
  return undefined;
}

export interface ProductVisibilitySectionProps {
  value: ProductVisibilityValue;
  /**
   * The branches the server already resolved for this product, with their
   * liveness. Empty on a create form — there is nothing stored yet.
   */
  knownBranches: ProductVisibility["branches"];
  onChange: (next: ProductVisibilityValue) => void;
  /** In-flight save. Blocks the controls without changing who may see them. */
  disabled?: boolean;
  /**
   * `super_admin`, decided by the parent from the session.
   *
   * False does NOT render disabled controls. See the argument in
   * `product-shared.tsx` about `readOnly`: a grid of greyed-out toggles is
   * harder to read than text, still draws a click, and tells the viewer
   * nothing. A viewer gets the ANSWER — where this product is offered — as
   * plain text, and a sentence naming who can change it.
   */
  canEdit: boolean;
  /** A server field error for `visibleOnSite`/`branchVisibility`/`branchIds`. */
  fieldError?: string;
}

/**
 * «محل عرضه محصول» — the retail channels a product is offered on.
 *
 * ⚠ THIS IS VISIBILITY, NOT INVENTORY, and the notice below says so on every
 * render rather than in a tooltip: the single most likely misreading of a
 * branch checklist is "this branch has its own stock of this product", which is
 * false in this system — `stock`, basket reservations and order allocations are
 * all global, and every listed branch sells out of the same quantity.
 */
export function ProductVisibilitySection({
  value,
  knownBranches,
  onChange,
  disabled = false,
  canEdit,
  fieldError,
}: ProductVisibilitySectionProps) {
  const groupName = useId();
  const problem = canEdit ? visibilityProblem(value) : undefined;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg text-ink">محل عرضه محصول</h2>
        {canEdit ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ ...value, visibleOnSite: true, branchVisibility: "all" })}
          >
            همه کانال‌ها
          </Button>
        ) : null}
      </div>

      <Notice tone="info" className="mt-3">
        <p className="text-xs leading-relaxed">{GLOBAL_STOCK_NOTICE}</p>
      </Notice>

      {canEdit ? (
        <div className="mt-4 space-y-4">
          <label
            className={cx(
              "flex items-start gap-2.5 rounded-md border p-3 transition-colors duration-150 ease-kz",
              "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]",
              value.visibleOnSite ? "border-primary/50 bg-primary-soft/40" : "border-line bg-surface",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
          >
            <input
              type="checkbox"
              checked={value.visibleOnSite}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, visibleOnSite: event.target.checked })}
              className={cx(
                "mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-ink">نمایش در وب‌سایت</span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                تا وقتی این گزینه خاموش است، کالا در فروشگاه اینترنتی دیده نمی‌شود.
              </span>
            </span>
          </label>

          <fieldset>
            <legend className="text-sm font-bold text-ink">نمایش در شعب</legend>
            <ul className="mt-2 space-y-2">
              {BRANCH_MODES.map((mode) => {
                const active = value.branchVisibility === mode;
                return (
                  <li key={mode}>
                    <label
                      className={cx(
                        "flex items-start gap-2.5 rounded-md border p-3 transition-colors duration-150 ease-kz",
                        "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--kz-focus)]",
                        active ? "border-primary/50 bg-primary-soft/40" : "border-line bg-surface",
                        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                      )}
                    >
                      <input
                        type="radio"
                        name={groupName}
                        value={mode}
                        checked={active}
                        disabled={disabled}
                        onChange={() => onChange({ ...value, branchVisibility: mode })}
                        className={cx(
                          "mt-0.5 size-4 shrink-0 accent-[color:var(--kz-primary)]",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--kz-focus)]",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-ink">
                          {BRANCH_MODE_LABEL[mode]}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                          {BRANCH_MODE_HINT[mode]}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          {/*
            RENDERED ONLY IN `selected`. The API refuses `branchIds` in the other
            two modes, so leaving the list on screen would invite an operator to
            curate a set that is thrown away — or rejected — on save.
          */}
          {value.branchVisibility === "selected" ? (
            <BranchMultiSelect
              selected={value.branchIds}
              onChange={(branchIds) => onChange({ ...value, branchIds })}
              knownBranches={knownBranches}
              disabled={disabled}
              {...(problem ? { error: problem } : {})}
            />
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <VisibilityFacts value={value} knownBranches={knownBranches} />
          <p className="text-xs leading-relaxed text-ink-subtle">
            تغییر محل عرضهٔ کالا فقط از دست مدیر ارشد (<bdi dir="ltr">super_admin</bdi>) برمی‌آید؛
            به همین دلیل این بخش برای شما فقط خوانده می‌شود.
          </p>
        </div>
      )}

      {fieldError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {fieldError}
        </p>
      ) : null}
    </section>
  );
}

/** The stored configuration as text — the read-only twin of the controls. */
function VisibilityFacts({
  value,
  knownBranches,
}: {
  value: ProductVisibilityValue;
  knownBranches: ProductVisibility["branches"];
}) {
  const hiddenEverywhere = !value.visibleOnSite && value.branchVisibility === "none";

  if (hiddenEverywhere) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <Badge size="sm" tone="neutral">
          پیش‌نویس
        </Badge>
        <span className="text-ink-muted">این کالا نه در سایت و نه در هیچ شعبه‌ای عرضه نمی‌شود.</span>
      </p>
    );
  }

  const names = knownBranches.map((branch) => branch.name);

  return (
    <dl className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <dt className="font-semibold text-ink-muted">نمایش در وب‌سایت:</dt>
        <dd>
          <Badge size="sm" tone={value.visibleOnSite ? "success" : "neutral"}>
            {value.visibleOnSite ? "بله" : "خیر"}
          </Badge>
        </dd>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <dt className="font-semibold text-ink-muted">نمایش در شعب:</dt>
        <dd className="text-ink">{BRANCH_MODE_LABEL[value.branchVisibility]}</dd>
      </div>
      {value.branchVisibility === "selected" ? (
        <div className="flex flex-wrap items-start gap-2">
          <dt className="font-semibold text-ink-muted">
            شعبه‌های انتخاب‌شده (<bdi data-numeric="">{formatInteger(names.length)}</bdi>):
          </dt>
          <dd className="min-w-0 text-ink">
            {names.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {knownBranches.map((branch) => (
                  <li key={branch.id}>
                    <Badge size="sm" tone={branch.isActive ? "neutral" : "warning"}>
                      {branch.name}
                      {branch.isActive ? "" : " (غیرفعال)"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-ink-subtle">هیچ شعبه‌ای انتخاب نشده است.</span>
            )}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
