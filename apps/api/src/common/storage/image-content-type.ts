/**
 * ============================================================================
 * WHAT A PRODUCT IMAGE IS ALLOWED TO BE — decided by BYTES, not by the caller.
 * ============================================================================
 *
 * The browser sends three things about an upload and a hostile client controls
 * all three: the filename, its extension, and the `Content-Type` of the
 * multipart part. `logo.png` can contain anything at all, and the part can
 * claim `image/png` while carrying a shell script. So none of them decides
 * anything here. The first bytes of the file do.
 *
 * WHY NO IMAGE LIBRARY. `sharp`, `file-type` and `image-size` would each do
 * this, and each would add a dependency — `sharp` a native one with prebuilt
 * binaries per platform — to answer a question that four byte comparisons
 * answer exactly. The signatures below are fixed by the PNG, JPEG and RIFF
 * specifications and are not going to move. If this project later needs real
 * decoding (thumbnails, EXIF stripping, dimension limits) that is the moment
 * to take the dependency, and this module is the seam where it would go.
 *
 * ---------------------------------------------------------------------------
 * WHY SVG IS REFUSED
 * ---------------------------------------------------------------------------
 * SVG is not a picture format, it is a document format: it may contain
 * `<script>`, `<foreignObject>`, event handlers and external references. An
 * SVG served from the same origin as the admin console is stored XSS with
 * extra steps, and an SVG served from the asset host is still a document the
 * browser will execute if anyone ever opens it directly. Refusing it is a
 * one-line decision here and an incident if it is deferred.
 *
 * It is refused EXPLICITLY rather than by omission so the caller is told
 * `IMAGE_TYPE_UNSUPPORTED` about a format they clearly meant to send, instead
 * of the generic "malformed" they would otherwise get from a file whose first
 * bytes are `<svg`.
 *
 * ---------------------------------------------------------------------------
 * MALFORMED IS NOT THE SAME AS UNSUPPORTED
 * ---------------------------------------------------------------------------
 * A zero-byte file, a truncated JPEG and a PNG header glued to nothing are all
 * things a real picker can produce — an interrupted copy, a failed export, a
 * file still being written. They are rejected as MALFORMED (400), because the
 * user's fix is "send the file again", while an unsupported format is a 415
 * whose fix is "send a different format". Collapsing the two would tell half
 * the users to do the wrong thing.
 * ============================================================================
 */

/** The formats this project accepts today. Order is not significant. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/**
 * The extension stored for each accepted type.
 *
 * NORMALISED FROM THE VERIFIED TYPE, never from the upload's filename. A file
 * called `photo.jpeg.png` that really is a JPEG is stored as `.jpg`, so the
 * object key can never disagree with the bytes it names, and a key can never
 * carry a second extension for something else to interpret.
 */
const EXTENSION_BY_MIME: Record<SupportedImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extensionForImageType(mime: SupportedImageMimeType): string {
  return EXTENSION_BY_MIME[mime];
}

/** Why a buffer was refused. `null` from {@link inspectImageBuffer} means OK. */
export type ImageRejection =
  /** Nothing was sent, or the part was empty. */
  | 'empty'
  /** Recognisably a format this project does not accept (SVG, GIF, BMP…). */
  | 'unsupported'
  /** Claims to be a supported format but the bytes do not hold up. */
  | 'malformed';

export interface ImageInspection {
  /** `null` when the buffer is not an acceptable image. */
  mime: SupportedImageMimeType | null;
  /** `null` when {@link mime} is set. */
  rejection: ImageRejection | null;
  /**
   * A short, non-sensitive description for the operator log — the sniffed
   * family and why it lost. Never contains file content.
   */
  detail: string;
}

const ASCII = (buffer: Buffer, offset: number, length: number): string =>
  buffer.subarray(offset, offset + length).toString('latin1');

/**
 * Formats that are recognisable but deliberately not accepted. Listed so the
 * refusal can say "we know what this is and the answer is no", which is a
 * different and more useful message than "we could not read this".
 */
function sniffUnsupported(buffer: Buffer): string | null {
  // SVG — text, so it may lead with a BOM, whitespace, an XML prologue, a
  // doctype or a comment before the root element. Scanning a small prefix
  // catches every ordering without parsing XML.
  const prefix = buffer.subarray(0, 1024).toString('latin1').trimStart();
  const withoutBom = prefix.charCodeAt(0) === 0xfeff ? prefix.slice(1) : prefix;
  if (
    /^<\?xml[\s\S]*?<svg[\s>]/i.test(withoutBom) ||
    /^<svg[\s>]/i.test(withoutBom)
  ) {
    return 'svg';
  }

  if (ASCII(buffer, 0, 3) === 'GIF') return 'gif';
  if (ASCII(buffer, 0, 2) === 'BM') return 'bmp';
  // TIFF, both byte orders.
  if (
    ASCII(buffer, 0, 4) === 'II\x2a\x00' ||
    ASCII(buffer, 0, 4) === 'MM\x00\x2a'
  ) {
    return 'tiff';
  }
  // HEIC/AVIF and friends: an ISO-BMFF `ftyp` box.
  if (buffer.length >= 12 && ASCII(buffer, 4, 4) === 'ftyp') return 'iso-bmff';
  // A PDF, a ZIP (docx/xlsx), or an ELF/Mach-O binary renamed to .png.
  if (ASCII(buffer, 0, 4) === '%PDF') return 'pdf';
  if (ASCII(buffer, 0, 2) === 'PK') return 'zip';

  return null;
}

