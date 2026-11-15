import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Access to the disposable object storage `globalSetup` provisioned.
 *
 * WHY A SEPARATE CLIENT AND NOT THE APPLICATION'S. Every assertion here is
 * about what really landed in the bucket, so it has to reach the bucket
 * INDEPENDENTLY of the code under test. Asking `ObjectStorageService` whether
 * it stored something proves only that it thinks it did; a second client
 * proves the bytes exist, carry the right content type, and disappear again
 * when they are supposed to.
 */
export interface TestStorage {
  endpoint: string;
  publicBaseUrl: string;
  bucket: string;
  client: S3Client;
  /** `true` when the object exists. */
  objectExists(key: string): Promise<boolean>;
  /** The stored `Content-Type`, or `null` when the object is absent. */
  contentTypeOf(key: string): Promise<string | null>;
  /** Raw bytes, or `null` when absent. */
  bodyOf(key: string): Promise<Buffer | null>;
  /** Every key currently under `prefix`. */
  listKeys(prefix?: string): Promise<string[]>;
  removeObject(key: string): Promise<void>;
  /**
   * Empty the bucket.
   *
   * The storage counterpart of `resetDb`. Without it a spec that asserts "the
   * bucket is empty" is really asserting "no earlier test in this file
   * uploaded anything", which is true exactly once and then silently stops
   * being a test of anything.
   */
  clearBucket(): Promise<void>;
  destroy(): void;
}

/** `null` when this run has no object storage — see `ContainerState.minio`. */
export function testStorage(): TestStorage | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;

  if (
    !endpoint ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !publicBaseUrl
  ) {
    return null;
  }

  const client = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  const absent = (error: unknown): boolean => {
    const name = (error as { name?: string }).name ?? '';
    return name === 'NotFound' || name === 'NoSuchKey';
  };

  return {
    endpoint,
    publicBaseUrl,
    bucket,
    client,

    async objectExists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (absent(error)) return false;
        throw error;
      }
    },

    async contentTypeOf(key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return head.ContentType ?? null;
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },

    async bodyOf(key) {
      try {
        const object = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const bytes = await object.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },

    async listKeys(prefix) {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
      );
      return (listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === 'string');
    },

    async removeObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async clearBucket() {
      // Deliberately one delete per key rather than DeleteObjects: the batch
      // API reports per-key failures in the RESPONSE rather than by throwing,
      // so a partial failure would pass unnoticed and leave the next spec
      // running against a dirty bucket.
      let cursor: string | undefined;
      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: cursor,
          }),
        );
        for (const entry of listed.Contents ?? []) {
          if (entry.Key) {
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: entry.Key }),
            );
          }
        }
        cursor = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (cursor);
    },

    destroy() {
      client.destroy();
    },
  };
}

/**
 * The storage handle, or an explanation of why the spec cannot run.
 *
 * NEVER SILENTLY PASSES. A storage spec that quietly succeeds when there is no
 * storage is worse than no spec: it reports green while proving nothing, which
 * is exactly how the original upload defect survived — the one existing test
 * that touched this route asserted only "not 403", because there was no MinIO
 * in the harness to assert anything else against.
 */
export function requireStorage(): TestStorage {
  const storage = testStorage();
  if (!storage) {
    throw new Error(
      'This spec needs object storage, and this run has none. `pnpm test:int` ' +
        'starts a disposable MinIO automatically; in KAZHAL_INT_PG_MODE=external ' +
        'set KAZHAL_INT_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY to point at one.',
    );
  }
  return storage;
}

/** True when this run provisioned storage at all. */
export function hasStorage(): boolean {
  return testStorage() !== null;
}
