/**
 * ============================================================================
 * OBJECT-STORAGE CONFIGURATION — resolved and validated ONCE, at boot.
 * ============================================================================
 *
 * WHAT WENT WRONG BEFORE, precisely.
 *
 * `MinioService` built its `S3Client` in its constructor from
 * `configService.get('MINIO_ACCESS_KEY')!` — a non-null assertion over a value
 * that was, on every developer machine and in `.env.example`, simply absent.
 * TypeScript was told to stop worrying; nothing else checked. The client was
 * constructed successfully with `{ accessKeyId: undefined, secretAccessKey:
 * undefined }`, the application booted clean, and the first upload died inside
 * the AWS signer:
 *
 *     Error: Resolved credential object is not valid
 *       at SignatureV4SignWithCredentials.validateResolvedCredentials
 *
 * which `GlobalExceptionFilter` correctly refused to leak, so the operator saw
 * «A critical error has occurred. Please contact support.» and no more. The
 * defect was not the 500. The defect was that a process missing every piece of
 * its storage configuration considered itself healthy.
 *
 * ---------------------------------------------------------------------------
 * THE ENDPOINT AND THE PUBLIC URL ARE DIFFERENT THINGS
 * ---------------------------------------------------------------------------
 * The old code used `MINIO_ENDPOINT` for both the address the API uploads to
 * and the address it wrote into `product_images.url` for a browser to fetch.
 * Those coincide only on a laptop. In any real deployment the API reaches
 * storage over a private address — `http://minio.internal:9000`, a service
 * mesh name, a VPC endpoint — that a customer's browser cannot resolve and
 * must never be told about, while the public asset lives behind a CDN or a
 * public bucket host. Conflating them means either the API cannot upload or
 * the browser cannot display, and which one breaks depends on which address
 * you picked.
 *
 * So there are two variables and `S3_PUBLIC_BASE_URL` is REQUIRED rather than
 * derived from the endpoint. Deriving it would silently reintroduce exactly
 * the conflation this separation exists to remove, and it would do so in
 * production, where the derived value is wrong.
 *
 * CONTRACT: the public URL of an object is `S3_PUBLIC_BASE_URL + '/' + key`.
 * Nothing else is appended — not the bucket, not a prefix. So for path-style
 * MinIO the variable includes the bucket
 * (`http://127.0.0.1:59000/kazhal-products`), and for a CDN mapped to the
 * bucket root it does not (`https://cdn.example.com`). One rule, no per-driver
 * special cases, and no repeat of the doubled `products/products/…` path the
 * old string interpolation produced.
 *
 * ---------------------------------------------------------------------------
 * LEGACY `MINIO_*`
 * ---------------------------------------------------------------------------
 * `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` are still read,
 * so an existing deployment does not break on the day this ships. `S3_*` wins
 * wherever both are set, every use of a legacy name is reported once at boot,
 * and there is no legacy spelling for the two genuinely new ideas
 * (`S3_PUBLIC_BASE_URL`, `S3_BUCKET`) because no old variable meant them.
 * ============================================================================
 */

/** How a value was reached, so boot logging can name the legacy spellings. */
export interface ResolvedFrom {
  readonly variable: string;
  readonly legacy: boolean;
}

export interface ObjectStorageConfig {
  /** Internal endpoint the API signs and uploads against. Never sent to a browser. */
  readonly endpoint: string;
  /** Browser-reachable base. The object key is appended to it with a single `/`. */
  readonly publicBaseUrl: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  readonly region: string;
  /**
   * Path-style addressing (`host/bucket/key`) rather than virtual-host style
   * (`bucket.host/key`). MinIO and most S3-compatible servers need `true`;
   * AWS S3 itself prefers `false`. Defaults to `true` because that is what the
   * documented local stack requires.
   */
  readonly forcePathStyle: boolean;
}

