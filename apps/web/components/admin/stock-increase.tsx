"use client";

import Link from "next/link";
import type { Route } from "next";

import { isApiError } from "@kazhal/api-client";

import { Notice } from "@/components/common";
import { useAppSession } from "@/components/providers";
import { isSuperAdmin } from "@/lib/permissions";
import { adminProductHref } from "@/lib/routes";

/**
 * THE LEGACY STOCK ADJUSTERS CAN NO LONGER ADD UNITS.
 *
 * Every unit that enters inventory must arrive with a purchase cost (or an
 * explicit "cost unknown"), so both adjust routes now refuse a resulting
 * INCREASE with 409 `STOCK_INCREASE_REQUIRES_RECEIPT`
 * (docs/PURCHASE-COST-ACCOUNTING.md §6). Decreases still work and are
 * reported as inventory loss. These helpers keep the two adjust screens
 * honest about that before the request, and after it if one slips through.
 */
export function isStockIncreaseRefusal(error: unknown): boolean {
  return isApiError(error) && error.code === "STOCK_INCREASE_REQUIRES_RECEIPT";
}

export function StockIncreaseNotice({
  productId,
  className,
}: {
  /** When given, a super_admin gets a link to the product's costing section. */
  productId?: number;
  className?: string;
}) {
  const { session } = useAppSession();
  const mainAdmin = isSuperAdmin(session);

  return (
    <Notice
      tone="warning"
      title="افزایش موجودی از این فرم ثبت نمی‌شود"
      {...(className ? { className } : {})}
    >
      {mainAdmin ? (
        <p className="text-xs leading-relaxed">
          هر واحدی که به انبار اضافه می‌شود باید قیمت خرید داشته باشد. برای کالای رسیده از
          تأمین‌کننده «ثبت ورود کالا» و برای اختلاف شمارش «اصلاح موجودی» را در بخش «قیمت خرید و
          ارزش موجودی» صفحهٔ همین کالا بزنید.
          {productId !== undefined ? (
            <>
              {" "}
              <Link href={`${adminProductHref(productId)}#costing` as Route} className="font-bold">
                رفتن به «ثبت ورود کالا» ←
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <p className="text-xs leading-relaxed">
          هر واحدی که به انبار اضافه می‌شود باید قیمت خرید داشته باشد و قیمت خرید را فقط مدیر کل
          ثبت می‌کند. از مدیر کل بخواهید این موجودی را با «ثبت ورود کالا» وارد کند. کاهش موجودی
          همچنان از همین فرم ممکن است.
        </p>
      )}
    </Notice>
  );
}
