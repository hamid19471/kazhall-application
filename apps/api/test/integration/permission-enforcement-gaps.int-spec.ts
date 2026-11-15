import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import { closeTestDataSource, resetDb } from './setup/test-db';
import {
  createProductWithVariant,
  createUser,
  uniqueSuffix,
} from './setup/seed-helpers';

/**
 * ===========================================================================
 * THREE CAPABILITIES THAT AUTHORISED NOTHING
 * ===========================================================================
 *
 * A final audit of the console against the API found three routes whose
 * declared permission did not match the authority they actually conferred.
 * Each is asserted here from the owner's question, because each was invisible
 * to every existing test: the endpoints all worked, and worked for the wrong
 * people.
 *
 *  1. "I gave my catalogue editor `products.update` but NOT
 *     `products.deactivate`. Can they still pull a product off the shelf?"
 *     They could. Variant activation rides inside `PATCH /products/:id`, and
 *     both activation codes were checked nowhere in the codebase.
 *
 *  2. "I gave somebody `products.create`. Can they finish the create form?"
 *     They could not. Image upload demanded `products.update`, which a
 *     create-only role has no reason to hold, so every upload 403'd halfway
 *     through a form the role was explicitly authorised to fill in.
 *
 *  3. "My reconciliation auditor can only read. Why is the screen offering
 *     them five buttons that move money?" Because `allowedActions` was
 *     computed from the case's state alone and never from the caller's.
 */
