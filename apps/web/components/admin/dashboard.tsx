"use client";

import Link from "next/link";
import type { Route } from "next";

import { Badge, Button, ErrorState, Skeleton, cx } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import {
  AccessDenied,
  AdminPageHeader,
  AdminSection,
  DataTable,
  EmptyRow,
  Gate,
  RequirePermission,
  forbiddenPermissions,
  StatTile,
  Td,
  Th,
  Tr,
  count,
  when,
} from "@/components/admin/ui";
import { AlertIcon, RefreshIcon } from "@/components/icons";
import { useAppSession } from "@/components/providers";
import { Notice } from "@/components/common";
import { fetchDashboard, fetchDashboardFinancial } from "@/lib/admin-api";
import type { DashboardProfit, DashboardSummary } from "@/lib/admin-api";
import { formatPercentString } from "@/lib/costing";
import { adminProfitReportHref } from "@/lib/routes";
import { isSuperAdmin } from "@/lib/permissions";
import { formatRialString, isZeroRialString } from "@/lib/money";
import { channelLabel, orderStatusLabel, orderStatusTone } from "@/lib/labels";

export function AdminDashboard() {
  return (
    <RequirePermission permissions={["dashboard.read"]}>
      <DashboardBody />
    </RequirePermission>
  );
}

