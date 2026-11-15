"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Badge, Button, Input } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice, Pagination, QueryBoundary } from "@/components/common";
import {
  AdminPageHeader,
  AdminSection,
  DataTable,
  EmptyRow,
  RequireRole,
  Select,
  Td,
  Th,
  Tr,
  count,
  when,
  useMutation,
} from "@/components/admin/ui";
import { pageInfoOf } from "@/components/admin/people-shared";
import { ChartIcon } from "@/components/icons";
import {
  PRICING_PLAN_STATUSES,
  createPricingPlan,
  fetchPricingPlans,
  type PricingPlanStatus,
} from "@/lib/admin-api";
import { pricingPlanStatusLabel, pricingPlanStatusTone } from "@/lib/pricing-labels";
import { PERSIAN_MONTHS, currentPersianMonth, persianDigits, planMonthLabel } from "@/lib/pricing";
import { adminPricingPlanHref, adminPricingPlansHref } from "@/lib/routes";

export const PRICING_ROLE_REASON =
  "هزینه‌های ماهانه، فروش هدف، سود هدف و قیمت‌گذاری همهٔ کالاها تنها در اختیار مدیر کل سامانه است و به هیچ نقش دیگری واگذار نمی‌شود.";

/** The five sentences every pricing screen must keep in front of the manager. */
export function PricingPrinciples() {
  return (
    <Notice tone="info" className="mb-5" icon={<ChartIcon className="size-5" />} title="قیمت‌ها فقط با تأیید نهایی شما تغییر می‌کنند">
      <ul className="list-disc space-y-1 ps-5">
        <li>ذخیرهٔ هزینه‌ها و ورودی‌ها، و حتی محاسبهٔ پیش‌نمایش، هیچ قیمتی را تغییر نمی‌دهد.</li>
        <li>
          مالیات و سود هدف دو درصد جدا از <b>قیمت نهایی فروش</b> هستند، نه درصدی روی قیمت خرید؛ سهم هزینه‌های ماهانه هم از
          همان قیمت فروش است.
        </li>
        <li>
          پوشش هزینه‌های ماهانه فقط وقتی کامل است که فروش واقعی ماه به «فروش ماهانهٔ هدف» برسد؛ این یک هدف قیمت‌گذاری است،
          نه تضمین فروش یا سود.
        </li>
        <li>گونه‌هایی که قیمت خریدشان معلوم یا کامل نیست، خودکار قیمت‌گذاری نمی‌شوند.</li>
        <li>قیمت‌های تازه فقط برای فروش‌های بعدی است؛ سفارش‌ها و گزارش‌های گذشته تغییر نمی‌کنند.</li>
      </ul>
    </Notice>
  );
}

export function PricingPlans({ page, status }: { page: number; status?: PricingPlanStatus }) {
  return (
    <RequireRole roles={["super_admin"]} reason={PRICING_ROLE_REASON}>
      <PricingPlansBody page={page} status={status} />
    </RequireRole>
  );
}

