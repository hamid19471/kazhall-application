import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  ProductImageErrorCodes,
  ProductImageMessages,
} from '../constants/product-image.messages';
import type { SupportedImageMimeType } from './image-content-type';
import { extensionForImageType } from './image-content-type';
import type { ObjectStorageConfig, StorageResolution } from './storage.config';

/**
 * ============================================================================
 * THE S3 SEAM.
 *
 * Replaces `MinioService`, which was MinIO-shaped in four ways that all had to
 * go: it pinned `region: 'us-east-1'` in source, hard-coded `Bucket:
 * 'products'` (a bucket that, as it turns out, had never been created on any
 * machine), built its client from non-null assertions over absent credentials,
 * and published object URLs by gluing the INTERNAL endpoint to a path it had
 * already prefixed — producing `…/products/products/<uuid>-<filename>`.
 *
 * Nothing here knows it is talking to MinIO. It talks to an S3 API described
 * entirely by {@link ObjectStorageConfig}, so the production target can be AWS
 * S3, Cloudflare R2, Backblaze B2 or a MinIO cluster with no code change —
 * only `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` and `S3_PUBLIC_BASE_URL`.
 *
 * ---------------------------------------------------------------------------
 * A CLIENT IS NEVER BUILT WITHOUT CREDENTIALS
 * ---------------------------------------------------------------------------
 * If configuration did not resolve, `client` stays `null` and every call
 * refuses with `IMAGE_STORAGE_UNAVAILABLE`. That is the whole of the original
 * bug's mechanism removed: there is no code path that can hand the AWS signer
 * an undefined key, because the only constructor that makes a client takes a
 * `configured` resolution.
 *
 * ---------------------------------------------------------------------------
 * WHAT NEVER REACHES A LOG
 * ---------------------------------------------------------------------------
 * `S3_SECRET_KEY`, the access key, and any `Authorization` / `X-Amz-Signature`
 * material. Operators need the endpoint, the bucket, the key and the SDK's
 * error name — all of which are here — and none of them is a secret. The
 * redaction in {@link describeFailure} is belt and braces for the one case
 * where an S3 implementation echoes a canonical request back inside a message.
 * ============================================================================
 */

/** What an upload produced. */
export interface StoredObject {
  /** The object key inside the bucket. Persisted so cleanup can delete it. */
  readonly key: string;
  /** Browser-reachable URL, built from `S3_PUBLIC_BASE_URL`. */
  readonly url: string;
  readonly bytes: number;
  readonly contentType: SupportedImageMimeType;
}

/** Why storage refused. Distinguishes an operator-fixable bucket gap. */
type FailureKind = 'unavailable' | 'bucket_missing';

