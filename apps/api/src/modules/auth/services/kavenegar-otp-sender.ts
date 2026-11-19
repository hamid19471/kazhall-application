import { Logger } from '@nestjs/common';
import { NORMALIZED_MOBILE_PATTERN } from '../otp.policy';
import {
  maskMobile,
  OtpDeliveryError,
  OtpDeliveryOutcome,
  OtpSender,
} from './otp-sender';
import {
  KAVENEGAR_REQUEST_TIMEOUT_MS,
  resolveOtpSmsConfig,
} from './kavenegar.config';

/**
 * A response larger than this is not a Kavenegar lookup answer. Enforced
 * WHILE STREAMING (see `readBounded`), so an oversized or endless body is
 * never buffered — not merely rejected after it has been read in full.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Kavenegar `return.status` values that are an explicit REFUSAL: the provider
 * answered, said no, and returned no message id, so nothing was queued for the
 * handset. Exactly the union of the rejection classes the reference
 * integration's result classifier treats as a definitive rejection
 * (transient-refused 402/409, rate-limited 451, global and template
 * configuration, account blocked, permanent recipient/payload). Any OTHER
 * non-200 status is unknown to us and therefore UNCERTAIN.
 */
export const KAVENEGAR_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  // transient refusal
  402, 409,
  // rate limited
  451,
  // global configuration (key, IP allow-list, sender line, method, …)
  403, 404, 405, 407, 412, 416, 427, 428, 607,
  // template configuration (template missing / not approved)
  424, 432,
  // account blocked or out of credit
  401, 418, 426, 429, 501,
  // permanent recipient or payload error (invalid receptor, token, …)
  400, 406, 411, 413, 414, 415, 417, 419, 420, 422, 431,
]);

/**
 * Socket error codes that can only occur BEFORE the HTTP request was written:
 * name resolution, refused or unroutable connection, connect timeout, and TLS
 * certificate failures during the handshake. The request bytes — and with
 * them the code — never left this host.
 *
 * Deliberately NOT here: `ECONNRESET`, `ETIMEDOUT`, `EPIPE`. Through `fetch`
 * we cannot tell whether those happened before or after the request was
 * written, so they are UNCERTAIN.
 */
const PRE_REQUEST_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function fail(
  outcome: OtpDeliveryOutcome,
  reason: string,
  providerStatus: number | null = null,
): OtpDeliveryError {
  return new OtpDeliveryError(outcome, reason, providerStatus);
}

/**
 * ===========================================================================
 * KavenegarOtpSender — OTP delivery through Kavenegar's Verify/Lookup API
 * ===========================================================================
 *
 * Same wire contract as the reference integration that already runs in
 * production:
 *
 *   GET <KAVENEGAR_LOOKUP_URL>?receptor=09XXXXXXXXX&token=<code>&template=<name>
 *
 * accepted ONLY when the HTTP status is 2xx AND the JSON body's
 * `return.status` is 200. Every other outcome rejects with an
 * `OtpDeliveryError`, classified as:
 *
 *   NOT_SENT  — a refusal status in the body (KAVENEGAR_REFUSAL_STATUSES); a
 *               3xx/4xx with no readable body; a socket error that can only
 *               happen before the request is written; an invalid input caught
 *               before any request.
 *   UNCERTAIN — our 5s timeout fired; a socket error that may have happened
 *               after the request was written; a 5xx with no readable body; a
 *               2xx without a readable `return.status`; a body over 64 KB
 *               (cut off while streaming); any status we do not recognise.
 *
 * `OtpService` releases the challenge and its cooldown on NOT_SENT and keeps
 * both on UNCERTAIN. When in doubt the classification is UNCERTAIN: wrongly
 * calling a delivered SMS "not sent" would let the customer trigger a second,
 * billed SMS at once; wrongly calling an undelivered one "uncertain" only
 * costs them the 60-second wait.
 *
 * NO RETRY HERE. Kavenegar has no idempotency key, so retrying a request that
 * may already have reached the provider can deliver and bill the same SMS
 * twice. The customer's own resend (after `OTP_RESEND_COOLDOWN_SECONDS`) is
 * the retry, and it is already bounded by `OtpService`'s per-mobile and per-IP
 * limits.
 *
 * Constructed by the factory in `auth.module.ts` (not by class injection), from
 * the validated configuration.
 *
 * WHAT IS LOGGED: on failure only — the failure reason, Kavenegar's numeric
 * status if there was one, and the masked mobile. Never the code, never the
 * URL (it contains the API key), never the raw response body or the thrown
 * error object (both can echo request details).
 */
export class KavenegarOtpSender extends OtpSender {
  private readonly logger = new Logger(KavenegarOtpSender.name);
  private readonly lookupUrl: URL;
  private readonly template: string;

  constructor(env: Readonly<Record<string, unknown>>) {
    super();
    const resolved = resolveOtpSmsConfig(env);
    // `validateEnv` has already refused to boot on these; this is the
    // defensive second check for a caller that constructs the sender directly.
    // The issue list names variables and problems only, never values.
    if (!resolved.ok || resolved.config.driver !== 'kavenegar') {
      throw new Error(
        `KavenegarOtpSender is misconfigured: ${
          resolved.ok
            ? 'OTP_SMS_DRIVER is not kavenegar'
            : resolved.issues.join('; ')
        }`,
      );
    }
    this.lookupUrl = resolved.config.lookupUrl;
    this.template = resolved.config.template;
  }

