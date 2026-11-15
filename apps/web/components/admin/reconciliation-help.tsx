"use client";

import { useState } from "react";

import { Button, cx } from "@kazhal/ui";

import { ChevronDownIcon, EyeIcon } from "@/components/icons";

/**
 * THE HELP PANEL.
 *
 * This page exists because money and goods can get out of step, and the people
 * who have to fix that are shop managers, not engineers. The panel answers the
 * three questions somebody opening it for the first time actually has — what
 * is this, when do I come here, and what can I safely do — and it says the one
 * thing the whole workflow depends on: NOTHING ON THIS PAGE MOVES MONEY.
 *
 * Collapsed by default, because it is for the first visit and the tenth visit
 * should not have to scroll past it.
 */
export function ReconciliationHelp() {
  const [open, setOpen] = useState(false);

  return (
    <section className="mb-5 rounded-lg border border-info/40 bg-info-soft/50">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        leadingIcon={<EyeIcon className="size-4" />}
        trailingIcon={
          <ChevronDownIcon
            className={cx("size-4 transition-transform duration-150 ease-kz", open && "rotate-180")}
          />
        }
        className="w-full justify-between"
      >
        این صفحه چیست و چه زمانی به آن سر می‌زنید؟
      </Button>

      {open ? (
        <div className="space-y-4 border-t border-info/30 p-4 text-sm leading-relaxed text-ink">
          <div>
            <h3 className="font-bold">این صفحه چیست؟</h3>
            <p className="mt-1 text-ink-muted">
              فهرست سفارش‌هایی که پول و کالا در آن‌ها با هم جور نیست و تصمیم یک انسان لازم است.
              مثلاً پول مشتری از درگاه رسیده اما کالا از انبار کسر نشده، یا وجهی رسیده که به هیچ
              سفارشی نمی‌خورد.
            </p>
          </div>

          <div>
            <h3 className="font-bold">چه زمانی سر بزنید؟</h3>
            <ul className="mt-1 space-y-1 text-ink-muted">
              <li>• هر روز، یک‌بار: تب «نیازمند اقدام» باید خالی شود.</li>
              <li>• وقتی مشتری می‌گوید «پول را دادم اما سفارشم ثبت نشده».</li>
              <li>• وقتی داشبورد هشدار پروندهٔ باز نشان می‌دهد.</li>
            </ul>
          </div>

          <div className="rounded-md border border-warning/40 bg-warning-soft/60 p-3">
            <h3 className="font-bold">مهم‌ترین نکته: هیچ اقدامی در این صفحه پول جابه‌جا نمی‌کند</h3>
            <p className="mt-1 text-ink-muted">
              این سامانه به درگاه پرداخت دستور بازپرداخت نمی‌دهد — چنین امکانی در آن پیاده‌سازی
              نشده است. بازپرداخت را باید خودتان در پنل درگاه انجام دهید و بعد در همین صفحه
              «تأیید بازپرداخت انجام‌شده» را ثبت کنید. آنچه اینجا ثبت می‌کنید، <b>سابقه و تصمیم</b>
              است، نه انتقال وجه.
            </p>
          </div>

          <div>
            <h3 className="font-bold">سه تب چه تفاوتی دارند؟</h3>
            <ul className="mt-1 space-y-1 text-ink-muted">
              <li>
                • <b>نیازمند اقدام</b> — هنوز کسی تصمیمی نگرفته است. کار شما از اینجا شروع می‌شود.
              </li>
              <li>
                • <b>در حال پیگیری</b> — تصمیم گرفته شده و منتظر چیزی بیرون از این سامانه است:
                بازپرداخت در پنل درگاه، یا رسیدن موجودی.
              </li>
              <li>
                • <b>بسته‌شده</b> — تکلیف پرونده روشن شده است.
              </li>
            </ul>
            <p className="mt-1 text-ink-muted">
              هر پرونده در دقیقاً یکی از این سه است، پس اگر هر سه تب را خالی کنید هیچ پرونده‌ای
              جا نمانده.
            </p>
          </div>

          <div>
            <h3 className="font-bold">سابقهٔ اقدام‌ها پاک می‌شود؟</h3>
            <p className="mt-1 text-ink-muted">
              نه. هر اقدامی که ثبت کنید با نام شما و زمان دقیق می‌ماند و ویرایش یا حذف نمی‌شود —
              این محدودیت در سطح پایگاه داده اعمال شده است، نه فقط در برنامه.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
