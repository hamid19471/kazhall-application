import { cx } from "@kazhal/ui";

import { BoxIcon } from "@/components/icons";

/**
 * A catalogue image.
 *
 * ## Why this is `<img>` and not `next/image`
 *
 * Product image URLs come from the API at runtime and point at whatever object
 * store the deployment uses (MinIO in the review stack). `next/image` refuses
 * any remote host that is not listed in `images.remotePatterns`, and
 * `next.config.ts` is owned by another workstream and must not be edited here —
 * so a `next/image` would throw on every real product. A plain `<img>` with
 * explicit `loading`, `decoding` and a reserved aspect box gives us the two
 * things that actually matter (no layout shift, no eager off-screen fetches)
 * without a config change this workstream is not allowed to make.
 *
 * The alt text is the product title, never the file name, and it is EMPTY for
 * the placeholder: a decorative box icon announced as "image" on every card in
 * a grid is noise.
 */
export function ProductImage({
  url,
  alt,
  className,
  sizes,
  priority = false,
}: {
  url: string | null | undefined;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  if (!url) {
    return (
      <div
        className={cx(
          "grid place-items-center bg-surface-muted text-ink-subtle",
          className,
        )}
      >
        <BoxIcon className="size-10" />
        <span className="kz-sr-only">تصویری برای این کالا ثبت نشده است</span>
      </div>
    );
  }

  return (
    /*
     * Remote hosts are runtime-configured and `images.remotePatterns` lives in
     * `next.config.ts`, which this workstream must not edit — see the note at
     * the top of this file.
     */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      sizes={sizes}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      className={cx("bg-surface-muted object-cover", className)}
    />
  );
}
