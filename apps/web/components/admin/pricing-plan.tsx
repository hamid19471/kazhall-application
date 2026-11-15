"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { Badge, Button, ErrorState, Input, Money, Spinner, cx, formatRialString } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice, Pagination, QueryBoundary } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  DataTable,
  EmptyRow,
  FilterBar,
  RequireRole,
  Select,
  StatTile,
  Td,
  Th,
  Tr,
  count,
  useMutation,
  when,
} from "@/components/admin/ui";
import { pageInfoOf } from "@/components/admin/people-shared";
import { PRICING_ROLE_REASON, PricingPrinciples } from "@/components/admin/pricing-plans";
import {
  PRICING_ITEM_CHANNELS,
  PRICING_ITEM_DIRECTIONS,
  PRICING_ITEM_SORTS,
  PRICING_ITEM_STATUSES,
  addPricingCost,
  applyPricingPlan,
  approvePricingPlan,
  bulkPricingItems,
  calculatePricingPlan,
  deletePricingPlan,
  fetchBranches,
  fetchPricingChanges,
  fetchPricingItems,
  fetchPricingPlan,
  fetchPricingRollbackPreview,
  fetchPricingRuns,
  removePricingCost,
  reorderPricingCosts,
  rollbackPricingPlan,
  unapprovePricingPlan,
  updatePricingCost,
  updatePricingItem,
  updatePricingPlan,
  type PricingCostEntry,
  type PricingItem,
  type PricingItemFilters,
  type PricingItemQuery,
  type PricingPlan,
  type PricingRun,
  type PricingSummary,
} from "@/lib/admin-api";
import { mintAttemptKey, isKeyConflict } from "@/lib/attempt-key";
import { amountProblem, formatPercentString, parseRialInput } from "@/lib/costing";
import {
  pricingItemStatusLabel,
  pricingItemStatusTone,
  pricingPlanStatusLabel,
  pricingPlanStatusTone,
  pricingReasonLabel,
  pricingRunKindLabel,
  pricingRunPhaseLabel,
  pricingRunStatusLabel,
  pricingRunStatusTone,
  pricingStaleReasonLabel,
} from "@/lib/pricing-labels";
import { PERSIAN_MONTHS, parsePercentInput, persianDigits, planMonthLabel, shareExample } from "@/lib/pricing";
import { adminPricingPlanHref, adminPricingPlansHref } from "@/lib/routes";

export type PricingPreviewParams = PricingItemQuery & { page: number };

const PAGE_SIZE = 25;
const MAX_PLAN_RIAL = BigInt("1000000000000000");
const ACTIVE_RUN = new Set(["queued", "running"]);

/**
 * Like `QueryBoundary`, but the loaded content always sits in the SAME element,
 * busy or not. `QueryBoundary` switches between a fragment and a busy `<div>`,
 * which remounts everything below it on every refresh; this workspace polls
 * and refreshes constantly, and its open forms, typed amounts and row overrides
 * must survive that.
 */
function Stable<T>({
  query,
  label,
  children,
}: {
  query: { data: T | undefined; error: unknown; isLoading: boolean; refetch: () => void };
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.data === undefined) {
    if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" label={label} />
      </div>
    );
  }
  return <div aria-busy={query.isLoading || undefined}>{children(query.data)}</div>;
}

const STEPS: { key: string; label: string }[] = [
  { key: "costs", label: "هزینه‌های ماهانه" },
  { key: "inputs", label: "فروش هدف، مالیات، سود و گرد کردن" },
  { key: "calculate", label: "محاسبه و پیش‌نمایش" },
  { key: "review", label: "بررسی خلاصه و استثناها" },
  { key: "apply", label: "تأیید و اعمال قیمت‌ها" },
  { key: "history", label: "نتیجه، تاریخچه و بازگردانی" },
];

function currentStep(plan: PricingPlan): number {
  switch (plan.status) {
    case "DRAFT":
      return plan.costEntries.length === 0 ? 0 : plan.inputProblems.length > 0 ? 1 : 2;
    case "CALCULATING":
      return 2;
    case "READY_FOR_REVIEW":
      return 3;
    case "APPROVED":
    case "APPLYING":
      return 4;
    case "FAILED":
      return plan.approvedAt ? 4 : 2;
    default:
      return 5;
  }
}

export function PricingPlanWorkspace({ planId, preview }: { planId: number; preview: PricingPreviewParams }) {
  return (
    <RequireRole roles={["super_admin"]} reason={PRICING_ROLE_REASON}>
      <Workspace planId={planId} preview={preview} />
    </RequireRole>
  );
}

