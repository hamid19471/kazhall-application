import {
  DEFAULT_PRODUCT_IMAGE_MAX_BYTES,
  DEFAULT_S3_REGION,
  resolveProductImageMaxBytes,
  resolveStorageConfig,
} from './storage.config';

/** Build an env reader over a plain object. */
const reader = (env: Record<string, string | undefined>) => (name: string) =>
  env[name];

const COMPLETE = {
  S3_ENDPOINT: 'http://127.0.0.1:59000',
  S3_PUBLIC_BASE_URL: 'http://127.0.0.1:59000/kazhal-products',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET: 'kazhal-products',
};

describe('resolveStorageConfig', () => {
  it('resolves a complete configuration', () => {
    const result = resolveStorageConfig(reader(COMPLETE));
    expect(result.status).toBe('configured');
    if (result.status !== 'configured') return;

    expect(result.config).toEqual({
      endpoint: 'http://127.0.0.1:59000',
      publicBaseUrl: 'http://127.0.0.1:59000/kazhal-products',
      accessKey: 'key',
      secretKey: 'secret',
      bucket: 'kazhal-products',
      region: DEFAULT_S3_REGION,
      forcePathStyle: true,
    });
    expect(result.legacyUsed).toEqual([]);
  });

  describe('the defect this module exists to prevent', () => {
    /**
     * The original failure: no storage variables at all, yet a client was
     * built from `configService.get(...)!` and the process considered itself
     * healthy until the first upload died inside the AWS signer.
     */
    it('reports every missing variable instead of resolving', () => {
      const result = resolveStorageConfig(reader({}));
      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;

      expect(result.missing).toEqual([
        'S3_ENDPOINT',
        'S3_PUBLIC_BASE_URL',
        'S3_ACCESS_KEY',
        'S3_SECRET_KEY',
        'S3_BUCKET',
      ]);
    });

    it('treats empty and whitespace-only values as missing', () => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_ACCESS_KEY: '', S3_SECRET_KEY: '   ' }),
      );
      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;
      expect(result.missing).toEqual(['S3_ACCESS_KEY', 'S3_SECRET_KEY']);
    });

    it('reports EVERY problem in one pass, not one per restart', () => {
      const result = resolveStorageConfig(
        reader({ S3_ENDPOINT: 'not-a-url', S3_BUCKET: 'A' }),
      );
      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;
      // three absent, plus two unusable values
      expect(result.missing.length).toBe(3);
      expect(result.invalid.length).toBe(2);
    });
  });

  describe('the internal endpoint and the public URL are separate', () => {
    it('requires S3_PUBLIC_BASE_URL rather than deriving it from the endpoint', () => {
      const withoutPublic = { ...COMPLETE, S3_PUBLIC_BASE_URL: undefined };
      const result = resolveStorageConfig(reader(withoutPublic));

      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;
      expect(result.missing).toEqual(['S3_PUBLIC_BASE_URL']);
    });

    it('keeps them independent when they differ', () => {
      const result = resolveStorageConfig(
        reader({
          ...COMPLETE,
          S3_ENDPOINT: 'http://minio.internal:9000',
          S3_PUBLIC_BASE_URL: 'https://cdn.kazhal.example',
        }),
      );
      if (result.status !== 'configured')
        throw new Error('expected configured');
      expect(result.config.endpoint).toBe('http://minio.internal:9000');
      expect(result.config.publicBaseUrl).toBe('https://cdn.kazhal.example');
    });

    it('strips trailing slashes so key joining is predictable', () => {
      const result = resolveStorageConfig(
        reader({
          ...COMPLETE,
          S3_ENDPOINT: 'http://127.0.0.1:59000///',
          S3_PUBLIC_BASE_URL: 'https://cdn.example.com/assets/',
        }),
      );
      if (result.status !== 'configured')
        throw new Error('expected configured');
      expect(result.config.endpoint).toBe('http://127.0.0.1:59000');
      expect(result.config.publicBaseUrl).toBe(
        'https://cdn.example.com/assets',
      );
    });
  });

  describe('validation', () => {
    it.each([
      ['a relative URL', 'api.example.com'],
      ['a non-http scheme', 'ftp://storage.example.com'],
      ['nonsense', '::::'],
    ])('refuses %s as S3_ENDPOINT', (_label, endpoint) => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_ENDPOINT: endpoint }),
      );
      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;
      expect(result.invalid.join(' ')).toContain('S3_ENDPOINT');
    });

    it.each([
      ['too short', 'ab'],
      ['uppercase', 'Kazhal-Products'],
      ['underscore', 'kazhal_products'],
      ['leading hyphen', '-kazhal'],
      ['consecutive dots', 'kazhal..products'],
      ['an IP address', '10.0.0.1'],
    ])('refuses bucket name: %s', (_label, bucket) => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_BUCKET: bucket }),
      );
      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;
      expect(result.invalid.join(' ')).toContain('S3_BUCKET');
    });

    it('accepts a legal bucket name with dots and hyphens', () => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_BUCKET: 'kazhal.product-images' }),
      );
      expect(result.status).toBe('configured');
    });

    it('honours S3_REGION when set', () => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_REGION: 'eu-central-1' }),
      );
      if (result.status !== 'configured')
        throw new Error('expected configured');
      expect(result.config.region).toBe('eu-central-1');
    });

    it.each([
      ['true', true],
      ['false', false],
      ['TRUE', true],
    ])('parses S3_FORCE_PATH_STYLE=%s', (raw, expected) => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_FORCE_PATH_STYLE: raw }),
      );
      if (result.status !== 'configured')
        throw new Error('expected configured');
      expect(result.config.forcePathStyle).toBe(expected);
    });

    it('refuses a non-boolean S3_FORCE_PATH_STYLE rather than guessing', () => {
      const result = resolveStorageConfig(
        reader({ ...COMPLETE, S3_FORCE_PATH_STYLE: 'yes' }),
      );
      expect(result.status).toBe('unconfigured');
    });

    it('defaults path style to true, which is what MinIO needs', () => {
      const result = resolveStorageConfig(reader(COMPLETE));
      if (result.status !== 'configured')
        throw new Error('expected configured');
      expect(result.config.forcePathStyle).toBe(true);
    });
  });

  describe('legacy MINIO_* compatibility', () => {
    it('accepts the legacy spellings and reports each one', () => {
      const result = resolveStorageConfig(
        reader({
          MINIO_ENDPOINT: 'http://127.0.0.1:9000',
          MINIO_ACCESS_KEY: 'old-key',
          MINIO_SECRET_KEY: 'old-secret',
          MINIO_BUCKET: 'kazhal-products',
          S3_PUBLIC_BASE_URL: 'http://127.0.0.1:9000/kazhal-products',
        }),
      );
      if (result.status !== 'configured')
        throw new Error('expected configured');

      expect(result.config.endpoint).toBe('http://127.0.0.1:9000');
      expect(result.config.accessKey).toBe('old-key');
      expect([...result.legacyUsed].sort()).toEqual([
        'MINIO_ACCESS_KEY',
        'MINIO_BUCKET',
        'MINIO_ENDPOINT',
        'MINIO_SECRET_KEY',
      ]);
    });

    it('S3_* wins wherever both are set', () => {
      const result = resolveStorageConfig(
        reader({
          ...COMPLETE,
          MINIO_ENDPOINT: 'http://legacy:9000',
          MINIO_ACCESS_KEY: 'legacy-key',
        }),
      );
      if (result.status !== 'configured')
        throw new Error('expected configured');
      expect(result.config.endpoint).toBe(COMPLETE.S3_ENDPOINT);
      expect(result.config.accessKey).toBe('key');
      // Nothing legacy was actually consumed, so nothing is reported.
      expect(result.legacyUsed).toEqual([]);
    });

    it('has no legacy spelling for the public base URL', () => {
      // No old variable ever meant this, so there is nothing to fall back to.
      const result = resolveStorageConfig(
        reader({
          MINIO_ENDPOINT: 'http://127.0.0.1:9000',
          MINIO_ACCESS_KEY: 'k',
          MINIO_SECRET_KEY: 's',
          MINIO_BUCKET: 'kazhal-products',
        }),
      );
      expect(result.status).toBe('unconfigured');
      if (result.status !== 'unconfigured') return;
      expect(result.missing).toEqual(['S3_PUBLIC_BASE_URL']);
    });
  });
});

