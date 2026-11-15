"use client";

import Link from "next/link";
import { useState } from "react";

import type { ApiError, CustomerOrder } from "@kazhal/api-client";
import { isApiError, isMissingOrForbidden } from "@kazhal/api-client";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Money,
  Skeleton,
  formatDateTime,
  formatInteger,
} from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Breadcrumbs, FormError, Notice, Pagination, QueryBoundary } from "@/components/common";
import { BoxIcon, ClockIcon, ShieldIcon } from "@/components/icons";
import {
  REVIEW_STATE_DETAIL,
  channelLabel,
  fulfillmentStateLabel,
  fulfillmentStateTone,
  orderStatusLabel,
  orderStatusTone,
  paymentMethodLabel,
  reviewStateLabel,
} from "@/lib/labels";
import { orderHref, ordersHref } from "@/lib/routes";

/**
 * The server's real default page size for `GET /me/orders` is 10. Asking for it
 * explicitly keeps the URL's `?page=` meaningful — a client that silently used
 * a different size would produce page links that disagree with the server's own
 * `totalPages`.
 */
const ORDERS_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function OrderList({ page }: { page: number }) {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => api.orders.listMyOrders({ page, limit: ORDERS_PAGE_SIZE }, { signal }),
    [api, page],
  );

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      data={data}
      onRetry={refetch}
      label="در حال بارگذاری سفارش‌ها"
      skeleton={
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} shape="block" height="6.5rem" />
          ))}
        </div>
      }
      isEmpty={(result) => result.items.length === 0}
      empty={
        <EmptyState
          icon={<BoxIcon className="size-8" />}
          title="هنوز سفارشی ثبت نکرده‌اید"
          description="سفارش‌های شما پس از ثبت، همین‌جا با وضعیت واقعی‌شان نمایش داده می‌شوند."
          action={
            <Link href="/products" className="no-underline">
              <span className="inline-flex h-11 items-center rounded-md bg-primary px-5 font-semibold text-primary-ink">
                دیدن کالاها
              </span>
            </Link>
          }
        />
      }
    >
      {(result) => (
        <>
          <ul className="space-y-3">
            {result.items.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </ul>
          <Pagination
            className="mt-8"
            pageInfo={result.pageInfo}
            buildHref={(target) => ordersHref(target > 1 ? { page: target } : {})}
          />
        </>
      )}
    </QueryBoundary>
  );
}

