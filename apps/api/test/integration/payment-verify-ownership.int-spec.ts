import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { PaymentStatusEnum } from 'src/modules/payment/enums/payment-status-enum';
import { PAYMENT_GATEWAY } from 'src/modules/payment/gateways/payment-gateway.interface';
import { StubPaymentGateway } from 'src/modules/payment/gateways/stub.gateway';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  CookieJar,
  TestApp,
  authenticate,
  createTestApp,
  withCookies,
} from './setup/test-app';
import {
  createProductWithVariant,
  createUser,
  forceStockForTest,
  uniqueSuffix,
} from './setup/seed-helpers';
import { closeTestDataSource, resetDb } from './setup/test-db';
import { makeOnlineOrder } from './support/inventory.harness';

/**
 * ============================================================================
 * `POST /payment/verify` MUST BE OWNER-SCOPED
 * ============================================================================
 *
 * THE DEFECT
 * ----------
 * The handler was, in full:
 *
 *     @Post('verify')
 *     async verify(@Body() verifyPaymentDto: VerifyPaymentDto) {
 *       const result = await this.paymentService.Verify(verifyPaymentDto.trackId);
 *       return { message: result.message, data: result };
 *     }
 *
 * No `@Roles`, no `@Req`, no ownership test anywhere on the path. `trackId` is
 * a value the CALLER supplies, so any authenticated customer could drive
 * verification of any other customer's payment attempt and read back that
 * attempt's `orderId`, `orderStatus`, `fulfillmentState`, `expectedAmount`,
 * `gatewayAmount` and reconciliation state. `POST /payment/start` has always
 * refused to open a session for somebody else's order; `verify` accepted one
 * from anybody.
 *
 * A weaker defect sat next to it: an UNKNOWN trackId answered 400 while a
 * FOREIGN one answered 200. That pair is a membership oracle — it lets anyone
 * enumerate which trackIds exist without needing to be able to act on them. So
 * "not yours" and "does not exist" now produce the same 404, and this suite
 * asserts they are the same BYTE FOR BYTE (modulo the one clock field), not
 * merely the same status code.
 *
 * WHAT IS ASSERTED, AND WHY IT IS AT HTTP LEVEL
 * ---------------------------------------------
 * Everything runs through the REAL application: the real cookie auth, the real
 * global `JwtAuthGuard`/`RolesGuard`, the real whitelisting `ValidationPipe`,
 * the real `GlobalExceptionFilter` envelope. A service-level test could not
 * prove any of the four things that actually matter here — that the identity
 * comes from the cookie, that an extra body key is refused, that the two 404s
 * are indistinguishable on the wire, and that the internal recovery workers
 * still run with NO identity at all.
 *
 * NO LIVE GATEWAY IS TOUCHED: the `PAYMENT_GATEWAY` binding is asserted to be
 * the deterministic stub before anything else runs. Nothing here refunds,
 * credits or reverses anything, and neither does the code under test.
 * ============================================================================
 */
