import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * The API's error envelope. Stable contract — do not reorder or rename.
 *
 *   success     always false
 *   statusCode  the HTTP status, repeated in the body for clients that only
 *               read JSON
 *   message     human-readable string, or the array of strings a failing
 *               ValidationPipe produces
 *   error       short machine-ish label ('Bad Request', or a domain code)
 *   details     EVERY other key the thrower put on the exception payload, e.g.
 *               `{ code: 'INSUFFICIENT_STOCK', variantId, physicalStock,
 *                  basketReserved, orderAllocated }`. Present only when the
 *               thrower supplied extra keys.
 *   timestamp   ISO-8601 UTC
 *   path        request URL
 */
interface ErrorBody {
  success: false;
  statusCode: number;
  message: string | string[];
  error?: string;
  details?: Record<string, unknown>;
  timestamp: string;
  path: string;
}

/**
 * Single error envelope for the whole API. Registered globally through
 * `APP_FILTER` in app.module.ts — it used to exist but was never registered,
 * so unhandled errors fell through to Nest's default handler and produced a
 * response shape that did not match the success envelope.
 *
 * Two deliberate properties:
 *  - the `timestamp` key is spelled correctly (it was `timstamp`),
 *  - only HttpExceptions leak their message. Anything else is reported as a
 *    generic 500 and the real cause is logged server-side, so a stack trace or
 *    a driver error string (which can contain SQL and column values) never
 *    reaches the client.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Websocket / RPC contexts have no HTTP response to write to.
    if (host.getType() !== 'http' || typeof response?.status !== 'function') {
      this.logger.error(
        `Unhandled ${host.getType()} exception`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] =
      'A critical error has occurred. Please contact support.';
    let error: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const asRecord = payload as Record<string, unknown>;
        const rawMessage = asRecord.message;
        if (typeof rawMessage === 'string' || Array.isArray(rawMessage)) {
          message = rawMessage as string | string[];
        } else {
          message = exception.message;
        }
        if (typeof asRecord.error === 'string') error = asRecord.error;

        // Structured detail passthrough. Throwing
        //   new ConflictException({ code: 'INSUFFICIENT_STOCK', variantId, ... })
        // used to lose everything except `message`/`error`, which forced
        // callers to smuggle machine-readable facts inside a human-readable
        // sentence. Anything the thrower added beyond the envelope's own keys
        // now survives under `details`.
        const extra: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(asRecord)) {
          if (key === 'message' || key === 'error' || key === 'statusCode')
            continue;
          extra[key] = value;
        }
        if (Object.keys(extra).length > 0) details = extra;
      }
    } else {
      this.logger.error(
        `Unhandled exception on ${request?.method} ${request?.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = {
      success: false,
      statusCode: status,
      message,
      ...(error ? { error } : {}),
      ...(details ? { details } : {}),
      timestamp: new Date().toISOString(),
      path: request?.url ?? '',
    };

    response.status(status).json(body);
  }
}
