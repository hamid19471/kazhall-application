import { ConflictException, NotFoundException } from '@nestjs/common';
import * as request from 'supertest';

import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { CategoriesService } from 'src/modules/categories/categories.service';
import { AuditActor } from 'src/modules/audit/audit.service';

/**
 * These two cases drive the service directly (there is no HTTP route), so the
 * actor cannot come from a request. It is spelled out rather than faked inside
 * the service, because `AuditService.record` is not optional: an administrative
 * act that could not be recorded has not, for the owner's purposes, happened.
 */
const TEST_ACTOR: AuditActor = {
  userId: null,
  display: 'integration-test',
  audience: 'admin',
  requestId: null,
};

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  createBranch,
  createCategory,
  createProduct,
  createUser,
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * ADMIN COVERAGE — replacements for the last uncovered skipped unit tests
 * ===========================================================================
 *
 * Every `describe.skip` block in `product.service.spec.ts`,
 * `order.service.spec.ts` and `categories.service.spec.ts` asserted the
 * PREVIOUS shape of a service that has since been reshaped, so none of them
 * could be un-skipped as written. Most had a replacement elsewhere in the
 * integration suite. These six did not:
 *
 *   product.service.spec.ts       describe.skip('create')
 *   order.service.spec.ts         describe.skip('findAll')
 *   order.service.spec.ts         describe.skip('findOne')
 *   categories.service.spec.ts    describe.skip('findOne')
 *   categories.service.spec.ts    describe.skip('removeOnlyCategory')
 *   categories.service.spec.ts    describe.skip('safeRemove')
 *
 * This file replaces all six against the REAL routes and the real database —
 * strictly better evidence than the mocked originals, which asserted that a
 * mocked repository had been called with a particular options object rather
 * than that anything was persisted or that any rule held.
 *
 * `CategoriesService.findOne` and `safeRemove` have no HTTP route at all, so
 * they are driven through the real service against the real database at the
 * bottom of this file.
 */