/** PNG: 8-byte signature followed immediately by the IHDR chunk. */
function isPng(buffer: Buffer): boolean | 'malformed' {
  const SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE))
    return false;
  // The signature is present, so the sender meant PNG. From here every failure
  // is malformed rather than "not a PNG".
  // 8 signature + 4 length + 4 type + 13 IHDR data + 4 CRC = 33 bytes minimum.
  if (buffer.length < 33) return 'malformed';
  if (ASCII(buffer, 12, 4) !== 'IHDR') return 'malformed';
  // A zero dimension is a structurally valid chunk describing an impossible
  // image; browsers render nothing and the admin sees a broken thumbnail.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) return 'malformed';
  return true;
}

/**
 * JPEG: SOI, a marker, and an EOI somewhere after it.
 *
 * The EOI requirement is what catches the common real-world failure — a copy
 * that stopped early. A truncated JPEG has a perfect three-byte header and no
 * terminator, and every decoder renders it as a half-grey rectangle.
 */
function isJpeg(buffer: Buffer): boolean | 'malformed' {
  if (buffer.length < 3) return false;
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
    return false;
  }
  if (buffer.length < 4) return 'malformed';
  // Scan backwards: the EOI is at the very end of a well-formed file, and some
  // cameras append a trailer, so a short backwards window is both correct and
  // cheap. Fall back to a full scan only if the tail does not have it.
  const tail = buffer.subarray(Math.max(2, buffer.length - 64));
  const hasEoiInTail = tail.indexOf(Buffer.from([0xff, 0xd9])) !== -1;
  if (hasEoiInTail) return true;
  return buffer.indexOf(Buffer.from([0xff, 0xd9]), 2) !== -1
    ? true
    : 'malformed';
}

/**
 * WebP: a RIFF container whose form type is `WEBP`.
 *
 * The declared RIFF payload size is checked against the real length, which is
 * the truncation test for this format. The spec pads odd-sized chunks to an
 * even boundary, so one trailing byte of slack is allowed and nothing more.
 */
function isWebp(buffer: Buffer): boolean | 'malformed' {
  if (buffer.length < 12) return false;
  if (ASCII(buffer, 0, 4) !== 'RIFF') return false;
  if (ASCII(buffer, 8, 4) !== 'WEBP') {
    // A RIFF container that is not WebP (an AVI, a WAV).
    return false;
  }
  if (buffer.length < 16) return 'malformed';
  const declared = buffer.readUInt32LE(4);
  const actual = buffer.length - 8;
  if (declared > actual || actual - declared > 1) return 'malformed';
  const chunk = ASCII(buffer, 12, 4);
  if (chunk !== 'VP8 ' && chunk !== 'VP8L' && chunk !== 'VP8X')
    return 'malformed';
  return true;
}

/**
 * Decide what a buffer really is.
 *
 * The declared MIME type is deliberately NOT an input. It is compared against
 * the result by the caller if it wants to, but it can never widen what is
 * accepted.
 */
export function inspectImageBuffer(
  buffer: Buffer | undefined | null,
): ImageInspection {
  if (!buffer || buffer.length === 0) {
    return { mime: null, rejection: 'empty', detail: 'zero-length body' };
  }

  const unsupported = sniffUnsupported(buffer);
  if (unsupported) {
    return {
      mime: null,
      rejection: 'unsupported',
      detail: `recognised as ${unsupported}`,
    };
  }

  const png = isPng(buffer);
  if (png === true)
    return { mime: 'image/png', rejection: null, detail: 'png' };
  if (png === 'malformed') {
    return {
      mime: null,
      rejection: 'malformed',
      detail: 'png header without a usable IHDR',
    };
  }

  const jpeg = isJpeg(buffer);
  if (jpeg === true)
    return { mime: 'image/jpeg', rejection: null, detail: 'jpeg' };
  if (jpeg === 'malformed') {
    return {
      mime: null,
      rejection: 'malformed',
      detail: 'jpeg without an end-of-image marker',
    };
  }

  const webp = isWebp(buffer);
  if (webp === true)
    return { mime: 'image/webp', rejection: null, detail: 'webp' };
  if (webp === 'malformed') {
    return {
      mime: null,
      rejection: 'malformed',
      detail: 'riff/webp with an inconsistent size or chunk',
    };
  }

  return {
    mime: null,
    rejection: 'unsupported',
    detail: 'no recognised image signature',
  };
}
