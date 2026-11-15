import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { PaymentMessages } from 'src/common/constants/payment.messages';
import { ReconciliationMessages } from 'src/common/constants/reconciliation.messages';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { FulfilmentRecoveryService } from './fulfilment-recovery.service';
import { PaymentReverificationService } from './payment-reverification.service';
import { PaymentService } from './payment.service';
import { requireIdempotencyKey } from '../orders/idempotency.helper';
import {
  ConfirmExternalRefundDto,
  MarkBackorderDto,
  MarkRefundRequiredDto,
  ResolveReconciliationDto,
  RetryFulfilmentDto,
} from './dto/reconciliation-action.dto';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import {
  ReconciliationCaseDetailView,
  ReconciliationQueueView,
} from './dto/reconciliation.view';
import { ReconciliationService } from './reconciliation.service';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiPermissionForbidden,
  ApiConflict,
  ApiErrorEnvelope,
  ApiInvalidInput,
  ApiNotFound,
  ApiRoleForbidden,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';

/**
 * Every reconciliation mutation takes the same mandatory `Idempotency-Key`.
 * Declared once so the six routes cannot drift into documenting it differently.
 */
const RECONCILIATION_IDEMPOTENCY_HEADER_DESCRIPTION =
  'REQUIRED. One client-generated key (a UUIDv4) per DECISION, resent verbatim ' +
  'on every retry of that decision, so a double-click or a timed-out retry ' +
  'cannot record the decision — or move the money — twice. An identical retry ' +
  'replays the stored response; the same key with a DIFFERENT body is 409 ' +
  '`IDEMPOTENCY_KEY_REUSED`. Operators never type this value.';

const RECONCILIATION_ACTION_400 =
  `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 when the ` +
  '`Idempotency-Key` header is missing (`IDEMPOTENCY_KEY_REQUIRED`) or ' +
  'malformed (`IDEMPOTENCY_KEY_INVALID`), and when `reason` is shorter than 4 ' +
  'characters — the reason is the only record of WHY a manual decision was ' +
  'taken and is written to the append-only audit trail.';

/** The shape every mutation answers with. */
const RECONCILIATION_ACTION_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    orderId: { type: 'integer' },
    action: { type: 'string' },
    actionId: {
      type: 'integer',
      description: 'The append-only `payment_actions` row just written.',
    },
    orderStatus: { type: 'string' },
    fulfillmentState: { type: 'string' },
    reconciliationState: { type: 'string', nullable: true },
    fulfilled: {
      type: 'boolean',
      description: 'RETRY ONLY. Whether THIS call consumed the stock.',
    },
    blocked: {
      type: 'string',
      nullable: true,
      description:
        'RETRY ONLY. Non-null when fulfilment was REFUSED because no receipt ' +
        'authorizes consuming stock. Never render such an order as progressing.',
    },
    stockRestored: {
      type: 'boolean',
      description:
        'REFUND CONFIRMATION ONLY. False when the order never consumed stock ' +
        '— there is nothing to restore and nothing is invented.',
    },
    message: { type: 'string' },
  },
};

/** Mandatory on every reconciliation mutation. Operator-facing wording. */
function requireReconciliationKey(raw: string | undefined): string {
  return requireIdempotencyKey(raw, {
    missing: ReconciliationMessages.IDEMPOTENCY_KEY_REQUIRED,
    invalid: ReconciliationMessages.IDEMPOTENCY_KEY_INVALID,
  });
}

