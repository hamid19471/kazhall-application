"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";

import { Badge, Button, ErrorState, Input, PersianDateRangeFields, readDayRange, tehranDayEnd, tehranDayStart } from "@kazhal/ui";
import { useApi, useApiQuery } from "@kazhal/ui/api/react";

import { Notice, Pagination } from "@/components/common";
import {
  AdminPageHeader,
  DataTable,
  EmptyRow,
  FilterBar,
  Gate,
  RequirePermission,
  Select,
  TableSkeleton,
  Td,
  Th,
  Tr,
  count,
  when,
} from "@/components/admin/ui";
import { idParam, pageInfoOf } from "@/components/admin/people-shared";
import { ClipboardIcon, LayersIcon } from "@/components/icons";
import { fetchStockMovements, STOCK_MOVEMENT_REASONS } from "@/lib/admin-api";
import type { StockMovementReason } from "@/lib/admin-api";
import { stockMovementReasonLabel } from "@/lib/labels";
import { adminInventoryHref, adminMovementsHref, adminOrderHref } from "@/lib/routes";
import { enumParam, localDateParam, pageParam } from "@/lib/search-params";
import type { RawSearchParams } from "@/lib/search-params";

const PAGE_SIZE = 30;

/**
 * ===========================================================================
 * THE PHYSICAL-STOCK LEDGER
 * ===========================================================================
 *
 * `stock_movements` is APPEND-ONLY: a row is written when units enter or leave
 * the shelf and is never updated and never deleted. So this screen is the
 * complete history of the stockroom, and a correction appears as a NEW row that
 * offsets an old one — never as an edit to it. That is what makes `balanceAfter`
 * trustworthy: it is the committed physical stock immediately after that
 * movement, read back inside the writing transaction rather than recomputed
 * later from a sum.
 *
 * ## THE TWO REASONS ON A ROW, AND WHY BOTH ARE SHOWN
 *
 * `reason` is the MACHINE reason (`manual_adjustment`, `pos_sale`, …) — it is
 * what the filter accepts and what code branches on. `reasonText` is the
 * sentence a human typed when correcting stock, now stored on the ledger row
 * itself. Showing only the enum would leave a reader looking at a −۲۸ with no
 * explanation; showing only the sentence would break the filter's vocabulary.
 * So the cell renders the label, the raw enum value, and — when a person
 * actually wrote one — the sentence beneath them.
 *
 * `reasonText` is `null` for every movement the SYSTEM wrote (a sale, a
 * fulfilment, a restore): nobody authored a sentence for those, and printing a
 * generated one would make it indistinguishable from an operator's own words.
 * It is also `null` on rows written before the ledger could carry the text, so
 * the screen never claims an old adjustment had no reason — only that this
 * table does not hold it.
 *
 * ## WHY THERE IS NO SEARCH BOX
 *
 * Every filter below is an equality or a range on a narrow column. The one
 * free-text field is unindexed and empty on the overwhelming majority of rows,
 * so a substring search over it would scan the whole ledger to look at a column
 * that is almost always NULL. Narrow with the filters, then read the sentences
 * on the rows that come back.
 */
export function AdminStockMovements({ params }: { params: RawSearchParams }) {
  return (
    <RequirePermission permissions={["inventory.movements.read"]}>
      <MovementsBody params={params} />
    </RequirePermission>
  );
}

