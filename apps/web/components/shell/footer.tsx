"use client";

import Link from "next/link";

import { formatInteger } from "@kazhal/ui";

import { useCategories } from "@/components/providers";
import { CompassIcon, LogoMark, ShieldIcon, TruckIcon } from "@/components/icons";
import { categoryHref } from "@/lib/routes";

/**
 * The footer.
 *
 * The three promises at the top are the only marketing copy in this app, and
 * each one is a statement the system can actually keep: the basket really does
 * hold stock for four hours, an order really is only called paid after
 * `POST /payment/verify` says so, and the catalogue really is the live one.
 * Nothing here claims same-day delivery, a returns window or a warranty,
 * because nothing in the API models any of those.
 */
export function Footer() {
  const { categories } = useCategories();

  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6">
        <ul className="grid gap-4 border-b border-line pb-8 sm:grid-cols-3">
          <PromiseCard
            icon={<ShieldIcon className="size-6" />}
            title="پرداخت امن"
            body="سفارش شما فقط پس از تأیید نهایی درگاه «پرداخت‌شده» ثبت می‌شود."
          />
          <PromiseCard
            icon={<TruckIcon className="size-6" />}
            title="ارسال به سراسر ایران"
            body="نشانی تحویل در لحظهٔ ثبت سفارش ذخیره می‌شود و بعداً تغییر نمی‌کند."
          />
          <PromiseCard
            icon={<CompassIcon className="size-6" />}
            title="نگهداری چهارساعتهٔ سبد"
            body="با افزودن کالا به سبد، موجودی آن تا چهار ساعت برای شما کنار گذاشته می‌شود."
          />
        </ul>

        <div className="grid gap-8 pt-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="flex items-center gap-2 text-ink">
              <LogoMark className="size-7 text-primary" />
              <span className="text-lg font-extrabold">کژال</span>
            </p>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-muted">
              فروشگاه تجهیزات کوهنوردی، شکار، کمپینگ و آفرود و ماهیگیری.
            </p>
          </div>

          <nav aria-labelledby="footer-categories">
            <h2 id="footer-categories" className="text-sm font-bold text-ink">
              دسته‌بندی‌ها
            </h2>
            <ul className="mt-3 space-y-2">
              {categories.length === 0 ? (
                <li className="text-sm text-ink-subtle">فهرست دسته‌بندی‌ها در دسترس نیست.</li>
              ) : (
                categories.slice(0, 6).map((category) => (
                  <li key={category.id}>
                    <Link
                      href={categoryHref(category.id)}
                      className="text-sm text-ink-muted no-underline hover:text-primary"
                    >
                      {category.title}
                      <span className="kz-sr-only">
                        {" "}
                        ({formatInteger(category.productCount)} کالا)
                      </span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </nav>

          <nav aria-labelledby="footer-account">
            <h2 id="footer-account" className="text-sm font-bold text-ink">
              حساب من
            </h2>
            <ul className="mt-3 space-y-2">
              <li>
                <Link href="/account" className="text-sm text-ink-muted no-underline hover:text-primary">
                  پیشخوان حساب
                </Link>
              </li>
              <li>
                <Link
                  href="/account/orders"
                  className="text-sm text-ink-muted no-underline hover:text-primary"
                >
                  سفارش‌های من
                </Link>
              </li>
              <li>
                <Link
                  href="/account/addresses"
                  className="text-sm text-ink-muted no-underline hover:text-primary"
                >
                  نشانی‌های من
                </Link>
              </li>
              <li>
                <Link href="/cart" className="text-sm text-ink-muted no-underline hover:text-primary">
                  سبد خرید
                </Link>
              </li>
            </ul>
          </nav>

          <div>
            <h2 className="text-sm font-bold text-ink">راهنما</h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">
              برای ورود کافی است شمارهٔ موبایل خود را وارد کنید؛ رمز عبوری در کار نیست.
            </p>
          </div>
        </div>
      </div>

      <p className="border-t border-line py-4 text-center text-2xs text-ink-subtle">
        © کژال — تمام قیمت‌ها به ریال است.
      </p>
    </footer>
  );
}

function PromiseCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3 rounded-lg bg-surface-muted p-4">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-primary">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-bold text-ink">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{body}</span>
      </span>
    </li>
  );
}