/**
 * `start` and `verify` carry no capability requirement, so any authenticated
 * caller on a surface the route serves may REACH
 * them — but neither acts on an order the caller does not own:
 *
 *  - `start`  refuses somebody else's order with 400
 *    (`PaymentService.Start`, under `FOR UPDATE` on the order row).
 *  - `verify` refuses somebody else's payment attempt with a NON-ENUMERATING
 *    404 (`PaymentService.verifyForCaller`). `super_admin` is exempt, on
 *    purpose and by policy — see that method.
 *
 * Ownership comes from `req.user.sub` (the access-token identity that
 * `JwtStrategy` resolved against the database) in both cases. NO handler here
 * reads an identity out of a request body. The two `admin/*` sweeps are
 * `super_admin`.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Payment Management')
@Controller('payment')
@Audiences('storefront')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly recoveryService: FulfilmentRecoveryService,
    private readonly reverificationService: PaymentReverificationService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  @ApiOperation({
    summary: 'Start a new payment',
    description:
      'Opens (or re-uses) a gateway session for an order the CALLER owns and ' +
      'returns the `paymentUrl` to redirect the customer to. Ownership is ' +
      'taken from the access token; note that paying somebody else’s order is ' +
      'refused with **400**, not 403. `reused: true` means an existing ' +
      'in-flight session was handed back rather than a new one opened.',
  })
  @ApiCreatedResponse({
    description: 'A gateway session to redirect the customer to.',
    schema: successEnvelopeSchema({
      message: PaymentMessages.PAYMENT_STARTED,
      data: {
        type: 'object',
        properties: {
          paymentId: { type: 'integer' },
          orderId: { type: 'integer' },
          trackId: { type: 'string' },
          amount: { type: 'integer', description: 'Integer Rial.' },
          paymentUrl: { type: 'string' },
          reused: { type: 'boolean' },
        },
      },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 when the order belongs to another user ` +
      '(NOT 403), when its status is not `pending`, when too many attempts ' +
      'are already pending, when a concurrent attempt is still in flight, and ' +
      'when the gateway is unreachable (`GATEWAY_UNAVAILABLE` — the underlying ' +
      '502 is deliberately downgraded here).',
  )
  @ApiAuthRequired()
  @ApiNotFound('No order has that id.')
  // The customer pays from the shop; the administrator may re-verify any
  // attempt (documented super_admin policy). Both audiences, declared.
  @Audiences('storefront', 'admin')
  @Post('start')
  async Start(
    @Req() req: UserRequest,
    @Body() createPayment: CreatePaymentDto,
  ) {
    const userId = req.user.sub;
    const result = await this.paymentService.Start(
      createPayment.orderId,
      userId,
    );
    // paymentUrl comes from the gateway implementation, not from a literal.
    return { message: PaymentMessages.PAYMENT_STARTED, data: result };
  }

  @ApiOperation({
    summary: 'Verify payment (owner or super_admin only)',
    description:
      'Re-asks the gateway about a `trackId` and, on success, applies the ' +
      'receipt. Call it from the gateway callback/return page.\n\n' +
      '**OWNER-SCOPED.** The caller must own the order behind the attempt ' +
      '(`orders.userId` = the access-token identity). A `super_admin` may ' +
      'verify any attempt; `sale` gets no exemption. Ownership is taken from ' +
      'the `access_token` cookie only — there is no `userId` body field, and ' +
      'sending one is rejected with 400 by the whitelisting `ValidationPipe`.\n\n' +
      '**A trackId you may not verify answers 404, and so does a trackId that ' +
      'does not exist — byte for byte the same body.** This is deliberate: a ' +
      'distinguishable pair would let anyone probe for other customers’ ' +
      'payment attempts. NOTE THE CONTRACT CHANGE: an unknown `trackId` used ' +
      'to answer **400**; it now answers **404** so that the two cases cannot ' +
      'be told apart.\n\n' +
      'A verification that succeeds but could NOT be applied does not throw: ' +
      'it answers 200/201 with `applied: false` plus ' +
      '`requiresReconciliation` and `reconciliationReason`. Read those before ' +
      'telling a customer the order is paid.',
  })
  @ApiCreatedResponse({
    description:
      'The gateway’s answer, whether or not it could be applied to the order.',
    schema: successEnvelopeSchema({
      data: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          alreadyProcessed: { type: 'boolean' },
          applied: { type: 'boolean' },
          paymentStatus: { type: 'string' },
          requiresReconciliation: { type: 'boolean' },
          reconciliationReason: { type: 'string', nullable: true },
          trackId: { type: 'string' },
          orderId: { type: 'integer' },
          orderStatus: { type: 'string' },
          fulfillmentState: { type: 'string' },
          expectedAmount: { type: 'integer' },
          gatewayAmount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400} — including a \`userId\` (or any other extra key) ` +
      'in the body, which is refused rather than ignored. Also 400 when the ' +
      'gateway reports the payment as not successful. A missing/foreign ' +
      '`trackId` is NO LONGER 400; see the 404.',
  )
  @ApiAuthRequired()
  @ApiNotFound(
    'The ONE answer for every attempt this caller may not verify: no payment ' +
      'attempt matches the `trackId`, the attempt belongs to another ' +
      'customer, or the order behind it no longer exists. All three return the ' +
      'same status, the same `message` (`Payment not found`) and the same ' +
      '`error` (`PAYMENT_ATTEMPT_NOT_FOUND`), so the response cannot be used ' +
      'to discover whether a guessed `trackId` exists. A `super_admin` sees ' +
      'this only for a `trackId` that really does not exist.',
  )
  @ApiErrorEnvelope(
    502,
    'The gateway answered with a non-2xx status, or the call timed out.',
  )
  // The customer pays from the shop; the administrator may re-verify any
  // attempt (documented super_admin policy). Both audiences, declared.
  @Audiences('storefront', 'admin')
  @Post('verify')
  async verify(
    @Req() req: UserRequest,
    @Body() verifyPaymentDto: VerifyPaymentDto,
  ) {
    // `req.user` is the access-token identity JwtStrategy resolved against the
    // database. The body contributes the trackId and nothing else — an
    // ownership decision derived from a body field would be no decision at all.
    const result = await this.paymentService.verifyForCaller(
      verifyPaymentDto.trackId,
      { userId: req.user.sub, roles: req.user.roles },
    );
    return { message: result.message, data: result };
  }

  /**
   * Manual, deterministic trigger for phase-2 crash recovery.
   *
   * The background timer already re-drives PAID orders stuck in
   * PENDING/AWAITING_STOCK, but an operator needs to be able to force a pass
   * after restocking, and the test suite needs to invoke recovery at an exact
   * point instead of racing a timer.
   */
  @ApiOperation({
    summary: 'Re-drive fulfilment for recoverable paid orders',
    description:
      'Manual trigger for phase-2 crash recovery: re-drives PAID orders stuck ' +
      'in PENDING/AWAITING_STOCK. Never throws for a single bad order — ' +
      'failures are counted in `data.failed` and recorded on the order. A ' +
      'call made while a sweep is already running returns an empty report.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description:
      'Maximum orders to scan. A non-numeric or non-positive value is ignored ' +
      'and the service default is used.',
    example: 50,
  })
  @ApiOkResponse({
    description: 'The recovery report. 200, not 201.',
    schema: successEnvelopeSchema({
      message: PaymentMessages.RECOVERY_TRIGGERED,
      data: {
        type: 'object',
        properties: {
          scanned: { type: 'integer' },
          fulfilled: { type: 'integer' },
          awaitingStock: { type: 'integer' },
          skipped: { type: 'integer' },
          failed: { type: 'integer' },
          blocked: { type: 'integer' },
          blockedOrderIds: { type: 'array', items: { type: 'integer' } },
          orderIds: { type: 'array', items: { type: 'integer' } },
          attempts: { type: 'integer' },
          overdue: { type: 'integer' },
        },
      },
    }),
  })
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @RequirePermissions('reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/fulfilment/recover')
  async recover(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? undefined : Number(limit);
    const report = await this.recoveryService.recover(
      Number.isFinite(parsed) && parsed! > 0 ? parsed : undefined,
    );
    return { message: PaymentMessages.RECOVERY_TRIGGERED, data: report };
  }

  /**
   * Manual trigger for the payment re-verification sweep.
   *
   * This is the ONLY path that can discover a receipt the gateway confirmed but
   * that was never recorded here (lost callback, crash between confirmation and
   * phase 1). It re-asks the gateway about unfinished attempts that still have
   * a `track_id`; read the precise limits of what it can and cannot recover in
   * payment-reverification.service.ts. It never moves money.
   */
  @ApiOperation({
    summary: 'Re-ask the gateway about unfinished payment attempts',
    description:
      'The ONLY path that can discover a receipt the gateway confirmed but ' +
      'that was never recorded here (lost callback, or a crash between ' +
      'confirmation and phase 1). It never moves money and never throws for a ' +
      'single attempt: a refusal is counted in `data.notPaid`, anything else ' +
      'in `data.errored`.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description:
      'Maximum attempts to re-ask about. A non-numeric or non-positive value ' +
      'is ignored and the service default is used.',
    example: 50,
  })
  @ApiOkResponse({
    description: 'The re-verification report. 200, not 201.',
    schema: successEnvelopeSchema({
      message: PaymentMessages.RECOVERY_TRIGGERED,
      data: {
        type: 'object',
        properties: {
          scanned: { type: 'integer' },
          recovered: { type: 'integer' },
          unapplied: { type: 'integer' },
          amountUnverified: { type: 'integer' },
          notPaid: { type: 'integer' },
          errored: { type: 'integer' },
          paymentIds: { type: 'array', items: { type: 'integer' } },
        },
      },
    }),
  })
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @RequirePermissions('reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/reverify')
  async reverify(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? undefined : Number(limit);
    const report = await this.reverificationService.sweep(
      Number.isFinite(parsed) && parsed! > 0 ? parsed : undefined,
    );
    return { message: PaymentMessages.RECOVERY_TRIGGERED, data: report };
  }

  // =========================================================================
  // MANUAL RECONCILIATION QUEUE  --  owner decision D-2
  //
  // Every route below is `super_admin`. `sale` and `site` get 403 from the
  // global RolesGuard, which is the correct answer: these endpoints expose one
  // customer's money and can move it.
  //
  // Every MUTATION additionally requires an `Idempotency-Key` header, validates
  // its allowed source states under a row lock, answers a stable 409 on
  // conflict, replays a retry verbatim, writes one append-only
  // `payment_actions` row, and emits only SCOPED realtime.
  //
  // THE CASE ID IS THE ORDER ID. A reconciliation case is a decision about one
  // order, and an order can carry several receipts that belong to the same
  // case (a duplicate confirmation is the archetype), so there is deliberately
  // no separate case identifier to keep in sync.
  // =========================================================================

  @ApiOperation({
    summary: 'Reconciliation queue (super_admin)',
    description:
      'Every order that needs a human, newest money first. An order is a case ' +
      'when ANY of these holds, computed from COMMITTED ROWS rather than from ' +
      'a stored flag:\n\n' +
      '1. it has a gateway-confirmed receipt nobody has closed ' +
      '(`requires_reconciliation` and `reconciled_at IS NULL`) — ' +
      '`unapplied_receipt`;\n' +
      '2. it is `paid` and its goods were never allocated — ' +
      '`fulfilment_incomplete` (`fulfillmentState: pending`) or ' +
      '`awaiting_stock`;\n' +
      '3. an operator decision on it is not closed out — `operator_open`.\n\n' +
      'A case can carry several of these at once and `caseTypes` lists them ' +
      'all. **The default is EVERYTHING, resolved cases included** — an ' +
      'unresolved discrepancy must not be able to disappear behind a default ' +
      'filter — so narrow explicitly with `resolved=false`.\n\n' +
      '`fulfilmentAuthorized` is the exact predicate the fulfilment claim ' +
      'evaluates: `false` on a paid, unfulfilled order means no receipt ' +
      'authorizes shipping it, which is the population this queue exists for. ' +
      'ALL MONEY IS RETURNED AS STRINGS of integer Rial — these are `bigint` ' +
      'columns and rounding them through a JavaScript `Number` is silent data ' +
      'loss. `money.confirmedHeld` and `money.refundedTotal` are disjoint ' +
      'buckets, so nothing is counted twice.\n\n' +
      'The response is a bounded view model; no TypeORM entity is serialized ' +
      'and the gateway session id (`track_id`) is never exposed.',
  })
  @ApiOkResponse({
    description: 'One page of cases. 200.',
    schema: successEnvelopeSchema({
      data: { $ref: getSchemaPath(ReconciliationQueueView) },
    }),
  })
  @ApiExtraModels(ReconciliationQueueView, ReconciliationCaseDetailView)
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @RequirePermissions('reconciliation.read')
  @Audiences('admin')
  @Get('admin/reconciliation')
  async reconciliationQueue(@Query() query: ReconciliationQueryDto) {
    return {
      message: ReconciliationMessages.QUEUE_READ,
      data: await this.reconciliationService.listQueue(query),
    };
  }

  @ApiOperation({
    summary: 'One reconciliation case (super_admin)',
    description:
      'Everything an operator needs to decide, for ONE order: its identifiers ' +
      'and the customer’s contact number, every payment attempt with the ' +
      'gateway’s own figures and reference, the order and fulfilment state, a ' +
      'stock/allocation summary, the append-only history of what has already ' +
      'been decided, and `allowedActions` — the mutations the server will ' +
      'honour from the CURRENT state, so the UI renders exactly the buttons ' +
      'that work.\n\n' +
      '`authorizationClauses` is the fulfilment claim’s own diagnosis, clause ' +
      'by clause, per receipt: which of `isSuccess`, `hasGatewayAmount`, ' +
      '`gatewayMatchesAmount`, `amountMatchesOrder`, `reasonResolved` hold. It ' +
      'is computed by the same SQL the claim uses, so it cannot disagree with ' +
      'why fulfilment actually refused.\n\n' +
      'NO SECRETS AND NO TOKENS. `payment.track_id` (which is itself the ' +
      'credential `POST /payment/verify` accepts), the re-verification ' +
      'scheduler’s columns and `orders.fulfillmentLastError` are all excluded ' +
      'by construction — the view is an allow-list, not a delete-list.',
  })
  @ApiParam({
    name: 'orderId',
    type: Number,
    description: 'Numeric `orders.id`. The case id IS the order id.',
    example: 41,
  })
  @ApiOkResponse({
    description: 'The case. 200.',
    schema: successEnvelopeSchema({
      data: { $ref: getSchemaPath(ReconciliationCaseDetailView) },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiOperation({
    summary: 'The queue’s summary counts',
    description:
      'Nine counts in ONE query over the same case projection the list uses, ' +
      'so a card and the rows beneath it cannot disagree.\n\n' +
      '`needsAction` + `tracking` + `closed` is the whole queue — the three ' +
      'stages partition it. Every other figure is an OVERLAPPING view of the ' +
      'unresolved part (a case can be both "customer paid, order incomplete" ' +
      'and "stock problem"), so they must never be added together.\n\n' +
      '`resolvedToday` is bounded by the **Asia/Tehran** calendar day, ' +
      'computed in PostgreSQL — a manager asking what was closed today means ' +
      'their day, not UTC’s.',
  })
  @ApiOkResponse({
    description: 'The counts.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiAuthRequired()
  @ApiPermissionForbidden('reconciliation.read')
  @RequirePermissions('reconciliation.read')
  @Audiences('admin')
  @Get('admin/reconciliation/summary')
  async reconciliationSummary() {
    return { data: await this.reconciliationService.queueSummary() };
  }

  /**
   * DECLARED AFTER `summary`, and that ordering is load-bearing: Nest matches
   * in declaration order, so with this route first `.../summary` would arrive
   * here as `orderId = "summary"` and `ParseIntPipe` would answer 400.
   */
  @ApiNotFound(
    'No order has that id, or the order has nothing outstanding ' +
      '(`RECONCILIATION_CASE_NOT_FOUND`).',
  )
  @RequirePermissions('reconciliation.read')
  @Audiences('admin')
  @Get('admin/reconciliation/:orderId')
  async reconciliationCase(
    @Req() req: UserRequest,
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    return {
      message: ReconciliationMessages.CASE_READ,
      // `allowedActions` is shaped for THIS caller: a reader without
      // `reconciliation.act` gets an empty list rather than five buttons the
      // server would refuse.
      data: await this.reconciliationService.readCase(
        orderId,
        req.user?.permissions ?? [],
      ),
    };
  }

  @ApiOperation({
    summary: 'Retry fulfilment for a case (super_admin)',
    description:
      'Re-drives payment phase 2 for ONE order through ' +
      '`FulfilmentService.drive()`’s UNCHANGED boundary. **The authorization ' +
      'predicate is not relaxed:** an order no receipt authorizes comes back ' +
      'with `blocked: "reconciliation_required"` and NOTHING is consumed. ' +
      'Stock cannot be consumed twice (the fulfilment ledger row is the ' +
      'completion marker) and no duplicate movement can be written.\n\n' +
      'Allowed only from `paid` + `pending`/`awaiting_stock`; anything else is ' +
      '409 `ORDER_NOT_RETRYABLE`. A resolved case is 409 ' +
      '`RECONCILIATION_ALREADY_RESOLVED`. Read `fulfilled` and `blocked` ' +
      'before telling anyone the order is on its way.',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 41 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: RECONCILIATION_IDEMPOTENCY_HEADER_DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'The retry outcome. 200, not 201.',
    schema: successEnvelopeSchema({
      message: ReconciliationMessages.FULFILMENT_RETRIED,
      data: RECONCILIATION_ACTION_RESULT_SCHEMA,
    }),
  })
  @ApiInvalidInput(RECONCILIATION_ACTION_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No case for that order id (`RECONCILIATION_CASE_NOT_FOUND`).')
  @ApiConflict(
    '`ORDER_NOT_RETRYABLE` (wrong order/fulfilment state), ' +
      '`RECONCILIATION_ALREADY_RESOLVED`, or the idempotency conflicts ' +
      '(`IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`).',
  )
  @RequirePermissions('reconciliation.read', 'reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/reconciliation/:orderId/retry-fulfilment')
  async retryFulfilment(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: RetryFulfilmentDto,
    @Req() req: UserRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireReconciliationKey(idempotencyKey);
    const data = await this.reconciliationService.retryFulfilment(
      orderId,
      dto,
      req.user.sub,
      key,
    );
    return { message: data.message, data };
  }

  @ApiOperation({
    summary: 'Mark a case as requiring a manual refund (super_admin)',
    description:
      '**RECORDS AN OBLIGATION. IT DOES NOT REFUND ANYTHING.** No payment row ' +
      'is touched, no order status changes, no stock moves and no gateway is ' +
      'called. It records who decided money must go back, why, when, and the ' +
      'expected amount, and it leaves the case IN the queue — an unpaid ' +
      'obligation must not be able to leave.\n\n' +
      'The customer’s `reviewState` becomes `refund_in_progress`, which says a ' +
      'refund is being processed and deliberately does NOT say one completed. ' +
      'Report the completion afterwards with `/confirm-refund`.',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 41 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: RECONCILIATION_IDEMPOTENCY_HEADER_DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'The obligation was recorded. 200, not 201.',
    schema: successEnvelopeSchema({
      message: ReconciliationMessages.REFUND_REQUIRED_RECORDED,
      data: RECONCILIATION_ACTION_RESULT_SCHEMA,
    }),
  })
  @ApiInvalidInput(RECONCILIATION_ACTION_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No case for that order id (`RECONCILIATION_CASE_NOT_FOUND`).')
  @ApiConflict('`RECONCILIATION_ALREADY_RESOLVED`, or an idempotency conflict.')
  @RequirePermissions('reconciliation.read', 'reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/reconciliation/:orderId/mark-refund-required')
  async markRefundRequired(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: MarkRefundRequiredDto,
    @Req() req: UserRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireReconciliationKey(idempotencyKey);
    const data = await this.reconciliationService.markRefundRequired(
      orderId,
      dto,
      req.user.sub,
      key,
    );
    return { message: data.message, data };
  }

  @ApiOperation({
    summary: 'Confirm an externally completed refund (super_admin)',
    description:
      '**REPORTS A REFUND THE OPERATOR ALREADY COMPLETED WITH THE PROVIDER.** ' +
      'No gateway call is made here — this system never moves money on its ' +
      'own. The operator names the receipt (`paymentId`), the amount actually ' +
      'refunded and the provider’s reference.\n\n' +
      'WHAT CHANGES: that receipt becomes `refunded` and gets a ' +
      '`reconciled_at`. **The receipt itself is never rewritten** — `amount`, ' +
      '`gateway_amount`, `gateway_amount_raw`, `ref_number` and `paid_at` are ' +
      'untouched.\n\n' +
      'WHAT CHANGES ONLY SOMETIMES: the ORDER becomes `refunded` with a ' +
      '`refundedAt` **only if the refunded receipt was the SETTLING one** ' +
      '(`success`). Refunding a `confirmed_unapplied` duplicate leaves the ' +
      'order alone — that receipt never settled anything, and cancelling an ' +
      'order the customer legitimately paid for would be a second error. ' +
      'INVENTORY IS RESTORED ONLY WHEN A REAL PRIOR CONSUMPTION EXISTS, ' +
      'derived from `stock_movements`; an order that never consumed stock gets ' +
      'nothing back (`stockRestored: false`) and its allocation is released as ' +
      'the hold it always was.\n\n' +
      'Double confirmation is refused three ways: the `Idempotency-Key` ' +
      'replays an identical retry, an already-`refunded` receipt is 409 ' +
      '`REFUND_ALREADY_CONFIRMED`, and a resolved case is 409 ' +
      '`RECONCILIATION_ALREADY_RESOLVED`.',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 41 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: RECONCILIATION_IDEMPOTENCY_HEADER_DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'The refund was recorded. 200, not 201.',
    schema: successEnvelopeSchema({
      message: ReconciliationMessages.REFUND_CONFIRMED,
      data: RECONCILIATION_ACTION_RESULT_SCHEMA,
    }),
  })
  @ApiInvalidInput(
    RECONCILIATION_ACTION_400 +
      '. Also 400 `REFUND_AMOUNT_INVALID` when `amount` is not positive or ' +
      'exceeds the largest figure recorded for the receipt.',
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound(
    'No case for that order id (`RECONCILIATION_CASE_NOT_FOUND`), or the ' +
      '`paymentId` is not on this order (`PAYMENT_NOT_ON_ORDER`).',
  )
  @ApiConflict(
    '`REFUND_ALREADY_CONFIRMED`, `PAYMENT_NOT_REFUNDABLE` (the gateway never ' +
      'confirmed that attempt), `RECONCILIATION_ALREADY_RESOLVED`, or an ' +
      'idempotency conflict.',
  )
  @RequirePermissions('reconciliation.read', 'reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/reconciliation/:orderId/confirm-refund')
  async confirmExternalRefund(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: ConfirmExternalRefundDto,
    @Req() req: UserRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireReconciliationKey(idempotencyKey);
    const data = await this.reconciliationService.confirmExternalRefund(
      orderId,
      dto,
      req.user.sub,
      key,
    );
    return { message: data.message, data };
  }

  @ApiOperation({
    summary: 'Mark a paid order as backordered (super_admin)',
    description:
      'An explicit decision to keep a paid order open and wait for stock. **No ' +
      'stock is consumed and none is promised**, no money moves, and the order ' +
      'keeps its `paid` status and its recoverable fulfilment state — so the ' +
      'recovery worker keeps retrying it and it completes on its own the ' +
      'moment stock returns.\n\n' +
      'The case deliberately STAYS in the queue: the customer is still owed ' +
      'goods. They see `reviewState: "under_review"`, which is true and is not ' +
      'a delivery promise. Allowed only from `paid` + ' +
      '`pending`/`awaiting_stock`.',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 41 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: RECONCILIATION_IDEMPOTENCY_HEADER_DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'The decision was recorded. 200, not 201.',
    schema: successEnvelopeSchema({
      message: ReconciliationMessages.BACKORDER_RECORDED,
      data: RECONCILIATION_ACTION_RESULT_SCHEMA,
    }),
  })
  @ApiInvalidInput(RECONCILIATION_ACTION_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No case for that order id (`RECONCILIATION_CASE_NOT_FOUND`).')
  @ApiConflict(
    '`ORDER_NOT_BACKORDERABLE` (the order is not paid, or its goods are ' +
      'already allocated), `RECONCILIATION_ALREADY_RESOLVED`, or an ' +
      'idempotency conflict.',
  )
  @RequirePermissions('reconciliation.read', 'reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/reconciliation/:orderId/mark-backorder')
  async markBackorder(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: MarkBackorderDto,
    @Req() req: UserRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireReconciliationKey(idempotencyKey);
    const data = await this.reconciliationService.markBackorder(
      orderId,
      dto,
      req.user.sub,
      key,
    );
    return { message: data.message, data };
  }

  @ApiOperation({
    summary: 'Resolve a case with no financial action (super_admin)',
    description:
      'Closes a case where nothing needed to move. `resolutionType` is ' +
      'MANDATORY and explicit (`no_discrepancy`, `settled_externally`, ' +
      '`customer_agreed`, `gateway_duplicate`) — "resolved" on its own records ' +
      'that somebody clicked something, not what they decided.\n\n' +
      '**A case marked `refund_required` cannot be closed this way** (409 ' +
      '`REFUND_PENDING_CONFIRMATION`): that would silently discharge a ' +
      'recorded obligation to give money back. Confirm the refund, or record a ' +
      'different decision first.\n\n' +
      'It stamps `reconciled_at` on the order’s still-open flagged receipts ' +
      'and changes NOTHING else about them — no status, no figures, no ' +
      'deletion. The receipts and their evidence stay exactly as the gateway ' +
      'left them; who signed them off, when and why is in the append-only ' +
      'audit trail.',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 41 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: RECONCILIATION_IDEMPOTENCY_HEADER_DESCRIPTION,
  })
  @ApiOkResponse({
    description: 'The case was closed. 200, not 201.',
    schema: successEnvelopeSchema({
      message: ReconciliationMessages.CASE_RESOLVED,
      data: RECONCILIATION_ACTION_RESULT_SCHEMA,
    }),
  })
  @ApiInvalidInput(RECONCILIATION_ACTION_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No case for that order id (`RECONCILIATION_CASE_NOT_FOUND`).')
  @ApiConflict(
    '`REFUND_PENDING_CONFIRMATION`, `RECONCILIATION_ALREADY_RESOLVED`, or an ' +
      'idempotency conflict.',
  )
  @RequirePermissions('reconciliation.read', 'reconciliation.act')
  @HttpCode(200)
  @Audiences('admin')
  @Post('admin/reconciliation/:orderId/resolve')
  async resolveReconciliation(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: ResolveReconciliationDto,
    @Req() req: UserRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireReconciliationKey(idempotencyKey);
    const data = await this.reconciliationService.resolveNoAction(
      orderId,
      dto,
      req.user.sub,
      key,
    );
    return { message: data.message, data };
  }
}
