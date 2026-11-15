import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

import {
  ProductImageErrorCodes,
  ProductImageMessages,
} from '../constants/product-image.messages';
import type { SupportedImageMimeType } from './image-content-type';
import { inspectImageBuffer } from './image-content-type';

/**
 * ============================================================================
 * SERVER-SIDE UPLOAD VALIDATION — the only validation that counts.
 *
 * The Admin picker checks size and type before it sends, and that check is a
 * courtesy: it saves a manager a pointless round trip with a 30 MB photo. It
 * is not a control. `POST /products/uploadImage` is an ordinary authenticated
 * HTTP endpoint that anything can call, so every rule is enforced again here,
 * against the bytes rather than against what the request claimed.
 *
 * ORDER MATTERS, and it is: present → size → content. Checking size before
 * content means a 40 MB file is refused without inspecting it, and checking
 * presence first means an empty part is never mistaken for a malformed image.
 *
 * WHY THE DECLARED MIME TYPE IS NEVER TRUSTED. `file.mimetype` is copied
 * verbatim from the multipart part the client wrote. A caller that sends a PHP
 * file labelled `image/png` gets exactly as far as the magic-byte check, which
 * does not care what the label said. The declared type is used for ONE thing:
 * noticing that it disagrees with the bytes, which is worth logging but is not
 * itself the refusal — a browser mislabelling a JPEG as `image/jpg` is common
 * and harmless, and the bytes decide either way.
 * ============================================================================
 */

/** A file that passed every check. */
export interface VerifiedImage {
  readonly buffer: Buffer;
  /** Verified from the bytes. This is what gets stored and served. */
  readonly contentType: SupportedImageMimeType;
  readonly bytes: number;
  /** What the client claimed, for logging only. */
  readonly declaredType: string | undefined;
}

/**
 * The shape this module needs from a multer file. Declared structurally rather
 * than importing `Express.Multer.File` so the validator can be unit-tested
 * with a plain object and no Express types in scope.
 */
export interface UploadedFileLike {
  buffer?: Buffer;
  size?: number;
  mimetype?: string;
  originalname?: string;
}

/**
 * Validate one uploaded part, or throw the refusal the client should see.
 *
 * Throws are deliberate rather than a result type: every caller wants the same
 * HTTP status for the same problem, and returning a discriminated union would
 * mean each caller re-deriving the mapping and eventually getting it wrong.
 */
export function verifyProductImageUpload(
  file: UploadedFileLike | undefined | null,
  maxBytes: number,
): VerifiedImage {
  // ---- present -----------------------------------------------------------
  if (!file || !file.buffer || file.buffer.byteLength === 0) {
    throw new BadRequestException({
      error: ProductImageErrorCodes.IMAGE_FILE_REQUIRED,
      message: ProductImageMessages.FILE_REQUIRED,
      field: 'file',
    });
  }

  const buffer = file.buffer;

  // ---- size --------------------------------------------------------------
  // Measured from the buffer, not from `file.size`, because `size` is a number
  // the upload machinery reports and the buffer is the thing that will be
  // stored. They agree today; if they ever disagree the bytes win.
  if (buffer.byteLength > maxBytes) {
    throw new PayloadTooLargeException({
      error: ProductImageErrorCodes.IMAGE_TOO_LARGE,
      message: ProductImageMessages.tooLarge(maxBytes),
      field: 'file',
      maxBytes,
      actualBytes: buffer.byteLength,
    });
  }

  // ---- content -----------------------------------------------------------
  const inspection = inspectImageBuffer(buffer);

  if (inspection.rejection === 'empty') {
    throw new BadRequestException({
      error: ProductImageErrorCodes.IMAGE_FILE_REQUIRED,
      message: ProductImageMessages.FILE_REQUIRED,
      field: 'file',
    });
  }

  if (inspection.rejection === 'unsupported') {
    throw new UnsupportedMediaTypeException({
      error: ProductImageErrorCodes.IMAGE_TYPE_UNSUPPORTED,
      message: ProductImageMessages.TYPE_UNSUPPORTED,
      field: 'file',
      /**
       * The accepted list travels with the refusal so a client can render it
       * without hard-coding a second copy that drifts.
       */
      supported: ['image/jpeg', 'image/png', 'image/webp'],
    });
  }

  if (inspection.rejection === 'malformed' || inspection.mime === null) {
    throw new BadRequestException({
      error: ProductImageErrorCodes.IMAGE_MALFORMED,
      message: ProductImageMessages.MALFORMED,
      field: 'file',
    });
  }

  return {
    buffer,
    contentType: inspection.mime,
    bytes: buffer.byteLength,
    declaredType: file.mimetype,
  };
}
