import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Req,
  ParseIntPipe,
  BadRequestException,
  ForbiddenException,
  Headers,
  HttpCode,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AdminOrdersService } from './admin-orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStatusOrderDto } from './dto/update-status-order.dto';
import {
  AdminOrderActionsQueryDto,
  AdminOrderQueryDto,
} from './dto/admin-order-query.dto';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import UserRoleEnum from '../user/enums/user-role.enum';
import { Roles } from '../auth/decorators/role.decorator';
import { CreatePosOrderDto } from './dto/create-pos-order.dto';
import { ReverseOrderDto } from './dto/reverse-order.dto';
import { OrderMessages } from 'src/common/constants/order.messages';
import {
  assertOwnPosSale,
  toCashierReceiptView,
} from './views/cashier-receipt.view';
import {
  assertPosSaleKeyOwnedBy,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  POS_IDEMPOTENCY_HEADER,
  requirePosIdempotencyKey,
} from './idempotency.helper';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiConflict,
  ApiInvalidInput,
  ApiNotFound,
  ApiPermissionForbidden,
  ApiRoleForbidden,
  ApiErrorEnvelope,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import {
  ConsultsPermissions,
  RequirePermissions,
} from 'src/modules/auth/permissions/permission.decorator';
import { hasPermission } from 'src/modules/auth/permissions/assert-permission';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';
import { AuditService } from 'src/modules/audit/audit.service';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import {
  AdminOrderActionListView,
  AdminOrderActionView,
  AdminOrderAddressView,
  AdminOrderCustomerView,
  AdminOrderDetailView,
  AdminOrderItemView,
  AdminOrderListView,
  AdminOrderPaymentView,
  AdminOrderRowView,
  AdminOrderUserView,
} from './views/admin-order.view';

