import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ObjectDeletionService } from 'src/common/storage/object-deletion.service';
import { ObjectStorageService } from 'src/common/storage/object-storage.service';
import { ObjectDeletionOrigin } from 'src/common/entities/object-deletion-job.entity';
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
 * DURABLE OBJECT DELETION.
 *
 * THE DEFECT THIS FILE PINS DOWN. Both deletion paths destroyed the only
 * durable reference to an object BEFORE the object was gone:
 *
 *     DELETE FROM product_images ... RETURNING "objectKey"   -- row now gone
 *     await storage.deleteObject(key)                        -- may fail
 *     if (!removed) log('... it can be swept later ...')      -- FALSE
 *
 * Once the row was gone the key lived only in a local variable. A failed
 * `DeleteObject` left the bytes in the bucket with nothing anywhere naming
 * them: no row to find them from, nothing to distinguish them from a live
 * object in a listing, and no later pass that could pick them up. Cleanup was
 * therefore NOT idempotent in the way that matters — re-running it did not
 * finish work a previous run had left undone, because the work had been
 * forgotten rather than left pending.
 *
 * Every test below asserts against the REAL bucket and the REAL job table. The
 * failure injection replaces `deleteObject` on the live service, so the code
 * under test is the shipping code, not a variant of it.
 * ============================================================================
 */