function PricingPlansBody({ page, status }: { page: number; status?: PricingPlanStatus }) {
  const api = useApi();
  const router = useRouter();
  const plans = useApiQuery(
    (signal) => fetchPricingPlans(api, { page, limit: 20, status }, { signal }),
    [api, page, status],
  );

  return (
    <>
      <AdminPageHeader
        title="قیمت‌گذاری ماهانه"
        description="هزینه‌های ماهانه، فروش هدف، مالیات و سود هدف را وارد کنید تا برای هر گونهٔ کالا قیمت فروش پیشنهاد شود. همهٔ مبالغ به ریال است."
      />
      <PricingPrinciples />

      <NewPlan copySources={plans.data?.data ?? []} onCreated={(id) => router.push(adminPricingPlanHref(id))} />

      <AdminSection
        title="برنامه‌ها"
        actions={
          <Select
            label="وضعیت"
            hideLabel
            value={status ?? ""}
            onChange={(event) =>
              router.push(adminPricingPlansHref({ status: event.target.value || undefined }))
            }
            options={[
              { value: "", label: "همهٔ وضعیت‌ها" },
              ...PRICING_PLAN_STATUSES.map((value) => ({ value, label: pricingPlanStatusLabel(value) })),
            ]}
          />
        }
      >
        <QueryBoundary
          isLoading={plans.isLoading}
          error={plans.error}
          data={plans.data}
          onRetry={plans.refetch}
          label="در حال خواندن برنامه‌ها"
        >
          {(data) => (
            <>
              <DataTable minWidth="40rem" caption="برنامه‌های قیمت‌گذاری ماهانه">
                <thead>
                  <tr>
                    <Th>برنامه</Th>
                    <Th>ماه</Th>
                    <Th>وضعیت</Th>
                    <Th numeric>گونه‌های ارزیابی‌شده</Th>
                    <Th numeric>قیمت‌هایی که تغییر می‌کنند</Th>
                    <Th>آخرین تغییر</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.length === 0 ? (
                    <EmptyRow colSpan={6}>هنوز برنامه‌ای ساخته نشده است.</EmptyRow>
                  ) : (
                    data.data.map((plan) => (
                      <Tr key={plan.id}>
                        <Td>
                          <Link href={adminPricingPlanHref(plan.id)} className="font-medium">
                            {plan.title}
                          </Link>
                        </Td>
                        <Td>{planMonthLabel(plan.effectiveYear, plan.effectiveMonth)}</Td>
                        <Td>
                          <Badge tone={pricingPlanStatusTone(plan.status)} size="sm">
                            {pricingPlanStatusLabel(plan.status)}
                          </Badge>
                        </Td>
                        <Td numeric>{count(plan.itemCount)}</Td>
                        <Td numeric>{count(plan.applicableCount)}</Td>
                        <Td>{when(plan.updatedAt)}</Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </DataTable>
              <Pagination
                className="mt-4"
                pageInfo={pageInfoOf(data)}
                buildHref={(next) => adminPricingPlansHref({ status, page: next > 1 ? next : undefined })}
              />
            </>
          )}
        </QueryBoundary>
      </AdminSection>
    </>
  );
}

function NewPlan({
  copySources,
  onCreated,
}: {
  copySources: { id: number; title: string; effectiveYear: number; effectiveMonth: number }[];
  onCreated: (planId: number) => void;
}) {
  const api = useApi();
  const now = useMemo(() => currentPersianMonth(), []);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState(String(now.year));
  const [month, setMonth] = useState(String(now.month));
  const [copyFrom, setCopyFrom] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const create = useCallback(
    () =>
      createPricingPlan(api, {
        title: title.trim(),
        effectiveYear: Number(year),
        effectiveMonth: Number(month),
        ...(copyFrom ? { copyFromPlanId: Number(copyFrom) } : {}),
      }),
    [api, title, year, month, copyFrom],
  );
  const { run, isPending, error } = useMutation(create);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() === "") {
      setProblem("برای برنامه یک عنوان بنویسید.");
      return;
    }
    setProblem(null);
    const plan = await run();
    if (plan) onCreated(plan.id);
  }

  const years = [now.year - 1, now.year, now.year + 1];

  return (
    <AdminSection title="برنامهٔ تازه" description="پس از ساخت، هزینه‌ها و ورودی‌ها را در صفحهٔ برنامه وارد می‌کنید.">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <Input
          label="عنوان"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          error={problem}
          containerClassName="lg:col-span-2"
        />
        <Select
          label="سال"
          value={year}
          onChange={(event) => setYear(event.target.value)}
          options={years.map((y) => ({ value: String(y), label: persianDigits(y) }))}
        />
        <Select
          label="ماه"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
          options={PERSIAN_MONTHS.map((name, index) => ({ value: String(index + 1), label: name }))}
        />
        <Select
          label="رونوشت از برنامهٔ قبلی"
          value={copyFrom}
          onChange={(event) => setCopyFrom(event.target.value)}
          hint="هزینه‌ها و ورودی‌ها رونوشت می‌شوند، نه پیش‌نمایش."
          options={[
            { value: "", label: "بدون رونوشت" },
            ...copySources.map((plan) => ({
              value: String(plan.id),
              label: `${plan.title} — ${planMonthLabel(plan.effectiveYear, plan.effectiveMonth)}`,
            })),
          ]}
        />
        <div className="flex items-end lg:col-span-5">
          <Button type="submit" isLoading={isPending}>
            ساخت برنامه
          </Button>
        </div>
        {error ? (
          <div className="lg:col-span-5">
            <FormError error={error} />
          </div>
        ) : null}
      </form>
    </AdminSection>
  );
}