describe('POST /payment/verify is owner-scoped', () => {
  let app: TestApp;
  let stub: StubPaymentGateway;

  /** The customer who owns the order and the payment attempt. */
  let owner: CookieJar;
  let ownerId: number;
  /** A different, perfectly legitimate customer. Not the owner of anything. */
  let stranger: CookieJar;
  /** `super_admin` — explicitly exempt; see PaymentService.verifyForCaller. */
  let admin: CookieJar;
  /** `sale` (a till). Deliberately NOT exempt. */
  let cashier: CookieJar;

  let variantId: number;
  let orderId: number;
  /** The owner's live payment attempt. */
  let trackId: string;

  beforeAll(async () => {
    app = await createTestApp();
    stub = app.app.get<StubPaymentGateway>(PAYMENT_GATEWAY);
  });

  afterAll(async () => {
    await app.close();
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await resetDb(app.dataSource);
    app.redis.flush();
    stub.reset();

    const ownerUser = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    ownerId = ownerUser.user.id;
    owner = await authenticate(app, ownerUser.username, ownerUser.password);

    const strangerUser = await createUser(app.dataSource, {
      roles: [UserRoleEnum.site],
    });
    stranger = await authenticate(
      app,
      strangerUser.username,
      strangerUser.password,
    );

    const adminUser = await createUser(app.dataSource, {
      roles: [UserRoleEnum.superAdmin],
    });
    admin = await authenticate(app, adminUser.username, adminUser.password);

    const saleUser = await createUser(app.dataSource, {
      roles: [UserRoleEnum.sale],
    });
    cashier = await authenticate(app, saleUser.username, saleUser.password);

    const { product, variant } = await createProductWithVariant(
      app.dataSource,
      { basePrice: 1_000_000 },
      { stock: 10, price: 1_000_000, sku: `SKU-${uniqueSuffix()}` },
    );
    variantId = variant.id;

    orderId = await makeOnlineOrder(app.dataSource, ownerId, [
      { productId: product.id, variantId: variant.id, quantity: 1 },
    ]);

    trackId = await startPayment(owner, orderId);
  });

  // ==========================================================================
  // Helpers
  // ==========================================================================

  async function startPayment(jar: CookieJar, order: number): Promise<string> {
    const response = await withCookies(app, jar)
      .post('/payment/start')
      .send({ orderId: order });
    if (response.status !== 201) {
      throw new Error(
        `payment/start failed (${response.status}): ${JSON.stringify(response.body)}`,
      );
    }
    return response.body.data.trackId as string;
  }

  function verify(jar: CookieJar, body: Record<string, unknown>) {
    return withCookies(app, jar).post('/payment/verify').send(body);
  }

  interface PaymentSnapshot {
    id: number;
    orderId: number;
    trackId: string | null;
    status: PaymentStatusEnum;
  }

  async function payments(): Promise<PaymentSnapshot[]> {
    const rows: Array<Record<string, unknown>> = await app.dataSource.query(
      `SELECT id, "orderId", track_id, status::text AS status
         FROM payment ORDER BY id ASC`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      orderId: Number(r.orderId),
      trackId: r.track_id as string | null,
      status: r.status as PaymentStatusEnum,
    }));
  }

  async function orderState(id: number): Promise<{
    status: string;
    fulfillmentState: string;
  }> {
    const rows: Array<{ status: string; fulfillmentState: string }> =
      await app.dataSource.query(
        `SELECT status::text AS status,
                "fulfillmentState"::text AS "fulfillmentState"
           FROM orders WHERE id = $1`,
        [id],
      );
    return rows[0];
  }

  async function physicalStock(id: number): Promise<number> {
    const rows: Array<{ stock: number }> = await app.dataSource.query(
      `SELECT stock FROM product_variants WHERE id = $1`,
      [id],
    );
    return Number(rows[0].stock);
  }

  /**
   * The raw response body with the ONE field that is allowed to differ between
   * two otherwise identical refusals — the clock — blanked out.
   *
   * Comparing `res.text` rather than `res.body` is deliberate: it compares the
   * bytes on the wire, so a difference in key ORDER, in whitespace, or in the
   * PRESENCE of an optional key (`details`) fails too. Comparing parsed objects
   * would quietly tolerate all three.
   */
  function onTheWire(text: string): string {
    return text.replace(/"timestamp":"[^"]*"/, '"timestamp":"<clock>"');
  }

  /** Every fact that must be untouched after a refused verification. */
  async function expectNothingHappened(): Promise<void> {
    expect(await payments()).toEqual([
      {
        id: expect.any(Number) as number,
        orderId,
        trackId,
        status: PaymentStatusEnum.PENDING,
      },
    ]);
    expect(await orderState(orderId)).toEqual({
      status: OrderStatusEnum.PENDING,
      fulfillmentState: FulfillmentStateEnum.NOT_REQUIRED,
    });
    expect(await physicalStock(variantId)).toBe(10);
    // The gateway was never even asked. A refusal that still round-trips to the
    // gateway is a refusal that still tells the caller their guess was real.
    expect(stub.verifyCalls).toEqual([]);
  }

  // ==========================================================================
  // Preconditions
  // ==========================================================================
  it('runs against the deterministic stub gateway, never a live one', () => {
    expect(stub).toBeInstanceOf(StubPaymentGateway);
  });

  // ==========================================================================
  // The owner
  // ==========================================================================
  it('lets the OWNER verify their own attempt', async () => {
    const response = await verify(owner, { trackId });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        success: true,
        applied: true,
        paymentStatus: PaymentStatusEnum.SUCCESS,
        trackId,
        orderId,
        orderStatus: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
        requiresReconciliation: false,
      },
    });

    // The DATABASE, not just the returned object.
    expect(await payments()).toEqual([
      {
        id: expect.any(Number) as number,
        orderId,
        trackId,
        status: PaymentStatusEnum.SUCCESS,
      },
    ]);
    expect(await orderState(orderId)).toEqual({
      status: OrderStatusEnum.PAID,
      fulfillmentState: FulfillmentStateEnum.FULFILLED,
    });
    expect(await physicalStock(variantId)).toBe(9);
  });

  // ==========================================================================
  // The stranger — the actual vulnerability
  // ==========================================================================
  it('refuses ANOTHER customer with a non-enumerating 404 and changes nothing', async () => {
    const response = await verify(stranger, { trackId });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      statusCode: 404,
      message: 'Payment not found',
      error: 'PAYMENT_ATTEMPT_NOT_FOUND',
    });
    // The body is exhaustively enumerated, so nothing about the order, the
    // amount, the owner or the attempt can leak through `details` or through a
    // key somebody adds later. (A substring search for the order id would be
    // useless here: a small integer occurs inside the ISO timestamp.)
    expect(Object.keys(response.body as object).sort()).toEqual([
      'error',
      'message',
      'path',
      'statusCode',
      'success',
      'timestamp',
    ]);

    await expectNothingHappened();
  });

  it('answers an UNKNOWN trackId with the same 404 (it used to be 400)', async () => {
    const response = await verify(stranger, {
      trackId: 'stub-no-such-attempt',
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      statusCode: 404,
      message: 'Payment not found',
      error: 'PAYMENT_ATTEMPT_NOT_FOUND',
    });
    await expectNothingHappened();
  });

  it('makes "not yours" and "does not exist" INDISTINGUISHABLE on the wire', async () => {
    // Same caller, same route, same everything except which trackId is sent:
    // one is real and belongs to somebody else, the other never existed.
    const foreign = await verify(stranger, { trackId });
    const unknown = await verify(stranger, {
      trackId: 'stub-no-such-attempt',
    });
    // And a third shape: a real trackId probed by its owner-to-be... i.e. an
    // attempt on an order that exists but whose payment row does not.
    const alsoUnknown = await verify(owner, { trackId: 'stub-999999' });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(alsoUnknown.status).toBe(404);

    expect(onTheWire(foreign.text)).toBe(onTheWire(unknown.text));
    expect(onTheWire(foreign.text)).toBe(onTheWire(alsoUnknown.text));
    // Belt and braces: the only difference between the raw bodies really is
    // the clock, so the normalisation above is not hiding anything.
    expect(foreign.text).not.toBe('');
    expect(onTheWire(foreign.text)).toContain('"statusCode":404');

    // Response headers must not give the game away either (a differing
    // content-length would defeat the whole exercise).
    expect(foreign.headers['content-length']).toBe(
      unknown.headers['content-length'],
    );

    await expectNothingHappened();
  });

  it('gives the `sale` role NO exemption', async () => {
    // The route serves the shop (the customer paying) and the admin console
    // (re-verifying an attempt). A till session is neither, so the cashier is
    // turned away at the audience layer — a stricter refusal than the 404 this
    // used to give, and it still reveals nothing about the attempt.
    const response = await verify(cashier, { trackId });

    expect(response.status).toBe(401);
    await expectNothingHappened();
  });

  // ==========================================================================
  // The super_admin policy — EXPLICIT, and therefore tested
  // ==========================================================================
  describe('super_admin policy: may verify ANY attempt', () => {
    it('verifies an attempt belonging to a customer', async () => {
      const response = await verify(admin, { trackId });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        success: true,
        applied: true,
        trackId,
        orderId,
        orderStatus: OrderStatusEnum.PAID,
      });

      // The order settles for its OWNER. Support driving a stuck callback must
      // not re-attribute the order to the admin who pushed the button.
      const rows: Array<{ userId: number | string }> =
        await app.dataSource.query(
          `SELECT "userId" FROM orders WHERE id = $1`,
          [orderId],
        );
      expect(Number(rows[0].userId)).toBe(ownerId);
    });

    it('still gets the same non-enumerating 404 for a trackId that does not exist', async () => {
      const adminUnknown = await verify(admin, { trackId: 'stub-nope' });
      const strangerUnknown = await verify(stranger, { trackId: 'stub-nope' });

      expect(adminUnknown.status).toBe(404);
      expect(onTheWire(adminUnknown.text)).toBe(
        onTheWire(strangerUnknown.text),
      );
      await expectNothingHappened();
    });
  });

  // ==========================================================================
  // No ownership decision may come from the body
  // ==========================================================================
  describe('the request body cannot carry an identity', () => {
    it('rejects a body containing `userId` outright (400), it does not strip it', async () => {
      const response = await verify(stranger, { trackId, userId: ownerId });

      expect(response.status).toBe(400);
      expect(response.body.statusCode).toBe(400);
      // The whitelisting ValidationPipe names the offending property, which is
      // how we know it was REFUSED rather than silently ignored.
      expect(JSON.stringify(response.body.message)).toContain('userId');

      await expectNothingHappened();
    });

    it('rejects it for the OWNER too — the field simply does not exist', async () => {
      const response = await verify(owner, { trackId, userId: ownerId });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.message)).toContain('userId');
      await expectNothingHappened();
    });

    it('cannot be used to escalate: sending the owner’s id does not buy access', async () => {
      // The 400 above already proves this, but state it as the security claim
      // it is: there is no body this stranger can send that verifies the
      // owner's attempt.
      for (const body of [
        { trackId, userId: ownerId },
        { trackId, sub: ownerId },
        { trackId, user: { sub: ownerId } },
      ]) {
        const response = await verify(stranger, body);
        expect([400, 404]).toContain(response.status);
        expect(response.status).not.toBe(201);
      }
      await expectNothingHappened();
    });
  });

  // ==========================================================================
  // The internal workers must keep working WITHOUT an identity
  // ==========================================================================
  describe('internal recovery and re-verification are unaffected', () => {
    /**
     * The re-verification sweep is the ONLY path that can discover a receipt
     * the gateway confirmed but that was never recorded here. It reaches money
     * through `PaymentService.Verify()` DIRECTLY, with no user in sight — which
     * is precisely why the ownership check lives in `verifyForCaller` at the
     * HTTP boundary and not inside `Verify()`. If it had been pushed down, this
     * test would fail (or the sweep would have had to invent a customer).
     */
    it('the re-verification sweep recovers a lost callback with no customer identity', async () => {
      // The customer closed the tab: the attempt stays `pending` with a
      // track_id, and no verify callback ever arrives. Backdate it past
      // `PAYMENT_REVERIFY_AFTER_MS` (15 min) so the sweep considers it due —
      // the only way to reach the due branch without sleeping.
      await app.dataSource.query(
        `UPDATE payment SET created_at = now() - interval '1 hour'
          WHERE track_id = $1`,
        [trackId],
      );

      const response = await withCookies(app, admin).post(
        '/payment/admin/reverify',
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        scanned: 1,
        recovered: 1,
        unapplied: 0,
        notPaid: 0,
        errored: 0,
      });

      // It really settled, through the ordinary path, for the real owner.
      expect(await payments()).toEqual([
        {
          id: expect.any(Number) as number,
          orderId,
          trackId,
          status: PaymentStatusEnum.SUCCESS,
        },
      ]);
      expect(await orderState(orderId)).toEqual({
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
      });
      expect(stub.verifyCalls).toEqual([trackId]);
    });

    it('the fulfilment recovery sweep re-drives an order stuck in AWAITING_STOCK', async () => {
      // Take the shelf to zero, so phase 1 records the money and phase 2
      // honestly cannot move the goods.
      await forceStockForTest(app.dataSource, variantId, 0);

      const verified = await verify(owner, { trackId });
      expect(verified.status).toBe(201);
      expect(verified.body.data).toMatchObject({
        applied: true,
        fulfillmentState: FulfillmentStateEnum.AWAITING_STOCK,
      });

      // Stock arrives. The recovery worker's backoff clock is reset here rather
      // than waited out: `fulfillmentNextAttemptAt` was stamped by the lease
      // that just ran, and this test is about whether recovery still WORKS, not
      // about its backoff (recovery-starvation.int-spec.ts owns that).
      await forceStockForTest(app.dataSource, variantId, 5);
      await app.dataSource.query(
        `UPDATE orders SET "fulfillmentNextAttemptAt" = NULL WHERE id = $1`,
        [orderId],
      );

      const recovered = await withCookies(app, admin).post(
        '/payment/admin/fulfilment/recover',
      );

      expect(recovered.status).toBe(200);
      expect(recovered.body.data).toMatchObject({
        scanned: 1,
        fulfilled: 1,
        blocked: 0,
        failed: 0,
      });
      expect(await orderState(orderId)).toEqual({
        status: OrderStatusEnum.PAID,
        fulfillmentState: FulfillmentStateEnum.FULFILLED,
      });
      expect(await physicalStock(variantId)).toBe(4);
    });

    it('keeps both admin sweeps to the admin console', async () => {
      // Neither a shopper nor a cashier holds an admin session, so both sweeps
      // refuse at the audience layer rather than the role layer.
      for (const route of [
        '/payment/admin/reverify',
        '/payment/admin/fulfilment/recover',
      ]) {
        expect((await withCookies(app, stranger).post(route)).status).toBe(401);
        expect((await withCookies(app, cashier).post(route)).status).toBe(401);
      }
    });
  });
});