describe('admin coverage (skipped-unit-test replacements)', () => {
  let app: TestApp;
  let admin: CookieJar;
  let adminUserId: number;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
    const created = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    adminUserId = created.user.id;
    admin = await authenticate(app, created.username, created.password);
  });

  // =========================================================================
  // Replaces product.service.spec.ts:197 describe.skip('create')
  // =========================================================================

  describe('POST /products', () => {
    it('persists a product with its categories and gives it a default sellable variant', async () => {
      const category = await createCategory(app.dataSource);

      const response = await withCookies(app, admin)
        .post('/products')
        .send({
          title: 'Integration Kettle',
          description: 'boils water',
          basePrice: 1_250_000,
          categoryIds: [category.id],
          productCode: 'KZ-P-ADMINCOV1',
        });

      expect([200, 201]).toContain(response.status);
      const productId = Number(response.body.data.id);

      // Persisted, not merely returned.
      const rows = await app.dataSource.query(
        `SELECT p.title, p."basePrice",
                (SELECT COUNT(*)::int FROM product_category pc WHERE pc.product_id = p.id) AS categories,
                (SELECT COUNT(*)::int FROM product_variants v WHERE v."productId" = p.id) AS variants
           FROM products p WHERE p.id = $1`,
        [productId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Integration Kettle');
      expect(Number(rows[0].basePrice)).toBe(1_250_000);
      expect(rows[0].categories).toBe(1);

      // The sellable-SKU invariant: a simple product is never left without a
      // variant, because a product with no variant participates in no stock
      // check and no reservation.
      expect(rows[0].variants).toBe(1);
      const [variant] = await app.dataSource.query(
        `SELECT "isDefault", stock, price FROM product_variants WHERE "productId" = $1`,
        [productId],
      );
      expect(variant.isDefault).toBe(true);
      // Opening stock is NOT invented: nobody counted this product yet.
      expect(Number(variant.stock)).toBe(0);
      expect(Number(variant.price)).toBe(1_250_000);
    });

    it('rolls the whole creation back when a category id is unknown', async () => {
      const response = await withCookies(app, admin)
        .post('/products')
        .send({
          title: 'Ghost Product',
          description: 'should never exist',
          basePrice: 1000,
          categoryIds: [999_999],
          // A VALID code, so the refusal below is really the unknown category
          // rolling the transaction back and not a DTO rejection before it.
          productCode: 'KZ-P-ADMINCOV2',
        });

      expect(response.status).toBeGreaterThanOrEqual(400);

      // No half-created product, and therefore no orphan default variant.
      const [{ products }] = await app.dataSource.query(
        `SELECT COUNT(*)::int AS products FROM products WHERE title = 'Ghost Product'`,
      );
      expect(products).toBe(0);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await request(app.server)
        .post('/products')
        .send({ title: 'x', description: 'y', basePrice: 1 });
      expect([401, 403]).toContain(response.status);
    });
  });

  // =========================================================================
  // Replaces order.service.spec.ts:184/:211 describe.skip('findAll'/'findOne')
  // =========================================================================

  describe('GET /orders and GET /orders/:id (the administrator’s view)', () => {
    /** One POS-shaped order row written straight to the table. */
    async function seedOrder(branchId: number | null): Promise<number> {
      const [row] = await app.dataSource.query(
        `INSERT INTO orders (channel, status, "branchId", "cashierUserId",
                             subtotal, total_price, "soldAt", "paidAt")
         VALUES ('pos', 'paid', $1, $2, 100, 100, now(), now())
         RETURNING id`,
        [branchId, adminUserId],
      );
      return Number(row.id);
    }

    it('returns every order to a super_admin', async () => {
      const branchA = await createBranch(app.dataSource);
      const branchB = await createBranch(app.dataSource);
      const a = await seedOrder(branchA.id);
      const b = await seedOrder(branchB.id);

      const response = await withCookies(app, admin).get('/orders');

      expect(response.status).toBe(200);
      const ids = (response.body.data as Array<{ id: number }>).map((o) =>
        Number(o.id),
      );
      expect(ids).toEqual(expect.arrayContaining([a, b]));
    });

    it('refuses a sale user the order list and every order it would contain', async () => {
      // This case used to assert branch scoping: a `sale` caller saw their own
      // branch's orders and not another's. The owner's rule is narrower --
      // browsing sales history is the administrator's, and a cashier's only
      // claim is the slip for a sale they rang up themselves -- so the branch
      // boundary has been replaced by a role boundary here, and the own-sale
      // receipt is covered in pos-catalog-and-report-authz.int-spec.ts.
      const mine = await createBranch(app.dataSource);
      const theirs = await createBranch(app.dataSource);
      const ours = await seedOrder(mine.id);
      const foreign = await seedOrder(theirs.id);

      const seller = await createUser(app.dataSource, {
        roles: [UserRoleEnum.sale],
        branchId: mine.id,
      });
      const jar = await authenticate(app, seller.username, seller.password);

      expect((await withCookies(app, jar).get('/orders')).status).toBe(401);

      // Neither order was sold by this cashier, so both are 404 -- not 403,
      // which would confirm that an order with that id exists.
      expect((await withCookies(app, jar).get(`/orders/${ours}`)).status).toBe(
        404,
      );
      expect(
        (await withCookies(app, jar).get(`/orders/${foreign}`)).status,
      ).toBe(404);
    });

    it('answers 404 for an order that does not exist', async () => {
      const response = await withCookies(app, admin).get('/orders/999999');
      expect(response.status).toBe(404);
    });

    it('refuses a customer (site role) outright — this is the staff view', async () => {
      const branch = await createBranch(app.dataSource);
      const orderId = await seedOrder(branch.id);
      const customer = await createUser(app.dataSource, {
        roles: [UserRoleEnum.site],
      });
      const jar = await authenticate(app, customer.username, customer.password);

      // A shopper holds a storefront session, and neither of these routes
      // serves the storefront — so both refuse at the audience layer, before
      // any role is read. 401 rather than 403 is also the better answer here:
      // 403 would confirm the staff view exists.
      expect((await withCookies(app, jar).get('/orders')).status).toBe(401);
      expect(
        (await withCookies(app, jar).get(`/orders/${orderId}`)).status,
      ).toBe(401);
    });
  });

  // =========================================================================
  // `DELETE /categories/removeOnlyCategory/:id` HAS BEEN REMOVED, and the three
  // cases that covered it are replaced below.
  //
  // It detached every product from the category and then deleted it, answering
  // 200. The `product_category` rows it dropped are the catalogue's navigation
  // structure; nothing recorded them and no admin could reconstruct which
  // products used to be in the category. `DELETE /categories/:id` is the honest
  // version of the same intent — it REFUSES while the category is in use.
  // =========================================================================

  describe('DELETE /categories/:id', () => {
    it('deletes an empty category', async () => {
      const category = await createCategory(app.dataSource);

      const response = await withCookies(app, admin).delete(
        `/categories/${category.id}`,
      );
      expect([200, 204]).toContain(response.status);

      const [{ count }] = await app.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM categories WHERE id = $1`,
        [category.id],
      );
      expect(count).toBe(0);
    });

    it('answers 409 CATEGORY_IN_USE while products are still attached, and deletes nothing', async () => {
      const category = await createCategory(app.dataSource);
      const product = await createProduct(app.dataSource, {
        categories: [category],
      });

      const response = await withCookies(app, admin).delete(
        `/categories/${category.id}`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('CATEGORY_IN_USE');
      // The count is what makes the refusal actionable: "no" without "because
      // 12 products are in it" leaves the admin with nothing to do next.
      expect(response.body.details.productCount).toBe(1);

      const [counts] = await app.dataSource.query(
        `SELECT (SELECT COUNT(*)::int FROM categories WHERE id = $1) AS category,
                (SELECT COUNT(*)::int FROM product_category WHERE category_id = $1) AS links,
                (SELECT COUNT(*)::int FROM products WHERE id = $2) AS product`,
        [category.id, product.id],
      );
      expect(counts).toEqual({ category: 1, links: 1, product: 1 });
    });

    it('answers 404 for a category that does not exist', async () => {
      const response = await withCookies(app, admin).delete(
        '/categories/999999',
      );
      expect(response.status).toBe(404);
    });

    it('drops the cached category document, so a later read cannot resurrect it', async () => {
      const category = await createCategory(app.dataSource);
      const categories = app.app.get(CategoriesService);

      // Populate the cache.
      await expect(categories.findOne(category.id)).resolves.toMatchObject({
        id: category.id,
      });

      await withCookies(app, admin).delete(`/categories/${category.id}`);

      await expect(categories.findOne(category.id)).rejects.toThrow();
    });
  });

  // =========================================================================
  // Replaces categories.service.spec.ts:155 findOne and :283 safeRemove.
  //
  // Neither has an HTTP route, so these drive the real service against the real
  // database instead of a mocked repository. That is a strict upgrade on the
  // originals, which asserted that `categoryRepository.findOne` had been called
  // with a particular options object — a fact about the mock, not about the
  // service.
  // =========================================================================

  describe('CategoriesService (no HTTP route exists for these)', () => {
    it('findOne returns the bounded CategoryView with a real product count', async () => {
      const categories = app.app.get(CategoriesService);
      const category = await createCategory(app.dataSource, 'Mobile');
      await createProduct(app.dataSource, { categories: [category] });
      await createProduct(app.dataSource, { categories: [category] });

      const view = await categories.findOne(category.id);

      expect(view).toEqual({
        id: category.id,
        title: 'Mobile',
        productCount: 2,
      });
      // BOUNDED on purpose: the old contract eager-loaded every
      // `Category.products` row into the response (and into the cache), which
      // is unbounded output and leaked the catalogue through a lookup endpoint.
      expect(Object.keys(view).sort()).toEqual(['id', 'productCount', 'title']);
    });

    it('findOne raises NotFound for a missing category', async () => {
      const categories = app.app.get(CategoriesService);
      // The old contract raised BadRequest here, which is what the skipped unit
      // test asserted; a missing entity is a 404 across the rest of the API.
      await expect(categories.findOne(999_999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('safeRemove deletes an empty category', async () => {
      const categories = app.app.get(CategoriesService);
      const category = await createCategory(app.dataSource);

      await categories.safeRemove(category.id, TEST_ACTOR);

      const [{ count }] = await app.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM categories WHERE id = $1`,
        [category.id],
      );
      expect(count).toBe(0);
    });

    it('safeRemove REFUSES to delete a category that still has products, and deletes nothing', async () => {
      const categories = app.app.get(CategoriesService);
      const category = await createCategory(app.dataSource);
      const product = await createProduct(app.dataSource, {
        categories: [category],
      });

      // 409, not 400: the request is well-formed and the refusal is about the
      // state of the catalogue.
      await expect(
        categories.safeRemove(category.id, TEST_ACTOR),
      ).rejects.toThrow(ConflictException);

      // The whole point: the refusal is atomic. A partial delete that detached
      // the products and then failed would be worse than either outcome.
      const [counts] = await app.dataSource.query(
        `SELECT (SELECT COUNT(*)::int FROM categories WHERE id = $1) AS category,
                (SELECT COUNT(*)::int FROM product_category WHERE category_id = $1) AS links,
                (SELECT COUNT(*)::int FROM products WHERE id = $2) AS product`,
        [category.id, product.id],
      );
      expect(counts).toEqual({ category: 1, links: 1, product: 1 });
    });

    it('safeRemove raises NotFound for a missing category', async () => {
      const categories = app.app.get(CategoriesService);
      await expect(categories.safeRemove(999_999, TEST_ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