describe('durable object deletion (int)', () => {
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

  const deletion = () => ctx.app.get(ObjectDeletionService);
  const cleanup = () => ctx.app.get(ProductImageCleanupService);

  async function superAdminJar(): Promise<CookieJar> {
    await seedRoles(ctx.dataSource);
    const { username, password } = await createUser(ctx.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    return authenticate(ctx, username, password, 'admin');
  }

  async function uploadImage(
    jar: CookieJar,
  ): Promise<{ id: number; objectKey: string }> {
    const response = await withCookies(ctx, jar)
      .post('/products/uploadImage')
      .attach('file', PNG_8X8, { filename: 'p.png', contentType: 'image/png' });
    expect(response.status).toBe(201);
    const id = Number(response.body.data.id);
    const rows = await ctx.dataSource.query(
      `SELECT "objectKey" FROM "product_images" WHERE "id" = $1`,
      [id],
    );
    return { id, objectKey: rows[0].objectKey };
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
        description: 'برای آزمون حذف پایدار',
        basePrice: 1_000_000,
        categoryIds: [category.id],
        productCode: code,
        ...(imageIds.length ? { images: imageIds } : {}),
      });
    expect([200, 201]).toContain(response.status);
    return Number(response.body.data.id);
  }

  async function jobs(): Promise<
    Array<{
      id: number;
      objectKey: string;
      status: string;
      attempts: number;
      lastError: string | null;
      origin: string;
    }>
  > {
    return await ctx.dataSource.query(
      `SELECT "id", "objectKey", "status", "attempts", "lastError", "origin"
         FROM "object_deletion_jobs" ORDER BY "id"`,
    );
  }

  /** Make every delete fail, for `times` calls (or forever when omitted). */
  function breakDeletes(times = Number.POSITIVE_INFINITY): () => void {
    const service = ctx.app.get(ObjectStorageService);
    const original = service.deleteObject.bind(service);
    let remaining = times;
    (service as unknown as { deleteObject: unknown }).deleteObject = (
      key: string,
    ): Promise<boolean> => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error('injected: storage unreachable'));
      }
      return original(key);
    };
    return () => {
      (service as unknown as { deleteObject: unknown }).deleteObject = original;
    };
  }

  /** Make every pending job due now, so a pass picks it up without waiting. */
  async function makeAllDue(): Promise<void> {
    await ctx.dataSource.query(
      `UPDATE "object_deletion_jobs" SET "nextAttemptAt" = now() - interval '1 second'
        WHERE "status" = 'pending'`,
    );
  }

  // =========================================================================
  // 1. The happy path
  // =========================================================================

  it('deletes immediately and leaves no job behind', async () => {
    const jar = await superAdminJar();
    const kept = await uploadImage(jar);
    const dropped = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0001', [
      kept.id,
      dropped.id,
    ]);

    const response = await withCookies(ctx, jar)
      .patch(`/products/${productId}`)
      .send({ images: [kept.id] });
    expect(response.status).toBe(200);

    await expect(storage.objectExists(dropped.objectKey)).resolves.toBe(false);
    await expect(storage.objectExists(kept.objectKey)).resolves.toBe(true);
    // The job was created and finalised in the same request.
    expect(await jobs()).toEqual([]);
  });

  // =========================================================================
  // 2. Failure keeps the key
  // =========================================================================

  /**
   * THE CENTRAL TEST. Before this change the key was gone the moment the row
   * was, and nothing could name the object again.
   */
  it('keeps a durable job when the delete fails, and the edit still commits', async () => {
    const jar = await superAdminJar();
    const kept = await uploadImage(jar);
    const dropped = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0002', [
      kept.id,
      dropped.id,
    ]);

    const restore = breakDeletes();
    try {
      const response = await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [kept.id] });
      // A product edit is NEVER blocked by object storage.
      expect(response.status).toBe(200);
    } finally {
      restore();
    }

    // The row is gone...
    const rows = await ctx.dataSource.query(
      `SELECT count(*)::int AS n FROM "product_images" WHERE "id" = $1`,
      [dropped.id],
    );
    expect(rows[0].n).toBe(0);
    // ...the bytes are still there...
    await expect(storage.objectExists(dropped.objectKey)).resolves.toBe(true);
    // ...and the key is recorded, which is the whole point.
    const pending = await jobs();
    expect(pending).toHaveLength(1);
    expect(pending[0].objectKey).toBe(dropped.objectKey);
    expect(pending[0].status).toBe('pending');
    expect(pending[0].origin).toBe(ObjectDeletionOrigin.DETACHED);
  });

  it('fails once and succeeds on the next pass', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0003', [image.id]);

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });
    } finally {
      restore();
    }
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(true);

    await makeAllDue();
    const outcome = await deletion().runPass();

    expect(outcome.deleted).toBe(1);
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(false);
    expect(await jobs()).toEqual([]);
  });

  it('retries repeatedly WITHOUT ever losing the objectKey', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0004', [image.id]);

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });

      for (let pass = 1; pass <= 3; pass++) {
        await makeAllDue();
        const outcome = await deletion().runPass();
        expect(outcome.retried).toBe(1);
        expect(outcome.deleted).toBe(0);

        const [job] = await jobs();
        // The key survives every failed attempt — this is the invariant.
        expect(job.objectKey).toBe(image.objectKey);
        expect(job.status).toBe('pending');
        expect(job.attempts).toBe(pass);
        expect(job.lastError).toContain('injected');
      }
    } finally {
      restore();
    }

    // And once storage recovers, the very same job finishes the work.
    await makeAllDue();
    await deletion().runPass();
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(false);
  });

  it('survives a restart: pending work is in the database, not in memory', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0005', [image.id]);

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });
    } finally {
      restore();
    }

    /*
     * A restart is simulated by reading the job back through a completely
     * independent query — nothing in application memory is consulted. The row
     * is the state, which is exactly what "durable" has to mean.
     */
    const [persisted] = await jobs();
    expect(persisted.objectKey).toBe(image.objectKey);

    await makeAllDue();
    await deletion().runPass();
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(false);
  });

  // =========================================================================
  // 3. Abandonment is reported, not silent
  // =========================================================================

  it('abandons after the attempt ceiling and keeps the row for an operator', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0006', [image.id]);

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });

      for (let pass = 0; pass < 12; pass++) {
        await makeAllDue();
        await deletion().runPass();
      }
    } finally {
      restore();
    }

    const [job] = await jobs();
    expect(job.status).toBe('abandoned');
    // KEPT, deliberately: it is the only record that these bytes are
    // unreferenced and still present.
    expect(job.objectKey).toBe(image.objectKey);
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(true);

    const backlog = await deletion().backlog();
    expect(backlog.abandoned).toBe(1);
    const reported = await deletion().abandonedJobs();
    expect(reported).toHaveLength(1);
    expect(reported[0].objectKey).toBe(image.objectKey);
    expect(reported[0].lastError).toContain('injected');
  });

  it('reports pending and abandoned counts for administrators', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0007', [image.id]);

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });
    } finally {
      restore();
    }

    const backlog = await deletion().backlog();
    expect(backlog.pending).toBe(1);
    expect(backlog.abandoned).toBe(0);
  });

  // =========================================================================
  // 4. Safety
  // =========================================================================

  /**
   * A job can outlive the reasoning that created it. Deleting an object a live
   * product displays is not recoverable by rerunning anything, so the worker
   * re-checks before every delete.
   */
  it('NEVER deletes an object that a product image references again', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);

    // Enqueue a job for a key that IS referenced by a live image.
    await ctx.dataSource.transaction((manager) =>
      deletion().enqueue(
        manager,
        image.objectKey,
        ObjectDeletionOrigin.ORPHAN_SWEEP,
      ),
    );
    await createProduct(jar, 'KZ-P-DUR0008', [image.id]);

    await makeAllDue();
    const outcome = await deletion().runPass();

    expect(outcome.skippedReferenced).toBe(1);
    expect(outcome.deleted).toBe(0);
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(true);
    // The job is dropped — it was wrong, not pending.
    expect(await jobs()).toEqual([]);
  });

  it('is idempotent: repeated passes over the same work change nothing', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0009', [image.id]);

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });
    } finally {
      restore();
    }

    await makeAllDue();
    const first = await deletion().runPass();
    const second = await deletion().runPass();
    const third = await deletion().runPass();

    expect(first.deleted).toBe(1);
    expect(second.claimed).toBe(0);
    expect(third.claimed).toBe(0);
    expect(await jobs()).toEqual([]);
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(false);
  });

  /**
   * `FOR UPDATE SKIP LOCKED` is what makes this safe. Two passes started
   * together must take DISJOINT rows: the total deleted across both is the
   * number of jobs, never more, and neither blocks on the other.
   */
  it('two concurrent workers never double-claim or double-finalise a job', async () => {
    const jar = await superAdminJar();

    const images = [
      await uploadImage(jar),
      await uploadImage(jar),
      await uploadImage(jar),
      await uploadImage(jar),
    ];
    const productId = await createProduct(
      jar,
      'KZ-P-DUR0010',
      images.map((i) => i.id),
    );

    const restore = breakDeletes();
    try {
      await withCookies(ctx, jar)
        .patch(`/products/${productId}`)
        .send({ images: [] });
    } finally {
      restore();
    }
    expect(await jobs()).toHaveLength(4);

    await makeAllDue();
    const [a, b] = await Promise.all([
      deletion().runPass(),
      deletion().runPass(),
    ]);

    // Disjoint: between them they claimed each job exactly once.
    expect(a.claimed + b.claimed).toBe(4);
    expect(a.deleted + b.deleted).toBe(4);
    expect(await jobs()).toEqual([]);
    for (const image of images) {
      await expect(storage.objectExists(image.objectKey)).resolves.toBe(false);
    }
  });

  it('enqueueing the same key twice keeps exactly one job', async () => {
    const key = 'products/2026/09/duplicate-key-test.png';
    for (let i = 0; i < 3; i++) {
      await ctx.dataSource.transaction((manager) =>
        deletion().enqueue(manager, key, ObjectDeletionOrigin.DETACHED),
      );
    }
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].objectKey).toBe(key);
  });

  // =========================================================================
  // 5. The other two enqueue paths
  // =========================================================================

  it('the orphan sweeper hands the key over atomically', async () => {
    const jar = await superAdminJar();
    const orphan = await uploadImage(jar);
    await ctx.dataSource.query(
      `UPDATE "product_images" SET "createdAt" = now() - interval '2 hours'`,
    );

    const restore = breakDeletes();
    let outcome;
    try {
      outcome = await cleanup().sweep(1000);
    } finally {
      restore();
    }

    // The row is gone and the object is not — but the key is recorded.
    expect(outcome.deletedRows).toBe(1);
    expect(outcome.deletedObjects).toBe(0);
    await expect(storage.objectExists(orphan.objectKey)).resolves.toBe(true);

    const [job] = await jobs();
    expect(job.objectKey).toBe(orphan.objectKey);
    expect(job.origin).toBe(ObjectDeletionOrigin.ORPHAN_SWEEP);

    // And the worker finishes it.
    await makeAllDue();
    await deletion().runPass();
    await expect(storage.objectExists(orphan.objectKey)).resolves.toBe(false);
  });

  it('a rollback deletes nothing, and records nothing to delete', async () => {
    const jar = await superAdminJar();
    const image = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0011', [image.id]);

    /*
     * An update that detaches the image AND then fails. The detach and the
     * deletion job are in the same transaction as the failure, so both must
     * vanish — the object must survive because the image row survives.
     */
    const response = await withCookies(ctx, jar)
      .patch(`/products/${productId}`)
      .send({ images: [], categoryIds: [999_999] });
    expect(response.status).toBe(404);

    // Image still attached, object still present, no deletion job.
    const rows = await ctx.dataSource.query(
      `SELECT "productId" FROM "product_images" WHERE "id" = $1`,
      [image.id],
    );
    expect(rows[0].productId).toBe(productId);
    await expect(storage.objectExists(image.objectKey)).resolves.toBe(true);
    expect(await jobs()).toEqual([]);
  });

  it('leaves no broken public reference after an image is removed', async () => {
    const jar = await superAdminJar();
    const kept = await uploadImage(jar);
    const dropped = await uploadImage(jar);
    const productId = await createProduct(jar, 'KZ-P-DUR0012', [
      kept.id,
      dropped.id,
    ]);

    await withCookies(ctx, jar)
      .patch(`/products/${productId}`)
      .send({ images: [kept.id] });

    // Every URL the admin projection still advertises must resolve.
    const view = await withCookies(ctx, jar).get(
      `/products/admin/${productId}`,
    );
    const urls: string[] = (view.body.data?.images ?? []).map(
      (image: { url: string }) => image.url,
    );
    expect(urls).toHaveLength(1);
    for (const url of urls) {
      const fetched = await fetch(url);
      expect(fetched.status).toBe(200);
    }
  });
});