/**
 * One controller, THREE audiences — so the tag is set per handler rather than
 * on the class: `Checkout` (the customer's own online purchase), `POS` (the
 * in-store till) and `Orders Management` (staff administration of orders that
 * already exist). Grouping them under a single tag hid the fact that a `site`
 * customer may call exactly two of these ten routes.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiExtraModels(
  AdminOrderListView,
  AdminOrderRowView,
  AdminOrderDetailView,
  AdminOrderItemView,
  AdminOrderAddressView,
  AdminOrderCustomerView,
  AdminOrderUserView,
  AdminOrderPaymentView,
  AdminOrderActionListView,
  AdminOrderActionView,
)
@Controller('orders')
@Audiences('admin')
export class OrdersController {
  /**
   * The `DataSource` is here for ONE read: checking that a replayed POS
   * `Idempotency-Key` belongs to the cashier presenting it (see
   * `assertPosSaleKeyOwnedBy`). It cannot live in `OrdersService.createPosOrder`
   * without changing that method's signature, since the check needs the
   * authenticated cashier before the sale payload is hashed. No business logic
   * runs through it and no writes are issued from the controller.
   *
   * `AdminOrdersService` owns every management READ. It is a second service
   * rather than more methods on `OrdersService` so that the projections a screen
   * consumes cannot quietly acquire a write path; see its header.
   */
  constructor(
    private readonly ordersService: OrdersService,
    private readonly adminOrders: AdminOrdersService,
    private readonly audit: AuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Roles(UserRoleEnum.site)
  @ApiOperation({
    summary: 'Quote my basket before placing the order (review step)',
    description:
      'Prices the caller’s ACTIVE basket under the inventory locks and returns a ' +
      '**server-signed quote** plus the exact lines it prices.\n\n' +
      'Show `basket` and `notices` to the customer. When they accept, send ' +
      '`quote.token` to `POST /orders` as `quoteToken`.\n\n' +
      'Writes nothing and holds nothing: stock is held by the four-hour basket ' +
      'reservations, and a quote confers no priority over an in-store sale. It ' +
      'is valid for a bounded period (`quote.expiresAt`) and is bound to this ' +
      'customer, these SKUs, these quantities, these unit prices and this total.',
  })
  @ApiTags('Checkout')
  @ApiOkResponse({
    description:
      'A signed quote plus the exact lines it prices. 200, not 201 — nothing ' +
      'is created.',
    schema: successEnvelopeSchema({
      data: {
        type: 'object',
        properties: {
          quote: {
            type: 'object',
            description:
              'Carries `token` (send it to POST /orders as `quoteToken`) and ' +
              '`expiresAt`.',
          },
          basket: {
            type: 'array',
            items: { type: 'object' },
            description: 'The lines exactly as priced.',
          },
          notices: { type: 'array', items: { type: 'object' } },
        },
      },
    }),
  })
  @ApiInvalidInput('The basket has no ACTIVE lines.')
  @ApiAuthRequired()
  @ApiRoleForbidden('site')
  @ApiNotFound('A variant referenced by a basket line no longer exists.')
  @ApiConflict(
    '`checkout_contents_changed` (nothing purchasable is left — send the ' +
      'customer back to the basket) or `checkout_retry_required` ' +
      '(`retryable: true`; a transient in-request race — re-quote and retry). ' +
      'Both codes appear as `error` and again in `details.code`.',
  )
  @HttpCode(200)
  @Audiences('storefront')
  @Post('quote')
  async quote(@Req() req: UserRequest) {
    return { data: await this.ordersService.quoteCheckout(req.user.sub) };
  }

  @Roles(UserRoleEnum.site)
  @ApiOperation({
    summary: 'Place an order from my basket (online checkout)',
    description:
      'Converts the authenticated customer’s ACTIVE basket lines into an order ' +
      'and turns their basket reservations into order allocations.\n\n' +
      '**`quoteToken` is mandatory in the contract, optional in the DTO.** It is ' +
      'the server-signed quote the customer accepted (from `POST /orders/quote`, ' +
      'or from `details.quote.token` of any 409 this endpoint returns). Omitting ' +
      'it does NOT place an order: it answers 409 `checkout_quote_required` ' +
      'carrying a freshly priced quote to review. The order is placed only if ' +
      'the quote is authentic, unexpired, issued to this customer, and still ' +
      'prices the basket exactly — same SKUs, quantities, unit prices and ' +
      'total, revalidated under the inventory locks.\n\n' +
      'The previous `confirmChanges` and `expectedTotal` fields are GONE and are ' +
      'now rejected by validation. `confirmChanges: true` used to suppress the ' +
      'very changes the server had just detected, including a mismatch with the ' +
      '`expectedTotal` sent in the same request, so the customer was charged ' +
      'whatever the server computed at that instant.\n\n' +
      'An `Idempotency-Key` header is also REQUIRED: a client that times out and ' +
      'retries must not place a second order for the same basket. A refused ' +
      'confirmation rolls the key back, so the SAME key may be reused for the ' +
      'retry; a successful request replays its stored response and allocates ' +
      'stock only once.\n\n' +
      '409 codes — NOT all of them carry a quote:\n' +
      '- `checkout_quote_required` (no quote yet — the ordinary first step): ' +
      'carries `details.quote` + `details.basket`.\n' +
      '- `checkout_quote_invalid` (expired, tampered, or not yours; also a quote ' +
      'that lapsed while the request waited for a variant lock): carries a quote.\n' +
      '- `checkout_quote_stale` (basket changed since the customer accepted): ' +
      'carries a quote plus a `details.changes` was/now diff.\n' +
      '- `checkout_contents_changed` (nothing purchasable left): `quote` is NULL. ' +
      'Send the customer back to the basket.\n' +
      '- `checkout_retry_required` (transient in-request race on an unlocked SKU): ' +
      'no quote, no diff, `retryable: true`. Re-quote and retry.\n\n' +
      'An EMPTY basket is a 400, decided before the quote gate. See ' +
      'docs/CHECKOUT-CONTRACT.md for the full table.\n\n' +
      '`address` must be one of the caller’s own saved addresses; another ' +
      'customer’s address answers 404.',
  })
  @ApiTags('Checkout')
  @ApiHeader({
    name: POS_IDEMPOTENCY_HEADER,
    required: true,
    description:
      'Client-generated, one per checkout attempt, resent verbatim on every ' +
      `retry of that attempt (scope \`online_order\`). ` +
      `${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters ` +
      'from [A-Za-z0-9._:-] — comma and whitespace are excluded, so a header ' +
      'accidentally sent twice (which Node joins with a comma) is rejected ' +
      'rather than silently treated as a third key. A UUIDv4 is the ' +
      'recommended choice.',
    example: '3f2b7c56-9c1f-4a2e-8f0d-6f1c9a5b4d21',
  })
  @ApiCreatedResponse({
    description:
      'Order placed, or the stored response of an earlier identical attempt replayed.',
    schema: successEnvelopeSchema({
      message: OrderMessages.ORDER_CREATED,
      data: { type: 'object', description: 'The created order.' },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400} — note that the removed \`confirmChanges\` and ` +
      '`expectedTotal` fields are now rejected here. Also 400 for an EMPTY ' +
      'basket (decided before the quote gate), a missing/blank ' +
      '`Idempotency-Key` (`IDEMPOTENCY_KEY_REQUIRED`) and a malformed one ' +
      '(`IDEMPOTENCY_KEY_INVALID`).',
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('site')
  @ApiNotFound(
    'The `address` is unknown OR belongs to another customer (both answer ' +
      '404), the calling user no longer exists, or a variant in the basket ' +
      'has disappeared.',
  )
  @ApiConflict(
    'One of seven codes, carried in `error` and in `details.code`. Only the ' +
      'first three carry `details.quote`:\n' +
      '- `checkout_quote_required` — no quote presented yet; the ordinary ' +
      'first step. Carries `details.quote` + `details.basket`.\n' +
      '- `checkout_quote_invalid` — expired, tampered with, or issued to ' +
      'another customer. Carries a fresh quote.\n' +
      '- `checkout_quote_stale` — the basket changed since the customer ' +
      'accepted. Carries a fresh quote plus a `details.changes` was/now diff.\n' +
      '- `checkout_contents_changed` — nothing purchasable is left; `quote` is ' +
      'NULL.\n' +
      '- `checkout_retry_required` — transient in-request race, ' +
      '`retryable: true`.\n' +
      '- `INSUFFICIENT_STOCK` — an accepted basket hold turned out to have no ' +
      'physical stock behind it (reachable after a super-admin stock ' +
      'correction made with `allowBelowReserved`). `details` carries ' +
      '`variantId`, `sku`, `requested`, `available` and `retryable: true`. ' +
      'NO `details.quote` is returned: the basket fingerprint still matches, ' +
      'so re-quoting alone will not help — the client must reduce the line. ' +
      'This replaces a bare 500.\n' +
      '- `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_REQUEST_IN_PROGRESS` — the ' +
      'same key with a different payload, or a concurrent attempt still ' +
      'running. A refused confirmation rolls the key back, so the SAME key may ' +
      'be reused for the retry.',
  )
  @Audiences('storefront')
  @Post()
  async create(
    @Req() req: UserRequest,
    @Body() createOrderDto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const userId = req.user.sub;
    const order = await this.ordersService.create(
      createOrderDto,
      userId,
      idempotencyKey ?? '',
    );
    return { message: OrderMessages.ORDER_CREATED, data: order };
  }

  /**
   * The cashier and the branch come from the verified access token and nowhere
   * else. `cashierId` / `branchId` in the body are ignored.
   *
   * `Idempotency-Key` is REQUIRED. It used to be optional — accepted when
   * present, skipped when absent — which made retry protection something a
   * client could forget its way out of, and clients forget exactly when it
   * matters: a cashier double-tapping "Charge", or a terminal retrying a
   * request that timed out after the server had already committed it. Both rang
   * the sale twice and decremented stock twice. Requiring the header is the
   * only version of this protection that is actually load-bearing.
   *
   * The key is produced by the POS FRONTEND: one value per sale attempt,
   * resent verbatim on every retry of that attempt. It is never entered by a
   * human.
   */
  /*
   * `pos.sell`, not the `sale` ROLE. Behaviour-preserving — both `sale` and
   * `super_admin` hold it — and it states the requirement as the capability
   * it actually is, so the branch check below is the only thing left
   * separating an administrator from a cashier on this route.
   */
  @RequirePermissions('pos.sell')
  @ApiTags('POS')
  @ApiOperation({
    summary: 'Create new POS sale',
    description:
      'Attribution is taken from the access token: `cashierId` and `branchId` in ' +
      'the request body are ignored.\n\n' +
      '**`Idempotency-Key` is required.** The POS application generates the key ' +
      'itself — one per sale attempt, typically a UUIDv4 — and resends the same ' +
      'value on every retry of that attempt. Cashiers never see or type it; do ' +
      'not build a UI that asks a human for it.\n\n' +
      'Behaviour of the key (scope `pos_sale`, so it can never collide with a ' +
      'key used by another feature):\n' +
      '- same key + same payload -> `201` replaying the stored response. One ' +
      'sale, one stock decrement, original cashier and branch preserved.\n' +
      '- same key + different payload -> `409 IDEMPOTENCY_KEY_REUSED`. The ' +
      'first sale is left untouched and no second sale is created.\n' +
      '- same key presented by a different cashier -> ' +
      '`409 IDEMPOTENCY_KEY_FOREIGN_CASHIER`. A replay never re-attributes a ' +
      'sale, and it is never handed to anyone but its original seller.\n' +
      '- N concurrent requests with the same key -> exactly one sale; the ' +
      'others wait on the unique index and replay the winner`s `201`.\n' +
      '- missing / malformed key -> `400`. Nothing is written.',
  })
  @ApiHeader({
    name: POS_IDEMPOTENCY_HEADER,
    required: true,
    description:
      `Client-generated key for this sale attempt (scope \`pos_sale\`). ` +
      `${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters ` +
      'from [A-Za-z0-9._:-]. Recommended: a UUIDv4 generated by the POS ' +
      'client when the cashier opens the sale, reused verbatim across every ' +
      'retry of that same sale attempt, and discarded once the sale succeeds ' +
      'or is abandoned. Generated by the software, never typed by a cashier.',
    example: '3f2b7c56-9c1f-4a2e-8f0d-6f1c9a5b4d21',
  })
  @ApiCreatedResponse({
    description: 'Sale recorded, or an identical earlier attempt replayed.',
    schema: successEnvelopeSchema({
      message: OrderMessages.ORDER_CREATED,
      data: { type: 'object', description: 'The recorded sale.' },
    }),
  })
  @ApiInvalidInput(
    'Missing or malformed `Idempotency-Key` (`IDEMPOTENCY_KEY_REQUIRED` / ' +
      '`IDEMPOTENCY_KEY_INVALID`), an invalid body (empty `items`, a ' +
      'non-positive or non-integer quantity), the cashier has no branch, or ' +
      'the branch row does not exist.',
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('sale or super_admin')
  @ApiNotFound('An unknown `variantId`, or the cashier user no longer exists.')
  @ApiConflict(
    '`IDEMPOTENCY_KEY_REUSED` (same key, different payload), ' +
      '`IDEMPOTENCY_KEY_FOREIGN_CASHIER` (a completed key presented by a ' +
      'different cashier), `IDEMPOTENCY_REQUEST_IN_PROGRESS` (a concurrent ' +
      'attempt holds the key), the cashier is deactivated, or insufficient ' +
      'stock. The stock refusal is `error: "INSUFFICIENT_STOCK"` (repeated in ' +
      '`details.code`) and carries `details.variantId`, `details.sku`, ' +
      '`details.requested`, `details.available` and `details.retryable`, so ' +
      '`body.error ?? body.details?.code` reads uniformly across every ' +
      'checkout and POS conflict.\n\n' +
      '`VARIANT_INACTIVE` — the variant is deactivated, so it may not be sold ' +
      'however many units are physically on the shelf. Decided against the ' +
      'ROW-LOCKED `product_variants.isActive` inside the sale transaction, ' +
      'before the order, its lines, the payment row, the stock decrement, any ' +
      'reservation displacement or any realtime event, so the refusal is ' +
      'atomic: no receipt exists and nothing moved. `details` carries only ' +
      '`variantId`, `sku` and `retryable: false` — retrying cannot help, only ' +
      'reactivation can. The whole transaction rolls back including the ' +
      'idempotency claim, so the SAME key may be reused once the SKU is ' +
      'active again. A multi-line sale containing one inactive variant fails ' +
      'entirely; no other line is charged or decremented.',
  )
  @Audiences('pos')
  @Post('pos')
  async createPosOrder(
    @Req() req: UserRequest,
    @Body() createOrderDto: CreatePosOrderDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ) {
    const branchId = req.user.branch;
    if (branchId === null || branchId === undefined) {
      throw new BadRequestException(OrderMessages.USER_NOT_IN_BRANCH);
    }

    // Validated before anything else touches the database: a request that
    // cannot be made safe must not reach the sale path at all, so a rejected
    // one provably leaves no order and no stock movement behind.
    const idempotencyKey = requirePosIdempotencyKey(idempotencyKeyHeader);

    await assertPosSaleKeyOwnedBy(
      this.dataSource.manager,
      idempotencyKey,
      req.user.sub,
    );

    const order = await this.ordersService.createPosOrder(
      createOrderDto,
      { userId: req.user.sub, branchId },
      idempotencyKey,
    );
    return { message: OrderMessages.ORDER_CREATED, data: order };
  }

  /**
   * MANAGEMENT ORDER LIST — bounded, filtered, projected.
   *
   * THE TWO THINGS THIS REPLACED. The handler was
   * `ordersService.findAll(undefined)`, i.e. `find({ where: {}, relations: {
   * user, address, cashierUser, items: { product } } })`: every order ever
   * placed, each fully hydrated with four relations, in one response. It grew
   * without bound with the table, and it published whole entities — so a LIST an
   * operator opens to scan order numbers carried each customer's postal code and
   * telephone number, and every column `orders` has ever grown,
   * `fulfillmentLastError` included.
   *
   * WHY `@Roles(superAdmin)` IS GONE. Sales history is still the
   * administrator's, but "administrator" is now a CAPABILITY (`orders.read`) and
   * not a role name. Stacking the role decorator on top would mean a custom role
   * granted `orders.read` is still refused by `RolesGuard` — which defeats
   * delegation entirely, and delegation is the point: the previous model's only
   * way to let an employee read orders was to make them a `super_admin`, i.e.
   * give them every capability the system has. A cashier holds no `orders.*`
   * permission (see `permissions/system-roles.ts`) and so is refused exactly as
   * before; they reprint their own sale at `GET /orders/{id}`.
   *
   * Still UNSCOPED by branch: an administrator with no branch of their own must
   * not be refused for lacking a branch they are not being scoped to.
   */
  @RequirePermissions('orders.read')
  @ApiTags('Orders Management')
  @ApiOperation({
    summary: 'List orders (management)',
    description:
      'One PAGE of orders, newest sale first, with server-side filters. Rows ' +
      'are `AdminOrderRowView` — a projection, never the order entity — and ' +
      'carry minimal customer identity only: the address, postal code and full ' +
      'telephone number are on `GET /orders/{id}`, which an operator has to ' +
      'open one order at a time.\n\n' +
      'ORDERING is `soldAt DESC, id DESC`. The unique tiebreaker is ' +
      'load-bearing: `soldAt` collides, and without it two pages of the same ' +
      'result set can repeat one row and skip another.\n\n' +
      '`from`/`to` are INCLUSIVE LOCAL CALENDAR DAYS in `REPORT_TIMEZONE` ' +
      '(default Asia/Tehran), not instants — the same half-open window ' +
      '`/reports/sales` uses, converted to UTC by PostgreSQL with the zone’s ' +
      'own rules for that date. `dateField` chooses the axis: `sold` (default), ' +
      '`paid` (the revenue axis; excludes unpaid orders) or `created`.\n\n' +
      '`paymentState` is DERIVED from the order’s `payment` rows in one ' +
      'aggregate, precedence success > refunded > pending > failed > none.\n\n' +
      'A cashier has no sales-history route. A customer reads their own orders ' +
      'at `GET /me/orders`.',
  })
  @ApiOkResponse({
    description:
      'One page of orders. The paginated object is spread NEXT TO the ' +
      'envelope, so the rows are at `data` and `total` / `page` / `limit` / ' +
      '`totalPages` sit beside it at the top level.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: { $ref: getSchemaPath(AdminOrderRowView) },
      },
      properties: {
        total: { type: 'integer', example: 412 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 10 },
        totalPages: { type: 'integer', example: 42 },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('orders.read')
  @Get()
  async findAll(@Query() query: AdminOrderQueryDto) {
    return this.adminOrders.list(query);
  }

  /**
   * ONE ORDER. TWO DIFFERENT PRINCIPALS, TWO DIFFERENT RESPONSE SHAPES, ONE
   * PATH — AND THAT IS WHY THIS ROUTE SPLITS AUTHORISATION IN THE HANDLER.
   *
   * Every other management route declares `@RequirePermissions(...)` and lets
   * the global `PermissionsGuard` answer. This one cannot, because a decorator
   * decides ONE answer for the whole route and there are genuinely two callers
   * here:
   *
   *   - the ADMINISTRATOR (any principal holding `orders.read`, delegated or
   *     not) reads the full management record, any branch;
   *   - the TILL OPERATOR reads a RECEIPT PROJECTION of a sale they themselves
   *     rang up. `sale` deliberately holds no `orders.*` permission at all —
   *     granting it would hand every cashier every customer's address and
   *     telephone number — so a `@RequirePermissions('orders.read')` here would
   *     take the cashier's own receipt away, which is a POS regression, and a
   *     `@RequirePermissions('pos.receipt.read_own')` would take the
   *     administrator's record away.
   *
   * So the route declares NO role and NO static permission, and the handler
   * picks the branch by CAPABILITY: `orders.read` gets the management record,
   * `pos.receipt.read_own` gets the till receipt, and a caller holding neither
   * is refused with the same PERMISSION_DENIED shape `PermissionsGuard` would
   * have thrown.
   *
   * This USED to keep `@Roles(superAdmin, sale)` as a coarse gate, and the
   * comment here used to describe that as a known limitation — a delegated
   * custom role holding `orders.read` could list orders and then be refused by
   * `RolesGuard` when it tried to open one. That decorator is gone; both
   * branches are expressed as capabilities, and the limitation with it.
   *
   * The permission is read only to SHAPE the response and to decide which of the
   * two contracts the caller is asking for — the refusals below and the guards
   * above are what authorise.
   *
   * A `sale` cashier reads ONLY the sale they themselves rang up — POS channel,
   * `cashierUserId` equal to their own user id, and in their own branch — and
   * gets a RECEIPT PROJECTION rather than the order entity. Branch scoping
   * alone was not enough: cashiers 1 and 2 share Sanandaj, so a branch check
   * let each read the other's sale.
   *
   * NON-ENUMERATION. For a cashier, every refusal is a 404, whether the order
   * is absent, another cashier's, another branch's, or an online customer's.
   * A cashier must not be able to tell "does not exist" from "not yours" by
   * walking ids — which the previous deliberate 403 allowed. `super_admin`
   * keeps the management semantics: 404 means genuinely absent.
   */
  @ApiTags('Orders Management')
  @ApiOperation({
    summary:
      "Get one order by id (management record, or a cashier's own receipt)",
    description:
      'A caller holding `orders.read` gets `AdminOrderDetailView`: the list ' +
      'row plus line items, the FROZEN delivery-address snapshot, the customer ' +
      'and account identities, every receipt (never the gateway session id), ' +
      'the fulfilment retry queue, the reconciliation case, and what this ' +
      'caller may actually DO to the order — `allowedStatusTransitions`, ' +
      '`canVoid`, `canReturn`, computed from the same conditions the mutation ' +
      'endpoints enforce, so the console never offers a refused action.\n\n' +
      "`sale`: only an order this cashier sold at this cashier's branch, and " +
      'only the fields a receipt needs — no customer, address, payment, ' +
      'fulfilment or reconciliation data. Every other id answers 404, so ids ' +
      'cannot be walked to discover which sales exist.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id`.',
    example: 41,
  })
  @ApiOkResponse({
    description:
      'The management record (`AdminOrderDetailView`) or, for a till operator, ' +
      'the receipt projection of their own sale.',
    schema: successEnvelopeSchema({
      data: { $ref: getSchemaPath(AdminOrderDetailView) },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The caller holds neither `orders.read` (the management record) nor ' +
      '`pos.receipt.read_own` (their own till receipt). `error` is ' +
      '`PERMISSION_DENIED` and `details.missingPermissions` names what is ' +
      'absent.',
  )
  @ApiNotFound(
    'No order has that id — or, for a `sale` caller, the order is not one ' +
      'they sold. The two are deliberately indistinguishable.',
  )
  @Audiences('admin', 'pos')
  /*
   * TWO CONTRACTS, ONE URL. `orders.read` gets the administrator's full order
   * record; `pos.receipt.read_own` gets the cashier's receipt for a sale they
   * themselves rang up; holding neither is a refusal in the same shape the
   * guard produces. A decorator cannot express that, so the codes are declared
   * here and decided below — and the branching now goes through the typed
   * `hasPermission` helper rather than `permissions.includes('...')`, so a
   * mistyped code is a compile error rather than a branch that never runs.
   */
  @ConsultsPermissions('orders.read', 'pos.receipt.read_own')
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: UserRequest,
  ) {
    // The capability decides WHICH contract is being asked for. `permissions`
    // is written by `JwtStrategy` from the database row read on this request,
    // so it is not something a caller can present.
    if (hasPermission(req, 'orders.read')) {
      return {
        data: await this.adminOrders.findDetail(id, req.user.permissions),
      };
    }

    /**
     * The till operator's own receipt. UNCHANGED behaviour:
     * `assertOwnPosSale` answers 404 for absent, another cashier's, another
     * branch's and an online customer's order alike, so ids cannot be walked.
     *
     * GATED ON `pos.receipt.read_own`, NOT ON THE `sale` ROLE. The role
     * decorator used to sit on this route, and it was the one place a
     * delegated order manager — a custom role holding `admin.access` and
     * `orders.read` but neither built-in role — was still refused, so they
     * could list orders and not open one. Both branches now test a capability,
     * which is the same thing the rest of the API does and removes the last
     * role-name dependency from this controller.
     */
    if (hasPermission(req, 'pos.receipt.read_own')) {
      const order = await this.ordersService.findOne(id);
      assertOwnPosSale(order, req.user);
      return { data: toCashierReceiptView(order) };
    }

    /**
     * Neither contract is available to this caller. The body is the same one
     * `PermissionsGuard` produces, so a console reads one refusal format for
     * the whole admin API. `orders.read` is named as the requirement because
     * it is the one an administrator would actually be missing; a POS caller
     * without `pos.receipt.read_own` cannot have opened a POS session at all.
     */
    throw new ForbiddenException({
      error: AuthErrorCodes.PERMISSION_DENIED,
      message: AuthMessages.PERMISSION_DENIED,
      requiredPermissions: ['orders.read'],
      missingPermissions: ['orders.read'],
    });
  }

  /**
   * AUDIT TRAIL — `orders.actions.read`.
   *
   * Every void, return and status change, each naming the staff member who
   * performed it. That is management history: it tells a reader who reversed
   * whose sale, which is exactly the cross-staff visibility the owner closed for
   * cashiers. A cashier's own receipt does not need it, and nothing in the POS
   * reads it — `sale` holds no `orders.*` permission, so it is refused here as
   * it was under the role check this replaces.
   *
   * PAGINATED, where it used to return every row an order had. An order's
   * history is append-only and grows with every correction, so an unbounded
   * response is a response whose size is decided by how much trouble that order
   * has been.
   */
  @RequirePermissions('orders.actions.read')
  @ApiTags('Orders Management')
  @ApiOperation({
    summary: 'Append-only audit trail of an order (management)',
    description:
      'Every void / return / status change with its own actor and timestamp, ' +
      'OLDEST FIRST — this is a narrative, so page 1 is the beginning. The ' +
      'original seller stays on the order itself and is never overwritten by a ' +
      'later reversal.\n\n' +
      'Default page size 50, capped at 100.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id`.',
    example: 41,
  })
  @ApiOkResponse({
    description:
      'One page of the audit trail, oldest first. An order with no recorded ' +
      'action answers an EMPTY array, not a 404.',
    schema: successEnvelopeSchema({
      data: { $ref: getSchemaPath(AdminOrderActionListView) },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('orders.actions.read')
  @ApiNotFound('No order has that id.')
  @Get(':id/actions')
  async findActions(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: AdminOrderActionsQueryDto,
  ) {
    // Existence is still confirmed first, so an unknown id is a 404 rather
    // than an empty page that looks like "this order has no history".
    await this.ordersService.findOne(id);
    return {
      data: await this.adminOrders.findActions(
        id,
        query.page ?? 1,
        query.limit ?? 50,
      ),
    };
  }

  /**
   * MANAGEMENT MUTATIONS — one capability each.
   *
   * Status change, void and return used to accept `sale` behind a branch check,
   * which meant a cashier could VOID a colleague's sale in their own branch — a
   * stronger power than the reads the owner closed. The POS offers none of these
   * operations and no client calls them; reversing a sale is a supervisor's
   * decision.
   *
   * They are now three SEPARATE permissions rather than one role, because they
   * are three different amounts of authority: advancing a status moves neither
   * money nor stock, while a void and a return each restore stock and change
   * what the reports say. A delegated role can be given the first without the
   * other two — which is the entire reason `@Roles(superAdmin)` is gone rather
   * than stacked on top; stacking it would refuse every custom role regardless
   * of what it was granted.
   *
   * EACH ONE ALSO WRITES AN ADMIN AUDIT ROW. `order_actions` already records the
   * change against the ORDER; `admin_audit_log` records it against the PERSON,
   * which is what the access-control screen reads when somebody asks what a
   * delegated role has actually been doing. Both are needed: one answers "what
   * happened to this order", the other "what has this operator done".
   */
  @RequirePermissions('orders.status.update')
  @ApiTags('Orders Management')
  @ApiOperation({
    summary: 'Update status of one order by id',
    description:
      'Enforces the order status state machine. Transitions to `canceled` / ' +
      '`refunded` must go through /void and /return so stock is restored.\n\n' +
      '**A PAID ORDER CANNOT BE ADVANCED UNTIL ITS GOODS ARE ALLOCATED.** ' +
      '`paid -> processing | shipped | delivered` is refused with **409 ' +
      '`ORDER_FULFILMENT_INCOMPLETE`** unless `fulfillmentState` is ' +
      '`fulfilled` or `not_required`. Both the fulfilment claim and the ' +
      "recovery sweep select `status = 'paid'`, so advancing such an order " +
      'would evict it from phase 2 permanently — money taken, goods never ' +
      'consumed. The refusal writes NOTHING: the order keeps its status, its ' +
      '`fulfillmentState` and its place in the recovery queue, so a later ' +
      'recovery pass (or an operator retry from ' +
      '`/payment/admin/reconciliation`) can still complete it and the same ' +
      'status change then succeeds.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id`.',
    example: 41,
  })
  @ApiOkResponse({
    description:
      'Status updated. Setting the status it already has is a no-op, not an ' +
      'error — and it writes no `order_actions` row and no admin audit row, ' +
      'because nothing happened.',
    schema: successEnvelopeSchema({
      message: OrderMessages.ORDER_STATUS_UPDATED,
      data: { $ref: getSchemaPath(AdminOrderRowView) },
    }),
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 when the ` +
      'transition is not allowed by the state machine, and when the target is ' +
      '`canceled` or `refunded` — those must go through /void and /return so ' +
      'stock is restored.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('orders.status.update')
  @ApiNotFound('No order has that id, or the acting user no longer exists.')
  @ApiConflict(
    'The order is frozen because it has already been voided, **or** the order ' +
      'is `paid` with `fulfillmentState` still `pending` / `awaiting_stock` ' +
      'and the requested status is `processing` / `shipped` / `delivered`. ' +
      'The second case answers `error: "ORDER_FULFILMENT_INCOMPLETE"` with ' +
      '`details: { orderId, status, fulfillmentState, requestedStatus, ' +
      'reconciliationQueue }`. Nothing is written; retry after the order is ' +
      'fulfilled.',
  )
  @Patch('/status/:id')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateStatusOrderDto: UpdateStatusOrderDto,
    @Req() req: UserRequest,
  ) {
    // Existence first: an unknown id must 404 before any mutation is tried.
    // This read doubles as the BEFORE state of the audit row. No branch gate —
    // an administrator is deliberately not scoped to a branch.
    const before = await this.ordersService.findOne(id);
    await this.ordersService.updateStatus(id, updateStatusOrderDto, {
      userId: req.user.sub,
      branchId: req.user.branch,
    });
    const after = await this.adminOrders.findRow(id);

    /**
     * AUDITED BY DIFF, NOT BY CALL.
     *
     * `updateStatus` short-circuits with `if (order.status === next) return
     * order` — it writes no `order_actions` row for that, because nothing
     * happened. An admin audit row written unconditionally would therefore claim
     * a status change that the order's own history denies, and the two ledgers
     * would disagree about the same instant. Comparing before with after is
     * the only detection that cannot drift from the service's own decision.
     */
    if (
      before.status !== after.status ||
      before.fulfillmentState !== after.fulfillmentState
    ) {
      await this.recordOrderAudit(req, AuditAction.ORDER_STATUS_CHANGED, {
        before,
        after,
        reason: null,
      });
    }

    return { message: OrderMessages.ORDER_STATUS_UPDATED, data: after };
  }

  @RequirePermissions('orders.void')
  @ApiTags('Orders Management')
  @ApiOperation({
    summary: 'Void a sale',
    description:
      'Reverses a sale that should not have happened: stock is restored, ' +
      '`voidedAt` is stamped and an `order_actions` row records who did it. ' +
      'The original cashier is unchanged.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id`.',
    example: 41,
  })
  @ApiOkResponse({
    description: 'Sale voided and stock restored. 200, not 201.',
    schema: successEnvelopeSchema({
      message: OrderMessages.ORDER_VOIDED,
      data: { $ref: getSchemaPath(AdminOrderRowView) },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('orders.void')
  @ApiNotFound(
    'No order has that id, the order has no line rows, or the acting user no ' +
      'longer exists.',
  )
  @ApiConflict(
    'The order is already voided, or it is `refunded` and can no longer be ' +
      'voided. Also returned when restoring stock hits an inventory ' +
      'constraint.',
  )
  @HttpCode(200)
  @Post(':id/void')
  async voidOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReverseOrderDto,
    @Req() req: UserRequest,
  ) {
    // Existence first: an unknown id must 404 before any mutation is tried,
    // and this read is the BEFORE state of the audit row.
    const before = await this.ordersService.findOne(id);
    await this.ordersService.voidOrder(
      id,
      { userId: req.user.sub, branchId: req.user.branch },
      dto,
    );
    const after = await this.adminOrders.findRow(id);

    await this.recordOrderAudit(req, AuditAction.ORDER_VOIDED, {
      before,
      after,
      reason: dto.reason ?? null,
    });

    return { message: OrderMessages.ORDER_VOIDED, data: after };
  }

  @RequirePermissions('orders.return')
  @ApiTags('Orders Management')
  @ApiOperation({
    summary: 'Return a sale',
    description:
      'Customer brought the goods back: stock is restored, the order becomes ' +
      '`refunded` and an `order_actions` row records who did it.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id`.',
    example: 41,
  })
  @ApiOkResponse({
    description: 'Sale returned and stock restored. 200, not 201.',
    schema: successEnvelopeSchema({
      message: OrderMessages.ORDER_RETURNED,
      data: { $ref: getSchemaPath(AdminOrderRowView) },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('orders.return')
  @ApiNotFound(
    'No order has that id, the order has no line rows, or the acting user no ' +
      'longer exists.',
  )
  @ApiConflict(
    'The order is already voided, already returned, or its status is not one ' +
      'of paid / processing / shipped / delivered. Also returned when ' +
      'restoring stock hits an inventory constraint.',
  )
  @HttpCode(200)
  @Post(':id/return')
  async returnOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReverseOrderDto,
    @Req() req: UserRequest,
  ) {
    // Existence first: an unknown id must 404 before any mutation is tried,
    // and this read is the BEFORE state of the audit row.
    const before = await this.ordersService.findOne(id);
    await this.ordersService.returnOrder(
      id,
      { userId: req.user.sub, branchId: req.user.branch },
      dto,
    );
    const after = await this.adminOrders.findRow(id);

    await this.recordOrderAudit(req, AuditAction.ORDER_RETURNED, {
      before,
      after,
      reason: dto.reason ?? null,
    });

    return { message: OrderMessages.ORDER_RETURNED, data: after };
  }

  /**
   * ==========================================================================
   * WHY THE ORDER AUDIT ROW IS WRITTEN *AFTER* THE FACT, AND DETACHED
   * ==========================================================================
   *
   * The convention is to pass the caller's `EntityManager` to
   * `AuditService.record` so the audit row commits with the change it
   * describes. THAT IS NOT AVAILABLE HERE. `OrdersService.updateStatus` and
   * `reverseOrder` each open and own their own `dataSource.transaction` — they
   * have to, because the reversal's stock restore, payment ledger update and
   * `order_actions` insert must be atomic with the status change — and neither
   * exposes that manager or accepts one. Threading a manager out through them
   * would mean editing the transactional core of the void/return path, which is
   * verified behaviour this work is explicitly not allowed to disturb.
   *
   * So the row is written after the commit, with `recordDetached`, which logs
   * and swallows a failed audit write instead of throwing. That choice is the
   * right way round for an act that has ALREADY happened: the stock is back, the
   * money ledger is updated and `order_actions` has recorded it against the
   * order. Throwing here would fail a request whose work is committed and
   * irreversible, telling the operator it did not happen. The order's own
   * append-only history is the durable record either way; `admin_audit_log` is
   * the cross-cutting view of what a PERSON did, and a gap in it is logged
   * loudly rather than silently.
   *
   * The summary is an explicit ALLOW-LIST of four scalars. No request body, no
   * customer identity, no money.
   */
  private async recordOrderAudit(
    req: UserRequest,
    action:
      | typeof AuditAction.ORDER_STATUS_CHANGED
      | typeof AuditAction.ORDER_VOIDED
      | typeof AuditAction.ORDER_RETURNED,
    change: {
      before: { status: string; fulfillmentState: string };
      after: AdminOrderRowView;
      reason: string | null;
    },
  ): Promise<void> {
    await this.audit.recordDetached({
      actor: auditActorFrom(req),
      action,
      targetType: AuditTarget.ORDER,
      targetId: change.after.id,
      // The human-facing sale number, frozen into the row: it is what an
      // operator quotes, and it stays readable if the order is later deleted.
      targetLabel: change.after.orderNumber,
      summary: {
        before: {
          status: change.before.status,
          fulfillmentState: change.before.fulfillmentState,
        },
        after: {
          status: change.after.status,
          fulfillmentState: change.after.fulfillmentState,
        },
        reason: change.reason,
      },
    });
  }
}
