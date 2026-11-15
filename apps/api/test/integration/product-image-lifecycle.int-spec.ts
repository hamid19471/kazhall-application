import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ProductImageCleanupService } from 'src/modules/products/services/product-image-cleanup.service';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { resetDb } from './setup/test-db';
import { requireStorage, TestStorage } from './setup/test-storage';
import { createCategory, createUser, seedRoles } from './setup/seed-helpers';
import { PNG_8X8 } from '../support/image-fixtures';

/**
 * ============================================================================
 * THE IMAGE LIFECYCLE — detached, attached, replaced, swept.
 *
 * Uploading is deliberately two-phase: an image is stored DETACHED and joins a
 * product only when its id appears in a create/update. That is what lets the
 * new-product form upload pictures before the product exists, and it is also
 * what creates two problems this file pins down:
 *
 *   AN ABANDONED UPLOAD leaks a row and an object forever. Nothing could sweep
 *   them before migration 0034, because a row recorded neither the object it
 *   owned nor when it was written.
 *
 *   A REPLACED IMAGE leaked its object. `applyImageContract` deleted the row
 *   and left the bytes — its own comment said so: "(The MinIO object is
 *   intentionally left.)"
 *
 * The sweeper is OFF by default because its TTL is a business decision nobody
 * has made. It is nonetheless fully exercised here, with an explicit TTL, so
 * that the decision is the ONLY thing outstanding — not the implementation.
 * ============================================================================
 */