function OrderRow({ order }: { order: CustomerOrder }) {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <Card as="li" tone="outlined" interactive className="relative">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-ink">
            <Link
              href={orderHref(order.id)}
              className="text-ink no-underline before:absolute before:inset-0 before:content-['']"
            >
              سفارش{" "}
              <bdi data-numeric="">{order.orderNumber ?? formatInteger(order.id)}</bdi>
            </Link>
          </h3>
          <p className="mt-1 text-xs text-ink-subtle">
            {order.soldAt ? formatDateTime(order.soldAt) : "تاریخ ثبت نامشخص"} ·{" "}
            {channelLabel(order.channel)} · <bdi data-numeric="">{formatInteger(units)}</bdi> کالا
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Money value={order.totalPrice} className="font-bold text-ink" />
          <div className="flex flex-wrap justify-end gap-1.5">
            <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
            {order.reviewState ? <Badge tone="warning">در حال بررسی</Badge> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function OrderDetail({ orderId }: { orderId: number }) {
  const api = useApi();
  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => api.orders.getMyOrder(orderId, { signal }),
    [api, orderId],
  );

  if (error) {
    // Another customer's order answers 404, identically to one that does not
    // exist. Rendering them differently would turn this page into an oracle for
    // which order ids are real.
    return (
      <>
        <ErrorState error={error} {...(isMissingOrForbidden(error) ? {} : { onRetry: refetch })} />
        <p className="mt-6 text-center">
          <Link href="/account/orders" className="text-sm">
            بازگشت به فهرست سفارش‌ها
          </Link>
        </p>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <div role="status" aria-busy="true" className="space-y-4">
        <span className="kz-sr-only">در حال بارگذاری سفارش</span>
        <Skeleton shape="block" height="9rem" />
        <Skeleton shape="block" height="14rem" />
      </div>
    );
  }

  return <OrderBody order={data} onChanged={refetch} />;
}

function OrderBody({ order, onChanged }: { order: CustomerOrder; onChanged: () => void }) {
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "حساب من", href: "/account" },
          { label: "سفارش‌ها", href: "/account/orders" },
          { label: order.orderNumber ?? `#${order.id}` },
        ]}
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl text-ink">
            سفارش <bdi data-numeric="">{order.orderNumber ?? formatInteger(order.id)}</bdi>
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {order.soldAt ? formatDateTime(order.soldAt) : "تاریخ ثبت نامشخص"} ·{" "}
            {channelLabel(order.channel)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
          <Badge tone={fulfillmentStateTone(order.fulfillmentState)}>
            {fulfillmentStateLabel(order.fulfillmentState)}
          </Badge>
        </div>
      </div>

      {/*
        The customer-safe review state. It is surfaced VERBATIM in meaning:
        `refund_in_progress` says a refund is being processed and never that one
        completed, and `under_review` never implies the goods are moving.
      */}
      {order.reviewState ? (
        <Notice tone="warning" className="mt-5" title={reviewStateLabel(order.reviewState)}>
          <p>{REVIEW_STATE_DETAIL[order.reviewState] ?? ""}</p>
        </Notice>
      ) : null}

      {order.status === "pending" ? <ContinuePayment orderId={order.id} onPaid={onChanged} /> : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
        <div className="space-y-6">
          <Card tone="outlined" as="section">
            <h2 className="text-lg text-ink">کالاهای این سفارش</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
              عنوان، کد و قیمت هر ردیف، همان چیزی است که در لحظهٔ ثبت سفارش ذخیره شده و با تغییر
              بعدی کاتالوگ عوض نمی‌شود.
            </p>

            <ul className="mt-4 divide-y divide-line">
              {order.items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{item.productTitleSnapshot}</p>
                    {item.variantSkuSnapshot ? (
                      <p className="mt-0.5 text-xs text-ink-subtle" dir="ltr" data-numeric="">
                        {item.variantSkuSnapshot}
                      </p>
                    ) : null}
                    {item.attributesSnapshot ? (
                      <p className="mt-1 text-xs text-ink-muted">
                        {Object.entries(item.attributesSnapshot)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join(" · ")}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-subtle">
                      <bdi data-numeric="">{formatInteger(item.quantity)}</bdi> ×{" "}
                      <Money value={item.unitPrice} withUnit={false} />
                    </p>
                  </div>
                  <Money value={item.totalPrice} className="text-sm font-bold text-ink" />
                </li>
              ))}
            </ul>
          </Card>

          {order.addressSnapshot ? (
            <Card tone="outlined" as="section">
              <h2 className="text-lg text-ink">نشانی تحویل</h2>
              <p className="mt-3 text-sm leading-relaxed text-ink">
                {order.addressSnapshot.province}، {order.addressSnapshot.city}
                <br />
                {order.addressSnapshot.address}
              </p>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-subtle">
                <div className="flex gap-1">
                  <dt>کد پستی</dt>
                  <dd dir="ltr" data-numeric="">
                    {order.addressSnapshot.postalCode}
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt>موبایل گیرنده</dt>
                  <dd dir="ltr" data-numeric="">
                    {order.addressSnapshot.receiverMobile}
                  </dd>
                </div>
              </dl>
              {order.addressSnapshot.capturedAt ? (
                <p className="mt-2 text-2xs text-ink-subtle">
                  این نشانی در {formatDateTime(order.addressSnapshot.capturedAt)} ذخیره شده است.
                </p>
              ) : null}
            </Card>
          ) : null}
        </div>

        <Card tone="raised" className="lg:sticky lg:top-44">
          <h2 className="text-lg text-ink">پرداخت</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-muted">جمع کالاها</dt>
              <dd>
                <Money value={order.subtotal} />
              </dd>
            </div>
            {order.discountCode ? (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">کد تخفیف</dt>
                <dd className="font-medium text-ink" dir="ltr">
                  {order.discountCode}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
              <dt className="font-semibold text-ink">مبلغ سفارش</dt>
              <dd>
                <Money value={order.totalPrice} className="text-base font-bold text-ink" />
              </dd>
            </div>
          </dl>

          <dl className="mt-4 space-y-2 border-t border-line pt-4 text-xs">
            <Timestamp label="روش پرداخت" value={paymentMethodLabel(order.paymentMethod)} />
            <Timestamp
              label="زمان دریافت وجه"
              value={order.paidAt ? formatDateTime(order.paidAt) : "هنوز پرداخت نشده"}
            />
            {order.voidedAt ? (
              <Timestamp label="زمان ابطال" value={formatDateTime(order.voidedAt)} />
            ) : null}
            {order.refundedAt ? (
              <Timestamp label="زمان بازپرداخت" value={formatDateTime(order.refundedAt)} />
            ) : null}
          </dl>

          <p className="mt-4 flex items-start gap-1.5 text-2xs leading-relaxed text-ink-subtle">
            <ShieldIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            وضعیت پول و وضعیت کالا جدا از هم دنبال می‌شوند؛ «پرداخت‌شده» به معنی «ارسال‌شده» نیست.
          </p>
        </Card>
      </div>
    </>
  );
}

function Timestamp({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="text-ink-muted">{value}</dd>
    </div>
  );
}

/**
 * Resume an unpaid order.
 *
 * `POST /payment/start` re-uses an in-flight gateway session when there is one
 * (`reused: true`), so this cannot strand a customer with two open sessions for
 * the same order. Paying somebody else's order answers 400 rather than 403 —
 * which the generic error handling below renders as the server wrote it.
 */
function ContinuePayment({ orderId, onPaid }: { orderId: number; onPaid: () => void }) {
  const api = useApi();
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);

  async function start() {
    if (isPending) return;
    setIsPending(true);
    setError(undefined);
    try {
      const result = await api.payment.start(orderId);
      window.location.assign(result.data.paymentUrl);
    } catch (cause) {
      setError(isApiError(cause) ? cause : undefined);
      setIsPending(false);
      onPaid();
    }
  }

  return (
    <Notice
      tone="info"
      className="mt-5"
      icon={<ClockIcon className="size-5" />}
      title="این سفارش هنوز پرداخت نشده است"
      action={
        <Button size="sm" isLoading={isPending} onClick={() => void start()}>
          ادامهٔ پرداخت
        </Button>
      }
    >
      <>
        <p>
          تا وقتی درگاه پرداخت را تأیید نکند، این سفارش «در انتظار پرداخت» می‌ماند و کالاها برای
          شما کنار گذاشته نشده‌اند.
        </p>
        <FormError error={error} className="mt-3" />
      </>
    </Notice>
  );
}
