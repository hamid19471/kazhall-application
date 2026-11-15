import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Inject,
  PayloadTooLargeException,
} from '@nestjs/common';

import {
  ProductImageErrorCodes,
  ProductImageMessages,
} from '../constants/product-image.messages';
import { PRODUCT_IMAGE_MAX_BYTES } from './storage.module';

/**
 * ============================================================================
 * MULTER'S REFUSALS, RESTATED IN THIS PROJECT'S UPLOAD CONTRACT.
 *
 * WHY THIS IS NOT `@Catch(MulterError)`. It was, and it never fired.
 * `@nestjs/platform-express` runs `transformException` on whatever multer
 * throws BEFORE any filter sees it, converting `MulterError` into a plain
 * `PayloadTooLargeException('File too large')` or
 * `BadRequestException('Unexpected field - image')` — a STRING payload with no
 * machine-readable code and an English sentence. A `MulterError` therefore
 * never reaches user code, and the route answered
 *
 *     400 {"message":"Unexpected field - image","error":"Bad Request"}
 *
 * which is precisely the shape this change exists to eliminate: no `error`
 * code a client can branch on, and an English string rendered verbatim to a
 * Persian-speaking store manager by `FormError`.
 *
 * So the filter catches the two exception TYPES Nest actually produces and
 * restates them. Which means it also sees the refusals this project throws
 * deliberately — 400 `IMAGE_MALFORMED`, 413 `IMAGE_TOO_LARGE` from
 * `verifyProductImageUpload` — and those must pass through untouched. They are
 * recognised by their own `error` code and re-emitted exactly as thrown.
 *
 * WHY THE CEILING AND THE LIMIT ARE TWO DIFFERENT NUMBERS.
 * `PRODUCT_IMAGE_MAX_BYTES` is a business rule an operator retunes, enforced
 * against the received bytes. The interceptor's ceiling is a memory guard that
 * has to be a compile-time constant, because `FileInterceptor(...)` options are
 * evaluated when the decorator is applied and cannot read configuration.
 * Anything between the two is refused by the first check; anything above the
 * ceiling is refused here. Both answer `IMAGE_TOO_LARGE` quoting the CONFIGURED
 * limit — the caller has no interest in which mechanism stopped them.
 * ============================================================================
 */
@Catch(BadRequestException, PayloadTooLargeException)
export class ProductImageUploadExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(PRODUCT_IMAGE_MAX_BYTES) private readonly maxBytes: number,
  ) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const translated = this.isAlreadyTranslated(exception)
      ? exception
      : this.translate(exception);

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const request = ctx.getRequest<{ url?: string }>();

    const payload = translated.getResponse() as Record<string, unknown>;
    const message = payload.message;
    const error = payload.error;

    /*
     * Everything except the envelope's own keys becomes `details` — the same
     * rule `GlobalExceptionFilter` applies, spelled out the same way, so the
     * two filters cannot drift into shaping the envelope differently.
     */
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'message' || key === 'error' || key === 'statusCode')
        continue;
      rest[key] = value;
    }

    // Shaped exactly like GlobalExceptionFilter's envelope — including the
    // "everything else becomes `details`" rule — so a client cannot tell which
    // filter answered.
    response.status(translated.getStatus()).json({
      success: false,
      statusCode: translated.getStatus(),
      message,
      ...(typeof error === 'string' ? { error } : {}),
      ...(Object.keys(rest).length > 0 ? { details: rest } : {}),
      timestamp: new Date().toISOString(),
      path: request?.url ?? '',
    });
  }

  /** Ours already: an object payload carrying one of this module's codes. */
  private isAlreadyTranslated(exception: HttpException): boolean {
    const payload = exception.getResponse();
    if (typeof payload !== 'object' || payload === null) return false;
    const code = (payload as { error?: unknown }).error;
    return typeof code === 'string' && code.startsWith('IMAGE_');
  }

  private translate(
    exception: HttpException,
  ): PayloadTooLargeException | BadRequestException {
    if (exception.getStatus() === 413) {
      return new PayloadTooLargeException({
        error: ProductImageErrorCodes.IMAGE_TOO_LARGE,
        message: ProductImageMessages.tooLarge(this.maxBytes),
        field: 'file',
        maxBytes: this.maxBytes,
      });
    }

    /*
     * A 400 from the multipart layer is one of two things, and they deserve
     * different sentences: the part was absent or misnamed (send a file), or
     * the body itself was cut short (send it again).
     */
    const text = this.messageOf(exception);
    const missingPart =
      /unexpected field|missing field name|boundary not found|limit_file_count/i.test(
        text,
      );

    return new BadRequestException(
      missingPart
        ? {
            error: ProductImageErrorCodes.IMAGE_FILE_REQUIRED,
            message: ProductImageMessages.FILE_REQUIRED,
            field: 'file',
          }
        : {
            error: ProductImageErrorCodes.IMAGE_MALFORMED,
            message: ProductImageMessages.MALFORMED,
            field: 'file',
          },
    );
  }

  private messageOf(exception: HttpException): string {
    const payload = exception.getResponse();
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join(' ');
    }
    return exception.message ?? '';
  }
}

/**
 * Memory guard for one request. See the class comment for why this is a
 * constant and `PRODUCT_IMAGE_MAX_BYTES` is not.
 *
 * Equal to the highest value `PRODUCT_IMAGE_MAX_BYTES` is allowed to take, so
 * raising the configured limit to its maximum never starts failing here
 * instead of there.
 */
export const UPLOAD_HARD_CEILING_BYTES = 64 * 1024 * 1024;
