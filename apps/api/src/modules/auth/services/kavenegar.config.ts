/**
 * ===========================================================================
 * OTP SMS configuration — which `OtpSender` is bound, and the Kavenegar
 * endpoint it calls
 * ===========================================================================
 *
 * A PURE function of the environment, so the same rules run in two places:
 * `validateEnv` (refuses to boot on a bad value) and `KavenegarOtpSender`
 * (reads the validated endpoint). There is no second parser to drift.
 *
 * ENDPOINT SHAPE. Kavenegar carries the API key IN THE URL PATH:
 *   https://api.kavenegar.com/v1/<API_KEY>/verify/lookup.json
 * so `KAVENEGAR_LOOKUP_URL` IS A SECRET in its entirety. It is never logged,
 * never put in an error message, and the validation issues below name the
 * PROBLEM ("WRONG_PATH"), never the value. The validation rules are the ones
 * the reference application already runs in production with.
 */

export const OTP_SMS_DRIVERS = ['log', 'kavenegar'] as const;
export type OtpSmsDriver = (typeof OTP_SMS_DRIVERS)[number];

/**
 * The Verify/Lookup template used when `KAVENEGAR_OTP_TEMPLATE` is unset.
 *
 * TEMPORARY, BY OWNER DECISION: Kazhal reuses the already-approved `loginVerify`
 * template of the account's existing application for customer testing, so no
 * new template has to be created or approved at this stage. Kazhal sends only
 * `token` (its 6-digit code) — the same single parameter that template already
 * receives. Set `KAVENEGAR_OTP_TEMPLATE` to switch to a Kazhal-specific
 * template later, with no code change.
 */
export const KAVENEGAR_DEFAULT_OTP_TEMPLATE = 'loginVerify';

/** Upper bound on a single provider call. Matches the reference integration. */
export const KAVENEGAR_REQUEST_TIMEOUT_MS = 5_000;

export type KavenegarUrlIssue =
  | 'MISSING'
  | 'MALFORMED'
  | 'UNEXPECTED_HOST'
  | 'INSECURE'
  | 'WRONG_PATH';
export type KavenegarTemplateIssue = 'MISSING' | 'MALFORMED';

export type OtpSmsConfig =
  | { driver: 'log' }
  | { driver: 'kavenegar'; lookupUrl: URL; template: string };

export type OtpSmsConfigResult =
  | { ok: true; config: OtpSmsConfig }
  | { ok: false; issues: string[] };

type OtpSmsEnv = Readonly<Record<string, unknown>>;

const LOOKUP_PATH = /^\/v1\/[^/]+\/verify\/lookup\.json$/;

/**
 * Kavenegar template names are short identifiers created in the panel. Anything
 * else (spaces, slashes, query characters) is a paste error, not a template.
 */
const TEMPLATE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Kavenegar's documented REST API host. The only production destination. */
export const KAVENEGAR_API_HOST = 'api.kavenegar.com';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function read(env: OtpSmsEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function validateLookupUrl(
  raw: string | undefined,
  nodeEnv: string | undefined,
): { url: URL } | { issue: KavenegarUrlIssue } {
  if (!raw) return { issue: 'MISSING' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { issue: 'MALFORMED' };
  }

  if (url.username || url.password || url.search || url.hash) {
    return { issue: 'MALFORMED' };
  }

  if (url.protocol === 'http:') {
    // Plain HTTP would put the API key and every OTP on the wire in clear.
    // Only a loopback stub, and never in production.
    if (nodeEnv === 'production' || !LOOPBACK_HOSTS.has(url.hostname)) {
      return { issue: 'INSECURE' };
    }
  } else if (url.protocol !== 'https:') {
    return { issue: 'MALFORMED' };
  }

  // THE HOST IS PINNED. This URL carries the API key in its path and every
  // request carries a live OTP, so a typo'd, copy-pasted or tampered host must
  // stop the boot rather than ship both to somebody else. Only Kavenegar's
  // documented API host on the default https port is accepted; a loopback
  // stub (http or https, any port) is allowed outside production only, and
  // unit tests mock `fetch` against the real host name, so they need neither.
  const isKavenegar =
    url.protocol === 'https:' &&
    url.hostname === KAVENEGAR_API_HOST &&
    url.port === '';
  const isLocalStub =
    nodeEnv !== 'production' && LOOPBACK_HOSTS.has(url.hostname);
  if (!isKavenegar && !isLocalStub) return { issue: 'UNEXPECTED_HOST' };

  if (!LOOKUP_PATH.test(url.pathname)) return { issue: 'WRONG_PATH' };

  return { url };
}

/**
 * Resolves `OTP_SMS_DRIVER` and, for `kavenegar`, its endpoint and template.
 *
 * `OTP_SMS_DRIVER` unset or empty means `log` — the binding every existing
 * deployment already runs, so adding this code changes nothing until the
 * owner opts in.
 */
export function resolveOtpSmsConfig(env: OtpSmsEnv): OtpSmsConfigResult {
  const driver = read(env, 'OTP_SMS_DRIVER') ?? 'log';

  if (!(OTP_SMS_DRIVERS as readonly string[]).includes(driver)) {
    return {
      ok: false,
      issues: [`OTP_SMS_DRIVER must be one of: ${OTP_SMS_DRIVERS.join(', ')}`],
    };
  }

  if (driver === 'log') return { ok: true, config: { driver: 'log' } };

  const issues: string[] = [];
  const nodeEnv = read(env, 'NODE_ENV');

  const lookup = validateLookupUrl(read(env, 'KAVENEGAR_LOOKUP_URL'), nodeEnv);
  if ('issue' in lookup) {
    issues.push(
      `KAVENEGAR_LOOKUP_URL is ${lookup.issue} (expected https://api.kavenegar.com/v1/<API_KEY>/verify/lookup.json)`,
    );
  }

  const template =
    read(env, 'KAVENEGAR_OTP_TEMPLATE') ?? KAVENEGAR_DEFAULT_OTP_TEMPLATE;
  if (!TEMPLATE_PATTERN.test(template)) {
    issues.push('KAVENEGAR_OTP_TEMPLATE is MALFORMED');
  }

  if (issues.length > 0 || 'issue' in lookup) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    config: { driver: 'kavenegar', lookupUrl: lookup.url, template },
  };
}
