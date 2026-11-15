import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center px-4 py-24">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <h1 className="text-2xl text-ink">این صفحه وجود ندارد</h1>
        <p className="text-ink-muted">
          نشانی واردشده در صندوق فروش کژال تعریف نشده است.
        </p>
        <Link
          href="/pos"
          className="inline-flex h-13 items-center rounded-md bg-primary px-7 text-lg font-semibold text-primary-ink no-underline"
        >
          بازگشت به صندوق
        </Link>
      </div>
    </main>
  );
}
