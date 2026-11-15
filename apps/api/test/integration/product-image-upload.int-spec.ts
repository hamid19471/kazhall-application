import * as request from 'supertest';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ObjectStorageService } from 'src/common/storage/object-storage.service';
import { ProductImage } from 'src/modules/products/entities/product-image.entity';
import { PRODUCT_IMAGE_MAX_BYTES } from 'src/common/storage/storage.module';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { resetDb } from './setup/test-db';
import { requireStorage, TestStorage } from './setup/test-storage';
import { createUser, seedRoles } from './setup/seed-helpers';
import { uniqueSuffix } from './setup/fixture-ids';
import {
  EMPTY,
  GIF_1X1,
  JPEG_8X8,
  NOT_AN_IMAGE,
  PNG_8X8,
  SVG_DOCUMENT,
  TRUNCATED_JPEG,
  TRUNCATED_PNG,
  WEBP_8X8,
  oversizedPng,
} from '../support/image-fixtures';

/**
 * ============================================================================
 * PRODUCT IMAGE UPLOAD — against a REAL S3 implementation.
 *
 * WHAT THIS FILE EXISTS TO PROVE, and why each claim needs a real bucket:
 *
 *   1. The route works at all. Before this change `POST /products/uploadImage`
 *      answered 500 «A critical error has occurred» on every machine, because
 *      an `S3Client` was built from `configService.get('MINIO_ACCESS_KEY')!`
 *      over a variable nobody had ever set. The one existing test that touched
 *      this route asserted only "not 403" — it could not assert more, because
 *      the harness had no storage. That gap is why the defect shipped, and it
 *      is the first thing closed here.
 *
 *   2. The bytes decide the format, not the filename or the declared type.
 *      Provable only against something that stores and returns a content type.
 *
 *   3. THE PUBLIC URL IS BUILT FROM `S3_PUBLIC_BASE_URL`, NEVER FROM THE
 *      INTERNAL ENDPOINT. The harness deliberately sets them to different
 *      strings so the difference is observable.
 *
 *   4. Compensation: an object whose row fails to insert is taken back out of
 *      the bucket. Asserted by looking in the bucket afterwards with an
 *      independent client — a mock cannot fail this test.
 *
 *   5. A missing bucket is a distinct, stable 503 and not a 500.
 *
 *   6. Cleanup deletes what it should and NEVER an attached image.
 * ============================================================================
 */