export type StorageResolution =
  | {
      readonly status: 'configured';
      readonly config: ObjectStorageConfig;
      /** Legacy `MINIO_*` names that supplied a value. */
      readonly legacyUsed: readonly string[];
    }
  | {
      readonly status: 'unconfigured';
      /** Required variables with no value under any accepted spelling. */
      readonly missing: readonly string[];
      /** Variables that had a value which cannot be used, with the reason. */
      readonly invalid: readonly string[];
      readonly legacyUsed: readonly string[];
    };

/** Reads one environment variable. Injected so this module stays pure and testable. */
export type EnvReader = (name: string) => string | undefined;

/** Absent, empty and whitespace-only all mean "not set". */
function value(read: EnvReader, name: string): string | undefined {
  const raw = read(name);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `S3_X`, falling back to a legacy `MINIO_X`. */
function preferred(
  read: EnvReader,
  canonical: string,
  legacy?: string,
): { value?: string; from?: ResolvedFrom } {
  const modern = value(read, canonical);
  if (modern !== undefined) {
    return { value: modern, from: { variable: canonical, legacy: false } };
  }
  if (legacy) {
    const old = value(read, legacy);
    if (old !== undefined) {
      return { value: old, from: { variable: legacy, legacy: true } };
    }
  }
  return {};
}

/** Strip trailing slashes so joining a key is predictable. */
function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function invalidUrl(raw: string, name: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `${name} is not an absolute URL (got ${JSON.stringify(raw)})`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${name} must use http or https (got ${JSON.stringify(parsed.protocol)})`;
  }
  return null;
}

/**
 * Bucket naming, per the S3 rules every compatible implementation shares.
 *
 * Validated here rather than left to the server because an invalid name fails
 * at the FIRST upload with a signature or "no such bucket" error that names
 * nothing useful, whereas here it fails at boot naming the variable.
 */
function invalidBucket(name: string): string | null {
  if (name.length < 3 || name.length > 63) {
    return 'S3_BUCKET must be between 3 and 63 characters';
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
    return (
      'S3_BUCKET may contain only lowercase letters, digits, dots and hyphens, ' +
      'and must start and end with a letter or digit'
    );
  }
  if (name.includes('..')) return 'S3_BUCKET must not contain consecutive dots';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    return 'S3_BUCKET must not be formatted as an IP address';
  }
  return null;
}

/** Everything a caller must supply for uploads to work at all. */
const REQUIRED = [
  'S3_ENDPOINT',
  'S3_PUBLIC_BASE_URL',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
] as const;

export const DEFAULT_S3_REGION = 'us-east-1';

/**
 * Resolve storage configuration from the environment.
 *
 * Returns a discriminated result rather than throwing, because the two callers
 * want opposite things from a bad configuration: production must refuse to
 * start, development must start and say uploads are off. Deciding that here
 * would force one of them to catch an exception to implement the other.
 */
export function resolveStorageConfig(read: EnvReader): StorageResolution {
  const legacyUsed: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  const note = (from?: ResolvedFrom) => {
    if (from?.legacy) legacyUsed.push(from.variable);
  };

  const endpoint = preferred(read, 'S3_ENDPOINT', 'MINIO_ENDPOINT');
  const publicBase = preferred(read, 'S3_PUBLIC_BASE_URL');
  const accessKey = preferred(read, 'S3_ACCESS_KEY', 'MINIO_ACCESS_KEY');
  const secretKey = preferred(read, 'S3_SECRET_KEY', 'MINIO_SECRET_KEY');
  const bucket = preferred(read, 'S3_BUCKET', 'MINIO_BUCKET');

  note(endpoint.from);
  note(publicBase.from);
  note(accessKey.from);
  note(secretKey.from);
  note(bucket.from);

  const found: Record<(typeof REQUIRED)[number], string | undefined> = {
    S3_ENDPOINT: endpoint.value,
    S3_PUBLIC_BASE_URL: publicBase.value,
    S3_ACCESS_KEY: accessKey.value,
    S3_SECRET_KEY: secretKey.value,
    S3_BUCKET: bucket.value,
  };
  for (const name of REQUIRED) {
    if (found[name] === undefined) missing.push(name);
  }

  // --- validate whatever WAS supplied, even if something else is missing, so
  // --- one boot reports every problem instead of one per restart.
  if (endpoint.value) {
    const problem = invalidUrl(endpoint.value, 'S3_ENDPOINT');
    if (problem) invalid.push(problem);
  }
  if (publicBase.value) {
    const problem = invalidUrl(publicBase.value, 'S3_PUBLIC_BASE_URL');
    if (problem) invalid.push(problem);
  }
  if (bucket.value) {
    const problem = invalidBucket(bucket.value);
    if (problem) invalid.push(problem);
  }

  const region = value(read, 'S3_REGION') ?? DEFAULT_S3_REGION;
  if (region.length === 0) invalid.push('S3_REGION must not be empty');

  const rawPathStyle = value(read, 'S3_FORCE_PATH_STYLE');
  let forcePathStyle = true;
  if (rawPathStyle !== undefined) {
    const normalised = rawPathStyle.toLowerCase();
    if (normalised === 'true' || normalised === 'false') {
      forcePathStyle = normalised === 'true';
    } else {
      invalid.push(
        `S3_FORCE_PATH_STYLE must be "true" or "false" (got ${JSON.stringify(rawPathStyle)})`,
      );
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { status: 'unconfigured', missing, invalid, legacyUsed };
  }

  return {
    status: 'configured',
    legacyUsed,
    config: {
      endpoint: withoutTrailingSlash(found.S3_ENDPOINT!),
      publicBaseUrl: withoutTrailingSlash(found.S3_PUBLIC_BASE_URL!),
      accessKey: found.S3_ACCESS_KEY!,
      secretKey: found.S3_SECRET_KEY!,
      bucket: found.S3_BUCKET!,
      region,
      forcePathStyle,
    },
  };
}

// ---------------------------------------------------------------------------
// Upload size limit
// ---------------------------------------------------------------------------

/**
 * 5 MiB.
 *
 * Chosen against what a product photograph actually is: a 2000×2000 JPEG at
 * good quality is well under 1 MB, and a modern phone's full-resolution HEIC
 * export converted to JPEG lands around 3-4 MB. 5 MiB accepts every
 * photograph a shop will realistically take while refusing the 40 MB scanner
 * TIFF and the accidental video.
 */
export const DEFAULT_PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Below this a limit is certainly a typo (nothing real fits in 1 KiB). */
const MIN_ALLOWED_MAX_BYTES = 1024;
/**
 * Above this the request is buffered entirely in memory by
 * `multer.memoryStorage()`, and a handful of concurrent uploads becomes a
 * denial of service against the API's own heap.
 */
const MAX_ALLOWED_MAX_BYTES = 64 * 1024 * 1024;

export type MaxBytesResolution =
  | { readonly status: 'ok'; readonly maxBytes: number }
  | { readonly status: 'invalid'; readonly reason: string };

export function resolveProductImageMaxBytes(
  read: EnvReader,
): MaxBytesResolution {
  const raw = value(read, 'PRODUCT_IMAGE_MAX_BYTES');
  if (raw === undefined) {
    return { status: 'ok', maxBytes: DEFAULT_PRODUCT_IMAGE_MAX_BYTES };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      status: 'invalid',
      reason: `PRODUCT_IMAGE_MAX_BYTES must be a positive integer number of bytes (got ${JSON.stringify(raw)})`,
    };
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    return {
      status: 'invalid',
      reason: `PRODUCT_IMAGE_MAX_BYTES is not a safe integer (got ${JSON.stringify(raw)})`,
    };
  }
  if (parsed < MIN_ALLOWED_MAX_BYTES || parsed > MAX_ALLOWED_MAX_BYTES) {
    return {
      status: 'invalid',
      reason:
        `PRODUCT_IMAGE_MAX_BYTES must be between ${MIN_ALLOWED_MAX_BYTES} and ` +
        `${MAX_ALLOWED_MAX_BYTES} bytes (got ${parsed})`,
    };
  }
  return { status: 'ok', maxBytes: parsed };
}