function Workspace({ planId, preview }: { planId: number; preview: PricingPreviewParams }) {
  const api = useApi();
  const plan = useApiQuery((signal) => fetchPricingPlan(api, planId, { signal }), [api, planId]);
  const [version, setVersion] = useState(0);
  // `plan` is a new object on every render; the effects below must not depend
  // on it, or they would re-run (and re-bump) on every render.
  const refetchPlan = useRef(plan.refetch);
  useEffect(() => {
    refetchPlan.current = plan.refetch;
  });
  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    refetchPlan.current();
  }, []);

  // Poll while a run is queued or running; refresh the preview once it ends.
  const running = Boolean(plan.data?.latestRun && ACTIVE_RUN.has(plan.data.latestRun.status));
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      const timer = setInterval(() => refetchPlan.current(), 1000);
      return () => clearInterval(timer);
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      setVersion((v) => v + 1);
    }
    return undefined;
  }, [running]);

  return (
    <Stable query={plan} label="در حال خواندن برنامه">
      {(data) => (
        <>
          <AdminPageHeader
            title={data.title}
            description={`برنامهٔ ${planMonthLabel(data.effectiveYear, data.effectiveMonth)} — روش «فروش ماهانهٔ هدف»، نسخهٔ فرمول ${persianDigits(data.formulaVersion)}. همهٔ مبالغ به ریال است.`}
            meta={
              <Badge tone={pricingPlanStatusTone(data.status)} size="sm">
                {pricingPlanStatusLabel(data.status)}
              </Badge>
            }
            actions={
              <Link href={adminPricingPlansHref()} className="text-sm">
                همهٔ برنامه‌ها ←
              </Link>
            }
          />
          <Stepper current={currentStep(data)} />
          <PricingPrinciples />
          {data.latestRun ? <RunPanel run={data.latestRun} /> : null}
          <CostsSection plan={data} onChanged={bump} />
          <InputsSection plan={data} onChanged={bump} />
          <CalculateSection plan={data} onChanged={bump} />
          {data.summary ? <SummarySection summary={data.summary} /> : null}
          {data.hasPreview ? (
            <PreviewSection plan={data} preview={preview} version={version} onChanged={bump} />
          ) : null}
          {data.hasPreview ? <ApproveApplySection plan={data} onChanged={bump} /> : null}
          <HistorySection plan={data} version={version} onChanged={bump} />
        </>
      )}
    </Stable>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mb-5 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="مراحل برنامه">
      {STEPS.map((step, index) => (
        <li
          key={step.key}
          aria-current={index === current ? "step" : undefined}
          className={cx(
            "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm",
            index === current
              ? "border-primary bg-primary-soft text-ink"
              : index < current
                ? "border-line text-ink-muted"
                : "border-line text-ink-subtle",
          )}
        >
          <span className="font-semibold" data-numeric="">
            {persianDigits(index + 1)}
          </span>
          <span className="min-w-0">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function RunPanel({ run }: { run: PricingRun }) {
  const active = ACTIVE_RUN.has(run.status);
  const percent = run.totalItems > 0 ? Math.round((run.processedItems / run.totalItems) * 100) : 0;
  return (
    <div
      className="mb-5 rounded-lg border border-line bg-surface p-4"
      role="status"
      aria-live="polite"
      aria-busy={active || undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{pricingRunKindLabel(run.kind)}</span>
        <Badge tone={pricingRunStatusTone(run.status)} size="sm">
          {pricingRunStatusLabel(run.status)}
        </Badge>
        {run.phase ? <span className="text-sm text-ink-muted">{pricingRunPhaseLabel(run.phase)}</span> : null}
        <span className="ms-auto text-sm text-ink-muted">{when(run.finishedAt ?? run.startedAt ?? run.queuedAt)}</span>
      </div>
      {active ? (
        <div className="mt-3">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="پیشرفت عملیات"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            <bdi data-numeric="">{count(run.processedItems)}</bdi> از <bdi data-numeric="">{count(run.totalItems)}</bdi>
          </p>
        </div>
      ) : null}
      {run.status === "failed" && run.errorMessage ? (
        <p className="mt-2 text-sm text-danger">{run.errorMessage}</p>
      ) : null}
      {run.status === "succeeded" && run.kind === "apply" ? (
        <p className="mt-2 text-sm text-ink-muted">
          قیمت <bdi data-numeric="">{count(Number(run.result?.changed ?? 0))}</bdi> گونه تغییر کرد. سفارش‌های گذشته تغییری نکردند.
        </p>
      ) : null}
      {run.status === "succeeded" && run.kind === "rollback" ? (
        <p className="mt-2 text-sm text-ink-muted">
          قیمت <bdi data-numeric="">{count(Number(run.result?.restored ?? 0))}</bdi> گونه به قبل برگشت؛{" "}
          <bdi data-numeric="">{count(Number(run.result?.conflictCount ?? 0))}</bdi> گونه که بعداً دوباره تغییر کرده بود دست‌نخورده ماند.
        </p>
      ) : null}
    </div>
  );
}

// ===========================================================================
// 1. Monthly costs
// ===========================================================================

function CostsSection({ plan, onChanged }: { plan: PricingPlan; onChanged: () => void }) {
  const api = useApi();
  const branches = useApiQuery((signal) => fetchBranches(api, { limit: 100 }, { signal }), [api]);
  const [error, setError] = useState<unknown>(undefined);
  const [editing, setEditing] = useState<number | "new" | null>(null);

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  function move(index: number, delta: -1 | 1) {
    const ids = plan.costEntries.map((entry) => entry.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void act(() => reorderPricingCosts(api, plan.id, ids));
  }

  const branchOptions = (branches.data?.data ?? []).map((branch) => ({ value: String(branch.id), label: branch.name }));

  return (
    <AdminSection
      title="۱. هزینه‌های ماهانه"
      description="هر هزینهٔ فعال در جمع ماهانه حساب می‌شود. هزینهٔ شعبه فقط برای شناسایی است؛ قیمت‌ها برای همهٔ کانال‌ها یکسان است."
      actions={
        plan.isEditable ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            افزودن هزینه
          </Button>
        ) : null
      }
    >
      {!plan.isEditable ? (
        <Notice tone="neutral" className="mb-3">
          این برنامه در وضعیت «{pricingPlanStatusLabel(plan.status)}» است و هزینه‌هایش قابل ویرایش نیست.
        </Notice>
      ) : null}
      {error ? <FormError error={error} /> : null}
      <DataTable minWidth="44rem" caption="هزینه‌های ماهانهٔ برنامه">
        <thead>
          <tr>
            <Th>عنوان</Th>
            <Th numeric>مبلغ ماهانه</Th>
            <Th>دامنه</Th>
            <Th>یادداشت</Th>
            <Th>وضعیت</Th>
            {plan.isEditable ? <Th>کارها</Th> : null}
          </tr>
        </thead>
        <tbody>
          {plan.costEntries.length === 0 ? (
            <EmptyRow colSpan={plan.isEditable ? 6 : 5}>هنوز هزینه‌ای ثبت نشده است.</EmptyRow>
          ) : (
            plan.costEntries.map((entry, index) => (
              <Tr key={entry.id} className={entry.isActive ? undefined : "text-ink-subtle"}>
                <Td>{entry.title}</Td>
                <Td numeric>
                  <Money value={entry.amountRial} withUnit={false} struck={!entry.isActive} />
                </Td>
                <Td>{entry.scope === "branch" ? `شعبهٔ ${entry.branchName ?? persianDigits(entry.branchId ?? 0)}` : "همهٔ فروشگاه‌ها"}</Td>
                <Td>{entry.note ?? "—"}</Td>
                <Td>
                  <Badge tone={entry.isActive ? "success" : "neutral"} size="sm">
                    {entry.isActive ? "فعال" : "غیرفعال"}
                  </Badge>
                </Td>
                {plan.isEditable ? (
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`بالا بردن ${entry.title}`}>
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => move(index, 1)}
                        disabled={index === plan.costEntries.length - 1}
                        aria-label={`پایین بردن ${entry.title}`}
                      >
                        ↓
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(entry.id)}>
                        ویرایش
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void act(() => updatePricingCost(api, plan.id, entry.id, { isActive: !entry.isActive }))}
                      >
                        {entry.isActive ? "غیرفعال" : "فعال"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void act(() => removePricingCost(api, plan.id, entry.id))}>
                        حذف
                      </Button>
                    </div>
                  </Td>
                ) : null}
              </Tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr>
            <Th>جمع هزینه‌های فعال</Th>
            <Th numeric>
              <Money value={plan.monthlyCostsTotalRial} withUnit={false} />
            </Th>
            <td colSpan={plan.isEditable ? 4 : 3} />
          </tr>
        </tfoot>
      </DataTable>
      {editing !== null && plan.isEditable ? (
        <CostForm
          key={String(editing)}
          entry={editing === "new" ? null : plan.costEntries.find((e) => e.id === editing) ?? null}
          branchOptions={branchOptions}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            if (editing === "new") await addPricingCost(api, plan.id, body);
            else await updatePricingCost(api, plan.id, editing, body);
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
    </AdminSection>
  );
}

function CostForm({
  entry,
  branchOptions,
  onCancel,
  onSave,
}: {
  entry: PricingCostEntry | null;
  branchOptions: { value: string; label: string }[];
  onCancel: () => void;
  onSave: (body: { title: string; amountRial: string; scope: "general" | "branch"; branchId: number | null; note: string | null }) => Promise<void>;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [amount, setAmount] = useState(entry?.amountRial ?? "");
  const [branch, setBranch] = useState(entry?.branchId ? String(entry.branchId) : "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [problems, setProblems] = useState<{ title?: string; amount?: string }>({});
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseRialInput(amount, { max: MAX_PLAN_RIAL });
    const next: { title?: string; amount?: string } = {};
    if (title.trim() === "") next.title = "عنوان هزینه را بنویسید.";
    if (parsed.kind === "empty") next.amount = "مبلغ ماهانه را وارد کنید.";
    if (parsed.kind === "invalid") next.amount = amountProblem(parsed.reason, "مبلغ ماهانه");
    setProblems(next);
    if (next.title || next.amount || parsed.kind !== "value") return;
    setPending(true);
    setError(undefined);
    try {
      await onSave({
        title: title.trim(),
        amountRial: parsed.value.toString(),
        scope: branch ? "branch" : "general",
        branchId: branch ? Number(branch) : null,
        note: note.trim() === "" ? null : note.trim(),
      });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Input label="عنوان هزینه" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} error={problems.title} />
      <Input
        label="مبلغ ماهانه (ریال)"
        numeric
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={problems.amount}
      />
      <Select
        label="دامنه"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        options={[{ value: "", label: "همهٔ فروشگاه‌ها (عمومی)" }, ...branchOptions]}
      />
      <Input label="یادداشت (اختیاری)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" size="sm" isLoading={pending}>
          {entry ? "ذخیرهٔ هزینه" : "افزودن هزینه"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          انصراف
        </Button>
      </div>
      {error ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <FormError error={error} />
        </div>
      ) : null}
    </form>
  );
}

// ===========================================================================
// 2. Inputs
// ===========================================================================

function InputsSection({ plan, onChanged }: { plan: PricingPlan; onChanged: () => void }) {
  const api = useApi();
  const [title, setTitle] = useState(plan.title);
  const [year, setYear] = useState(String(plan.effectiveYear));
  const [month, setMonth] = useState(String(plan.effectiveMonth));
  const [revenue, setRevenue] = useState(plan.targetMonthlyRevenueRial ?? "");
  const [tax, setTax] = useState(plan.taxRatePercent?.replace(/\.00$/, "") ?? "");
  const [profit, setProfit] = useState(plan.targetProfitMarginPercent?.replace(/\.00$/, "") ?? "");
  const [step, setStep] = useState(plan.roundingStepRial);
  const [maxIncrease, setMaxIncrease] = useState(plan.reviewMaxIncreasePercent.replace(/\.00$/, ""));
  const [reviewDecreases, setReviewDecreases] = useState(plan.reviewDecreases);
  const [notes, setNotes] = useState(plan.notes ?? "");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const save = useCallback(async () => {
    const next: Record<string, string> = {};
    const rev = parseRialInput(revenue, { max: MAX_PLAN_RIAL });
    const stepValue = parseRialInput(step, { max: BigInt(10_000_000) });
    const taxValue = parsePercentInput(tax);
    const profitValue = parsePercentInput(profit);
    const increase = parsePercentInput(maxIncrease, 10_001);
    if (rev.kind === "invalid") next.revenue = amountProblem(rev.reason, "فروش ماهانهٔ هدف");
    if (stepValue.kind !== "value" || stepValue.value < BigInt(1)) next.step = "گام گرد کردن باید عددی صحیح از ۱ تا ۱۰٬۰۰۰٬۰۰۰ ریال باشد.";
    if (taxValue.kind === "invalid") next.tax = "درصد مالیات را از ۰ تا کمتر از ۱۰۰، حداکثر با دو رقم اعشار وارد کنید.";
    if (profitValue.kind === "invalid") next.profit = "درصد سود هدف را از ۰ تا کمتر از ۱۰۰، حداکثر با دو رقم اعشار وارد کنید.";
    if (increase.kind !== "value") next.maxIncrease = "درصد را حداکثر با دو رقم اعشار وارد کنید.";
    if (title.trim() === "") next.title = "عنوان برنامه را بنویسید.";
    setProblems(next);
    if (Object.keys(next).length > 0) throw new Error("invalid");
    return updatePricingPlan(api, plan.id, {
      title: title.trim(),
      effectiveYear: Number(year),
      effectiveMonth: Number(month),
      targetMonthlyRevenueRial: rev.kind === "value" ? rev.value.toString() : null,
      ...(taxValue.kind === "value" ? { taxRatePercent: taxValue.text } : {}),
      ...(profitValue.kind === "value" ? { targetProfitMarginPercent: profitValue.text } : {}),
      roundingStepRial: stepValue.kind === "value" ? stepValue.value.toString() : undefined,
      reviewMaxIncreasePercent: increase.kind === "value" ? increase.text : undefined,
      reviewDecreases,
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  }, [api, plan.id, title, year, month, revenue, tax, profit, step, maxIncrease, reviewDecreases, notes]);
  const { run, isPending, error } = useMutation(save);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const result = await run();
    if (result) {
      setSaved(true);
      onChanged();
    }
  }

  const share = shareExample(plan.operatingCostRatePercent, plan.taxRatePercent, plan.targetProfitMarginPercent);
  const disabled = !plan.isEditable;
  const years = [plan.effectiveYear - 1, plan.effectiveYear, plan.effectiveYear + 1];

  return (
    <AdminSection
      title="۲. فروش ماهانهٔ هدف، مالیات، سود هدف و گرد کردن قیمت"
      description="ذخیرهٔ این ورودی‌ها هیچ قیمتی را تغییر نمی‌دهد. هر تغییر، پیش‌نمایش قبلی را کنار می‌گذارد تا دوباره محاسبه شود."
    >
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="عنوان برنامه" value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled} error={problems.title} containerClassName="sm:col-span-2" />
        <Select
          label="سال"
          value={year}
          disabled={disabled}
          onChange={(e) => setYear(e.target.value)}
          options={years.map((y) => ({ value: String(y), label: persianDigits(y) }))}
        />
        <Select
          label="ماه"
          value={month}
          disabled={disabled}
          onChange={(e) => setMonth(e.target.value)}
          options={PERSIAN_MONTHS.map((name, i) => ({ value: String(i + 1), label: name }))}
        />
        <Input
          label="فروش ماهانهٔ هدف (ریال)"
          numeric
          value={revenue}
          disabled={disabled}
          onChange={(e) => setRevenue(e.target.value)}
          error={problems.revenue}
          hint="سهم هزینه‌های ماهانه از هر ریال فروش = جمع هزینه‌ها ÷ این عدد."
        />
        <Input label="درصد مالیات از قیمت فروش" numeric value={tax} disabled={disabled} onChange={(e) => setTax(e.target.value)} error={problems.tax} hint="مثلاً ۱۰ یا ۹٫۵" />
        <Input
          label="درصد سود هدف از قیمت فروش"
          numeric
          value={profit}
          disabled={disabled}
          onChange={(e) => setProfit(e.target.value)}
          error={problems.profit}
          hint="سود ناخالص هدف، جدا از مالیات."
        />
        <Input
          label="گام گرد کردن به بالا (ریال)"
          numeric
          value={step}
          disabled={disabled}
          onChange={(e) => setStep(e.target.value)}
          error={problems.step}
          hint="مثلاً ۱۰٬۰۰۰؛ قیمت همیشه به بالا گرد می‌شود."
        />
        <Input
          label="افزایش بیش از این درصد بررسی شود"
          numeric
          value={maxIncrease}
          disabled={disabled}
          onChange={(e) => setMaxIncrease(e.target.value)}
          error={problems.maxIncrease}
        />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="size-4 accent-[color:var(--kz-primary)]"
            checked={reviewDecreases}
            disabled={disabled}
            onChange={(e) => setReviewDecreases(e.target.checked)}
          />
          هر کاهش قیمت پیش از اعمال بررسی شود
        </label>
        <Input label="یادداشت (اختیاری)" value={notes} disabled={disabled} onChange={(e) => setNotes(e.target.value)} maxLength={1000} containerClassName="sm:col-span-2" />
        {!disabled ? (
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
            <Button type="submit" isLoading={isPending}>
              ذخیرهٔ ورودی‌ها
            </Button>
            {saved ? <span className="text-sm text-success">ذخیره شد؛ هیچ قیمتی تغییر نکرد.</span> : null}
          </div>
        ) : null}
        {error && !(error instanceof Error && error.message === "invalid") ? (
          <div className="sm:col-span-2 lg:col-span-4">
            <FormError error={error} />
          </div>
        ) : null}
      </form>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Derived label="جمع هزینه‌های ماهانهٔ فعال">
          <Money value={plan.monthlyCostsTotalRial} />
        </Derived>
        <Derived label="سهم هزینه‌ها از فروش هدف">{formatPercentString(plan.operatingCostRatePercent)}</Derived>
        <Derived label="سهم قیمت خرید از قیمت فروش (مخرج فرمول)">{formatPercentString(plan.denominatorPercent)}</Derived>
        <Derived label="مثال: قیمت خرید ۱٬۰۰۰٬۰۰۰ ریال">
          {share ? <ExamplePrice denominatorPercent={plan.denominatorPercent} /> : "—"}
        </Derived>
      </dl>
      {plan.inputProblems.length > 0 ? (
        <Notice tone="warning" className="mt-4" title="هنوز نمی‌توان محاسبه کرد">
          <ul className="list-disc space-y-1 ps-5">
            {plan.inputProblems.map((problem) => (
              <li key={problem.code}>{problem.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </AdminSection>
  );
}

function Derived({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-line p-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-1 font-semibold" data-numeric="">
        {children}
      </dd>
    </div>
  );
}

/** 1 000 000 ÷ denominator, from the server's two-decimal string, for illustration only. */
function ExamplePrice({ denominatorPercent }: { denominatorPercent: string | null }) {
  if (!denominatorPercent) return <>—</>;
  const [whole, frac = ""] = denominatorPercent.split(".");
  const hundredths = BigInt(whole) * BigInt(100) + BigInt(frac.padEnd(2, "0").slice(0, 2));
  if (hundredths <= BigInt(0)) return <>—</>;
  const price = (BigInt(1_000_000) * BigInt(10_000) + hundredths - BigInt(1)) / hundredths;
  return (
    <>
      حدود <Money value={price.toString()} />
    </>
  );
}

// ===========================================================================
// 3. Calculate
// ===========================================================================

function CalculateSection({ plan, onChanged }: { plan: PricingPlan; onChanged: () => void }) {
  const api = useApi();
  const [key, setKey] = useState(mintAttemptKey);
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const canCalculate =
    ["DRAFT", "READY_FOR_REVIEW", "FAILED"].includes(plan.status) &&
    plan.inputProblems.length === 0 &&
    !(plan.latestRun && ACTIVE_RUN.has(plan.latestRun.status));

  async function calculate() {
    setPending(true);
    setError(undefined);
    try {
      await calculatePricingPlan(api, plan.id, key);
      setKey(mintAttemptKey());
      onChanged();
    } catch (caught) {
      setError(caught);
      if (!isKeyConflict(caught)) setKey(mintAttemptKey());
    } finally {
      setPending(false);
    }
  }

  return (
    <AdminSection
      title="۳. محاسبه و پیش‌نمایش"
      description="قیمت هر گونه جداگانه از میانگین موزون قیمت خرید همان گونه محاسبه و ذخیره می‌شود تا بررسی کنید. محاسبه هیچ قیمتی را تغییر نمی‌دهد."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={calculate} isLoading={pending} disabled={!canCalculate}>
          {plan.hasPreview ? "محاسبهٔ دوباره" : "محاسبه و پیش‌نمایش"}
        </Button>
        {plan.calculatedAt ? <span className="text-sm text-ink-muted">آخرین محاسبه: {when(plan.calculatedAt)}</span> : null}
        {plan.hasPreview && plan.status === "READY_FOR_REVIEW" ? (
          <span className="text-sm text-ink-muted">محاسبهٔ دوباره تصمیم‌های بررسی فعلی را از نو شروع می‌کند.</span>
        ) : null}
      </div>
      {error ? <div className="mt-3"><FormError error={error} /></div> : null}
    </AdminSection>
  );
}

// ===========================================================================
// 4. Summary and preview
// ===========================================================================

function SummarySection({ summary }: { summary: PricingSummary }) {
  return (
    <AdminSection title="۴. خلاصهٔ پیش‌نمایش" description="اعداد از همین پیش‌نمایش ذخیره‌شده محاسبه می‌شوند؛ درصدها نسبت به قیمت فعلی است.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="گونه‌های ارزیابی‌شده" value={count(summary.evaluated)} />
        <StatTile label="آماده" value={count(summary.ready)} tone="success" />
        <StatTile label="بدون تغییر" value={count(summary.unchanged)} />
        <StatTile label="نیازمند بررسی" value={count(summary.needsReview)} tone="warning" hint={`${count(summary.approvedReview)} مورد تأیید شده`} />
        <StatTile label="مسدود" value={count(summary.blocked)} tone="danger" hint="تا اصلاح داده‌ها اعمال نمی‌شود" />
        <StatTile label="میانگین تغییر" value={formatPercentString(summary.averageChangePercent)} />
        <StatTile label="کمترین تغییر" value={formatPercentString(summary.minChangePercent)} />
        <StatTile label="بیشترین تغییر" value={formatPercentString(summary.maxChangePercent)} />
      </div>
      <p className="mt-3 text-sm text-ink-muted">
        با وضعیت فعلی، قیمت <b data-numeric="">{count(summary.applicable)}</b> گونه تغییر می‌کند (
        <bdi data-numeric="">{count(summary.applicableIncreases)}</bdi> افزایش،{" "}
        <bdi data-numeric="">{count(summary.applicableDecreases)}</bdi> کاهش).
        {summary.stale > 0 ? ` ${count(summary.stale)} ردیف پس از محاسبه قدیمی شده است.` : ""}
      </p>
    </AdminSection>
  );
}

function PreviewSection({
  plan,
  preview,
  version,
  onChanged,
}: {
  plan: PricingPlan;
  preview: PricingPreviewParams;
  version: number;
  onChanged: () => void;
}) {
  const api = useApi();
  const router = useRouter();
  const editable = plan.status === "READY_FOR_REVIEW";
  const query: PricingItemQuery = { ...preview, limit: PAGE_SIZE };
  const filterKey = JSON.stringify(query);
  const items = useApiQuery(
    (signal) => fetchPricingItems(api, plan.id, query, { signal }),
    [api, plan.id, filterKey, version],
  );
  const [bulkError, setBulkError] = useState<unknown>(undefined);
  const [bulkDone, setBulkDone] = useState<string | null>(null);
  const [approveReview, setApproveReview] = useState(false);

  const filters: PricingItemFilters = useMemo(() => {
    const { page: _page, limit: _limit, sort: _sort, order: _order, ...rest } = preview;
    void _page;
    void _limit;
    void _sort;
    void _order;
    return rest;
  }, [preview]);

  function href(next: Partial<PricingPreviewParams>) {
    const merged = { ...preview, ...next };
    return adminPricingPlanHref(plan.id, {
      view: merged.view === "exceptions" ? undefined : merged.view,
      search: merged.search,
      status: merged.status,
      categoryId: merged.categoryId,
      channel: merged.channel,
      direction: merged.direction,
      minChangePercent: merged.minChangePercent,
      maxChangePercent: merged.maxChangePercent,
      included: merged.included,
      stale: merged.stale,
      sort: merged.sort === "product" ? undefined : merged.sort,
      order: merged.order === "asc" ? undefined : merged.order,
      page: merged.page && merged.page > 1 ? merged.page : undefined,
    });
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };
    const percent = (key: string) => {
      const raw = text(key);
      if (!raw) return undefined;
      const negative = raw.startsWith("-") || raw.startsWith("−");
      const parsed = parsePercentInput(raw.replace(/^[-−]/, ""), 1_000_000);
      return parsed.kind === "value" ? `${negative ? "-" : ""}${parsed.text}` : undefined;
    };
    const included = text("included");
    router.push(
      href({
        view: (text("view") as PricingPreviewParams["view"]) ?? "exceptions",
        search: text("search"),
        status: text("status") as PricingPreviewParams["status"],
        channel: text("channel") as PricingPreviewParams["channel"],
        direction: text("direction") as PricingPreviewParams["direction"],
        minChangePercent: percent("minChangePercent"),
        maxChangePercent: percent("maxChangePercent"),
        included: included === undefined ? undefined : included === "true",
        sort: (text("sort") as PricingPreviewParams["sort"]) ?? "product",
        order: (text("order") as "asc" | "desc") ?? "asc",
        page: 1,
      }),
    );
  }

  async function bulk(included: boolean) {
    setBulkError(undefined);
    setBulkDone(null);
    try {
      const result = await bulkPricingItems(api, plan.id, {
        filters,
        included,
        approveNeedsReview: included && approveReview,
      });
      setBulkDone(`${count(result.updated)} ردیف ${included ? "انتخاب" : "کنار گذاشته"} شد.`);
      onChanged();
    } catch (caught) {
      setBulkError(caught);
    }
  }

  return (
    <AdminSection
      title="پیش‌نمایش قیمت‌ها"
      description="به‌طور پیش‌فرض فقط استثناها (نیازمند بررسی، مسدود و قدیمی‌شده) نشان داده می‌شوند. «نیازمند بررسی» را می‌توانید تأیید کنید؛ «مسدود» تا اصلاح داده‌ها و محاسبهٔ دوباره اعمال نمی‌شود."
    >
      <FilterBar key={filterKey} onSubmit={applyFilters} onReset={() => router.push(adminPricingPlanHref(plan.id))} collapsible defaultOpen summary="فیلتر، جست‌وجو و مرتب‌سازی">
        <Select
          name="view"
          label="نمایش"
          defaultValue={preview.view ?? "exceptions"}
          options={[
            { value: "exceptions", label: "فقط استثناها" },
            { value: "all", label: "همهٔ ردیف‌ها" },
            { value: "applicable", label: "فقط قیمت‌هایی که تغییر می‌کنند" },
          ]}
        />
        <Input name="search" label="نام کالا، کد کالا، کد گونه یا SKU" defaultValue={preview.search ?? ""} containerClassName="min-w-0" />
        <Select
          name="status"
          label="وضعیت"
          defaultValue={preview.status ?? ""}
          options={[{ value: "", label: "همه" }, ...PRICING_ITEM_STATUSES.map((value) => ({ value, label: pricingItemStatusLabel(value) }))]}
        />
        <Select
          name="direction"
          label="جهت تغییر"
          defaultValue={preview.direction ?? ""}
          options={[
            { value: "", label: "همه" },
            ...PRICING_ITEM_DIRECTIONS.map((value) => ({
              value,
              label: value === "increase" ? "افزایش" : value === "decrease" ? "کاهش" : "بدون تغییر",
            })),
          ]}
        />
        <Select
          name="channel"
          label="عرضه"
          defaultValue={preview.channel ?? ""}
          options={[
            { value: "", label: "همه" },
            ...PRICING_ITEM_CHANNELS.map((value) => ({
              value,
              label: value === "site" ? "فقط سایت" : value === "branches" ? "فقط شعبه‌ها" : value === "both" ? "سایت و شعبه‌ها" : "عرضه نمی‌شود",
            })),
          ]}
        />
        <Input name="minChangePercent" label="کمترین درصد تغییر" numeric defaultValue={preview.minChangePercent ?? ""} containerClassName="min-w-0" />
        <Input name="maxChangePercent" label="بیشترین درصد تغییر" numeric defaultValue={preview.maxChangePercent ?? ""} containerClassName="min-w-0" />
        <Select
          name="included"
          label="انتخاب"
          defaultValue={preview.included === undefined ? "" : String(preview.included)}
          options={[
            { value: "", label: "همه" },
            { value: "true", label: "انتخاب‌شده" },
            { value: "false", label: "کنار گذاشته‌شده" },
          ]}
        />
        <Select
          name="sort"
          label="مرتب‌سازی"
          defaultValue={preview.sort ?? "product"}
          options={PRICING_ITEM_SORTS.map((value) => ({ value, label: SORT_LABEL[value] }))}
        />
        <Select
          name="order"
          label="ترتیب"
          defaultValue={preview.order ?? "asc"}
          options={[
            { value: "asc", label: "صعودی" },
            { value: "desc", label: "نزولی" },
          ]}
        />
      </FilterBar>

      {editable ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-line p-3">
          <span className="text-sm text-ink-muted">برای همهٔ ردیف‌های همین فیلتر (نه فقط این صفحه):</span>
          <Button size="sm" variant="secondary" onClick={() => void bulk(true)}>
            انتخاب همه
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void bulk(false)}>
            کنار گذاشتن همه
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[color:var(--kz-primary)]"
              checked={approveReview}
              onChange={(e) => setApproveReview(e.target.checked)}
            />
            ردیف‌های «نیازمند بررسی» هم تأیید شوند
          </label>
          {bulkDone ? <span className="text-sm text-success" role="status">{bulkDone}</span> : null}
        </div>
      ) : (
        <Notice tone="neutral" className="mb-4">
          ردیف‌ها فقط در وضعیت «آمادهٔ بررسی» تغییر می‌کنند.
        </Notice>
      )}
      {bulkError ? <FormError error={bulkError} /> : null}

      <Stable query={items} label="در حال خواندن پیش‌نمایش">
        {(page) => (
          <>
            <p className="mb-2 text-sm text-ink-muted">
              <bdi data-numeric="">{count(page.total)}</bdi> ردیف با این فیلتر
            </p>
            <DataTable minWidth="72rem" caption="ردیف‌های پیش‌نمایش قیمت">
              <thead>
                <tr>
                  <Th>انتخاب</Th>
                  <Th>کالا و گونه</Th>
                  <Th numeric>میانگین قیمت خرید</Th>
                  <Th numeric>قیمت فعلی</Th>
                  <Th numeric>قیمت محاسبه‌شده</Th>
                  <Th numeric>قیمت پیشنهادی</Th>
                  <Th numeric>قیمت نهایی</Th>
                  <Th numeric>تغییر</Th>
                  <Th>وضعیت و دلیل</Th>
                </tr>
              </thead>
              <tbody>
                {page.data.length === 0 ? (
                  <EmptyRow colSpan={9}>ردیفی با این فیلتر نیست.</EmptyRow>
                ) : (
                  page.data.map((item) => (
                    <ItemRow key={item.id} planId={plan.id} item={item} editable={editable} onChanged={onChanged} />
                  ))
                )}
              </tbody>
            </DataTable>
            <Pagination className="mt-4" pageInfo={pageInfoOf(page)} buildHref={(next) => href({ page: next })} />
          </>
        )}
      </Stable>
    </AdminSection>
  );
}

/** "2133332.5000" → "۲٬۱۳۳٬۳۳۲٫۵": grouped integer part, significant decimals only. */
function rawPriceText(raw: string): string {
  const [whole, fraction = ""] = raw.split(".");
  const decimals = fraction.replace(/0+$/, "");
  const grouped = formatRialString(whole, { withUnit: false });
  return decimals ? `${grouped}٫${persianDigits(decimals)}` : grouped;
}

const SORT_LABEL: Record<(typeof PRICING_ITEM_SORTS)[number], string> = {
  product: "نام کالا",
  changePercent: "درصد تغییر",
  changeRial: "مبلغ تغییر",
  currentPrice: "قیمت فعلی",
  finalPrice: "قیمت نهایی",
  costBasis: "قیمت خرید",
  status: "وضعیت",
};

function ItemRow({
  planId,
  item,
  editable,
  onChanged,
}: {
  planId: number;
  item: PricingItem;
  editable: boolean;
  onChanged: () => void;
}) {
  const api = useApi();
  const [override, setOverride] = useState(item.overridePriceRial ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const blocked = item.status === "BLOCKED" || item.stale;
  const canInclude = editable && !blocked && !(item.status === "UNCHANGED" && item.overridePriceRial === null);

  async function patch(body: { included?: boolean; overridePriceRial?: string | null }) {
    setPending(true);
    setError(undefined);
    try {
      await updatePricingItem(api, planId, item.id, body);
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  function saveOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (override.trim() === "") {
      setProblem(null);
      void patch({ overridePriceRial: null });
      return;
    }
    const parsed = parseRialInput(override);
    if (parsed.kind !== "value" || parsed.value < BigInt(1)) {
      setProblem(parsed.kind === "invalid" ? amountProblem(parsed.reason, "قیمت دستی") : "قیمت دستی باید بیشتر از صفر باشد.");
      return;
    }
    if (item.costBasisRial !== null && parsed.value < BigInt(item.costBasisRial)) {
      setProblem("قیمت دستی نمی‌تواند کمتر از میانگین قیمت خرید باشد.");
      return;
    }
    setProblem(null);
    void patch({ overridePriceRial: parsed.value.toString() });
  }

  const label = `${item.productTitle} — ${item.variantCode}`;
  const change = item.changeRial === null ? null : BigInt(item.changeRial);

  return (
    <Tr className={cx(blocked && "text-ink-muted")}>
      <Td>
        <input
          type="checkbox"
          className="size-4 accent-[color:var(--kz-primary)]"
          aria-label={`انتخاب ${label}`}
          checked={item.included}
          disabled={!canInclude || pending}
          onChange={(e) => void patch({ included: e.target.checked })}
        />
      </Td>
      <Td>
        <div className="min-w-[12rem]">
          <div className="font-medium">{item.productTitle}</div>
          <div className="text-xs text-ink-muted">
            <bdi dir="ltr" data-numeric="">{item.variantCode}</bdi> · <bdi dir="ltr" data-numeric="">{item.sku}</bdi>
            {item.isDefaultVariant ? " · کالای ساده" : ""}
          </div>
        </div>
      </Td>
      <Td numeric>
        <Money value={item.costBasisRial} withUnit={false} />
      </Td>
      <Td numeric>
        <Money value={item.currentPriceRial} withUnit={false} fallback="ثبت نشده" />
      </Td>
      <Td numeric>
        {item.rawPrice ? <bdi data-numeric="">{rawPriceText(item.rawPrice)}</bdi> : "—"}
      </Td>
      <Td numeric>
        <Money value={item.proposedPriceRial} withUnit={false} />
      </Td>
      <Td numeric>
        {editable && !blocked ? (
          <form onSubmit={saveOverride} className="flex min-w-[11rem] items-start gap-1">
            <Input
              label={`قیمت دستی ${label}`}
              hideLabel
              numeric
              value={override}
              placeholder={item.proposedPriceRial ?? ""}
              onChange={(e) => setOverride(e.target.value)}
              error={problem}
              className="h-9 text-sm"
            />
            <Button type="submit" size="sm" variant="ghost" isLoading={pending}>
              ثبت
            </Button>
          </form>
        ) : (
          <Money value={item.finalPriceRial} withUnit={false} />
        )}
      </Td>
      <Td numeric>
        {change === null ? (
          "—"
        ) : (
          <span className={cx(change > BigInt(0) ? "text-ink" : change < BigInt(0) ? "text-danger" : "text-ink-muted")}>
            <Money value={item.changeRial} withUnit={false} />
            <span className="ms-1 text-xs">({formatPercentString(item.changePercent)})</span>
          </span>
        )}
      </Td>
      <Td>
        <div className="flex min-w-[12rem] flex-col gap-1">
          <span className="flex flex-wrap gap-1">
            <Badge tone={pricingItemStatusTone(item.status)} size="sm">
              {pricingItemStatusLabel(item.status)}
            </Badge>
            {item.stale ? (
              <Badge tone="danger" size="sm">
                قدیمی
              </Badge>
            ) : null}
            {item.reviewed && item.status === "NEEDS_REVIEW" ? (
              <Badge tone="success" size="sm">
                تأییدشده
              </Badge>
            ) : null}
            {item.overridePriceRial ? (
              <Badge tone="info" size="sm">
                قیمت دستی
              </Badge>
            ) : null}
          </span>
          {item.reasons.map((reason) => (
            <span key={reason} className="text-xs text-ink-muted">
              {pricingReasonLabel(reason)}
            </span>
          ))}
          {item.stale && item.staleReason ? <span className="text-xs text-danger">{pricingStaleReasonLabel(item.staleReason)}</span> : null}
          {error ? <FormError error={error} /> : null}
        </div>
      </Td>
    </Tr>
  );
}

// ===========================================================================
// 5. Approve and apply
// ===========================================================================

function ApproveApplySection({ plan, onChanged }: { plan: PricingPlan; onChanged: () => void }) {
  const api = useApi();
  const applicable = plan.summary?.applicable ?? 0;
  const [dialog, setDialog] = useState<"approve" | "apply" | null>(null);
  const [key, setKey] = useState(mintAttemptKey);
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const close = useCallback(() => setDialog(null), []);
  const running = plan.latestRun && ACTIVE_RUN.has(plan.latestRun.status);
  const canApply = plan.status === "APPROVED" || (plan.status === "FAILED" && plan.approvedAt !== null);

  async function act(kind: "approve" | "unapprove" | "apply") {
    setPending(true);
    setError(undefined);
    try {
      if (kind === "approve") await approvePricingPlan(api, plan.id, applicable);
      if (kind === "unapprove") await unapprovePricingPlan(api, plan.id);
      if (kind === "apply") {
        await applyPricingPlan(api, plan.id, applicable, key);
        setKey(mintAttemptKey());
      }
      setDialog(null);
      onChanged();
    } catch (caught) {
      setError(caught);
      if (kind === "apply" && !isKeyConflict(caught)) setKey(mintAttemptKey());
    } finally {
      setPending(false);
    }
  }

  if (["APPLIED", "ROLLED_BACK", "APPLYING"].includes(plan.status)) return null;

  return (
    <AdminSection
      title="۵. تأیید و اعمال قیمت‌ها"
      description="تأیید، ردیف‌ها را ثابت می‌کند. اعمال همهٔ قیمت‌های انتخاب‌شده را با هم تغییر می‌دهد یا هیچ‌کدام را؛ اگر قیمت یا بهای خرید گونه‌ای پس از محاسبه تغییر کرده باشد، هیچ قیمتی تغییر نمی‌کند."
    >
      <p className="mb-3">
        با تأیید و اعمال این برنامه، قیمت <b data-numeric="">{count(applicable)}</b> گونه تغییر می‌کند.
      </p>
      <div className="flex flex-wrap gap-2">
        {plan.status === "READY_FOR_REVIEW" ? (
          <Button onClick={() => setDialog("approve")} disabled={applicable === 0 || Boolean(running)}>
            تأیید برنامه
          </Button>
        ) : null}
        {plan.status === "APPROVED" ? (
          <Button variant="secondary" onClick={() => void act("unapprove")} isLoading={pending}>
            خروج از تأیید برای ویرایش
          </Button>
        ) : null}
        {canApply ? (
          <Button onClick={() => setDialog("apply")} disabled={Boolean(running)}>
            اعمال قیمت‌ها
          </Button>
        ) : null}
      </div>
      {error ? <div className="mt-3"><FormError error={error} /></div> : null}
      <ConfirmDialog
        open={dialog === "approve"}
        onClose={close}
        onConfirm={() => void act("approve")}
        isPending={pending}
        tone="neutral"
        title="تأیید برنامهٔ قیمت‌گذاری"
        question={`${count(applicable)} قیمت برای اعمال تأیید می‌شود.`}
        consequences={[
          "ردیف‌های پیش‌نمایش ثابت می‌شوند؛ برای تغییر دوباره باید از تأیید خارج شوید.",
          "هنوز هیچ قیمتی تغییر نمی‌کند؛ اعمال یک مرحلهٔ جداگانه است.",
        ]}
        confirmLabel="تأیید برنامه"
      />
      <ConfirmDialog
        open={dialog === "apply"}
        onClose={close}
        onConfirm={() => void act("apply")}
        isPending={pending}
        title="اعمال قیمت‌های تازه"
        question={`قیمت فروش ${count(applicable)} گونه همین حالا تغییر می‌کند.`}
        consequences={[
          `قیمت ${count(applicable)} گونه در سایت، شعبه‌ها و صندوق فروش یکجا به‌روز می‌شود — یا اگر یکی از آن‌ها پس از محاسبه تغییر کرده باشد، هیچ‌کدام.`,
          "فقط فروش‌های بعدی با قیمت تازه ثبت می‌شوند؛ سفارش‌ها، بهای تمام‌شده و گزارش‌های گذشته تغییر نمی‌کنند.",
          "بعداً می‌توانید برنامه را بازگردانید؛ قیمتی که پس از اعمال دوباره تغییر کرده باشد دست‌نخورده می‌ماند.",
        ]}
        confirmLabel={`اعمال ${count(applicable)} قیمت`}
      />
    </AdminSection>
  );
}

// ===========================================================================
// 6. Result, history and rollback
// ===========================================================================

function HistorySection({ plan, version, onChanged }: { plan: PricingPlan; version: number; onChanged: () => void }) {
  const api = useApi();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const runs = useApiQuery((signal) => fetchPricingRuns(api, plan.id, { signal }), [api, plan.id, version]);
  const changes = useApiQuery(
    (signal) => fetchPricingChanges(api, plan.id, { page, limit: 20 }, { signal }),
    [api, plan.id, page, version],
  );
  const rollback = useApiQuery(
    (signal) => fetchPricingRollbackPreview(api, plan.id, { signal }),
    [api, plan.id, version],
    { enabled: plan.status === "APPLIED" },
  );
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(mintAttemptKey);
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const deletable = plan.isEditable && !plan.appliedAt;

  async function doRollback() {
    setPending(true);
    setError(undefined);
    try {
      await rollbackPricingPlan(api, plan.id, key);
      setKey(mintAttemptKey());
      setOpen(false);
      onChanged();
    } catch (caught) {
      setError(caught);
      if (!isKeyConflict(caught)) setKey(mintAttemptKey());
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setError(undefined);
    try {
      await deletePricingPlan(api, plan.id);
      router.push(adminPricingPlansHref());
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <AdminSection title="۶. نتیجه، تاریخچه و بازگردانی امن">
      {plan.status === "APPLIED" ? (
        <div className="mb-4 rounded-md border border-line p-3">
          {rollback.data ? (
            <p className="text-sm">
              بازگردانی، قیمت <b data-numeric="">{count(rollback.data.restorable)}</b> گونه را به پیش از اعمال برمی‌گرداند.{" "}
              {rollback.data.conflicts > 0
                ? `${count(rollback.data.conflicts)} گونه پس از اعمال دوباره تغییر کرده است و قیمت فعلی‌اش دست نمی‌خورد.`
                : ""}
            </p>
          ) : null}
          <Button className="mt-2" variant="danger" size="sm" onClick={() => setOpen(true)}>
            بازگردانی برنامه
          </Button>
        </div>
      ) : null}
      {error ? <FormError error={error} /> : null}

      <h3 className="mb-2 mt-2 font-semibold">عملیات‌ها</h3>
      <QueryBoundary isLoading={runs.isLoading} error={runs.error} data={runs.data} onRetry={runs.refetch} label="در حال خواندن عملیات‌ها">
        {(rows) => (
          <DataTable minWidth="40rem" caption="عملیات‌های برنامه">
            <thead>
              <tr>
                <Th>عملیات</Th>
                <Th>وضعیت</Th>
                <Th>درخواست‌دهنده</Th>
                <Th>زمان</Th>
                <Th>نتیجه</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={5}>هنوز عملیاتی انجام نشده است.</EmptyRow>
              ) : (
                rows.map((run) => (
                  <Tr key={run.id}>
                    <Td>{pricingRunKindLabel(run.kind)}</Td>
                    <Td>
                      <Badge tone={pricingRunStatusTone(run.status)} size="sm">
                        {pricingRunStatusLabel(run.status)}
                      </Badge>
                    </Td>
                    <Td>{run.requestedByDisplay}</Td>
                    <Td>{when(run.finishedAt ?? run.queuedAt)}</Td>
                    <Td>{run.errorMessage ?? runResultText(run)}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </DataTable>
        )}
      </QueryBoundary>

      <h3 className="mb-2 mt-5 font-semibold">تاریخچهٔ قیمت‌ها</h3>
      <QueryBoundary isLoading={changes.isLoading} error={changes.error} data={changes.data} onRetry={changes.refetch} label="در حال خواندن تاریخچه">
        {(data) => (
          <>
            <DataTable minWidth="48rem" caption="قیمت‌هایی که این برنامه نوشت یا بازگرداند">
              <thead>
                <tr>
                  <Th>نوع</Th>
                  <Th>کالا و گونه</Th>
                  <Th numeric>قیمت قبلی</Th>
                  <Th numeric>قیمت تازه</Th>
                  <Th>توسط</Th>
                  <Th>زمان</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 ? (
                  <EmptyRow colSpan={6}>این برنامه هنوز قیمتی ننوشته است.</EmptyRow>
                ) : (
                  data.data.map((change) => (
                    <Tr key={change.id}>
                      <Td>{change.kind === "apply" ? "اعمال" : "بازگردانی"}</Td>
                      <Td>
                        {change.productTitle ?? "—"}{" "}
                        <bdi dir="ltr" data-numeric="" className="text-xs text-ink-muted">
                          {change.variantCode ?? ""}
                        </bdi>
                      </Td>
                      <Td numeric>
                        <Money value={change.oldPriceRial} withUnit={false} fallback="ثبت نشده" />
                      </Td>
                      <Td numeric>
                        <Money value={change.newPriceRial} withUnit={false} fallback="ثبت نشده" />
                      </Td>
                      <Td>{change.changedByDisplay}</Td>
                      <Td>{when(change.changedAt)}</Td>
                    </Tr>
                  ))
                )}
              </tbody>
            </DataTable>
            {data.totalPages > 1 ? (
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  قبلی
                </Button>
                <span className="text-sm" data-numeric="">
                  {count(page)} / {count(data.totalPages)}
                </span>
                <Button size="sm" variant="ghost" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
                  بعدی
                </Button>
              </div>
            ) : null}
          </>
        )}
      </QueryBoundary>

      {deletable ? (
        <div className="mt-5">
          <Button variant="ghost" size="sm" onClick={() => void remove()}>
            حذف این برنامه (هرگز اعمال نشده است)
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={open}
        onClose={close}
        onConfirm={() => void doRollback()}
        isPending={pending}
        title="بازگردانی قیمت‌های این برنامه"
        question={`قیمت ${count(rollback.data?.restorable ?? 0)} گونه به پیش از اعمال برمی‌گردد.`}
        consequences={[
          "فقط قیمت‌هایی بازمی‌گردند که هنوز همان قیمتِ نوشته‌شده توسط این برنامه‌اند.",
          "قیمتی که پس از اعمال دستی یا با برنامهٔ دیگری تغییر کرده است، بازنویسی نمی‌شود.",
          "سفارش‌ها و گزارش‌های گذشته تغییر نمی‌کنند؛ این کار در تاریخچه ثبت می‌شود و برگشت‌پذیر نیست.",
        ]}
        confirmLabel="بازگردانی"
        confirmPhrase="بازگردانی"
      />
    </AdminSection>
  );
}

function runResultText(run: PricingRun): string {
  if (run.status !== "succeeded" || !run.result) return "—";
  if (run.kind === "calculate") return `${count(Number(run.result.evaluated ?? 0))} گونه ارزیابی شد`;
  if (run.kind === "apply") return `${count(Number(run.result.changed ?? 0))} قیمت تغییر کرد`;
  return `${count(Number(run.result.restored ?? 0))} قیمت بازگشت، ${count(Number(run.result.conflictCount ?? 0))} ناسازگاری`;
}