@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly client: S3Client | null = null;
  private readonly config: ObjectStorageConfig | null = null;

  constructor(resolution: StorageResolution) {
    if (resolution.status !== 'configured') return;

    this.config = resolution.config;
    this.client = new S3Client({
      region: resolution.config.region,
      endpoint: resolution.config.endpoint,
      credentials: {
        accessKeyId: resolution.config.accessKey,
        secretAccessKey: resolution.config.secretKey,
      },
      forcePathStyle: resolution.config.forcePathStyle,
    });
  }

  /** True when uploads can be attempted at all. */
  isAvailable(): boolean {
    return this.client !== null && this.config !== null;
  }

  /** The bucket in use, for diagnostics. `null` when unconfigured. */
  get bucket(): string | null {
    return this.config?.bucket ?? null;
  }

  /**
   * Public URL for a key. Exposed so a migration or a repair script can
   * recompute a URL without duplicating the join rule.
   */
  publicUrlFor(key: string): string {
    if (!this.config) {
      throw new Error('publicUrlFor called while storage is unconfigured');
    }
    return `${this.config.publicBaseUrl}/${key}`;
  }

  /**
   * Build a collision-resistant object key.
   *
   * THE ORIGINAL FILENAME IS NOT IN IT. The old key was
   * `products/${uuid()}-${file.originalname}`, which put attacker-controlled
   * text into a path: `../`, a second extension (`x.png.html`), control
   * characters, RTL overrides that make a key display backwards, and
   * unbounded length. Sanitising that safely is a surprising amount of code
   * to preserve information nobody reads — the filename is not shown anywhere
   * in the Admin console. So it is simply dropped, and the extension is
   * normalised from the VERIFIED content type rather than from what the
   * upload claimed.
   *
   * The date segments are for humans and lifecycle rules (an S3 prefix
   * expiry, a bulk listing) and carry no meaning the code depends on.
   */
  private buildKey(contentType: SupportedImageMimeType): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `products/${year}/${month}/${randomUUID()}.${extensionForImageType(contentType)}`;
  }

  /**
   * Store one verified image.
   *
   * `contentType` is the type this project VERIFIED from the bytes, never the
   * one the client declared, so the object cannot be served back as something
   * it is not.
   */
  async putImage(
    body: Buffer,
    contentType: SupportedImageMimeType,
  ): Promise<StoredObject> {
    const client = this.client;
    const config = this.config;
    if (!client || !config) {
      this.logger.error(
        'Refusing an upload: object storage is not configured. ' +
          'Set S3_ENDPOINT, S3_PUBLIC_BASE_URL, S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET.',
      );
      throw this.refuse('unavailable');
    }

    const key = this.buildKey(contentType);

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
        }),
      );
    } catch (cause) {
      const kind = this.classify(cause);
      this.logger.error(
        `PutObject failed: ${this.describeFailure(cause)} ` +
          `[endpoint=${config.endpoint} bucket=${config.bucket} key=${key} bytes=${body.byteLength}]`,
      );
      throw this.refuse(kind);
    }

    return {
      key,
      url: this.publicUrlFor(key),
      bytes: body.byteLength,
      contentType,
    };
  }

  /**
   * Remove one object.
   *
   * IDEMPOTENT BY CONSTRUCTION: S3 `DeleteObject` succeeds whether or not the
   * key is there, which is what lets both callers — the compensation path
   * after a failed database write, and the orphan sweeper — run twice without
   * caring.
   *
   * Returns `false` instead of throwing when storage refuses. Every caller is
   * already handling a failure when it calls this, and turning a cleanup miss
   * into a second exception would mask the first one.
   *
   * A `false` HERE IS NOT THE END OF THE STORY, and this method deliberately
   * makes no promise about what happens next. Its callers hold a durable
   * `object_deletion_jobs` row for the key before they call, so a refusal is
   * retried by `ObjectDeletionService`. This method's only contract is
   * "deleted, or not deleted".
   */
  async deleteObject(key: string): Promise<boolean> {
    const client = this.client;
    const config = this.config;
    if (!client || !config) {
      this.logger.warn(
        `Cannot delete object ${key}: object storage is not configured.`,
      );
      return false;
    }

    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return true;
    } catch (cause) {
      this.logger.error(
        `DeleteObject failed: ${this.describeFailure(cause)} ` +
          `[endpoint=${config.endpoint} bucket=${config.bucket} key=${key}]`,
      );
      return false;
    }
  }

  /**
   * Turn any SDK or network failure into one of two stable outcomes.
   *
   * A missing bucket is singled out because it is the one storage failure with
   * a specific, cheap operator fix — run the provisioning step — and because
   * it is the SECOND fault this project actually had: even after credentials
   * were supplied, the hard-coded `products` bucket had never been created on
   * any machine, so the next error would have been this one.
   */
  private classify(cause: unknown): FailureKind {
    if (cause instanceof S3ServiceException) {
      if (cause.name === 'NoSuchBucket') return 'bucket_missing';
      // Some implementations answer a missing bucket with a bare 404.
      if (
        cause.$metadata?.httpStatusCode === 404 &&
        cause.name === 'NotFound'
      ) {
        return 'bucket_missing';
      }
    }
    return 'unavailable';
  }

  /**
   * A one-line, non-sensitive description for the operator log.
   *
   * Signature and credential material is stripped even though the SDK does not
   * normally include it, because "normally" is not a guarantee across every
   * S3-compatible server's error text.
   */
  private describeFailure(cause: unknown): string {
    const name =
      cause instanceof Error
        ? cause.name
        : typeof cause === 'string'
          ? cause
          : 'UnknownError';
    const rawMessage = cause instanceof Error ? cause.message : '';
    const status =
      cause instanceof S3ServiceException
        ? cause.$metadata?.httpStatusCode
        : undefined;
    const code = (cause as { code?: string })?.code;

    const safeMessage = rawMessage
      .replace(
        /(AWS4-HMAC-SHA256|Signature=|Credential=|X-Amz-Signature=)[^\s&,]*/gi,
        '$1[redacted]',
      )
      .replace(/\s+/g, ' ')
      .slice(0, 300);

    return [
      name,
      code ? `code=${code}` : undefined,
      status ? `http=${status}` : undefined,
      safeMessage ? `message="${safeMessage}"` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** The client-facing refusal. Never carries SDK text. */
  private refuse(kind: FailureKind): ServiceUnavailableException {
    if (kind === 'bucket_missing') {
      return new ServiceUnavailableException({
        error: ProductImageErrorCodes.IMAGE_STORAGE_BUCKET_MISSING,
        message: ProductImageMessages.STORAGE_BUCKET_MISSING,
      });
    }
    return new ServiceUnavailableException({
      error: ProductImageErrorCodes.IMAGE_STORAGE_UNAVAILABLE,
      message: ProductImageMessages.STORAGE_UNAVAILABLE,
    });
  }
}
