"use client";

import Link from "next/link";
import { useState } from "react";

import type { ApiError } from "@kazhal/api-client";
import { Badge, Button, Card, ErrorState, Skeleton } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { FormError, Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import {
  AdminPageHeader,
  AdminSection,
  ConfirmDialog,
  DataTable,
  EmptyRow,
  Fact,
  Gate,
  RequirePermission,
  Select,
  StatTile,
  TableSkeleton,
  Td,
  Textarea,
  Th,
  Tr,
  count,
  useMutation,
  when,
} from "@/components/admin/ui";
import { AlertIcon, ClockIcon, RefreshIcon, ScaleIcon } from "@/components/icons";
import { LineAdjustmentsPanel } from "@/components/admin/order-line-adjustments";
import {
  fetchOrder,
  fetchOrderActions,
  returnOrder,
  updateOrderStatus,
  voidOrder,
} from "@/lib/admin-api";
import type {
  AdminOrderAction,
  AdminOrderDetail as AdminOrderDetailView,
  AdminOrderItem,
  AdminOrderPayment,
  AdminOrderStatus,
} from "@/lib/admin-api";
import {
  channelLabel,
  fulfillmentStateLabel,
  fulfillmentStateTone,
  orderActionKindLabel,
  orderActionKindTone,
  orderStatusLabel,
  orderStatusTone,
  paymentReconciliationReasonLabel,
  paymentStateLabel,
  paymentStateTone,
  paymentStatusLabel,
  paymentStatusTone,
  reconciliationStateLabel,
  reconciliationStateTone,
} from "@/lib/labels";
import { formatRialString } from "@/lib/money";
import { can } from "@/lib/permissions";
import { adminCaseHref, adminOrdersHref } from "@/lib/routes";

/**
 * ===========================================================================
 * ONE ORDER, FOR THE ADMINISTRATOR
 * ===========================================================================
 *
 * ## Everything here is a SNAPSHOT, and that is the point
 *
 * The line items, the delivery address, the branch name and the seller's name
 * are all frozen columns, not relations. The API refuses to load the live
 * `addresses` row or the live catalogue row at all, because a past order whose
 * address changed when the customer tidied their address book — or whose
 * product title changed when somebody fixed a typo in the catalogue — is a
 * historical record that has been rewritten. This screen says so next to each
 * one, so an operator reading an old order knows they are reading what was
 * true then rather than what is true now.
 *
 * ## No affordance is invented here
 *
 * `allowedStatusTransitions`, `canVoid` and `canReturn` come from the server,
 * computed from the SAME conditions its mutation endpoints enforce and already
 * filtered by this caller's capabilities. Nothing on this screen re-derives
 * them: a console with its own copy of the rules drifts, and the operator finds
 * out by clicking a button and receiving a 409. So a status this order cannot
 * reach is not in the select, and the void and return buttons are absent
 * rather than disabled-with-a-tooltip.
 *
 * The 403 and 409 handlers still exist, and still say something useful. The
 * server is the authority; this screen agreeing with it is a courtesy that can
 * in principle be stale by the width of one page load.
 *
 * ## The gateway session id
 *
 * Is not served by this endpoint and must never be rendered. It is the entire
 * credential `POST /payment/verify` accepts, so the receipt panel below shows
 * the operator-quotable `refNumber` and nothing that could re-drive a payment.
 */
export function AdminOrderDetail({ orderId }: { orderId: number }) {
  return (
    <RequirePermission permissions={["orders.read"]}>
      <OrderDetailBody orderId={orderId} />
    </RequirePermission>
  );
}

function OrderDetailBody({ orderId }: { orderId: number }) {
  const api = useApi();
  const { session } = useAppSession();

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchOrder(api, orderId, { signal }),
    [api, orderId],
  );

  const mayReadHistory = can(session, "orders.actions.read");
  const history = useApiQuery(
    (signal) => fetchOrderActions(api, orderId, { limit: 100 }, { signal }),
    [api, orderId],
    { enabled: mayReadHistory },
  );

  if (error) {
    return (
      <>
        <AdminPageHeader title="سفارش" />
        <ErrorState
          error={error}
          title="این سفارش خوانده نشد"
          description={
            error.status === 404
              ? "سفارشی با این شناسه وجود ندارد."
              : "ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
          }
          onRetry={refetch}
        />
        <p className="mt-4">
          <Link href={adminOrdersHref()} className="text-sm">
            بازگشت به فهرست سفارش‌ها ←
          </Link>
        </p>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <AdminPageHeader title="سفارش" />
        <div role="status" aria-busy="true" className="space-y-4">
          <span className="kz-sr-only">در حال بارگذاری سفارش</span>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} shape="block" height="6.5rem" />
            ))}
          </div>
          <Skeleton shape="block" height="18rem" />
        </div>
      </>
    );
  }

  const refetchAll = () => {
    refetch();
    if (mayReadHistory) history.refetch();
  };

  return (
    <>
      <AdminPageHeader
        title={
          <bdi dir="ltr" data-numeric="">
            {data.orderNumber ?? `#${data.id}`}
          </bdi>
        }
        description={
          <>
            {channelLabel(data.channel)} — شناسهٔ عددی{" "}
            <bdi data-numeric="">{count(data.id)}</bdi>. همهٔ مبالغ به ریال است و همهٔ
            عنوان‌ها و نشانی‌ها، نسخهٔ ثبت‌شده در لحظهٔ فروش‌اند.
          </>
        }
        meta={
          <>
            <Badge size="sm" tone={orderStatusTone(data.status)}>
              {orderStatusLabel(data.status)}
            </Badge>
            <Badge size="sm" tone={fulfillmentStateTone(data.fulfillmentState)}>
              {fulfillmentStateLabel(data.fulfillmentState)}
            </Badge>
            <Badge size="sm" tone={paymentStateTone(data.paymentState)}>
              {paymentStateLabel(data.paymentState)}
            </Badge>
            <Badge size="sm" tone={reconciliationStateTone(data.reconciliation.state)}>
              مغایرت: {reconciliationStateLabel(data.reconciliation.state)}
            </Badge>
          </>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={refetchAll}
            leadingIcon={<RefreshIcon className="size-4" />}
          >
            به‌روزرسانی
          </Button>
        }
      />

      {data.voidedAt !== null ? (
        <Notice tone="danger" className="mb-5" title="این سفارش ابطال شده است">
          <p>
            ابطال در <bdi data-numeric="">{when(data.voidedAt)}</bdi> ثبت شده است. اقلام آن به
            انبار برگشته و این فروش از آمار حذف شده است؛ وضعیت سفارش دیگر قابل تغییر نیست.
          </p>
        </Notice>
      ) : null}

      {/*
        A non-null reconciliation state means a human decision is attached to
        this order's money. Linking straight to the case is the difference
        between telling the operator there is a problem and showing them where
        it is handled.
      */}
      {data.reconciliation.state !== null ? (
        <Notice
          tone={data.reconciliation.state === "refund_required" ? "danger" : "warning"}
          className="mb-5"
          icon={<ScaleIcon className="size-5" />}
          title="این سفارش پروندهٔ مغایرت پرداخت دارد"
          action={
            /*
              THE WARNING IS FOR EVERY ORDER READER; THE DESTINATION IS NOT.
              `/admin/reconciliation/:orderId` declares `reconciliation.read`,
              which `orders.read` does not include — so the notice still says
              the order has a case, and only the link is withheld.
            */
            <Gate permissions={["reconciliation.read"]}>
              <Link href={adminCaseHref(data.id)} className="text-sm font-bold no-underline">
                دیدن پرونده ←
              </Link>
            </Gate>
          }
        >
          <p>
            وضعیت پرونده: <b>{reconciliationStateLabel(data.reconciliation.state)}</b>
            {data.reconciliation.resolvedAt ? (
              <>
                {" "}
                — بسته‌شده در{" "}
                <bdi data-numeric="">{when(data.reconciliation.resolvedAt)}</bdi>
              </>
            ) : null}
            . تعیین تکلیف پول در صفحهٔ پرونده انجام می‌شود، نه اینجا.
          </p>
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="مبلغ پرداختی مشتری"
          value={formatRialString(data.totalPrice)}
          hint="مبلغ نهایی سفارش، همان‌طور که در لحظهٔ فروش ثبت شده است."
          tone="primary"
        />
        <StatTile
          label="جمع اقلام"
          value={formatRialString(data.subtotal)}
          hint="مجموع مبلغ خطوط سفارش، پیش از تخفیف سطح سفارش."
        />
        <StatTile
          label="تعداد اقلام / کالا"
          value={`${count(data.itemCount)} / ${count(data.unitCount)}`}
          hint="شمار خطوط مجزا، و مجموع تعداد واحدهای فروخته‌شده."
        />
        <StatTile
          label="تاریخ فروش"
          value={when(data.soldAt)}
          hint={
            data.paidAt
              ? `دریافت وجه: ${when(data.paidAt)}`
              : "وجهی برای این سفارش دریافت نشده است."
          }
        />
      </div>

      <OrderActions order={data} onDone={refetchAll} />

      <ItemsPanel items={data.items} />

      {/* super_admin only; renders and requests nothing for anybody else. */}
      <LineAdjustmentsPanel orderId={data.id} onDone={refetchAll} />

      {data.channel === "online" ? <CustomerPanel order={data} /> : <SellerPanel order={data} />}

      <PaymentsPanel payments={data.payments} />

      <FulfilmentPanel order={data} />

      <HistoryPanel
        mayRead={mayReadHistory}
        rows={history.data?.data}
        total={history.data?.total}
        isLoading={history.isLoading}
        error={history.error}
        onRetry={history.refetch}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * WHAT THE OPERATOR MAY DO — and nothing else.
 *
 * Each action is offered only when the server said it is possible AND the
 * caller holds its capability. The two are separate questions and the copy
 * keeps them separate: "you may not do this" and "this order cannot have this
 * done to it" are different sentences, and telling an operator the first when
 * the second is true sends them to ask for a permission that would not help.
 */
function OrderActions({
  order,
  onDone,
}: {
  order: AdminOrderDetailView;
  onDone: () => void;
}) {
  const api = useApi();
  const { session } = useAppSession();

  const mayChangeStatus = can(session, "orders.status.update");
  const mayVoid = can(session, "orders.void");
  const mayReturn = can(session, "orders.return");

  const [target, setTarget] = useState<string>("");
  const [reason, setReason] = useState("");
  const [dialog, setDialog] = useState<"status" | "void" | "return" | null>(null);

  const status = useMutation((next: AdminOrderStatus) =>
    updateOrderStatus(api, order.id, next),
  );
  const voiding = useMutation((note: string) =>
    voidOrder(api, order.id, note.trim() === "" ? {} : { reason: note.trim() }),
  );
  const returning = useMutation((note: string) =>
    returnOrder(api, order.id, note.trim() === "" ? {} : { reason: note.trim() }),
  );

  const close = () => setDialog(null);

  /*
   * One success banner and one error for the whole panel, keyed off whichever
   * mutation last ran. Three separate banners would let a stale "voided
   * successfully" sit under a failed return.
   */
  const pending = status.isPending || voiding.isPending || returning.isPending;
  const failure = status.error ?? voiding.error ?? returning.error;
  const success = status.done ?? voiding.done ?? returning.done;

  function clearMessages() {
    status.setDone(null);
    voiding.setDone(null);
    returning.setDone(null);
    status.setError(undefined);
    voiding.setError(undefined);
    returning.setError(undefined);
  }

  async function runStatus() {
    if (target === "") return;
    clearMessages();
    const result = await status.run(target as AdminOrderStatus);
    if (result) {
      status.setDone("وضعیت سفارش تغییر کرد و در تاریخچهٔ سفارش به نام شما ثبت شد.");
      setTarget("");
      close();
      onDone();
    }
  }

  async function runVoid() {
    clearMessages();
    const result = await voiding.run(reason);
    if (result) {
      voiding.setDone("سفارش ابطال شد و اقلام آن به موجودی انبار برگشت.");
      setReason("");
      close();
      onDone();
    }
  }

  async function runReturn() {
    clearMessages();
    const result = await returning.run(reason);
    if (result) {
      returning.setDone(
        "مرجوعی ثبت شد و اقلام به انبار برگشت. بازپرداخت وجه به مشتری هنوز انجام نشده است.",
      );
      setReason("");
      close();
      onDone();
    }
  }

  const nothingOffered =
    order.allowedStatusTransitions.length === 0 && !order.canVoid && !order.canReturn;

  return (
    <AdminSection
      className="mt-4"
      title="اقدام‌ها"
      description="هر اقدام فقط زمانی نمایش داده می‌شود که سرور اعلام کرده باشد برای این سفارش و برای حساب شما پذیرفته می‌شود."
    >
      {success ? (
        <Notice tone="success" className="mb-4">
          <p>{success}</p>
        </Notice>
      ) : null}

      <MutationFailure error={failure} orderId={order.id} />

      {nothingOffered ? (
        <p className="text-sm leading-relaxed text-ink-subtle">
          {mayChangeStatus || mayVoid || mayReturn
            ? "وضعیت فعلی این سفارش هیچ‌یک از اقدام‌های مدیریتی را نمی‌پذیرد."
            : "حساب شما اختیار تغییر وضعیت، ابطال یا ثبت مرجوعی ندارد. این صفحه فقط خواندنی است."}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------------------------------------------------------------- */}
        {order.allowedStatusTransitions.length > 0 ? (
          <div className="rounded-md border border-line p-4">
            <h3 className="text-sm font-bold text-ink">تغییر وضعیت سفارش</h3>
            <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">
              فقط وضعیت‌هایی فهرست شده‌اند که سرور از وضعیت فعلی می‌پذیرد. «لغو‌شده» و
              «بازپرداخت‌شده» در این فهرست نیستند، چون باید موجودی را برگردانند و به ابطال و
              مرجوعی واگذار شده‌اند.
            </p>
            <div className="mt-3">
              <Select
                name="targetStatus"
                label="وضعیت تازه"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                options={[
                  { value: "", label: "انتخاب کنید…" },
                  ...order.allowedStatusTransitions.map((value) => ({
                    value,
                    label: orderStatusLabel(value),
                  })),
                ]}
              />
            </div>
            <Button
              className="mt-3"
              size="sm"
              disabled={target === ""}
              onClick={() => {
                clearMessages();
                setDialog("status");
              }}
            >
              ثبت تغییر وضعیت
            </Button>
          </div>
        ) : mayChangeStatus && order.voidedAt === null ? (
          <div className="rounded-md border border-line bg-surface-muted p-4">
            <h3 className="text-sm font-bold text-ink">تغییر وضعیت سفارش</h3>
            <p className="mt-1 text-2xs leading-relaxed text-ink-muted">
              از وضعیت «{orderStatusLabel(order.status)}» هیچ وضعیت مجازی برای این سفارش وجود
              ندارد.
              {order.status === "paid" &&
              order.fulfillmentState !== "fulfilled" &&
              order.fulfillmentState !== "not_required"
                ? " سفارش پرداخت شده اما کالای آن از انبار کسر نشده است؛ تا آن زمان نمی‌تواند از «پرداخت‌شده» جلوتر برود، چون از صف بازیابی آماده‌سازی خارج می‌شد."
                : ""}
            </p>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {order.canVoid ? (
          <div className="rounded-md border border-danger/40 p-4">
            <h3 className="text-sm font-bold text-danger">ابطال سفارش</h3>
            <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">
              فروش اشتباه یا منصرف‌شده. اقلام به انبار برمی‌گردد و فروش از آمار حذف می‌شود.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="danger"
              onClick={() => {
                clearMessages();
                setReason("");
                setDialog("void");
              }}
            >
              ابطال این سفارش
            </Button>
          </div>
        ) : mayVoid ? (
          <div className="rounded-md border border-line bg-surface-muted p-4">
            <h3 className="text-sm font-bold text-ink">ابطال سفارش</h3>
            <p className="mt-1 text-2xs leading-relaxed text-ink-muted">
              {order.voidedAt !== null
                ? "این سفارش قبلاً ابطال شده است."
                : "سفارش بازپرداخت‌شده قابل ابطال نیست؛ برگشت آن پیش‌تر ثبت شده است."}
            </p>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {order.canReturn ? (
          <div className="rounded-md border border-danger/40 p-4">
            <h3 className="text-sm font-bold text-danger">ثبت مرجوعی</h3>
            <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">
              مشتری کالا را برگردانده است. اقلام به انبار برمی‌گردد و مبلغ به‌عنوان مرجوعی
              <b> امروز</b> در گزارش‌ها ثبت می‌شود.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="danger"
              onClick={() => {
                clearMessages();
                setReason("");
                setDialog("return");
              }}
            >
              ثبت مرجوعی این سفارش
            </Button>
          </div>
        ) : mayReturn ? (
          <div className="rounded-md border border-line bg-surface-muted p-4">
            <h3 className="text-sm font-bold text-ink">ثبت مرجوعی</h3>
            <p className="mt-1 text-2xs leading-relaxed text-ink-muted">
              {order.voidedAt !== null
                ? "این سفارش ابطال شده و مرجوعی روی آن ثبت نمی‌شود."
                : `سفارشی در وضعیت «${orderStatusLabel(order.status)}» قابل مرجوع‌کردن نیست؛ فقط پرداخت‌شده، در حال آماده‌سازی، ارسال‌شده و تحویل‌شده پذیرفته می‌شوند.`}
            </p>
          </div>
        ) : null}
      </div>

      {/* --- status change ------------------------------------------------ */}
      <ConfirmDialog
        open={dialog === "status"}
        onClose={close}
        onConfirm={runStatus}
        tone="neutral"
        isPending={pending}
        confirmLabel="بله، وضعیت را تغییر بده"
        title={`تغییر وضعیت به «${orderStatusLabel(target)}»`}
        question={`وضعیت این سفارش از «${orderStatusLabel(order.status)}» به «${orderStatusLabel(target)}» تغییر می‌کند.`}
        consequences={[
          "سفارش را در چرخهٔ عمر خود جلو می‌برد و وضعیت تازه روی سفارش ثبت می‌شود.",
          "هیچ پولی جابه‌جا نمی‌شود: نه مبلغی از مشتری گرفته می‌شود و نه به او برگردانده می‌شود.",
          "هیچ تغییری در موجودی انبار ایجاد نمی‌کند؛ نه کالایی کسر می‌شود و نه به انبار برمی‌گردد.",
          "این اقدام در تاریخچهٔ همین سفارش، به نام شما ثبت می‌شود.",
          "پس از ثبت، فهرست وضعیت‌های مجاز دوباره از سرور خوانده می‌شود؛ اینکه بتوانید به وضعیت قبلی برگردید به ماشین وضعیت سفارش بستگی دارد و تضمین‌شده نیست.",
        ]}
      />

      {/* --- void --------------------------------------------------------- */}
      <ConfirmDialog
        open={dialog === "void"}
        onClose={close}
        onConfirm={runVoid}
        tone="danger"
        isPending={pending}
        confirmPhrase="ابطال"
        confirmLabel="بله، این سفارش را ابطال کن"
        title="ابطال سفارش"
        question="این کار برگشت‌پذیر نیست. پیش از تأیید، پیامدها را بخوانید."
        consequences={[
          "همهٔ اقلام این سفارش به موجودی انبار برمی‌گردد.",
          "این فروش از آمار و گزارش فروش حذف می‌شود.",
          "وضعیت سفارش به «لغو‌شده» تغییر می‌کند و پس از آن دیگر قابل تغییر نیست.",
          "هیچ پولی به‌طور خودکار به مشتری برگردانده نمی‌شود؛ بازگرداندن وجه خارج از این سامانه انجام می‌شود.",
          "این اقدام برگشت‌پذیر نیست؛ راهی برای «لغو ابطال» در این سامانه وجود ندارد.",
          "به نام شما در تاریخچهٔ سفارش ثبت می‌شود.",
        ]}
      >
        <Textarea
          name="voidReason"
          label="دلیل (اختیاری)"
          hint="روی ردیف تاریخچهٔ سفارش، در کنار نام شما، ذخیره می‌شود."
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </ConfirmDialog>

      {/* --- return ------------------------------------------------------- */}
      <ConfirmDialog
        open={dialog === "return"}
        onClose={close}
        onConfirm={runReturn}
        tone="danger"
        isPending={pending}
        confirmPhrase="مرجوعی"
        confirmLabel="بله، مرجوعی را ثبت کن"
        title="ثبت مرجوعی سفارش"
        question="این کار برگشت‌پذیر نیست. پیش از تأیید، پیامدها را بخوانید."
        consequences={[
          "همهٔ اقلام این سفارش به موجودی انبار برمی‌گردد.",
          "مبلغ سفارش به‌عنوان مرجوعی در گزارش‌ها ثبت می‌شود، با تاریخ امروز — نه با تاریخ فروش اصلی.",
          "وضعیت سفارش به «بازپرداخت‌شده» تغییر می‌کند.",
          "این اقدام برگشت‌پذیر نیست.",
          "ثبت مرجوعی در اینجا هیچ پولی را جابه‌جا نمی‌کند. بازپرداخت واقعی به مشتری باید در پنل خودِ درگاه پرداخت انجام شود؛ در این سامانه هیچ رابط بازپرداخت درگاهی وجود ندارد.",
          "به نام شما در تاریخچهٔ سفارش ثبت می‌شود.",
        ]}
      >
        <Textarea
          name="returnReason"
          label="دلیل (اختیاری)"
          hint="روی ردیف تاریخچهٔ سفارش، در کنار نام شما، ذخیره می‌شود."
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </ConfirmDialog>
    </AdminSection>
  );
}

/**
 * A mutation failure, in Persian.
 *
 * Every message the orders API sends is ENGLISH — they are written for POS
 * vendors reading the OpenAPI document, not for a store manager — so a bare
 * `<FormError>` here would put an English sentence in front of somebody who
 * cannot act on it. The branches below cover the refusals this screen can
 * actually provoke and say what to DO; anything else falls through to the
 * server's own text rather than being replaced by a vague apology that hides
 * information a support call would need.
 */
function MutationFailure({
  error,
  orderId,
}: {
  error: unknown;
  orderId: number;
}) {
  if (!error) return null;
  const api = error as ApiError;

  if (api?.status === 403) {
    const missing = api.details?.missingPermissions;
    return (
      <Notice tone="danger" className="mb-4" title="حساب شما اختیار این اقدام را ندارد">
        <p>
          سرور این درخواست را رد کرد. پنهان‌بودن یا نبودن دکمه در این تصمیم نقشی ندارد — هر
          درخواست در سرور دوباره بررسی می‌شود. از مدیر ارشد بخواهید اختیار لازم را به نقش شما
          اضافه کند.
        </p>
        {Array.isArray(missing) && missing.length > 0 ? (
          <p className="mt-2 flex flex-wrap gap-1.5">
            {missing.map((code) => (
              <Badge key={String(code)} size="sm" tone="neutral">
                <bdi dir="ltr">{String(code)}</bdi>
              </Badge>
            ))}
          </p>
        ) : null}
      </Notice>
    );
  }

  if (api?.code === "ORDER_FULFILMENT_INCOMPLETE") {
    return (
      <Notice tone="warning" className="mb-4" title="کالای این سفارش هنوز از انبار کسر نشده">
        <p>
          سفارش پرداخت شده است، اما موجودی آن تخصیص نیافته؛ بنابراین نمی‌تواند از
          «پرداخت‌شده» جلوتر برود. جلو بردن آن سفارش را برای همیشه از صف بازیابی آماده‌سازی
          خارج می‌کرد، پس سرور هیچ تغییری ثبت نکرد. از صفحهٔ مغایرت پرداخت آن را تعیین تکلیف
          کنید یا تا انجام آماده‌سازی صبر کنید، سپس دوباره تلاش کنید.
        </p>
        <Gate permissions={["reconciliation.read"]}>
          <p className="mt-2">
            <Link href={adminCaseHref(orderId)} className="text-sm font-bold no-underline">
              رفتن به پروندهٔ مغایرت این سفارش ←
            </Link>
          </p>
        </Gate>
      </Notice>
    );
  }

  if (api?.code === "ORDER_HAS_LINE_ADJUSTMENTS") {
    return (
      <Notice tone="warning" className="mb-4" title="این سفارش برگشت یا بازپرداخت جزئی دارد">
        <p>
          پس از اولین برگشت جزئی، ابطال یا مرجوعیِ کل سفارش ممکن نیست تا هیچ فروشی دو بار برگشت
          نخورد. باقی اقلام را مدیر کل از بخش «برگشت و بازپرداخت اقلام» همین صفحه برگشت می‌زند. هیچ
          تغییری ثبت نشد.
        </p>
      </Notice>
    );
  }

  if (api?.status === 409) {
    return (
      <Notice tone="warning" className="mb-4" title="وضعیت فعلی سفارش این اقدام را نمی‌پذیرد">
        <p>
          سرور این اقدام را رد کرد، یعنی وضعیت سفارش از زمان باز شدن این صفحه عوض شده است —
          احتمالاً کسی دیگر روی همین سفارش کاری کرده. صفحه را به‌روز کنید تا فهرست اقدام‌های
          ممکن دوباره از سرور خوانده شود. هیچ تغییری ثبت نشد.
        </p>
      </Notice>
    );
  }

  if (api?.status === 404) {
    return (
      <Notice tone="danger" className="mb-4" title="این سفارش پیدا نشد">
        <p>ممکن است شناسهٔ سفارش درست نباشد. به فهرست سفارش‌ها برگردید و دوباره باز کنید.</p>
      </Notice>
    );
  }

  if (api?.status === 0) {
    return (
      <Notice tone="danger" className="mb-4" title="ارتباط با سرور برقرار نشد">
        <p>
          درخواست به سرور نرسید، پس هیچ تغییری ثبت نشده است. اتصال شبکه را بررسی کنید و دوباره
          تلاش کنید.
        </p>
      </Notice>
    );
  }

  return <FormError error={error} className="mb-4" />;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function ItemsPanel({ items }: { items: AdminOrderItem[] }) {
  return (
    <AdminSection
      className="mt-4"
      title="اقلام سفارش"
      description="عنوان، کد کالا و ویژگی‌های هر خط، نسخهٔ منجمدشده در لحظهٔ فروش است و با تغییر کاتالوگ عوض نمی‌شود — تغییر نام یا قیمت کالا، سابقهٔ این سفارش را بازنویسی نمی‌کند."
    >
      <DataTable minWidth="44rem" caption="اقلام سفارش">
        <thead>
          <tr>
            <Th>کالا</Th>
            <Th>ویژگی‌ها</Th>
            <Th numeric>تعداد</Th>
            <Th numeric>قیمت واحد</Th>
            <Th numeric>مبلغ خط</Th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={5}>این سفارش هیچ خط کالایی ندارد.</EmptyRow>
          ) : (
            items.map((item) => (
              <Tr key={item.id}>
                <Td>
                  <span className="block font-bold text-ink">{item.productTitleSnapshot}</span>
                  {item.variantSkuSnapshot ? (
                    <bdi dir="ltr" data-numeric="" className="block text-2xs text-ink-subtle">
                      {item.variantSkuSnapshot}
                    </bdi>
                  ) : null}
                </Td>
                <Td>
                  {item.attributesSnapshot && Object.keys(item.attributesSnapshot).length > 0 ? (
                    <span className="text-xs text-ink-muted">
                      {Object.entries(item.attributesSnapshot)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" · ")}
                    </span>
                  ) : (
                    <span className="text-ink-subtle">—</span>
                  )}
                </Td>
                <Td numeric>{count(item.quantity)}</Td>
                <Td numeric>{formatRialString(item.unitPrice)}</Td>
                <Td numeric className="font-bold">
                  {formatRialString(item.totalPrice)}
                </Td>
              </Tr>
            ))
          )}
        </tbody>
      </DataTable>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Customer and delivery (web orders)
// ---------------------------------------------------------------------------

function CustomerPanel({ order }: { order: AdminOrderDetailView }) {
  const address = order.address;
  /*
   * `capturedAt === null` marks a pre-migration row whose address text was
   * RECONSTRUCTED from the customer's address book, not captured at checkout.
   * `backfilled` is the entity's own flag for the same condition. Either one
   * means the same thing and it has to be said out loud: an operator resolving
   * a delivery dispute must not read a reconstruction as evidence.
   */
  const reconstructed = address !== null && (address.capturedAt === null || address.backfilled === true);

  return (
    <AdminSection
      className="mt-4"
      title="مشتری و تحویل"
      description="نشانی زیر همان نشانی‌ای است که در لحظهٔ تسویه ثبت شده — نه ردیف فعلی دفتر نشانی‌های مشتری. مشتری می‌تواند نشانی خود را بعداً ویرایش یا حذف کند و این متن تغییر نمی‌کند."
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="حساب فروشگاه">
          {order.user ? (
            <bdi dir="ltr">{order.user.identifier}</bdi>
          ) : (
            <span className="text-ink-subtle">بدون حساب فروشگاه</span>
          )}
        </Fact>
        <Fact label="نام مشتری">
          {order.customer?.name ?? <span className="text-ink-subtle">ثبت‌نشده</span>}
        </Fact>
        <Fact label="شمارهٔ موبایل مشتری" numeric>
          {order.customer ? <bdi dir="ltr">{order.customer.mobile}</bdi> : "—"}
        </Fact>
      </dl>

      {address === null ? (
        <p className="mt-4 text-sm text-ink-subtle">
          برای این سفارش هیچ نشانی تحویلی ثبت نشده است.
        </p>
      ) : (
        <>
          {reconstructed ? (
            <Notice tone="warning" className="mt-4" title="این نشانی بازسازی‌شده است">
              <p>
                این ردیف پیش از افزودن ستون نشانیِ منجمد ثبت شده و متن آن با یک مهاجرت داده
                بازسازی شده است. پس <b>ادعایی درباره آنچه نشانی در زمان ثبت سفارش می‌گفته
                نیست</b> و نباید به‌عنوان مدرک در اختلاف تحویل به آن استناد شود.
              </p>
            </Notice>
          ) : null}

          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="استان">{address.province}</Fact>
            <Fact label="شهر">{address.city}</Fact>
            <Fact label="کد پستی" numeric>
              <bdi dir="ltr">{address.postalCode}</bdi>
            </Fact>
            <Fact
              label="نشانی"
              hint="متن نشانی همان‌طور که در لحظهٔ تسویه ثبت شده است."
            >
              {address.address}
            </Fact>
            <Fact label="موبایل گیرنده" numeric>
              <bdi dir="ltr">{address.receiverMobile}</bdi>
            </Fact>
            <Fact
              label="زمان ثبت نشانی"
              numeric
              hint={
                address.capturedAt === null
                  ? "خالی‌بودن این مقدار یعنی نشانی در لحظهٔ تسویه ثبت نشده و بازسازی شده است."
                  : "شناسهٔ ردیف اصلی نشانی فقط برای رهگیری است؛ آن ردیف ممکن است بعداً ویرایش یا حذف شده باشد."
              }
            >
              {when(address.capturedAt)}
            </Fact>
          </dl>
        </>
      )}
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Seller and branch (POS orders)
// ---------------------------------------------------------------------------

function SellerPanel({ order }: { order: AdminOrderDetailView }) {
  return (
    <AdminSection
      className="mt-4"
      title="فروشنده و شعبه"
      description="نام فروشنده و نام شعبه، نسخهٔ ثبت‌شده در لحظهٔ فروش است. تغییر نام یا غیرفعال‌شدن آن کارمند یا آن شعبه، این سابقه را عوض نمی‌کند و حذف نمی‌شود."
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact
          label="فروشنده در لحظهٔ فروش"
          hint="کسی که فروش را زده است؛ نه کسی که بعداً آن را ابطال یا مرجوع کرده — آن اقدام‌ها در تاریخچهٔ سفارش، نام عامل خودشان را دارند."
        >
          {order.cashierDisplaySnapshot ? (
            <bdi dir="ltr">{order.cashierDisplaySnapshot}</bdi>
          ) : (
            <span className="text-ink-subtle">ثبت‌نشده</span>
          )}
        </Fact>
        <Fact label="شعبه در لحظهٔ فروش">
          {order.branchNameSnapshot ?? <span className="text-ink-subtle">بدون شعبه</span>}
        </Fact>
        <Fact
          label="شناسهٔ عددی فروشنده و شعبه"
          numeric
          hint="فقط برای رهگیری؛ ممکن است حساب یا شعبه امروز وجود نداشته باشد."
        >
          {order.cashierUserId === null ? "—" : count(order.cashierUserId)} /{" "}
          {order.branchId === null ? "—" : count(order.branchId)}
        </Fact>
        <Fact label="مشتری حضوری">
          {order.customerDisplay ? (
            <bdi>{order.customerDisplay}</bdi>
          ) : (
            <span className="text-ink-subtle">ثبت‌نشده</span>
          )}
        </Fact>
        <Fact label="شمارهٔ موبایل مشتری" numeric>
          {order.customer ? <bdi dir="ltr">{order.customer.mobile}</bdi> : "—"}
        </Fact>
      </dl>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

function PaymentsPanel({ payments }: { payments: AdminOrderPayment[] }) {
  return (
    <AdminSection
      className="mt-4"
      title="رسیدهای پرداخت"
      description="هر ردیف یک رسید است. «مبلغ درخواستی» آن است که ما خواسته‌ایم و «مبلغ اعلامی درگاه» آن است که درگاه گزارش کرده؛ نابرابری این دو، خودش یک مغایرت است. شناسهٔ نشست درگاه در این سامانه هیچ‌جا نمایش داده نمی‌شود."
    >
      <DataTable minWidth="60rem" caption="رسیدهای پرداخت">
        <thead>
          <tr>
            <Th>وضعیت رسید</Th>
            <Th numeric>مبلغ درخواستی</Th>
            <Th numeric>مبلغ اعلامی درگاه</Th>
            <Th>شمارهٔ پیگیری</Th>
            <Th>زمان پرداخت</Th>
            <Th>نیازمند بررسی؟</Th>
            <Th>علت و زمان بررسی</Th>
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 ? (
            <EmptyRow colSpan={7}>
              هیچ رسیدی برای این سفارش ثبت نشده است. برای فروش حضوری نقدی این حالت طبیعی نیست
              و برای سفارش پرداخت‌نشدهٔ سایت طبیعی است.
            </EmptyRow>
          ) : (
            payments.map((payment) => (
              <Tr key={payment.id}>
                <Td>
                  <Badge size="sm" tone={paymentStatusTone(payment.status)}>
                    {paymentStatusLabel(payment.status)}
                  </Badge>
                </Td>
                <Td numeric>{formatRialString(payment.amount)}</Td>
                <Td numeric>
                  {payment.gatewayAmount === null ? (
                    <span className="text-ink-subtle">اعلام نشد</span>
                  ) : (
                    formatRialString(payment.gatewayAmount)
                  )}
                </Td>
                <Td>
                  {payment.refNumber ? (
                    <bdi dir="ltr" data-numeric="">
                      {payment.refNumber}
                    </bdi>
                  ) : (
                    <span className="text-ink-subtle">—</span>
                  )}
                </Td>
                <Td>
                  <span className="text-2xs text-ink-muted" data-numeric="">
                    {when(payment.paidAt ?? payment.createdAt)}
                  </span>
                </Td>
                <Td>
                  <Badge size="sm" tone={payment.requiresReconciliation ? "warning" : "neutral"}>
                    {payment.requiresReconciliation ? "بله" : "خیر"}
                  </Badge>
                </Td>
                <Td>
                  <span className="block text-2xs leading-relaxed text-ink-muted">
                    {paymentReconciliationReasonLabel(payment.reconciliationReason) || "—"}
                  </span>
                  {payment.reconciledAt ? (
                    <span className="mt-0.5 block text-2xs text-ink-subtle" data-numeric="">
                      بررسی‌شده در {when(payment.reconciledAt)}
                    </span>
                  ) : payment.requiresReconciliation ? (
                    <span className="mt-0.5 block text-2xs text-danger">هنوز بسته نشده</span>
                  ) : null}
                </Td>
              </Tr>
            ))
          )}
        </tbody>
      </DataTable>
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

function FulfilmentPanel({ order }: { order: AdminOrderDetailView }) {
  const { fulfilment } = order;

  return (
    <AdminSection
      className="mt-4"
      title="آماده‌سازی و کسر موجودی"
      description="وضعیت کالا، مستقل از وضعیت پول نگه داشته می‌شود. موجودی در این سامانه بین سایت و همهٔ شعبه‌ها مشترک است و به تفکیک شعبه نگهداری نمی‌شود."
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="وضعیت">
          <Badge size="sm" tone={fulfillmentStateTone(fulfilment.state)}>
            {fulfillmentStateLabel(fulfilment.state)}
          </Badge>
        </Fact>
        <Fact label="تعداد تلاش" numeric hint="شمار تلاش‌های خودکار برای کسر موجودی.">
          {count(fulfilment.attempts)}
        </Fact>
        <Fact label="آخرین تلاش" numeric>
          {when(fulfilment.lastAttemptAt)}
        </Fact>
        <Fact
          label="تلاش بعدی"
          numeric
          hint="خالی‌بودن این مقدار یعنی «هم‌اکنون موعد آن است»، نه «هیچ‌وقت»."
        >
          {when(fulfilment.nextAttemptAt)}
        </Fact>
      </dl>

      {fulfilment.lastError ? (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger-soft/40 p-3">
          <p className="flex items-center gap-2 text-xs font-bold text-danger">
            <AlertIcon className="size-4" aria-hidden="true" />
            متن خطای آخرین تلاش
          </p>
          <p className="mt-1.5 break-words text-2xs leading-relaxed text-ink" dir="ltr">
            {fulfilment.lastError}
          </p>
          <p className="mt-1.5 text-2xs text-ink-subtle">
            این متن خطای فنی داخلی است و فقط در همین صفحه نمایش داده می‌شود؛ به مشتری نشان داده
            نمی‌شود.
          </p>
        </div>
      ) : null}
    </AdminSection>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * The order's own append-only history (`order_actions`).
 *
 * A SEPARATE capability, `orders.actions.read`, so the panel says "you may not
 * read this" rather than rendering an empty box. An empty box is a lie with two
 * readings — "nothing ever happened to this order" and "you cannot see what
 * happened" — and the operator has no way to tell which one they are looking
 * at.
 */
function HistoryPanel({
  mayRead,
  rows,
  total,
  isLoading,
  error,
  onRetry,
}: {
  mayRead: boolean;
  rows: AdminOrderAction[] | undefined;
  total: number | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (!mayRead) {
    return (
      <AdminSection className="mt-4" title="تاریخچهٔ اقدام‌های سفارش">
        <Card tone="outlined" padding="md" className="text-center">
          <AlertIcon className="mx-auto size-6 text-warning" aria-hidden="true" />
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            حساب شما اختیار <bdi dir="ltr">orders.actions.read</bdi> را ندارد، پس تاریخچهٔ
            اقدام‌های این سفارش برای شما خوانده نمی‌شود. این یعنی «نمی‌بینید»، نه «چیزی ثبت
            نشده است».
          </p>
        </Card>
      </AdminSection>
    );
  }

  return (
    <AdminSection
      className="mt-4"
      title="تاریخچهٔ اقدام‌های سفارش"
      description="دفتر فقط‌افزودنیِ خودِ سفارش: چه کسی، چه کاری، از چه وضعیتی به چه وضعیتی، با چه دلیلی و در چه زمانی. قدیمی‌ترین رخداد در بالا."
    >
      {error ? (
        <ErrorState
          error={error}
          title="تاریخچهٔ این سفارش خوانده نشد"
          description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
          onRetry={onRetry}
        />
      ) : isLoading || !rows ? (
        <TableSkeleton rows={3} columns={4} />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-subtle">
          هیچ اقدام مدیریتی روی این سفارش ثبت نشده است — نه تغییر وضعیتی، نه ابطالی و نه
          مرجوعی.
        </p>
      ) : (
        <>
          <ol className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 gap-3 rounded-md border border-line p-3"
              >
                <ClockIcon className="mt-0.5 size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge size="sm" tone={orderActionKindTone(row.action)}>
                      {orderActionKindLabel(row.action)}
                    </Badge>
                    {row.fromStatus || row.toStatus ? (
                      <span className="text-xs text-ink-muted">
                        {orderStatusLabel(row.fromStatus)} ← {orderStatusLabel(row.toStatus)}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1.5 text-xs text-ink">
                    توسط{" "}
                    <b>
                      <bdi dir="ltr">{row.actorDisplaySnapshot}</bdi>
                    </b>
                    {row.actorUserId === null ? (
                      <span className="text-ink-subtle"> (حساب دیگر موجود نیست)</span>
                    ) : null}
                  </p>
                  {row.reason ? (
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      دلیل: {row.reason}
                    </p>
                  ) : null}
                  <p className="mt-1 text-2xs text-ink-subtle" data-numeric="">
                    {when(row.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {total !== undefined && total > rows.length ? (
            <p className="mt-3 text-2xs text-ink-subtle">
              <bdi data-numeric="">{count(rows.length)}</bdi> از{" "}
              <bdi data-numeric="">{count(total)}</bdi> ردیف نمایش داده شده است.
            </p>
          ) : null}
        </>
      )}
    </AdminSection>
  );
}
