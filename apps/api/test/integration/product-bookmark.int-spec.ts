/**
 * ACCEPTANCE 29 -- bookmarking must not crash, and must not be targetable at
 * another user.
 *
 * Two defects fixed together:
 *   - `product.users.some(...)` on a `findOne()` that never loaded `users`
 *     threw TypeError -> 500 on every call;
 *   - `userId` came from the request body, so any authenticated user could
 *     create or delete bookmarks for anybody else (IDOR).
 */
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ProductMessages } from 'src/common/constants/product.messages';
import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import {
  countBookmarks,
  seedProduct,
  uniqueSku,
} from './support/catalog.fixtures';

describe('Product bookmark (int)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  it("does not crash and toggles the caller's own bookmark", async () => {
    const user = await ctx.loginAs([UserRoleEnum.site], 'bm-owner');
    const product = await seedProduct(ctx.dataSource, {
      title: 'Bookmarkable',
      variants: [{ sku: uniqueSku('BM'), price: 10, stock: 1 }],
    });

    const on = await ctx
      .request()
      .post('/products/bookmark')
      .set('Cookie', user.cookie)
      .send({ productId: product.id })
      .expect(201);

    expect(on.body.data).toEqual({ bookmarked: true });
    expect(on.body.message).toBe(ProductMessages.PRODUCT_BOOKMARKED);
    expect(await countBookmarks(ctx.dataSource, product.id, user.userId)).toBe(
      1,
    );

    const off = await ctx
      .request()
      .post('/products/bookmark')
      .set('Cookie', user.cookie)
      .send({ productId: product.id })
      .expect(201);

    expect(off.body.data).toEqual({ bookmarked: false });
    expect(await countBookmarks(ctx.dataSource, product.id, user.userId)).toBe(
      0,
    );
  });

  it('cannot bookmark on behalf of another user', async () => {
    const attacker = await ctx.loginAs([UserRoleEnum.site], 'bm-attacker');
    const victim = await ctx.loginAs([UserRoleEnum.site], 'bm-victim');
    const product = await seedProduct(ctx.dataSource, { title: 'Target' });

    // `userId` is not a member of BookmarkProductDto and the global
    // ValidationPipe runs with forbidNonWhitelisted, so the request is
    // rejected outright rather than silently ignored.
    await ctx
      .request()
      .post('/products/bookmark')
      .set('Cookie', attacker.cookie)
      .send({ productId: product.id, userId: victim.userId })
      .expect(400);

    expect(
      await countBookmarks(ctx.dataSource, product.id, victim.userId),
    ).toBe(0);
    expect(
      await countBookmarks(ctx.dataSource, product.id, attacker.userId),
    ).toBe(0);
  });

  it('binds the bookmark to the token subject, never to a body field', async () => {
    const attacker = await ctx.loginAs([UserRoleEnum.site], 'bm-attacker-2');
    const victim = await ctx.loginAs([UserRoleEnum.site], 'bm-victim-2');
    const product = await seedProduct(ctx.dataSource, { title: 'Target 2' });

    await ctx
      .request()
      .post('/products/bookmark')
      .set('Cookie', attacker.cookie)
      .send({ productId: product.id })
      .expect(201);

    expect(
      await countBookmarks(ctx.dataSource, product.id, attacker.userId),
    ).toBe(1);
    expect(
      await countBookmarks(ctx.dataSource, product.id, victim.userId),
    ).toBe(0);
  });

  it('requires authentication', async () => {
    const product = await seedProduct(ctx.dataSource, { title: 'Target 3' });
    await ctx
      .request()
      .post('/products/bookmark')
      .send({ productId: product.id })
      .expect(401);
  });

  it('404s for an unknown product instead of crashing', async () => {
    const user = await ctx.loginAs([UserRoleEnum.site], 'bm-404');
    await ctx
      .request()
      .post('/products/bookmark')
      .set('Cookie', user.cookie)
      .send({ productId: 999_999 })
      .expect(404);
  });

  it('never discloses bookmarking users on the admin projection', async () => {
    const admin = await ctx.loginAs([UserRoleEnum.superAdmin], 'bm-admin');
    const shopper = await ctx.loginAs([UserRoleEnum.site], 'bm-shopper');
    const product = await seedProduct(ctx.dataSource, { title: 'Counted' });

    await ctx
      .request()
      .post('/products/bookmark')
      .set('Cookie', shopper.cookie)
      .send({ productId: product.id })
      .expect(201);

    const res = await ctx
      .request()
      .get(`/products/admin/${product.id}`)
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(res.body.data.bookmarkCount).toBe(1);
    expect(res.body.data).not.toHaveProperty('users');
  });
});