  async send(mobile: string, code: string): Promise<void> {
    try {
      // Defensive: OtpService only ever hands over the normalized form, but a
      // malformed receptor must not become a billed provider call.
      if (!NORMALIZED_MOBILE_PATTERN.test(mobile)) {
        throw fail('NOT_SENT', 'INVALID_RECEPTOR');
      }
      // Lookup tokens may not contain whitespace; a code is digits only.
      if (!/^\d{4,10}$/.test(code)) {
        throw fail('NOT_SENT', 'INVALID_TOKEN');
      }
      await this.lookup(mobile, code);
    } catch (error) {
      const failure =
        error instanceof OtpDeliveryError
          ? error
          : fail('UNCERTAIN', 'UNEXPECTED');
      this.logger.warn(
        `event=otp_sms_delivery outcome=${failure.outcome} reason=${failure.reason}` +
          (failure.providerStatus !== null
            ? ` providerStatus=${failure.providerStatus}`
            : '') +
          ` mobile=${maskMobile(mobile)}`,
      );
      throw failure;
    }
  }

  private async lookup(mobile: string, code: string): Promise<void> {
    const target = new URL(this.lookupUrl.toString());
    target.search = new URLSearchParams({
      receptor: mobile,
      token: code,
      template: this.template,
    }).toString();

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      KAVENEGAR_REQUEST_TIMEOUT_MS,
    );

    let httpStatus: number;
    let text: string;
    try {
      let response: Response;
      try {
        response = await fetch(target, {
          method: 'GET',
          headers: { accept: 'application/json' },
          // Never follow: a redirect is a misconfiguration (it is classified
          // below) and following it would resend the key-bearing request.
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        // The caught error itself is deliberately never logged or rethrown:
        // undici errors can carry the request URL, which carries the API key.
        // Only its socket error code is read.
        if (controller.signal.aborted) throw fail('UNCERTAIN', 'TIMEOUT');
        const socketCode = readSocketErrorCode(error);
        throw PRE_REQUEST_ERROR_CODES.has(socketCode)
          ? fail('NOT_SENT', `NETWORK_${socketCode}`)
          : fail('UNCERTAIN', 'NETWORK');
      }
      httpStatus = response.status;
      let bounded: string | null;
      try {
        bounded = await readBounded(response, MAX_RESPONSE_BYTES);
      } catch {
        // Headers arrived, so the request was received: the body failing is
        // not evidence that nothing was sent.
        throw fail(
          'UNCERTAIN',
          controller.signal.aborted ? 'TIMEOUT' : 'BODY_READ',
        );
      }
      if (bounded === null) {
        // The provider answered with something we refuse to read. Whatever it
        // was, the request was received: not evidence that nothing was sent.
        throw fail('UNCERTAIN', 'RESPONSE_TOO_LARGE', httpStatus);
      }
      text = bounded;
    } finally {
      clearTimeout(timer);
    }

    classify(httpStatus, readProviderStatus(text));
  }
}

/**
 * Returns on acceptance; throws a classified `OtpDeliveryError` otherwise.
 * Mirrors the reference classifier: a readable body status decides first, the
 * bare HTTP status only when there is no readable body.
 */
export function classify(
  httpStatus: number,
  providerStatus: number | null,
): void {
  if (providerStatus !== null) {
    if (providerStatus === 200) {
      if (httpStatus >= 200 && httpStatus < 300) return;
      throw fail('UNCERTAIN', 'INCONSISTENT_RESPONSE', httpStatus);
    }
    if (KAVENEGAR_REFUSAL_STATUSES.has(providerStatus)) {
      throw fail('NOT_SENT', 'PROVIDER_REJECTED', providerStatus);
    }
    throw fail('UNCERTAIN', 'UNKNOWN_PROVIDER_STATUS', providerStatus);
  }

  if (httpStatus >= 300 && httpStatus < 500) {
    // Redirects, 4xx (including 429): the request was refused at the door.
    throw fail('NOT_SENT', 'HTTP_STATUS', httpStatus);
  }
  throw fail(
    'UNCERTAIN',
    httpStatus >= 200 && httpStatus < 300
      ? 'MALFORMED_RESPONSE'
      : 'HTTP_STATUS',
    httpStatus,
  );
}

/** `error.cause.code` from undici, or `error.code`; `''` when absent. */
function readSocketErrorCode(error: unknown): string {
  const candidates = [
    (error as { cause?: { code?: unknown } } | null)?.cause?.code,
    (error as { code?: unknown } | null)?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

/** Kavenegar's `{ "return": { "status": <int> } }`, or null. */
/**
 * Reads at most `limit` bytes of the body and decodes them as UTF-8, or
 * returns null — after cancelling the stream — as soon as the body is known to
 * be larger: up front from `content-length`, otherwise the moment the running
 * total passes the limit. The request's abort signal still applies, so the 5s
 * timeout covers a slow or endless body as well as the headers.
 */
export async function readBounded(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

function readProviderStatus(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = (parsed as { return?: unknown }).return;
  if (!envelope || typeof envelope !== 'object') return null;
  const status = (envelope as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}
