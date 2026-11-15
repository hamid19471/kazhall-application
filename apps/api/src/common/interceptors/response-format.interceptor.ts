import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';

/**
 * Wraps every successful handler return value in a uniform envelope.
 *
 * The previous implementation spread the handler result directly
 * (`{ success, timeStamp, ...data }`). Spreading an ARRAY produces an object
 * with numeric string keys — `["a","b"]` became `{"0":"a","1":"b"}` — which
 * silently broke every controller returning a bare array (all five `/branch`
 * routes). Non-object results (`string`, `number`, `null`) were equally
 * mangled: spreading a string yields per-character keys.
 *
 * Rule now:
 *   - a plain object is spread as before (backwards compatible),
 *   - anything else (array, primitive, null, Date, Buffer, …) is placed under
 *     `data` and left structurally intact,
 *   - a response that is already an envelope is returned untouched, so
 *     double-wrapping cannot happen.
 */
@Injectable()
export class ResponseFormatInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler<any>,
  ): Observable<any> {
    return next.handle().pipe(
      map((data: unknown) => {
        if (isEnvelope(data)) return data;

        const envelope = {
          success: true,
          timeStamp: new Date().toISOString(),
        };

        return isPlainObject(data)
          ? { ...envelope, ...data }
          : { ...envelope, data: data ?? null };
      }),
    );
  }
}

/**
 * True only for object literals / class instances that are safe to spread.
 * Arrays, Dates, Buffers, streams and primitives are explicitly excluded.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (Buffer.isBuffer(value)) return false;
  if (typeof (value as { pipe?: unknown }).pipe === 'function') return false;
  return true;
}

function isEnvelope(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof (value as { success?: unknown }).success === 'boolean' &&
    typeof (value as { timeStamp?: unknown }).timeStamp === 'string'
  );
}