function MovementsBody({ params }: { params: RawSearchParams }) {
  const api = useApi();
  const router = useRouter();

  const page = pageParam(params);
  const variantId = idParam(params, "variantId");
  const productId = idParam(params, "productId");
  const actorUserId = idParam(params, "actorUserId");
  const orderId = idParam(params, "orderId");
  const reason = enumParam<StockMovementReason>(params, "reason", STOCK_MOVEMENT_REASONS);
  const fromDay = localDateParam(params, "from");
  const toDay = localDateParam(params, "to");

  const filters = {
    page,
    limit: PAGE_SIZE,
    ...(variantId ? { variantId } : {}),
    ...(productId ? { productId } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(orderId ? { orderId } : {}),
    ...(reason ? { reason } : {}),
    ...(fromDay ? { from: tehranDayStart(fromDay) ?? fromDay } : {}),
    ...(toDay ? { to: tehranDayEnd(toDay) ?? toDay } : {}),
  };

  const { data, error, isLoading, refetch } = useApiQuery(
    (signal) => fetchStockMovements(api, filters, { signal }),
    [api, JSON.stringify(filters)],
  );

  /** The filters as they appear in the URL, for building paging links. */
  const urlFilters = {
    variantId,
    productId,
    actorUserId,
    orderId,
    reason,
    from: fromDay,
    to: toDay,
  };

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };
    // A reversed range is refused where it is shown; nothing is swapped or sent.
    const range = readDayRange(form);
    if (range.error) return;
    router.push(
      adminMovementsHref({
        variantId: read("variantId"),
        productId: read("productId"),
        actorUserId: read("actorUserId"),
        orderId: read("orderId"),
        reason: read("reason"),
        from: range.from,
        to: range.to,
      }),
    );
  }

  return (
    <>
      <AdminPageHeader
        title="گردش موجودی"
        description="هر ورود و خروج کالا از قفسه، به ترتیب زمان و از تازه به قدیم."
        meta={
          data ? (
            <Badge tone="neutral" size="sm">
              <bdi data-numeric="">{count(data.total)}</bdi> حرکت
            </Badge>
          ) : null
        }
        actions={
          <Gate permissions={["inventory.read"]}>
            <Link href={adminInventoryHref()} className="no-underline">
              <Button variant="secondary" size="sm" leadingIcon={<LayersIcon className="size-4" />}>
                بازگشت به موجودی
              </Button>
            </Link>
          </Gate>
        }
      />

      <Notice
        tone="info"
        title="این دفتر فقط اضافه می‌شود و هرگز ویرایش نمی‌شود"
        icon={<ClipboardIcon className="size-5" />}
      >
        <p>
          هیچ ردیفی در این دفتر تغییر داده یا حذف نمی‌شود. اگر اشتباهی رخ داده باشد، اصلاح آن یک
          ردیف <b>تازه</b> است که ردیف قبلی را جبران می‌کند — نه دست‌کاری ردیف قبلی. به همین دلیل
          «موجودی پس از حرکت» قابل اعتماد است: این عدد در همان تراکنشِ نوشتن از پایگاه داده خوانده
          شده، نه بعداً از جمع‌زدن ردیف‌ها.
        </p>
        <p className="mt-1.5">
          متنی که مدیر هنگام اصلاح دستی می‌نویسد، در ستون «علت» و زیر عنوان ماشینی آن نمایش داده
          می‌شود؛ همان متن در دفتر رخدادهای مدیریتی هم ثبت می‌شود. حرکت‌هایی که سامانه خودش ثبت
          می‌کند (فروش حضوری، تأمین سفارش اینترنتی، بازگشت کالا) متن توضیحی ندارند، چون کسی آن‌ها را
          ننوشته است. ردیف‌های قدیمی‌تر از افزوده‌شدن این ستون هم متنی ندارند و توضیح آن‌ها فقط در
          دفتر رخدادهای مدیریتی است.
        </p>
      </Notice>

      <div className="mt-5">
        <FilterBar onSubmit={applyFilters} onReset={() => router.push(adminMovementsHref({}))}>
          <Input
            key={`variant-${variantId ?? ""}`}
            name="variantId"
            label="شناسهٔ گونهٔ کالا"
            defaultValue={variantId ? String(variantId) : ""}
            numeric
            inputMode="numeric"
            hint="گونه، نه کالا. از ستون «گردش این گونه» در صفحهٔ موجودی پر می‌شود."
          />
          <Input
            key={`product-${productId ?? ""}`}
            name="productId"
            label="شناسهٔ کالا"
            defaultValue={productId ? String(productId) : ""}
            numeric
            inputMode="numeric"
            hint="همهٔ حرکت‌های همهٔ گونه‌های یک کالا."
          />
          <Select
            key={`reason-${reason ?? ""}`}
            name="reason"
            label="علت حرکت"
            defaultValue={reason ?? ""}
            options={[
              { value: "", label: "همهٔ علت‌ها" },
              ...STOCK_MOVEMENT_REASONS.map((value) => ({
                value,
                label: stockMovementReasonLabel(value),
              })),
            ]}
          />
          <Input
            key={`order-${orderId ?? ""}`}
            name="orderId"
            label="شناسهٔ سفارش"
            defaultValue={orderId ? String(orderId) : ""}
            numeric
            inputMode="numeric"
            hint="هر چه یک سفارش از انبار برداشته یا به آن برگردانده است."
          />
          <Input
            key={`actor-${actorUserId ?? ""}`}
            name="actorUserId"
            label="شناسهٔ کاربر عامل"
            defaultValue={actorUserId ? String(actorUserId) : ""}
            numeric
            inputMode="numeric"
            hint="با پر کردن این فیلد، حرکت‌های خودکار سامانه (که عاملی ندارند) نمایش داده نمی‌شوند."
          />
          <PersianDateRangeFields
            key={`range-${fromDay ?? ""}-${toDay ?? ""}`}
            fromLabel="از تاریخ (شامل همان روز)"
            toLabel="تا تاریخ (شامل همان روز)"
            toHint="روز کامل، به وقت تهران."
            defaultFrom={fromDay}
            defaultTo={toDay}
          />
        </FilterBar>
      </div>

      <div className="mt-4">
        {error ? (
          <ErrorState
            error={error}
            title="دفتر گردش موجودی خوانده نشد"
            description="ارتباط با سرور برقرار نشد یا پاسخی دریافت نشد."
            onRetry={refetch}
          />
        ) : isLoading || !data ? (
          <TableSkeleton rows={10} columns={6} />
        ) : (
          <>
            <DataTable minWidth="64rem" caption="دفتر گردش موجودی">
              <thead>
                <tr>
                  <Th>زمان</Th>
                  <Th>کالا و گونه</Th>
                  <Th numeric>تغییر</Th>
                  <Th numeric>موجودی پس از حرکت</Th>
                  <Th>علت</Th>
                  <Th>سفارش مرتبط</Th>
                  <Th>عامل</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 ? (
                  <EmptyRow colSpan={7}>
                    با این فیلترها هیچ حرکتی ثبت نشده است. اگر بازهٔ تاریخ گذاشته‌اید، آن را بازتر
                    کنید.
                  </EmptyRow>
                ) : (
                  data.data.map((row) => (
                    <Tr key={row.id}>
                      <Td>
                        <span className="whitespace-nowrap text-2xs text-ink-muted" data-numeric="">
                          {when(row.createdAt)}
                        </span>
                      </Td>
                      <Td>
                        <span className="block text-sm text-ink">{row.productTitle}</span>
                        <bdi dir="ltr" data-numeric="" className="mt-0.5 block text-2xs text-ink-subtle">
                          {row.sku}
                        </bdi>
                      </Td>
                      <Td numeric>
                        <span
                          className={
                            row.delta < 0
                              ? "font-bold text-danger"
                              : row.delta > 0
                                ? "font-bold text-success"
                                : "text-ink-muted"
                          }
                        >
                          {signedCount(row.delta)}
                        </span>
                      </Td>
                      <Td numeric>{count(row.balanceAfter)}</Td>
                      <Td>
                        <span className="text-xs text-ink">{stockMovementReasonLabel(row.reason)}</span>
                        <bdi dir="ltr" className="mt-0.5 block text-2xs text-ink-subtle">
                          {row.reason}
                        </bdi>
                        {/*
                          The operator's own words, under the machine label.

                          `max-w-*` plus `break-words` keeps a 500-character
                          sentence from stretching the row: the table already
                          scrolls horizontally inside `DataTable`, and an
                          unbounded cell would push every column after it off
                          the visible area instead of wrapping. `whitespace-
                          pre-line` preserves the line breaks somebody typed
                          without honouring accidental runs of spaces.
                        */}
                        {row.reasonText ? (
                          <p className="mt-1.5 max-w-[24rem] whitespace-pre-line break-words border-s-2 border-line ps-2 text-2xs leading-5 text-ink-muted">
                            {row.reasonText}
                          </p>
                        ) : null}
                      </Td>
                      <Td>
                        {/*
                          THE ORDER NUMBER IS EVIDENCE; THE LINK IS A SECOND
                          CAPABILITY. `/admin/orders/:id` gates on
                          `orders.read`, which a stockroom ledger reader need
                          not hold — so the number is always printed and only
                          the navigation is withheld.
                        */}
                        {row.orderId === null ? (
                          <span className="text-2xs text-ink-subtle">بدون سفارش</span>
                        ) : (
                          <Gate
                            permissions={["orders.read"]}
                            fallback={
                              <bdi dir="ltr" data-numeric="" className="text-xs text-ink">
                                {row.orderNumber ?? `#${row.orderId}`}
                              </bdi>
                            }
                          >
                            <Link href={adminOrderHref(row.orderId)} className="no-underline">
                              <bdi dir="ltr" data-numeric="" className="text-xs text-primary">
                                {row.orderNumber ?? `#${row.orderId}`}
                              </bdi>
                            </Link>
                          </Gate>
                        )}
                      </Td>
                      <Td>
                        {row.actorDisplaySnapshot ? (
                          <span className="text-xs text-ink">{row.actorDisplaySnapshot}</span>
                        ) : (
                          <span className="text-2xs text-ink-subtle">سامانه (بدون عامل انسانی)</span>
                        )}
                      </Td>
                    </Tr>
                  ))
                )}
              </tbody>
            </DataTable>

            <Pagination
              className="mt-6"
              pageInfo={pageInfoOf(data)}
              buildHref={(target) =>
                adminMovementsHref({
                  ...urlFilters,
                  ...(target > 1 ? { page: target } : {}),
                })
              }
            />
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `-3` → `‎−۳`, `+2` → `‎+۲`.
 *
 * The sign is part of the value, so it is rendered as text rather than implied
 * by the colour alone: colour is not available to a forced-colors user, to a
 * colour-blind reader, or in a printed page, and "3" where "−3" was meant is the
 * worst possible ambiguity on a stock ledger.
 */
function signedCount(delta: number): string {
  if (delta === 0) return count(0);
  return delta < 0 ? `−${count(Math.abs(delta))}` : `+${count(delta)}`;
}
