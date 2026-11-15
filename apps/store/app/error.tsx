"use client";

/**
 * The route-level error boundary. Must be a Client Component.
 *
 * Next 16.3 passes `retry` (stable since 16.3.0; `unstable_retry` in 16.2),
 * which re-runs the failed render INCLUDING its data fetching — unlike the
 * older `reset`, which only re-rendered the children. A till wants the former:
 * the usual cause here is the API being briefly unreachable.
 */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center px-4 py-24">
      <div className="flex max-w-md flex-col items-center gap-4 text-center" role="alert">
        <h1 className="text-2xl text-ink">صندوق به مشکل خورد</h1>
        <p className="text-ink-muted">
          این صفحه بارگذاری نشد. اتصال شبکه‌ی صندوق را بررسی کنید و دوباره تلاش کنید. هیچ فروشی
          به‌خاطر این خطا ثبت یا حذف نمی‌شود.
        </p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-13 items-center rounded-md bg-primary px-7 text-lg font-semibold text-primary-ink"
        >
          تلاش دوباره
        </button>
        {error.digest ? (
          <p className="text-2xs text-ink-subtle" dir="ltr">
            {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