describe('permission enforcement gaps', () => {
  let app: TestApp;
  let admin: CookieJar;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    const created = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    admin = await authenticate(
      app,
      created.username,
      created.password,
      'admin',
    );
  });

  async function roleWith(permissions: string[]): Promise<number> {
    const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '');
    const response = await withCookies(app, admin)
      .post('/admin/access/roles')
      .send({
        name: `role_${suffix}`,
        titleFa: 'نقش آزمایشی',
        permissions,
      });
    expect(response.status).toBe(201);
    return Number(response.body.data.id);
  }

  async function staffHolding(permissions: string[]): Promise<CookieJar> {
    const roleId = await roleWith(permissions);
    const created = await createUser(app.dataSource, { roles: [] });
    const assign = await withCookies(app, admin)
      .put(`/admin/access/users/${created.user.id}/roles`)
      .send({ roleIds: [roleId] });
    expect(assign.status).toBe(200);
    return authenticate(app, created.username, created.password, 'admin');
  }

  // =========================================================================
  // 1. Taking a variant off sale
  // =========================================================================

  describe('products.activate / products.deactivate', () => {
    it('refuses to retire a variant for a role holding only products.update', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
      );
      const editor = await staffHolding([
        'admin.access',
        'products.read',
        'products.update',
      ]);

      const response = await withCookies(app, editor)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: false }] });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_DENIED');
      expect(response.body.details.missingPermissions).toEqual([
        'products.deactivate',
      ]);

      // The refusal must be ATOMIC: the variant is still on sale.
      const [row] = await app.dataSource.query<Array<{ isActive: boolean }>>(
        `SELECT "isActive" FROM "product_variants" WHERE "id" = $1`,
        [variant.id],
      );
      expect(row.isActive).toBe(true);
    });

    it('allows it once products.deactivate is granted', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
      );
      const editor = await staffHolding([
        'admin.access',
        'products.read',
        'products.update',
        'products.deactivate',
      ]);

      const response = await withCookies(app, editor)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: false }] });

      expect(response.status).toBe(200);
      const [row] = await app.dataSource.query<Array<{ isActive: boolean }>>(
        `SELECT "isActive" FROM "product_variants" WHERE "id" = $1`,
        [variant.id],
      );
      expect(row.isActive).toBe(false);
    });

    it('requires products.activate to put one back on sale', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
      );
      await app.dataSource.query(
        `UPDATE "product_variants" SET "isActive" = false WHERE "id" = $1`,
        [variant.id],
      );

      const editor = await staffHolding([
        'admin.access',
        'products.read',
        'products.update',
        'products.deactivate', // the OTHER direction, deliberately
      ]);

      const refused = await withCookies(app, editor)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: true }] });
      expect(refused.status).toBe(403);
      expect(refused.body.details.missingPermissions).toEqual([
        'products.activate',
      ]);
    });

    it('does NOT refuse a body that merely restates the current state', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
      );
      const editor = await staffHolding([
        'admin.access',
        'products.read',
        'products.update',
      ]);

      // The check is on the TRANSITION. A client echoing a variant back
      // unchanged is not deactivating anything, and refusing it would break
      // ordinary saves for a role that legitimately holds only
      // `products.update` — a regression worse than the hole being closed.
      const response = await withCookies(app, editor)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: true, price: 12345 }] });

      expect(response.status).toBe(200);
      const [row] = await app.dataSource.query<
        Array<{ isActive: boolean; price: string }>
      >(
        `SELECT "isActive", "price"::text FROM "product_variants" WHERE "id" = $1`,
        [variant.id],
      );
      expect(row.isActive).toBe(true);
      expect(row.price).toBe('12345');
    });
  });

  // =========================================================================
  // 2. Finishing the create form
  // =========================================================================

  describe('product image upload', () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000a49444154789c6300010000050001' +
        '0d0a2db40000000049454e44ae426082',
      'hex',
    );

    it('accepts a role holding products.create but not products.update', async () => {
      const creator = await staffHolding([
        'admin.access',
        'products.read',
        'products.create',
      ]);

      const response = await withCookies(app, creator)
        .post('/products/uploadImage')
        .attach('file', png, 'a.png');

      // The assertion is on AUTHORISATION, not on storage. There is no MinIO
      // in this harness, so a permitted upload gets as far as the object store
      // and fails there; what matters is that it is no longer turned away at
      // the guard, which is what a create-only role used to hit.
      expect(response.status).not.toBe(403);
      expect(response.body.error).not.toBe('PERMISSION_DENIED');
    });

    it('accepts a role holding products.update but not products.create', async () => {
      const editor = await staffHolding([
        'admin.access',
        'products.read',
        'products.update',
      ]);

      const response = await withCookies(app, editor)
        .post('/products/uploadImage')
        .attach('file', png, 'a.png');

      expect(response.status).not.toBe(403);
      expect(response.body.error).not.toBe('PERMISSION_DENIED');
    });

    it('refuses a role holding neither', async () => {
      const reader = await staffHolding(['admin.access', 'products.read']);

      const response = await withCookies(app, reader)
        .post('/products/uploadImage')
        .attach('file', png, 'a.png');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_DENIED');
    });
  });

  // =========================================================================
  // 2b. READ-ONLY IS READ-ONLY ON THE SERVER, WHATEVER THE SCREEN SHOWS
  // =========================================================================

  /**
   * The admin product page opens on `products.read`, and every editable
   * control on it is now hidden from a viewer who holds nothing else. That is
   * a KINDNESS — it stops an operator typing into a field whose contents will
   * be discarded — and it is NEVER the control.
   *
   * This block is the control. Every mutation the page can perform is called
   * DIRECTLY, with a `products.read`-only session, bypassing the UI entirely.
   * If one of them ever succeeds, the read-only screen is decoration over a
   * writable API and the hiding has become a lie.
   */
  describe('a products.read-only viewer, calling the API directly', () => {
    async function reader(): Promise<CookieJar> {
      return staffHolding([
        'admin.access',
        'products.read',
        'inventory.read',
        'categories.read',
        'attributes.read',
      ]);
    }

    it('cannot edit the product body (title, description, price, categories, images)', async () => {
      const { product } = await createProductWithVariant(app.dataSource);
      const viewer = await reader();

      const response = await withCookies(app, viewer)
        .patch(`/products/${product.id}`)
        .send({
          title: 'Renamed by a viewer',
          description: 'Rewritten by a viewer',
          basePrice: 1,
          categoryIds: [],
          images: [],
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_DENIED');
      expect(response.body.details.missingPermissions).toContain(
        'products.update',
      );

      // And nothing moved. A 403 that had already written half the body would
      // be worse than a 200.
      const [row] = await app.dataSource.query<Array<{ title: string }>>(
        `SELECT title FROM products WHERE id = $1`,
        [product.id],
      );
      expect(row.title).not.toBe('Renamed by a viewer');
    });

    it('cannot edit a variant, its SKU, its price or its attributes', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
      );
      const viewer = await reader();

      const response = await withCookies(app, viewer)
        .patch(`/products/${product.id}`)
        .send({
          variants: [{ id: variant.id, sku: 'VIEWER-SKU', price: 1 }],
        });

      expect(response.status).toBe(403);

      const [row] = await app.dataSource.query<Array<{ sku: string }>>(
        `SELECT sku FROM product_variants WHERE id = $1`,
        [variant.id],
      );
      expect(row.sku).not.toBe('VIEWER-SKU');
    });

    it('cannot create a product', async () => {
      const viewer = await reader();

      const response = await withCookies(app, viewer)
        .post('/products')
        .send({ title: 'Made by a viewer', basePrice: 1000 });

      expect(response.status).toBe(403);
      expect(response.body.details.missingPermissions).toContain(
        'products.create',
      );
    });

    it('cannot flip a variant active or inactive in either direction', async () => {
      const { product, variant } = await createProductWithVariant(
        app.dataSource,
      );
      const viewer = await reader();

      // active -> inactive needs `products.deactivate`
      const off = await withCookies(app, viewer)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: false }] });
      expect(off.status).toBe(403);

      // and inactive -> active needs `products.activate`
      await app.dataSource.query(
        `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
        [variant.id],
      );
      const on = await withCookies(app, viewer)
        .patch(`/products/${product.id}`)
        .send({ variants: [{ id: variant.id, isActive: true }] });
      expect(on.status).toBe(403);
    });

    it('cannot adjust stock through EITHER of the two routes that do it', async () => {
      // The product page uses `/products/variants/:id/stock/adjust`; the
      // inventory screen uses `/admin/inventory/variants/:id/adjust`. They
      // perform the same mutation, so hiding one control and leaving the other
      // route open would be no protection at all.
      const { variant } = await createProductWithVariant(app.dataSource);
      const viewer = await reader();

      const viaProduct = await withCookies(app, viewer)
        .post(`/products/variants/${variant.id}/stock/adjust`)
        .send({ delta: 5, reason: 'viewer adjustment' });
      expect(viaProduct.status).toBe(403);
      expect(viaProduct.body.details.missingPermissions).toContain(
        'inventory.adjust',
      );

      const viaInventory = await withCookies(app, viewer)
        .post(`/admin/inventory/variants/${variant.id}/adjust`)
        .send({ mode: 'delta', delta: 5, reason: 'viewer adjustment' });
      expect(viaInventory.status).toBe(403);
    });

    it('cannot upload an image, which is where a saved edit would get its ids', async () => {
      const viewer = await reader();

      const response = await withCookies(app, viewer)
        .post('/products/uploadImage')
        .attach(
          'file',
          Buffer.from(
            '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
              '1f15c4890000000a49444154789c6300010000050001' +
              '0d0a2db40000000049454e44ae426082',
            'hex',
          ),
          'a.png',
        );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_DENIED');
    });

    it('CAN still read everything the page displays', async () => {
      // The other half of "read-only": it must not have become "no access".
      const { product } = await createProductWithVariant(app.dataSource);
      const viewer = await reader();

      await withCookies(app, viewer).get('/products/admin').expect(200);
      await withCookies(app, viewer)
        .get(`/products/admin/${product.id}`)
        .expect(200);
      await withCookies(app, viewer).get('/admin/inventory').expect(200);
    });
  });

  // =========================================================================
  // 3. What the reconciliation screen offers
  // =========================================================================

  describe('reconciliation allowedActions', () => {
    async function seedCase(): Promise<number> {
      const [order] = await app.dataSource.query<Array<{ id: number }>>(
        `INSERT INTO orders
           (channel, status, total_price, subtotal, "fulfillmentState",
            paid_at, "paidAt", "soldAt")
         VALUES ('online', 'paid', 100000, 100000, 'pending',
                 now(), now(), now())
         RETURNING id`,
      );
      return Number(order.id);
    }

    it('offers nothing to a reader who cannot act', async () => {
      const orderId = await seedCase();
      const reader = await staffHolding([
        'admin.access',
        'reconciliation.read',
      ]);

      const response = await withCookies(app, reader).get(
        `/payment/admin/reconciliation/${orderId}`,
      );

      expect(response.status).toBe(200);
      // The console renders exactly this list. An auditor used to be shown all
      // five critical-risk actions, compose a mandatory justification, press
      // one, and collect a 403.
      expect(response.body.data.allowedActions).toEqual([]);
    });

    it('offers the state-appropriate actions once reconciliation.act is held', async () => {
      const orderId = await seedCase();
      const operator = await staffHolding([
        'admin.access',
        'reconciliation.read',
        'reconciliation.act',
      ]);

      const response = await withCookies(app, operator).get(
        `/payment/admin/reconciliation/${orderId}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.allowedActions.length).toBeGreaterThan(0);
    });

    it('still refuses the mutation itself, not merely the button', async () => {
      const orderId = await seedCase();
      const reader = await staffHolding([
        'admin.access',
        'reconciliation.read',
      ]);

      // Shaping a response is not authorising a request. A caller who ignores
      // the empty list must still be refused by the guard.
      const response = await withCookies(app, reader)
        .post(`/payment/admin/reconciliation/${orderId}/mark-refund-required`)
        .send({ reason: 'تلاش برای اقدام بدون اختیار لازم.' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION_DENIED');
      expect(response.body.details.missingPermissions).toContain(
        'reconciliation.act',
      );
    });
  });
});