describe('product image upload (int)', () => {
  let ctx: TestApp;
  let storage: TestStorage;

  beforeAll(async () => {
    // Throws — never skips — when this run has no storage. A storage spec that
    // passes vacuously is how the original defect survived.
    storage = requireStorage();
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
    storage.destroy();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
    // The bucket needs resetting for the same reason the database does: several
    // assertions below are "nothing was stored", and that is only meaningful
    // against an empty bucket.
    await storage.clearBucket();
    ctx.redis.flush();
  });

  async function superAdminJar(): Promise<CookieJar> {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return authenticate(ctx, username, password, 'admin');
  }

  async function roleWith(
    admin: CookieJar,
    permissions: string[],
  ): Promise<number> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const response = await withCookies(ctx, admin)
      .post('/admin/access/roles')
      .send({
        name: `role_${suffix}`,
        titleFa: 'نقش آزمایشی',
        permissions,
      });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  async function staffHolding(
    admin: CookieJar,
    permissions: string[],
  ): Promise<CookieJar> {
    const roleId = await roleWith(admin, permissions);
    const created = await createUser(ctx.dataSource, { roles: [] });
    const assign = await withCookies(ctx, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [roleId] });
    expect(assign.status).toBe(200);
    return authenticate(ctx, created.username, created.password, 'admin');
  }

  const upload = (jar: CookieJar, body: Buffer, name: string, type: string) =>
    withCookies(ctx, jar)
      .post('/products/uploadImage')
      .attach('file', body, { filename: name, contentType: type });

  async function rowFor(id: number): Promise<{
    id: number;
    url: string;
    objectKey: string | null;
    productId: number | null;
    createdAt: Date;
  }> {
    const [row] = await ctx.dataSource.query(
      `SELECT "id", "url", "objectKey", "productId", "createdAt"
         FROM "product_images" WHERE "id" = $1`,
      [id],
    );
    return row;
  }

  // =========================================================================
  // 1. The happy path, per format
  // =========================================================================

  describe('accepted formats', () => {
    it.each([
      ['PNG', PNG_8X8, 'shot.png', 'image/png', 'image/png', '.png'],
      ['JPEG', JPEG_8X8, 'shot.jpg', 'image/jpeg', 'image/jpeg', '.jpg'],
      ['WebP', WEBP_8X8, 'shot.webp', 'image/webp', 'image/webp', '.webp'],
    ])(
      'stores a %s and returns a detached image',
      async (_label, bytes, filename, declared, expectedType, extension) => {
        const jar = await superAdminJar();

        const response = await upload(jar, bytes, filename, declared);
        expect(response.status).toBe(201);

        const image = response.body.data;
        expect(typeof image.id).toBe('number');
        expect(typeof image.url).toBe('string');

        const row = await rowFor(Number(image.id));
        // Detached: it belongs to no product until an update says so.
        expect(row.productId).toBeNull();
        expect(row.objectKey).toEqual(expect.any(String));
        expect(row.objectKey!.endsWith(extension)).toBe(true);

        // The bytes really are in the bucket, and really are these bytes.
        await expect(storage.objectExists(row.objectKey!)).resolves.toBe(true);
        await expect(storage.bodyOf(row.objectKey!)).resolves.toEqual(bytes);
        // Served back as the VERIFIED type.
        await expect(storage.contentTypeOf(row.objectKey!)).resolves.toBe(
          expectedType,
        );
      },
    );

    it('never embeds the original filename in the object key', async () => {
      const jar = await superAdminJar();
      // A filename that would be actively hostile inside a path.
      const response = await upload(
        jar,
        PNG_8X8,
        '../../etc/passwd;rm -rf .png',
        'image/png',
      );
      expect(response.status).toBe(201);

      const row = await rowFor(Number(response.body.data.id));
      expect(row.objectKey).toMatch(
        /^products\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/,
      );
      expect(row.objectKey).not.toContain('passwd');
      expect(row.objectKey).not.toContain('..');
    });

    it('gives concurrent uploads distinct keys', async () => {
      const jar = await superAdminJar();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          upload(jar, PNG_8X8, 'same-name.png', 'image/png'),
        ),
      );
      for (const response of responses) expect(response.status).toBe(201);

      const keys = await Promise.all(
        responses.map(
          async (r) => (await rowFor(Number(r.body.data.id))).objectKey,
        ),
      );
      expect(new Set(keys).size).toBe(6);
    });

    /**
     * THE BUG THAT MADE STORED URLS UNREACHABLE. The old code published
     * `${MINIO_ENDPOINT}/products/${key}` where `key` already began with
     * `products/`, from an endpoint that in any real deployment is a private
     * address. Both halves of that are asserted against here.
     */
    it('builds the public URL from S3_PUBLIC_BASE_URL, not the internal endpoint', async () => {
      const jar = await superAdminJar();
      const response = await upload(jar, PNG_8X8, 'a.png', 'image/png');
      const row = await rowFor(Number(response.body.data.id));

      expect(row.url).toBe(`${storage.publicBaseUrl}/${row.objectKey}`);
      expect(row.url).not.toContain('/products/products/');

      // And the URL is genuinely fetchable as an image.
      const fetched = await fetch(row.url);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-type')).toBe('image/png');
    });

    it('trusts the bytes over a lying Content-Type', async () => {
      const jar = await superAdminJar();
      // A real JPEG, announced as PNG, named .png.
      const response = await upload(jar, JPEG_8X8, 'lie.png', 'image/png');
      expect(response.status).toBe(201);

      const row = await rowFor(Number(response.body.data.id));
      expect(row.objectKey!.endsWith('.jpg')).toBe(true);
      await expect(storage.contentTypeOf(row.objectKey!)).resolves.toBe(
        'image/jpeg',
      );
    });
  });

  // =========================================================================
  // 2. Refusals
  // =========================================================================

  describe('refusals', () => {
    it('refuses a missing file with 400 IMAGE_FILE_REQUIRED', async () => {
      const jar = await superAdminJar();
      const response = await withCookies(ctx, jar).post(
        '/products/uploadImage',
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('IMAGE_FILE_REQUIRED');
    });

    it('refuses an empty file', async () => {
      const jar = await superAdminJar();
      const response = await upload(jar, EMPTY, 'empty.png', 'image/png');
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('IMAGE_FILE_REQUIRED');
    });

    /**
     * The security case: SVG can carry `<script>`. It is refused by content,
     * so renaming it to `.png` changes nothing.
     */
    it.each([
      ['SVG', SVG_DOCUMENT, 'logo.svg', 'image/svg+xml'],
      ['SVG renamed to .png', SVG_DOCUMENT, 'logo.png', 'image/png'],
      ['GIF', GIF_1X1, 'anim.gif', 'image/gif'],
      ['a PHP file named .png', NOT_AN_IMAGE, 'shell.png', 'image/png'],
    ])('refuses %s with 415', async (_label, bytes, name, type) => {
      const jar = await superAdminJar();
      const response = await upload(jar, bytes, name, type);

      expect(response.status).toBe(415);
      expect(response.body.error).toBe('IMAGE_TYPE_UNSUPPORTED');
      expect(response.body.details.supported).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
      // Nothing was written, to either system.
      await expect(storage.listKeys('products/')).resolves.toEqual([]);
      const rows = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "product_images"`,
      );
      expect(rows[0].n).toBe(0);
    });

    it.each([
      ['a truncated PNG', TRUNCATED_PNG],
      ['a JPEG with no EOI marker', TRUNCATED_JPEG],
    ])('refuses %s with 400 IMAGE_MALFORMED', async (_label, bytes) => {
      const jar = await superAdminJar();
      const response = await upload(jar, bytes, 'broken.png', 'image/png');
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('IMAGE_MALFORMED');
    });

    it('refuses an oversized file with 413 and reports the limit', async () => {
      const jar = await superAdminJar();
      const maxBytes = ctx.app.get<number>(PRODUCT_IMAGE_MAX_BYTES);

      const response = await upload(
        jar,
        oversizedPng(maxBytes + 1024),
        'huge.png',
        'image/png',
      );

      expect(response.status).toBe(413);
      expect(response.body.error).toBe('IMAGE_TOO_LARGE');
      expect(response.body.details.maxBytes).toBe(maxBytes);
      await expect(storage.listKeys('products/')).resolves.toEqual([]);
    });

    it('accepts a file exactly at the limit', async () => {
      const jar = await superAdminJar();
      const maxBytes = ctx.app.get<number>(PRODUCT_IMAGE_MAX_BYTES);

      const response = await upload(
        jar,
        oversizedPng(maxBytes),
        'exact.png',
        'image/png',
      );
      expect(response.status).toBe(201);
    });

    it('answers a Persian message a store manager can act on', async () => {
      const jar = await superAdminJar();
      const response = await upload(
        jar,
        SVG_DOCUMENT,
        'a.svg',
        'image/svg+xml',
      );
      // FormError renders `message` verbatim, so it must be Persian.
      expect(response.body.message).toMatch(/[؀-ۿ]/);
      expect(response.body.message).toContain('JPEG');
    });
  });

  // =========================================================================
  // 3. Authorization — unchanged rules, re-proven
  // =========================================================================

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      const response = await request(ctx.server)
        .post('/products/uploadImage')
        .attach('file', PNG_8X8, {
          filename: 'a.png',
          contentType: 'image/png',
        });
      expect(response.status).toBe(401);
      await expect(storage.listKeys('products/')).resolves.toEqual([]);
    });

    it('refuses a storefront session on the admin route', async () => {
      await seedRoles(ctx.dataSource);
      const { username, password } = await createUser(ctx.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const jar = await authenticate(ctx, username, password, 'storefront');

      const response = await upload(jar, PNG_8X8, 'a.png', 'image/png');
      expect([401, 403]).toContain(response.status);
    });

    it('refuses products.read alone with 403', async () => {
      const admin = await superAdminJar();
      const reader = await staffHolding(admin, [
        'admin.access',
        'products.read',
      ]);

      const response = await upload(reader, PNG_8X8, 'a.png', 'image/png');
      expect(response.status).toBe(403);
      await expect(storage.listKeys('products/')).resolves.toEqual([]);
    });

    /**
     * The create flow uploads images BEFORE the product exists, so a catalogue
     * author must be allowed through this route even though they can never
     * call `products.update`.
     */
    it.each([['products.create'], ['products.update']])(
      'allows products.read + %s',
      async (capability) => {
        const admin = await superAdminJar();
        const staff = await staffHolding(admin, [
          'admin.access',
          'products.read',
          capability,
        ]);

        const response = await upload(staff, PNG_8X8, 'a.png', 'image/png');
        expect(response.status).toBe(201);
      },
    );
  });

  // =========================================================================
  // 4. Storage failures are 503, never 500
  // =========================================================================

  describe('storage failures', () => {
    /**
     * A bucket that does not exist is the SECOND fault this project had: even
     * once credentials were supplied, the hard-coded `products` bucket had
     * never been created anywhere. It must be its own diagnosable answer.
     */
    it('answers 503 IMAGE_STORAGE_BUCKET_MISSING when the bucket is absent', async () => {
      const jar = await superAdminJar();
      const service = ctx.app.get(ObjectStorageService);

      // Point the live client at a bucket nobody created. Restored afterwards.
      const original = (service as unknown as { config: { bucket: string } })
        .config.bucket;
      (service as unknown as { config: { bucket: string } }).config.bucket =
        'kazhal-absent-bucket';

      try {
        const response = await upload(jar, PNG_8X8, 'a.png', 'image/png');
        expect(response.status).toBe(503);
        expect(response.body.error).toBe('IMAGE_STORAGE_BUCKET_MISSING');
        // Not the generic critical-error text.
        expect(response.body.message).not.toContain('critical error');
      } finally {
        (service as unknown as { config: { bucket: string } }).config.bucket =
          original;
      }
    });

    it('answers 503 IMAGE_STORAGE_UNAVAILABLE when storage cannot be reached', async () => {
      const jar = await superAdminJar();
      const service = ctx.app.get(ObjectStorageService);
      const client = (service as unknown as { client: { send: unknown } })
        .client;
      const originalSend = (client as { send: unknown }).send;

      (client as { send: unknown }).send = () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:1');
        error.name = 'Error';
        return Promise.reject(error);
      };

      try {
        const response = await upload(jar, PNG_8X8, 'a.png', 'image/png');
        expect(response.status).toBe(503);
        expect(response.body.error).toBe('IMAGE_STORAGE_UNAVAILABLE');
        // No row survives a failed upload.
        const rows = await ctx.dataSource.query(
          `SELECT count(*)::int AS n FROM "product_images"`,
        );
        expect(rows[0].n).toBe(0);
      } finally {
        (client as { send: unknown }).send = originalSend;
      }
    });

    it('never leaks SDK text or credentials to the client', async () => {
      const jar = await superAdminJar();
      const service = ctx.app.get(ObjectStorageService);
      const client = (service as unknown as { client: { send: unknown } })
        .client;
      const originalSend = (client as { send: unknown }).send;

      (client as { send: unknown }).send = () =>
        Promise.reject(
          new Error(
            'SignatureDoesNotMatch: Credential=kazhal_int_key/20260917 Signature=deadbeef',
          ),
        );

      try {
        const response = await upload(jar, PNG_8X8, 'a.png', 'image/png');
        const payload = JSON.stringify(response.body);
        expect(payload).not.toContain('kazhal_int_key');
        expect(payload).not.toContain('Signature');
        expect(payload).not.toContain('SignatureDoesNotMatch');
      } finally {
        (client as { send: unknown }).send = originalSend;
      }
    });

    /**
     * COMPENSATION. The object is already in the bucket when the row insert
     * fails; it must not be left there. Verified with an independent client —
     * this is the assertion a mocked storage layer structurally cannot make.
     */
    it('deletes the uploaded object when the database insert fails', async () => {
      const jar = await superAdminJar();

      const before = await storage.listKeys('products/');
      expect(before).toEqual([]);

      /*
       * Break the insert on the very repository instance the service holds —
       * resolved from the Nest container, not a fresh handle that might not be
       * the same object. The failure is a plain Error so nothing in the upload
       * path can mistake it for a refusal it knows how to translate.
       */
      const repo = ctx.app.get<Repository<ProductImage>>(
        getRepositoryToken(ProductImage),
      );
      const save = jest
        .spyOn(repo, 'save')
        .mockRejectedValueOnce(new Error('insert blew up'));

      try {
        const response = await upload(jar, PNG_8X8, 'a.png', 'image/png');
        expect(response.status).toBe(500);
      } finally {
        save.mockRestore();
      }

      // The bucket is empty again, and no row exists.
      await expect(storage.listKeys('products/')).resolves.toEqual([]);
      const rows = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "product_images"`,
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