describe('resolveProductImageMaxBytes', () => {
  it('defaults to 5 MiB when unset', () => {
    const result = resolveProductImageMaxBytes(reader({}));
    expect(result).toEqual({
      status: 'ok',
      maxBytes: DEFAULT_PRODUCT_IMAGE_MAX_BYTES,
    });
    expect(DEFAULT_PRODUCT_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('accepts an explicit value', () => {
    const result = resolveProductImageMaxBytes(
      reader({ PRODUCT_IMAGE_MAX_BYTES: '2097152' }),
    );
    expect(result).toEqual({ status: 'ok', maxBytes: 2_097_152 });
  });

  it.each([
    ['not a number', 'five megabytes'],
    ['a float', '1.5'],
    ['negative', '-1'],
    ['a suffixed value', '5MB'],
  ])('refuses %s rather than falling back to the default', (_label, raw) => {
    const result = resolveProductImageMaxBytes(
      reader({ PRODUCT_IMAGE_MAX_BYTES: raw }),
    );
    expect(result.status).toBe('invalid');
  });

  it('refuses a value so small nothing could fit', () => {
    expect(
      resolveProductImageMaxBytes(reader({ PRODUCT_IMAGE_MAX_BYTES: '10' }))
        .status,
    ).toBe('invalid');
  });

  it('refuses a value large enough to be a memory denial of service', () => {
    // memoryStorage() buffers the whole request; 512 MiB per upload is not a
    // limit, it is an outage waiting for four concurrent users.
    expect(
      resolveProductImageMaxBytes(
        reader({ PRODUCT_IMAGE_MAX_BYTES: String(512 * 1024 * 1024) }),
      ).status,
    ).toBe('invalid');
  });
});