function DashboardBody() {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchDashboard(api, {}, { signal }),
    [api],
  );

  if (error) {
    /*
     * A 403 IS NOT AN UNREACHABLE SERVER. The gate above already answers the
     * ordinary case, but a role edited while this tab was open produces the
     * refusal at runtime — and the old copy called it a connection failure and
     * offered a retry that can never succeed.
     */
    const forbidden = forbiddenPermissions(error);
    return (
      <>
        <AdminPageHeader title="داشبورد" />
        {forbidden ? (
          <AccessDenied
            permissions={forbidden.length > 0 ? forbidden : ["dashboard.read"]}
            title="اختیار دیدن داشبورد را ندارید"
            description="سرور این درخواست را رد کرد. تلاش دوباره نتیجه‌ای ندارد؛ از مدیر ارشد بخواهید اختیار زیر را به نقش شما اضافه کند."
          />
        ) : (
          <ErrorState
            error={error}
            title="خلاصهٔ امروز خوانده نشد"
            description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
            onRetry={refetch}
          />
        )}
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <AdminPageHeader title="داشبورد" />
        <div role="status" aria-busy="true" className="space-y-4">
          <span className="kz-sr-only">در حال بارگذاری داشبورد</span>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} shape="block" height="6.5rem" />
            ))}
          </div>
          <Skeleton shape="block" height="16rem" />
        </div>
      </>
    );
  }

  return (
    <>
      <AdminPageHeader
        title="داشبورد"
        description={
          <>
            همهٔ مبالغ به <b>ریال</b> است و «امروز» یعنی روزِ تقویمی به وقت رسمی تهران، از
            نیمه‌شب تا نیمه‌شب. اعداد این صفحه دو دسته‌اند و با هم جمع نمی‌شوند:{" "}
            <b>پول دریافتی</b> بر اساس زمان دریافت وجه، و <b>سفارش‌های ثبت‌شده</b> بر اساس
            زمان ثبت سفارش. زیر هر کارت نوشته شده چه چیزی در آن شمرده می‌شود و چه چیزی نه.
            چون بهای تمام‌شدهٔ کالا در این سامانه ثبت نمی‌شود، هیچ عددی بر پایهٔ آن نمایش
            داده نمی‌شود.
          </>
        }
        meta={
          <Badge tone="neutral" size="sm">
            <bdi data-numeric="">{toJalali(data.period.date)}</bdi>
          </Badge>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={refetch}
            leadingIcon={<RefreshIcon className="size-4" />}
          >
            به‌روزرسانی
          </Button>
        }
      />

      <Alerts data={data} />

      {/*
        TWO SECTIONS, NOT ONE ROW OF EIGHT TILES.

        There used to be a single tile called «تعداد سفارش امروز» sitting
        between the two money tiles. It counted orders by the instant the MONEY
        moved, not by the instant the order was placed — so an abandoned basket
        from this morning was in it, an order paid today but placed yesterday
        was in it, and an order placed today but paid tomorrow was NOT. Three
        unrelated behaviours under one label, next to two revenue figures that
        implied it was a revenue figure too.

        The counts and the money are now separated by a heading, and every tile
        says which instant places it. Nothing on this screen is a figure whose
        meaning has to be guessed.
      */}
      <h2 className="mb-1 mt-6 text-base text-ink">فروش امروز</h2>
      <p className="mb-2.5 text-xs leading-relaxed text-ink-muted">
        این بخش بر اساس <b>زمان دریافت وجه</b> است، نه زمان ثبت سفارش. سفارشی که دیروز ثبت
        شده و امروز پرداخت شده، اینجا در «امروز» می‌آید.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="تعداد فروش امروز"
          value={count(data.totals.salesCount)}
          hint="سفارش‌هایی که وجه آن‌ها امروز دریافت شده است — چه در فروشگاه، چه از سایت. سفارش در انتظار پرداخت، لغوشده یا ناموفق در این عدد نیست."
          tone="primary"
        />
        <StatTile
          label="تعداد کالای فروخته‌شده"
          value={count(data.totals.unitsSold)}
          hint="مجموع تعداد اقلام روی همان سفارش‌های «تعداد فروش امروز». نه اقلام سفارش‌های در انتظار پرداخت، نه اقلام مرجوع‌شده."
        />
        <StatTile
          label="مرجوعی‌های امروز"
          value={count(data.totals.refundedCount)}
          hint="تعداد سفارش‌هایی که امروز مرجوع شده‌اند. تاریخ فروش آن‌ها هر روزی می‌تواند باشد."
          tone={data.totals.refundedCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="ابطال‌های امروز"
          value={count(data.totals.voidedCount)}
          hint="تعداد فروش‌های پرداخت‌شده‌ای که امروز در صندوق ابطال شده‌اند."
          tone={data.totals.voidedCount > 0 ? "warning" : "neutral"}
        />
      </div>

      {/*
        THE MONEY LIVES BEHIND ITS OWN GATE AND ITS OWN REQUEST.
        Rendered only for the main administrator, and only then is
        `GET /admin/dashboard/financial` called at all — a delegated
        administrator's console never asks for a figure it may not have.
      */}
      <FinancialSection />

      <h2 className="mb-1 mt-6 text-base text-ink">سفارش‌های ثبت‌شده در امروز</h2>
      <p className="mb-2.5 text-xs leading-relaxed text-ink-muted">
        این بخش بر اساس <b>زمان ثبت سفارش</b> است و هیچ‌کدام از اعداد آن «فروش» نیست. با
        اعداد بخش بالا جمع نکنید: یک سفارش می‌تواند امروز ثبت شود و فردا پرداخت گردد.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="سفارش ثبت‌شده امروز"
          value={count(data.totals.ordersCreated)}
          hint="همهٔ سفارش‌هایی که امروز در سامانه ثبت شده‌اند، با هر وضعیتی. این عدد نشان می‌دهد امروز چقدر سرمان شلوغ بوده، نه اینکه چقدر فروخته‌ایم."
        />
        <StatTile
          label="از این‌ها، پرداخت‌شده"
          value={count(data.totals.ordersCreatedPaid)}
          hint="سفارش‌های امروز که وجه آن‌ها دریافت شده است. ممکن است پرداخت بعضی از آن‌ها در روز دیگری انجام شود، پس با «تعداد فروش امروز» برابر نیست."
          tone={data.totals.ordersCreatedPaid > 0 ? "success" : "neutral"}
        />
        <StatTile
          label="از این‌ها، در انتظار پرداخت"
          value={count(data.totals.ordersCreatedPending)}
          hint="سفارش‌های امروز که هنوز پولی بابت آن‌ها دریافت نشده است. اینها فروش نیستند و در هیچ‌یک از مبالغ بالا شمرده نشده‌اند."
          tone={data.totals.ordersCreatedPending > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="از این‌ها، ناموفق یا لغوشده"
          value={count(data.totals.ordersCreatedFailedOrCanceled)}
          hint="سفارش‌های امروز که پرداختشان ناموفق بوده یا لغو شده‌اند و هرگز پولی بابتشان دریافت نشده. فروشِ ابطال‌شده در این عدد نیست و جداگانه گزارش می‌شود."
          tone={data.totals.ordersCreatedFailedOrCanceled > 0 ? "danger" : "neutral"}
        />
      </div>

      <p className="mt-2.5 text-2xs leading-relaxed text-ink-subtle">
        همچنین در این لحظه{" "}
        <b data-numeric="">{count(data.pipeline.pendingWebOrders)}</b> سفارش سایت در انتظار
        پرداخت است (از هر روزی، نه فقط امروز). این‌ها سبد خرید هستند، نه فروش، و در هیچ مبلغی
        شمرده نمی‌شوند.
      </p>


      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AdminSection
          title="آخرین سفارش‌ها"
          description="هشت سفارش آخر بر اساس زمان ثبت، صرف‌نظر از وضعیت و تاریخ. ستون زمان، زمان دریافت وجه را نشان می‌دهد و اگر پولی دریافت نشده باشد، زمان ثبت سفارش را."
          actions={
            /*
              The dashboard SUMMARISES the order queue; it does not grant access
              to it. `/admin/orders` declares `orders.read`, so the shortcut is
              gated while the eight rows — which this summary already returned
              — stay readable.
            */
            <Gate permissions={["orders.read"]}>
              <Link href="/admin/orders" className="text-xs">
                همهٔ سفارش‌ها
              </Link>
            </Gate>
          }
        >
          <DataTable minWidth="30rem" caption="آخرین سفارش‌ها">
            <thead>
              <tr>
                <Th>شمارهٔ سفارش</Th>
                <Th>وضعیت</Th>
                <Th>زمان</Th>
              </tr>
            </thead>
            <tbody>
              {data.recentOrders.length === 0 ? (
                <EmptyRow colSpan={3}>هنوز سفارشی ثبت نشده است.</EmptyRow>
              ) : (
                data.recentOrders.map((order) => (
                  <Tr key={order.id}>
                    <Td>
                      <Gate
                        permissions={["orders.read"]}
                        fallback={
                          <bdi dir="ltr" data-numeric="" className="text-ink">
                            {order.orderNumber ?? `#${order.id}`}
                          </bdi>
                        }
                      >
                        <Link href={`/admin/orders/${order.id}` as Route} className="no-underline">
                          <bdi dir="ltr" data-numeric="" className="text-primary">
                            {order.orderNumber ?? `#${order.id}`}
                          </bdi>
                        </Link>
                      </Gate>
                      <span className="mt-0.5 block text-2xs text-ink-subtle">
                        {channelLabel(order.channel)}
                        {order.branchName ? ` — ${order.branchName}` : ""}
                      </span>
                    </Td>
                    <Td>
                      <Badge size="sm" tone={orderStatusTone(order.status)}>
                        {orderStatusLabel(order.status)}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="text-2xs text-ink-muted" data-numeric="">
                        {when(order.revenueAt ?? order.createdAt)}
                      </span>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </DataTable>
        </AdminSection>
      </div>

      <AdminSection
        className="mt-4"
        title="وضعیت موجودی"
        description="موجودی در این سامانه بین سایت و همهٔ شعبه‌ها مشترک است و به تفکیک شعبه نگهداری نمی‌شود."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="گونه‌های رو به اتمام"
            value={count(data.inventory.lowStockVariants)}
            hint={`موجودی قابل فروش آن‌ها ${count(data.inventory.lowStockThreshold)} عدد یا کمتر است. این یک آستانهٔ نمایشی است، نه نقطهٔ سفارش تعیین‌شده.`}
            tone={data.inventory.lowStockVariants > 0 ? "warning" : "neutral"}
          />
          <StatTile
            label="گونه‌های ناموجود"
            value={count(data.inventory.outOfStockVariants)}
            hint="موجودی قابل فروش صفر یا کمتر است؛ رزروهای فعال سبد خرید و تخصیص سفارش‌ها کسر شده‌اند."
            tone={data.inventory.outOfStockVariants > 0 ? "danger" : "neutral"}
          />
          <StatTile
            label="گونه‌های فعال"
            value={count(data.inventory.trackedVariants)}
            hint="گونه‌هایی که در حال حاضر قابل فروش‌اند و موجودی آن‌ها پیگیری می‌شود."
          />
        </div>
      </AdminSection>
    </>
  );
}

/**
 * OPERATIONAL ALERTS.
 *
 * Only conditions that need a human are rendered, each with a link to the page
 * where the work is actually done. A card that says "3 cases" and leaves the
 * manager to find the queue is a notification, not an alert.
 *
 * When nothing needs attention the section says so explicitly rather than
 * disappearing: an empty area reads as "not loaded yet".
 */
function Alerts({ data }: { data: DashboardSummary }) {
  const alerts: Array<{
    key: string;
    tone: "danger" | "warning";
    title: string;
    body: string;
    href: Route;
    action: string;
    /*
     * THE CAPABILITY THE DESTINATION DECLARES. The dashboard's own
     * `dashboard.read` says nothing about the queues these cards point at, so
     * the LINK is gated on the page it opens while the card — the count, which
     * this summary already returned — stays. Offering "بررسی پرونده‌ها" to
     * somebody the reconciliation queue will refuse is a dead end presented as
     * the next step.
     */
    permission: string;
  }> = [];

  if (data.pipeline.openReconciliationCases > 0) {
    alerts.push({
      key: "reconciliation",
      tone: "danger",
      title: `${count(data.pipeline.openReconciliationCases)} پروندهٔ مغایرت پرداخت باز است`,
      body: "در این پرونده‌ها یا پول مشتری دریافت شده و سفارش کامل نشده، یا وجهی رسیده که به سفارشی نخورده است. تا زمانی که بررسی نشوند، تکلیف پول مشتری روشن نیست.",
      href: "/admin/reconciliation" as Route,
      action: "بررسی پرونده‌ها",
      permission: "reconciliation.read",
    });
  }
  if (data.pipeline.refundRequiredCases > 0) {
    alerts.push({
      key: "refund",
      tone: "danger",
      title: `${count(data.pipeline.refundRequiredCases)} پرونده در انتظار بازپرداخت است`,
      body: "برای این پرونده‌ها تصمیم به بازپرداخت گرفته شده اما هنوز تأیید نشده که در پنل درگاه پرداخت انجام شده باشد.",
      href: "/admin/reconciliation" as Route,
      action: "دیدن پرونده‌ها",
      permission: "reconciliation.read",
    });
  }
  if (data.pipeline.awaitingFulfilment > 0) {
    alerts.push({
      key: "fulfilment",
      tone: "warning",
      title: `${count(data.pipeline.awaitingFulfilment)} سفارش پرداخت‌شده در انتظار کسر موجودی است`,
      body: "مشتری پول را پرداخت کرده ولی کالا هنوز از انبار کسر نشده است — معمولاً چون موجودی کافی نبوده.",
      href: "/admin/orders?fulfillmentState=awaiting_stock" as Route,
      action: "دیدن سفارش‌ها",
      permission: "orders.read",
    });
  }
  if (data.pipeline.fulfilmentFailed > 0) {
    alerts.push({
      key: "failed",
      tone: "danger",
      title: `${count(data.pipeline.fulfilmentFailed)} سفارش در کسر موجودی شکست خورده است`,
      body: "تلاش خودکار برای کسر موجودی این سفارش‌ها ناموفق بوده و نیاز به بررسی دستی دارد.",
      href: "/admin/orders?fulfillmentState=failed" as Route,
      action: "دیدن سفارش‌ها",
      permission: "orders.read",
    });
  }
  if (data.inventory.outOfStockVariants > 0) {
    alerts.push({
      key: "oos",
      tone: "warning",
      title: `${count(data.inventory.outOfStockVariants)} گونهٔ کالا ناموجود است`,
      body: "این کالاها در سایت و صندوق قابل فروش نیستند تا زمانی که موجودی آن‌ها اصلاح شود.",
      href: "/admin/inventory?stockState=out_of_stock" as Route,
      action: "اصلاح موجودی",
      permission: "inventory.read",
    });
  }
  if (data.pipeline.pendingWebOrders > 0) {
    alerts.push({
      key: "pending",
      tone: "warning",
      title: `${count(data.pipeline.pendingWebOrders)} سفارش سایت در انتظار پرداخت است`,
      body: "این‌ها هنوز فروش نیستند و در مبلغ فروش امروز شمرده نشده‌اند؛ سبدهای رهاشده هم در همین دسته‌اند.",
      href: "/admin/orders?status=pending&channel=online" as Route,
      action: "دیدن سفارش‌ها",
      permission: "orders.read",
    });
  }

  if (alerts.length === 0) {
    return (
      <div className="rounded-lg border border-success/40 bg-success-soft/50 p-4 text-sm text-ink">
        هیچ مورد نیازمند اقدامی وجود ندارد — نه پروندهٔ مغایرت باز است، نه سفارشی در انتظار کسر
        موجودی، و نه کالای ناموجودی.
      </div>
    );
  }

  return (
    <section aria-label="موارد نیازمند اقدام" className="grid gap-3 md:grid-cols-2">
      {alerts.map((alert) => (
        <div
          key={alert.key}
          className={cx(
            "flex min-w-0 gap-3 rounded-lg border p-4",
            alert.tone === "danger"
              ? "border-danger/40 bg-danger-soft/50"
              : "border-warning/40 bg-warning-soft/50",
          )}
        >
          <AlertIcon
            className={cx(
              "mt-0.5 size-5 shrink-0",
              alert.tone === "danger" ? "text-danger" : "text-warning",
            )}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">{alert.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{alert.body}</p>
            <Gate permissions={[alert.permission]}>
              <p className="mt-2">
                <Link href={alert.href} className="text-xs font-bold">
                  {alert.action} ←
                </Link>
              </p>
            </Gate>
          </div>
        </div>
      ))}
    </section>
  );
}

/** `YYYY-MM-DD` (Gregorian, from the API) rendered as a Jalali date. */
function toJalali(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { dateStyle: "full" }).format(date);
}

/**
 * ===========================================================================
 * TODAY'S MONEY — the main administrator only
 * ===========================================================================
 *
 * A SEPARATE COMPONENT WITH A SEPARATE REQUEST, not a hidden block inside the
 * dashboard payload. `dashboard.read` is delegatable and a shift supervisor is
 * meant to hold it; today's gross, refunds, voids, net, the per-channel and
 * per-BRANCH revenue split and the best sellers by revenue are not delegable —
 * the owner's rule puts them with the main administrator, alongside the sales
 * reports.
 *
 * `GET /admin/dashboard/financial` carries `@Roles(super_admin)` and
 * `@Audiences('admin')`, the same gate `/reports/*` carries. This component
 * renders nothing and ISSUES NO REQUEST for anyone else, so a delegated
 * administrator's console never asks for a figure it may not have and never
 * collects a 403 it did not need to see.
 *
 * Hiding it is not the control. The API refuses.
 */
function FinancialSection() {
  const api = useApi();
  const { session } = useAppSession();
  const maySeeMoney = isSuperAdmin(session);

  const { data: financial, error } = useApiQuery(
    (signal) => fetchDashboardFinancial(api, { signal }),
    [api],
    { enabled: maySeeMoney },
  );

  if (!maySeeMoney) return null;

  if (error) {
    // A role edited while this tab was open. Say so plainly rather than
    // offering a retry that cannot succeed.
    return (
      <Notice tone="warning" className="mt-6">
        <p>
          ارقام مالی امروز خوانده نشد. دیدن آن‌ها تنها در اختیار مدیر ارشد است؛ اگر نقش شما
          همین حالا تغییر کرده باشد، این بخش دیگر برای شما باز نمی‌شود.
        </p>
      </Notice>
    );
  }

  if (!financial) {
    return <Skeleton className="mt-6" shape="block" height="12rem" />;
  }

  return (
    <>
      <h2 className="mb-1 mt-6 text-base text-ink">پول دریافتی امروز</h2>
      <p className="mb-2.5 text-xs leading-relaxed text-ink-muted">
        این بخش بر اساس <b>زمان دریافت وجه</b> است، نه زمان ثبت سفارش. سفارشی که دیروز ثبت
        شده و امروز پرداخت شده، اینجا در «امروز» می‌آید؛ سفارشی که امروز ثبت شده و فردا
        پرداخت شود، فردا اینجا دیده می‌شود. تعدادها در بخش «فروش امروز» بالاتر است؛ اینجا
        فقط مبلغ‌هاست.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="فروش ناخالص امروز"
          value={formatRialString(financial.money.grossSales)}
          hint="مجموع مبلغ سفارش‌هایی که وجه آن‌ها امروز دریافت شده است. مرجوعی و ابطال هنوز از این عدد کسر نشده. سفارش‌های در انتظار پرداخت در آن نیستند."
          tone="primary"
        />
        <StatTile
          label="فروش خالص امروز"
          value={formatRialString(financial.money.netSales)}
          hint="فروش ناخالص، منهای مرجوعی‌ها و ابطال‌هایی که امروز ثبت شده‌اند. مرجوعیِ یک فروشِ هفتهٔ پیش، از روزِ مرجوع‌شدن کسر می‌شود نه از روز فروش."
          tone="success"
        />
        <StatTile
          label="مرجوعی‌های امروز"
          value={formatRialString(financial.money.refundedTotal)}
          hint="مبلغ سفارش‌هایی که امروز مرجوع شده‌اند. تاریخ فروش آن‌ها هر روزی می‌تواند باشد؛ مبلغ از فروش خالصِ امروز کسر شده است."
          tone={isZeroRialString(financial.money.refundedTotal) ? "neutral" : "warning"}
        />
        <StatTile
          label="ابطال‌های امروز"
          value={formatRialString(financial.money.voidedTotal)}
          hint="مبلغ فروش‌های پرداخت‌شده‌ای که امروز در صندوق ابطال شده‌اند. مانند مرجوعی، از فروش خالصِ امروز کسر می‌شود، نه از روزی که فروخته شده بود."
          tone={isZeroRialString(financial.money.voidedTotal) ? "neutral" : "warning"}
        />
      </div>
      {financial.profit ? <ProfitTiles profit={financial.profit} /> : null}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AdminSection
          title="فروش به تفکیک کانال"
          description="سایت در برابر صندوق فروشگاه، بر اساس زمان دریافت وجه — نه زمان ثبت سفارش. مرجوعی و ابطالِ امروز از ستون «فروش خالص» کسر شده است."
        >
          {financial.byChannel.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-subtle">امروز هنوز فروشی ثبت نشده است.</p>
          ) : (
            <DataTable minWidth="24rem" caption="فروش به تفکیک کانال">
              <thead>
                <tr>
                  <Th>کانال</Th>
                  <Th numeric>تعداد فروش</Th>
                  <Th numeric>تعداد کالا</Th>
                  <Th numeric>فروش خالص</Th>
                </tr>
              </thead>
              <tbody>
                {financial.byChannel.map((row) => (
                  <Tr key={row.channel}>
                    <Td>{channelLabel(row.channel)}</Td>
                    <Td numeric>{count(row.salesCount)}</Td>
                    <Td numeric>{count(row.unitsSold)}</Td>
                    <Td numeric>{formatRialString(row.netSales)}</Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </AdminSection>

        <AdminSection
          title="فروش به تفکیک شعبه"
          description="بر اساس زمان دریافت وجه. سفارش‌های اینترنتی شعبه ندارند و در ردیف «بدون شعبه» می‌آیند."
        >
          {financial.byBranch.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-subtle">امروز هنوز فروشی ثبت نشده است.</p>
          ) : (
            <DataTable minWidth="24rem" caption="فروش به تفکیک شعبه">
              <thead>
                <tr>
                  <Th>شعبه</Th>
                  <Th numeric>تعداد فروش</Th>
                  <Th numeric>فروش خالص</Th>
                </tr>
              </thead>
              <tbody>
                {financial.byBranch.map((row) => (
                  <Tr key={row.branchId ?? "none"}>
                    <Td>{row.branchName ?? "بدون شعبه (سایت)"}</Td>
                    <Td numeric>{count(row.salesCount)}</Td>
                    <Td numeric>{formatRialString(row.netSales)}</Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </AdminSection>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AdminSection
          title="پرفروش‌ترین کالاهای امروز"
          description="فقط اقلام سفارش‌هایی که وجه آن‌ها امروز دریافت شده است. عنوان و کد کالا همان چیزی است که روی فاکتور بوده، نه کاتالوگ امروز — تغییر نام کالا سابقه را عوض نمی‌کند."
        >
          {financial.topVariants.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-subtle">امروز هنوز کالایی فروخته نشده است.</p>
          ) : (
            <ol className="space-y-2">
              {financial.topVariants.map((variant, index) => (
                <li
                  key={`${variant.variantId ?? "none"}-${index}`}
                  className="flex items-center gap-3 rounded-md border border-line p-3"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-7 shrink-0 place-items-center rounded-pill bg-primary-soft text-xs font-bold text-primary"
                    data-numeric=""
                  >
                    {count(index + 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">
                      {variant.productTitle}
                    </span>
                    {variant.sku ? (
                      <bdi
                        dir="ltr"
                        data-numeric=""
                        className="block truncate text-2xs text-ink-subtle"
                      >
                        {variant.sku}
                      </bdi>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-end">
                    <span className="block text-sm font-bold text-ink" data-numeric="">
                      {count(variant.unitsSold)} عدد
                    </span>
                    <span className="block text-2xs text-ink-subtle" data-numeric="">
                      {formatRialString(variant.grossSales)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </AdminSection>
      </div>
    </>
  );
}

/**
 * TODAY'S GROSS PROFIT — rendered only when the API sends the `profit` block.
 *
 * Gross, never net (docs/PURCHASE-COST-ACCOUNTING.md §1): no expense is
 * modelled. `grossProfit` covers only sales whose purchase cost is known, so
 * the coverage and the unknown-cost revenue sit beside it, and a null profit
 * is a dash rather than a zero.
 */
function ProfitTiles({ profit }: { profit: DashboardProfit }) {
  const incomplete = !isZeroRialString(profit.unknownNetRevenue);
  return (
    <>
      <h3 className="mb-1 mt-5 text-sm text-ink">سود ناخالص امروز</h3>
      <p className="mb-2.5 text-xs leading-relaxed text-ink-muted">
        سود ناخالص است، نه سود خالص: فقط بهای خرید کالا از درآمد کم شده و هزینه‌هایی مانند اجاره،
        حقوق و ارسال در آن نیست.{" "}
        <Link href={adminProfitReportHref()}>گزارش کامل سود ناخالص ←</Link>
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="سود ناخالص امروز"
          value={profit.grossProfit === null ? "—" : formatRialString(profit.grossProfit)}
          hint="درآمد خالص فروش‌های دارای قیمت خرید معلوم، منهای بهای تمام‌شدهٔ آن‌ها."
          tone="success"
        />
        <StatTile
          label="حاشیه سود ناخالص"
          value={formatPercentString(profit.grossMarginPercent)}
          hint="نسبت به درآمد خالصِ همان فروش‌های دارای قیمت خرید معلوم."
        />
        <StatTile
          label="پوشش اطلاعات قیمت خرید"
          value={formatPercentString(profit.coveragePercent)}
          hint={`درآمد با قیمت خرید معلوم: ${formatRialString(profit.knownNetRevenue)}`}
          tone={incomplete ? "warning" : "neutral"}
        />
        <StatTile
          label="درآمد با قیمت خرید نامعلوم"
          value={formatRialString(profit.unknownNetRevenue)}
          hint={
            incomplete
              ? "اطلاعات قیمت خرید این فروش ناقص است؛ سود قابل محاسبه نیست."
              : "همهٔ فروش‌های امروز قیمت خرید معلوم دارند."
          }
          tone={incomplete ? "warning" : "neutral"}
        />
      </div>
    </>
  );
}