describe('product image lifecycle (int)', () => {
  let ctx: TestApp;
  let storage: TestStorage;

  beforeAll(async () => {
    storage = requireStorage();
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
    storage.destroy();
  });

  beforeEach(async () => {
    await resetDb(ctx.dataSource);
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

  async function uploadImage(
    jar: CookieJar,
  ): Promise<{ id: number; url: string; objectKey: string }> {
    const response = await withCookies(ctx, jar)
      .post('/products/uploadImage')
      .attach('file', PNG_8X8, {
        filename: 'p.png',
        contentType: 'image/png',
      });
    expect(response.status).toBe(201);

    const id = Number(response.body.data.id);
    const [row] = await ctx.dataSource.query(
      `SELECT "objectKey", "url" FROM "product_images" WHERE "id" = $1`,
      [id],
    );
    return { id, url: row.url, objectKey: row.objectKey };
  }

  async function createProduct(
    jar: CookieJar,
    code: string,
    imageIds: number[],
  ): Promise<number> {
    const category = await createCategory(ctx.dataSource);
    const response = await withCookies(ctx, jar)
      .post('/products')
      .send({
        title: `کالای ${code}`,
        description: 'برای آزمون چرخهٔ عمر تصویر',
        basePrice: 1_000_000,
        categoryIds: [category.id],
        productCode: code,
        ...(imageIds.length ? { images: imageIds } : {}),
      });
    expect([200, 201]).toContain(response.status);
    return Number(response.body.data.id);
  }

  /**
   * The DECLARED return type is what types this, not a trailing `as`.
   * `dataSource.query` returns `any`, and an assertion on the call expression
   * is exactly the kind `@typescript-eslint/no-unnecessary-type-assertion`
   * strips on `--fix` — leaving every caller silently untyped. A declared
   * return type cannot be removed that way.
   */
  async function imageRows(
    productId: number,
  ): Promise<
    Array<{ id: number; objectKey: string | null; sortOrder: number }>
  > {
    return await ctx.dataSource.query(
      `SELECT "id", "objectKey", "sortOrder"
         FROM "product_images" WHERE "productId" = $1 ORDER BY "sortOrder"`,
      [productId],
    );
  }

  // =========================================================================
  // 1. Attaching
  // =========================================================================

  describe('attaching a detached image', () => {
    it('attaches uploads to a new product and preserves their order', async () => {
      const jar = await superAdminJar();
      const first = await uploadImage(jar);
      const second = await uploadImage(jar);
      const third = await uploadImage(jar);

      const productId = await createProduct(jar, 'KZ-P-IMGLIFE1', [
        third.id,
        first.id,
        second.id,
      ]);

      // The submitted order IS the stored order; index becomes sortOrder.
      const rows = await imageRows(productId);
      expect(rows.map((r) => r.id)).toEqual([third.id, first.id, second.id]);
      expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2]);

      // And every object is still in the bucket. Each row was written by an
      // upload in this test, so a NULL key would itself be a defect.
      for (const row of rows) {
        expect(row.objectKey).toEqual(expect.any(String));
        await expect(storage.objectExists(row.objectKey!)).resolves.toBe(true);
      }
    });

    it('reorders on update without touching the objects', async () => {
      const jar = await superAdminJar();
      const a = await uploadImage(jar);
      const b = await uploadImage(jar);
      const productId = await createProduct(jar, 'KZ-P-IMGLIFE2', [a.id, b.id]);

      const response = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [b.id, a.id] });
      expect(response.status).toBe(200);

      expect((await imageRows(productId)).map((r) => r.id)).toEqual([
        b.id,
        a.id,
      ]);
      await expect(storage.objectExists(a.objectKey)).resolves.toBe(true);
      await expect(storage.objectExists(b.objectKey)).resolves.toBe(true);
    });
  });

  // =========================================================================
  // 2. Ownership — unchanged rules, re-proven now that objects are real
  // =========================================================================

  describe('an image cannot be stolen or invented', () => {
    it('refuses an image already owned by another product', async () => {
      const jar = await superAdminJar();
      const image = await uploadImage(jar);
      await createProduct(jar, 'KZ-P-IMGOWN1', [image.id]);

      const category = await createCategory(ctx.dataSource);
      const second = await withCookies(ctx, jar)
        .post('/products')
        .send({
          title: 'دزد تصویر',
          description: 'نباید موفق شود',
          basePrice: 500_000,
          categoryIds: [category.id],
          productCode: 'KZ-P-IMGOWN2',
          images: [image.id],
        });

      expect(second.status).toBe(400);
      // The first product keeps it, and the object is untouched.
      await expect(storage.objectExists(image.objectKey)).resolves.toBe(true);
    });

    it('refuses an unknown image id', async () => {
      const jar = await superAdminJar();
      const category = await createCategory(ctx.dataSource);
      const response = await withCookies(ctx, jar)
        .post('/products')
        .send({
          title: 'تصویر ناموجود',
          description: 'نباید موفق شود',
          basePrice: 500_000,
          categoryIds: [category.id],
          productCode: 'KZ-P-IMGGHOST',
          images: [987_654],
        });
      expect(response.status).toBe(404);
    });

    it('refuses duplicate image ids', async () => {
      const jar = await superAdminJar();
      const image = await uploadImage(jar);
      const category = await createCategory(ctx.dataSource);

      const response = await withCookies(ctx, jar)
        .post('/products')
        .send({
          title: 'تصویر تکراری',
          description: 'نباید موفق شود',
          basePrice: 500_000,
          categoryIds: [category.id],
          productCode: 'KZ-P-IMGDUP',
          images: [image.id, image.id],
        });
      expect(response.status).toBe(400);
    });
  });

  // =========================================================================
  // 3. Detaching now removes the bytes
  // =========================================================================

  describe('replacing a product image', () => {
    /**
     * THE LEAK THIS CLOSES. Dropping an image from the `images` array deletes
     * its row; before migration 0034 the object stayed in the bucket forever
     * because nothing recorded which object the row owned.
     */
    it('deletes the object of an image the update drops', async () => {
      const jar = await superAdminJar();
      const kept = await uploadImage(jar);
      const dropped = await uploadImage(jar);
      const productId = await createProduct(jar, 'KZ-P-IMGDROP', [
        kept.id,
        dropped.id,
      ]);

      await expect(storage.objectExists(dropped.objectKey)).resolves.toBe(true);

      const response = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [kept.id] });
      expect(response.status).toBe(200);

      // Row gone, object gone, and the survivor untouched.
      expect((await imageRows(productId)).map((r) => r.id)).toEqual([kept.id]);
      await expect(storage.objectExists(dropped.objectKey)).resolves.toBe(
        false,
      );
      await expect(storage.objectExists(kept.objectKey)).resolves.toBe(true);
    });

    it('clears every image when sent an empty array', async () => {
      const jar = await superAdminJar();
      const a = await uploadImage(jar);
      const b = await uploadImage(jar);
      const productId = await createProduct(jar, 'KZ-P-IMGCLEAR', [a.id, b.id]);

      const response = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });
      expect(response.status).toBe(200);

      expect(await imageRows(productId)).toEqual([]);
      await expect(storage.objectExists(a.objectKey)).resolves.toBe(false);
      await expect(storage.objectExists(b.objectKey)).resolves.toBe(false);
    });
  });

  // =========================================================================
  // 4. The orphan sweeper
  // =========================================================================

  describe('orphaned upload cleanup', () => {
    const cleanup = () => ctx.app.get(ProductImageCleanupService);

    /** Backdate a detached row so a TTL can see it as abandoned. */
    async function backdate(imageId: number, ms: number): Promise<void> {
      await ctx.dataSource.query(
        `UPDATE "product_images"
            SET "createdAt" = now() - ($2 || ' milliseconds')::interval
          WHERE "id" = $1`,
        [imageId, String(ms)],
      );
    }

    it('is disabled unless an explicit TTL is configured', () => {
      // The safety default. Enabling it without PRODUCT_IMAGE_ORPHAN_TTL_MS is
      // refused at boot rather than defaulted, because how long a detached
      // image may live is a business decision and deleting somebody's photo
      // early is not recoverable.
      expect(cleanup().enabled).toBe(false);
      expect(cleanup().ttlMs).toBeNull();
    });

    it('refuses to sweep with no TTL at all', async () => {
      await expect(cleanup().sweep()).rejects.toThrow(/TTL/i);
    });

    it('deletes an abandoned detached image, row and object', async () => {
      const jar = await superAdminJar();
      const abandoned = await uploadImage(jar);
      await backdate(abandoned.id, 60 * 60 * 1000);

      const outcome = await cleanup().sweep(30 * 60 * 1000);

      expect(outcome.deletedRows).toBe(1);
      expect(outcome.deletedObjects).toBe(1);
      await expect(storage.objectExists(abandoned.objectKey)).resolves.toBe(
        false,
      );
      const rows = await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM "product_images" WHERE "id" = $1`,
        [abandoned.id],
      );
      expect(rows[0].n).toBe(0);
    });

    it('leaves a detached image that is younger than the TTL', async () => {
      const jar = await superAdminJar();
      const fresh = await uploadImage(jar);

      const outcome = await cleanup().sweep(60 * 60 * 1000);

      expect(outcome.scanned).toBe(0);
      expect(outcome.deletedRows).toBe(0);
      await expect(storage.objectExists(fresh.objectKey)).resolves.toBe(true);
    });

    /**
     * THE ONE THING THIS SERVICE MUST NEVER DO. An attached image is a picture
     * a customer is looking at; deleting it is not recoverable by rerunning
     * anything.
     */
    it('NEVER deletes an image attached to a product, however old', async () => {
      const jar = await superAdminJar();
      const attached = await uploadImage(jar);
      const productId = await createProduct(jar, 'KZ-P-IMGKEEP', [attached.id]);

      // Older than any plausible TTL.
      await ctx.dataSource.query(
        `UPDATE "product_images" SET "createdAt" = now() - interval '400 days'`,
      );

      const outcome = await cleanup().sweep(1);

      expect(outcome.deletedRows).toBe(0);
      expect((await imageRows(productId)).map((r) => r.id)).toEqual([
        attached.id,
      ]);
      await expect(storage.objectExists(attached.objectKey)).resolves.toBe(
        true,
      );
    });

    it('is idempotent — a second pass deletes nothing and does not throw', async () => {
      const jar = await superAdminJar();
      const abandoned = await uploadImage(jar);
      await backdate(abandoned.id, 60 * 60 * 1000);

      const first = await cleanup().sweep(1000);
      const second = await cleanup().sweep(1000);
      const third = await cleanup().sweep(1000);

      expect(first.deletedRows).toBe(1);
      expect(second.deletedRows).toBe(0);
      expect(third.deletedRows).toBe(0);
      expect(second.scanned).toBe(0);
    });

    it('sweeps several abandoned images in one pass', async () => {
      const jar = await superAdminJar();
      const images = [
        await uploadImage(jar),
        await uploadImage(jar),
        await uploadImage(jar),
      ];
      for (const image of images) await backdate(image.id, 60 * 60 * 1000);

      const outcome = await cleanup().sweep(1000);

      expect(outcome.deletedRows).toBe(3);
      expect(outcome.deletedObjects).toBe(3);
      await expect(storage.listKeys('products/')).resolves.toEqual([]);
    });

    /**
     * A row written before migration 0034 does not know its object. Guessing a
     * key from the URL would risk deleting somebody else's bytes, so the row
     * goes and the object is left strictly alone.
     */
    it('deletes a legacy row with no objectKey without touching any object', async () => {
      const jar = await superAdminJar();
      const legacy = await uploadImage(jar);
      await ctx.dataSource.query(
        `UPDATE "product_images" SET "objectKey" = NULL WHERE "id" = $1`,
        [legacy.id],
      );
      await backdate(legacy.id, 60 * 60 * 1000);

      const outcome = await cleanup().sweep(1000);

      expect(outcome.deletedRows).toBe(1);
      expect(outcome.deletedObjects).toBe(0);
      // The bytes survive, unreferenced — deliberately, see the migration.
      await expect(storage.objectExists(legacy.objectKey)).resolves.toBe(true);
    });

    /**
     * The race the conditional DELETE exists for: an image attached between
     * the scan and the delete must survive. Simulated by attaching it after
     * the row qualifies but before the sweep runs.
     */
    it('spares an image attached after it became eligible', async () => {
      const jar = await superAdminJar();
      const image = await uploadImage(jar);
      await backdate(image.id, 60 * 60 * 1000);

      // It now qualifies... and is attached before the sweep looks.
      const productId = await createProduct(jar, 'KZ-P-IMGRACE', [image.id]);

      const outcome = await cleanup().sweep(1000);

      expect(outcome.deletedRows).toBe(0);
      expect((await imageRows(productId)).map((r) => r.id)).toEqual([image.id]);
      await expect(storage.objectExists(image.objectKey)).resolves.toBe(true);
    });
  });
});
