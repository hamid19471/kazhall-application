import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  ReconciliationErrorCode,
  ReconciliationMessages,
} from 'src/common/constants/reconciliation.messages';
import { UserMessages } from 'src/common/constants/user.messages';
import { IdempotencyScope } from 'src/common/entities/idempotency-key.entity';
import { resolveReportTimezone } from '../orders/business-time';
import { FulfillmentStateEnum } from '../orders/enums/fulfillment-state.enum';
import { OrderChannel } from '../orders/enums/order-channel.enum';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import {
  OrderReconciliationState,
  isTerminalReconciliationState,
} from '../orders/enums/reconciliation-state.enum';
import {
  IdempotentReplayError,
  claimIdempotencyKey,
  completeIdempotencyKey,
  peekIdempotencyKey,
  requestHashOf,
} from '../orders/idempotency.helper';
import { InventoryService } from '../inventory/inventory.service';
import { ConsumedVariantResult } from '../inventory/inventory.types';
import { StockMovementReason } from '../inventory/entities/stock-movement.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { User } from '../user/entities/user.entity';
import {
  ConfirmExternalRefundDto,
  MarkBackorderDto,
  MarkRefundRequiredDto,
  ResolveReconciliationDto,
  RetryFulfilmentDto,
} from './dto/reconciliation-action.dto';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import {
  ReconciliationActionResultView,
  ReconciliationCaseDetailView,
  ReconciliationCaseSummaryView,
  ReconciliationQueueSummaryView,
  ReconciliationQueueView,
} from './dto/reconciliation.view';
import {
  PaymentAction,
  PaymentActionType,
} from './entities/payment-action.entity';
import { PaymentStatusEnum } from './enums/payment-status-enum';
import { FulfilmentService } from './fulfilment.service';
import {
  ReconciliationActionName,
  ReconciliationCaseType,
  ReconciliationStage,
} from './reconciliation.types';

/** The fulfilment states a paid order can still be acted on from. */
const UNALLOCATED_FULFILMENT_STATES: readonly FulfillmentStateEnum[] = [
  FulfillmentStateEnum.PENDING,
  FulfillmentStateEnum.AWAITING_STOCK,
];

/** The statuses that mean the gateway CONFIRMED money for this attempt. */
const CONFIRMED_PAYMENT_STATUSES: readonly PaymentStatusEnum[] = [
  PaymentStatusEnum.SUCCESS,
  PaymentStatusEnum.CONFIRMED_UNAPPLIED,
];

/**
 * The order statuses a settling receipt's refund may move the order OUT of.
 *
 * Identical to the set `OrdersService.returnOrder` accepts, on purpose: a
 * confirmed refund is commercially the same event as a return, and the two must
 * not disagree about which orders can be reversed.
 */
const REFUNDABLE_ORDER_STATUSES: readonly OrderStatusEnum[] = [
  OrderStatusEnum.PAID,
  OrderStatusEnum.PROCESSING,
  OrderStatusEnum.SHIPPED,
  OrderStatusEnum.DELIVERED,
];

/**
 * What a mutation produced: the value to answer with, the case row as it stands
 * AFTER the business transaction committed, and any stock that was genuinely
 * given back.
 *
 * Returning the realtime material instead of emitting it inline is what keeps
 * every emit OUTSIDE the transaction. An event emitted from inside one
 * announces state that may still roll back, and a customer told their order
 * changed when it did not is the failure mode this whole feature exists to
 * avoid.
 */
interface ReconciliationEffect<T> {
  result: T;
  row: CaseRow;
  /** Units a reversal put BACK. Published as a `stock` invalidation. */
  restored?: ConsumedVariantResult[];
  /**
   * Units a `retryFulfilment` TOOK.
   *
   * Absent before this pass, which is why rescuing a paid order from the
   * reconciliation queue moved real stock and announced nothing: the publish
   * block read only `restored`, so a successful retry was silent to every
   * storefront and till.
   */
  consumed?: ConsumedVariantResult[];
}

/** Raw shape of one queue row, straight out of the case query. */
interface CaseRow {
  orderId: number;
  orderNumber: string | null;
  channel: OrderChannel;
  /**
   * These four arrive from raw SQL as `::text` and are TYPED AS THE ENUMS
   * rather than as `string`.
   *
   * That is not cosmetic. Typing them `string` makes every comparison against
   * an enum member an unchecked one — which is exactly how a stale literal
   * ('awaiting-stock', 'PAID') silently stops matching and a guard silently
   * stops guarding. With the enum types, a member renamed in the enum breaks
   * this file at compile time. The database values ARE the enum values: the
   * columns are Postgres enums (or CHECK-constrained varchars) built from these
   * same TypeScript enums by the migrations.
   */
  orderStatus: OrderStatusEnum;
  fulfillmentState: FulfillmentStateEnum;
  branchId: number | null;
  /** The customer to notify on their OWN room. NULL for a walk-in POS sale. */
  userId: number | null;
  reconciliationState: OrderReconciliationState | null;
  reconciliationResolvedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  orderTotal: string;
  confirmedHeld: string;
  confirmedUnapplied: string;
  refundedTotal: string;
  hasAmountDiscrepancy: boolean;
  hasUnappliedReceipt: boolean;
  fulfilmentAuthorized: boolean;
  /**
   * Whether this order is IN the queue right now.
   *
   * It is a computed COLUMN rather than a WHERE clause so the same projection
   * can answer two different questions: "list the cases" (`WHERE c."isCase"`)
   * and "what does this order look like NOW, after the decision I just took"
   * (no filter). The second one matters: a successful retry, a confirmed refund
   * or a resolution can legitimately take an order OUT of the queue, and a
   * projection that could only see cases would answer 404 for the very order it
   * had just fixed.
   */
  isCase: boolean;
}

/**
 * ============================================================================
 * MANUAL RECONCILIATION WITH AN ADMIN QUEUE  --  OWNER DECISION D-2
 * ============================================================================
 *
 * THE PROBLEM THIS CLOSES. Three separate parts of this system already detect a
 * money/goods discrepancy, refuse to act on it, and say a human must decide:
 * `PaymentService` (a confirmed receipt it could not apply),
 * `FulfilmentService` (a paid order no receipt authorizes shipping), and
 * `OrdersService` (a paid order whose goods were never allocated). There was
 * nowhere for that human to go, and `payment.reconciled_at` — the column that
 * means "dealt with" — had ZERO writers in the whole application.
 *
 * THE POLICY, IN FULL. It is the same six rules on every endpoint here:
 *
 *   1. NOTHING IS AUTOMATIC. No refund, no cancellation, no back-order, no
 *      write-off happens without an operator explicitly asking for it, with a
 *      reason. This service has no timer, no sweep and no inference.
 *   2. GATEWAY EVIDENCE IS NEVER REWRITTEN. `amount`, `gateway_amount`,
 *      `gateway_amount_raw`, `ref_number` and `paid_at` are read-only to every
 *      path in this file. A confirmation is a fact about the outside world.
 *   3. STOCK IS NEVER INVENTED. A refund restores physical stock ONLY through
 *      `InventoryService.restoreForOrder`, which derives what to give back from
 *      `stock_movements` (`HAVING SUM(delta) < 0`). An order that never
 *      consumed anything restores NOTHING, and its allocation is released as
 *      the hold it always was.
 *   4. NO DECISION IS TAKEN TWICE. Every mutation demands an
 *      `Idempotency-Key`, validates the source state under a row lock, and
 *      replays the stored response verbatim on a retry.
 *   5. EVERYTHING IS AUDITED. Every mutation writes one `payment_actions` row
 *      naming the operator, their reason, and the from/to of every state it
 *      moved. The table is append-only at the DATABASE level (migration 0018).
 *   6. THE CUSTOMER IS TOLD SOMETHING TRUE. Never "fulfilled" about goods that
 *      have not moved, never "refunded" about money that has not gone back, and
 *      never an operator note or an internal error string. See
 *      `toCustomerOrderReviewState`.
 *
 * ============================================================================
 * THE LOCKING STRATEGY, AND WHY IT IS SAFE UNDER CONCURRENCY
 * ============================================================================
 *
 * Every mutation runs in ONE transaction and takes its locks in this order:
 *
 *   1. the `idempotency_keys` row, via the unique index (`claimIdempotencyKey`
 *      is the FIRST write, before any row lock — a duplicate request blocks on
 *      the index while holding nothing, so it cannot deadlock against anything
 *      else);
 *   2. `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` — the order row, the
 *      same row `FulfilmentService.claim()` takes with `FOR UPDATE SKIP LOCKED`
 *      and `OrdersService.updateStatus` takes with `pessimistic_write`;
 *   3. the specific `payment` row, when the action names one;
 *   4. variant rows, only via `InventoryService`, which takes them in its own
 *      documented global order (order -> variant -> reservation).
 *
 * That is the SAME order every other writer in this application uses, which is
 * what makes the set deadlock-free rather than merely usually-fine. Because the
 * order row is held for the whole transaction, a concurrent fulfilment claim
 * either runs entirely before us (and we read what it wrote) or skips us
 * (`SKIP LOCKED`) and finds our committed result on its next pass. Two
 * operators pressing the same button race on step 1 and exactly one wins; the
 * loser either replays the winner's response or is told the state has moved.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * The business calendar. Only `queueSummary`'s "resolved today" figure needs
   * it, but it is resolved once here — through the same helper the reports and
   * the dashboard use — so there is one answer to "where does the day start"
   * in the whole application rather than three.
   */
  private readonly timezone: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fulfilment: FulfilmentService,
    private readonly inventory: InventoryService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    configService: ConfigService,
  ) {
    this.timezone = resolveReportTimezone(
      configService.get<string>('REPORT_TIMEZONE'),
    );
  }

  // =========================================================================
  // READS
  // =========================================================================

  /**
   * The queue.
   *
   * THE CASE PREDICATE IS COMPUTED FROM COMMITTED ROWS, never from a stored
   * "needs attention" flag. A flag is only as complete as the code paths that
   * remember to set it, and the one property this queue must have is that an
   * unresolved discrepancy cannot silently vanish from it. An order is a case
   * when ANY of these is true:
   *
   *   (a) it has a confirmed receipt an operator has not closed
   *       (`requires_reconciliation AND reconciled_at IS NULL`);
   *   (b) it is PAID and its goods were never allocated
   *       (`fulfillmentState IN ('pending','awaiting_stock')`);
   *   (c) an operator has taken ANY decision on it
   *       (`reconciliationState IS NOT NULL`), resolved or not.
   *
   * CLAUSE (c) DELIBERATELY DOES NOT REQUIRE "still open". A case an operator
   * closed stays listed and is simply LABELLED resolved, so the `resolved`
   * filter has both sides to select and a decision cannot be made to vanish by
   * taking it. `resolved=false` is the working view; the default is everything.
   *
   * ALL MONEY IS AGGREGATED AND COMPARED IN POSTGRESQL and leaves it as
   * `::text`. Nothing on this path converts a `bigint` Rial column to a JS
   * `Number`.
   */
  async listQueue(
    query: ReconciliationQueryDto,
  ): Promise<ReconciliationQueueView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const { where, params } = this.buildQueueFilter(query);

    const countRows: Array<{ count: string }> = await this.dataSource.query(
      `SELECT COUNT(*)::text AS count FROM (${this.caseSelect(where)}) c`,
      params,
    );
    const total = Number(countRows[0]?.count ?? '0');

    const rows: CaseRow[] = await this.dataSource.query(
      `${this.caseSelect(where)}
        ORDER BY c."paidAt" DESC NULLS LAST, c."orderId" DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );

    return {
      data: rows.map((row) => this.toSummary(row)),
      total,
      page,
      limit,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    };
  }

  /**
   * One case, with everything an operator needs to decide.
   *
   * @param actorPermissions the caller's effective capability codes. Used only
   * to shape `allowedActions`; every mutation re-checks under a row lock, so
   * nothing here authorises anything.
   */
  async readCase(
    orderId: number,
    actorPermissions: readonly string[] = [],
  ): Promise<ReconciliationCaseDetailView> {
    const rows: CaseRow[] = await this.dataSource.query(
      this.caseSelect(`c."orderId" = $1 AND c."isCase"`),
      [orderId],
    );
    const row = rows[0];
    if (!row) throw this.caseNotFound(orderId);

    return this.dataSource.transaction(async (manager) =>
      this.buildDetail(manager, row, actorPermissions),
    );
  }

  // =========================================================================
  // MUTATIONS
  // =========================================================================

  /**
   * ACTION 1 — RETRY FULFILMENT.
   *
   * It reuses `FulfilmentService.drive()`'s boundary UNCHANGED. That is the
   * entire safety argument: `drive()` already locks the order with
   * `FOR UPDATE SKIP LOCKED`, evaluates the authorization predicate with the
   * row held, consumes stock through `consumeForOnlineFulfilment` (whose
   * completion marker is the existence of an `online_fulfillment` movement, so
   * a second call moves nothing), and flips the state with a guarded
   * conditional UPDATE. Nothing here relaxes it: an order no receipt authorizes
   * comes back `blocked` and is reported as blocked.
   *
   * The idempotency record commits in its own transaction BEFORE `drive()`
   * runs, because `drive()` opens a transaction of its own and must not be
   * nested inside the claim — a replayed request therefore returns the stored
   * outcome instead of re-driving, and a genuinely new request is serialised
   * against a concurrent duplicate by the unique index.
   */
  async retryFulfilment(
    orderId: number,
    dto: RetryFulfilmentDto,
    actorUserId: number,
    idempotencyKey: string,
  ): Promise<ReconciliationActionResultView> {
    return this.withIdempotency(
      orderId,
      idempotencyKey,
      { action: PaymentActionType.RETRY_FULFILMENT, orderId, ...dto },
      async () => {
        const before = await this.loadCaseRowOrThrow(
          this.dataSource.manager,
          orderId,
        );
        this.assertAddressable(before);
        this.assertNotResolved(before);
        if (
          before.orderStatus !== OrderStatusEnum.PAID ||
          !UNALLOCATED_FULFILMENT_STATES.includes(before.fulfillmentState)
        ) {
          throw new ConflictException({
            error: ReconciliationErrorCode.ORDER_NOT_RETRYABLE,
            message: ReconciliationMessages.ORDER_NOT_RETRYABLE,
            orderId,
            status: before.orderStatus,
            fulfillmentState: before.fulfillmentState,
          });
        }

        const outcome = await this.fulfilment.drive(orderId, actorUserId);

        const after = await this.loadCaseRowOrThrow(
          this.dataSource.manager,
          orderId,
        );
        const actionId = await this.dataSource.transaction((manager) =>
          this.writeAudit(manager, {
            orderId,
            paymentId: null,
            action: PaymentActionType.RETRY_FULFILMENT,
            actorUserId,
            reason: dto.reason,
            fromOrderStatus: before.orderStatus,
            toOrderStatus: after.orderStatus,
            fromReconciliationState: before.reconciliationState,
            toReconciliationState: after.reconciliationState,
            idempotencyKey,
          }),
        );

        return {
          row: after,
          /*
           * The units this retry actually consumed, so the publish block can
           * announce them. `drive()` returns the committed rows; without
           * carrying them here a successful rescue changed real stock and
           * told nobody.
           */
          consumed: outcome.consumed,
          result: {
            orderId,
            action: PaymentActionType.RETRY_FULFILMENT,
            actionId,
            orderStatus: after.orderStatus,
            fulfillmentState: after.fulfillmentState,
            reconciliationState: after.reconciliationState,
            fulfilled:
              outcome.claimed &&
              outcome.state === FulfillmentStateEnum.FULFILLED,
            blocked: outcome.blocked,
            message: ReconciliationMessages.FULFILMENT_RETRIED,
          },
        };
      },
    );
  }

  /**
   * ACTION 2 — MARK FOR MANUAL REFUND.
   *
   * IT DOES NOT PRETEND A REFUND HAPPENED and it moves no money. It records the
   * OBLIGATION: who decided it, why, when, and the expected amount. No payment
   * row is touched, no order status changes, no stock moves. The case stays in
   * the queue (`refund_required` is non-terminal, by design — an unpaid
   * obligation must not be able to leave) and the customer's derived
   * `reviewState` becomes `refund_in_progress`, which says a refund is being
   * processed and deliberately does NOT say one has completed.
   */
  async markRefundRequired(
    orderId: number,
    dto: MarkRefundRequiredDto,
    actorUserId: number,
    idempotencyKey: string,
  ): Promise<ReconciliationActionResultView> {
    return this.withIdempotency(
      orderId,
      idempotencyKey,
      { action: PaymentActionType.MARK_REFUND_REQUIRED, orderId, ...dto },
      () =>
        this.dataSource.transaction(async (manager) => {
          const before = await this.lockCase(manager, orderId);
          this.assertNotResolved(before);

          await this.setReconciliationState(
            manager,
            orderId,
            OrderReconciliationState.REFUND_REQUIRED,
          );

          const actionId = await this.writeAudit(manager, {
            orderId,
            paymentId: null,
            action: PaymentActionType.MARK_REFUND_REQUIRED,
            actorUserId,
            reason: dto.reason,
            amount: dto.expectedAmount ?? null,
            fromReconciliationState: before.reconciliationState,
            toReconciliationState: OrderReconciliationState.REFUND_REQUIRED,
            idempotencyKey,
          });

          const after = await this.loadCaseRowOrThrow(manager, orderId);

          return {
            row: after,
            result: {
              orderId,
              action: PaymentActionType.MARK_REFUND_REQUIRED,
              actionId,
              orderStatus: after.orderStatus,
              fulfillmentState: after.fulfillmentState,
              reconciliationState: OrderReconciliationState.REFUND_REQUIRED,
              message: ReconciliationMessages.REFUND_REQUIRED_RECORDED,
            },
          };
        }),
    );
  }

  /**
   * ACTION 3 — CONFIRM AN EXTERNALLY COMPLETED REFUND.
   *
   * This is a REPORT of something that happened with the provider, never an
   * instruction to this system to refund anything: no gateway call is made
   * anywhere in this file. The operator names the receipt, the amount and the
   * provider's reference.
   *
   * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE:
   *
   *  - `payment.status` -> `refunded` and `payment.reconciled_at` -> now(),
   *    which is the same ledger move `OrdersService.reverseOrder` already makes
   *    for a returned sale. `amount`, `gateway_amount`, `gateway_amount_raw`,
   *    `ref_number` and `paid_at` are NOT touched: the receipt is evidence.
   *  - the ORDER is transitioned to `refunded` ONLY IF THE REFUNDED RECEIPT WAS
   *    THE SETTLING ONE (`status = 'success'` before this call). Refunding a
   *    `confirmed_unapplied` duplicate must not cancel an order the customer
   *    legitimately paid for and may already have received — that receipt never
   *    settled anything, so nothing about the order changes.
   *  - INVENTORY IS RESTORED ONLY WHEN A REAL PRIOR CONSUMPTION EXISTS, and
   *    only via `InventoryService.restoreForOrder`, which derives the quantity
   *    from `stock_movements` with `HAVING SUM(delta) < 0`. An order that never
   *    consumed stock gets nothing back and its allocation is released as the
   *    hold it always was. Nothing is fabricated and stock cannot go negative,
   *    because restoration only ever ADDS.
   *
   * DOUBLE CONFIRMATION IS IMPOSSIBLE three times over: the `Idempotency-Key`
   * replays a repeat of the SAME request, the receipt's status is re-read under
   * `FOR UPDATE` and a non-confirmed one is refused, and the case's terminal
   * state refuses a second decision.
   */
  async confirmExternalRefund(
    orderId: number,
    dto: ConfirmExternalRefundDto,
    actorUserId: number,
    idempotencyKey: string,
  ): Promise<ReconciliationActionResultView> {
    return this.withIdempotency(
      orderId,
      idempotencyKey,
      { action: PaymentActionType.CONFIRM_EXTERNAL_REFUND, orderId, ...dto },
      () =>
        this.dataSource.transaction(async (manager) => {
          const before = await this.lockCase(manager, orderId);
          this.assertNotResolved(before);

          // Lock the receipt and read every figure as TEXT: these are `bigint`
          // Rial columns and must not round through a JS `Number`.
          const receipts: Array<{
            id: number;
            status: PaymentStatusEnum;
            amount: string;
            gateway_amount: string | null;
            amount_ok: boolean;
          }> = await manager.query(
            `SELECT id,
                    status::text AS status,
                    amount::text AS amount,
                    gateway_amount::text AS gateway_amount,
                    ($3::bigint > 0
                      AND $3::bigint <= GREATEST(amount,
                                                 COALESCE(gateway_amount, amount)))
                      AS amount_ok
               FROM payment
              WHERE id = $1 AND "orderId" = $2
                FOR UPDATE`,
            [dto.paymentId, orderId, String(dto.amount)],
          );
          const receipt = receipts[0];
          if (!receipt) {
            throw new NotFoundException({
              error: ReconciliationErrorCode.PAYMENT_NOT_ON_ORDER,
              message: ReconciliationMessages.PAYMENT_NOT_ON_ORDER,
              orderId,
              paymentId: dto.paymentId,
            });
          }
          if (receipt.status === PaymentStatusEnum.REFUNDED) {
            throw new ConflictException({
              error: ReconciliationErrorCode.REFUND_ALREADY_CONFIRMED,
              message: ReconciliationMessages.REFUND_ALREADY_CONFIRMED,
              orderId,
              paymentId: dto.paymentId,
            });
          }
          if (!CONFIRMED_PAYMENT_STATUSES.includes(receipt.status)) {
            throw new ConflictException({
              error: ReconciliationErrorCode.PAYMENT_NOT_REFUNDABLE,
              message: ReconciliationMessages.PAYMENT_NOT_REFUNDABLE,
              orderId,
              paymentId: dto.paymentId,
              paymentStatus: receipt.status,
            });
          }
          if (!receipt.amount_ok) {
            throw new BadRequestException({
              error: ReconciliationErrorCode.REFUND_AMOUNT_INVALID,
              message: ReconciliationMessages.REFUND_AMOUNT_INVALID,
              orderId,
              paymentId: dto.paymentId,
              // Strings: these are the recorded figures, quoted exactly.
              recordedAmount: receipt.amount,
              gatewayAmount: receipt.gateway_amount,
            });
          }

          const settledTheOrder = receipt.status === PaymentStatusEnum.SUCCESS;

          // The ledger move. Evidence columns are untouched.
          await manager.query(
            `UPDATE payment
                SET status = $2, reconciled_at = now(), updated_at = now()
              WHERE id = $1`,
            [dto.paymentId, PaymentStatusEnum.REFUNDED],
          );

          let restored: ConsumedVariantResult[] = [];
          let stockRestored = false;
          let toOrderStatus: string | null = null;

          if (settledTheOrder) {
            // A partially refunded order is finished line by line, never
            // wholesale (docs/PURCHASE-COST-ACCOUNTING.md §5.1).
            await this.inventory.assertNoLineAdjustments(manager, orderId);
            const actor = await this.loadActor(manager, actorUserId);
            // Movement-derived: an order with no consumption restores NOTHING.
            const restore = await this.inventory.restoreForOrder(manager, {
              orderId,
              reason: StockMovementReason.RETURN_RESTORE,
              actorUserId: actor.id,
              actorDisplaySnapshot: this.displayNameOf(actor),
              // Revenue is reversed exactly when the order becomes REFUNDED
              // below, which is when the sales summary books it.
              reverseRevenue: REFUNDABLE_ORDER_STATUSES.includes(
                before.orderStatus,
              ),
            });
            stockRestored = restore.restored.length > 0;

            if (REFUNDABLE_ORDER_STATUSES.includes(before.orderStatus)) {
              toOrderStatus = OrderStatusEnum.REFUNDED;
              await manager.query(
                `UPDATE orders
                    SET status = $2,
                        "fulfillmentState" = $3,
                        "refundedAt" = now()
                  WHERE id = $1`,
                [
                  orderId,
                  OrderStatusEnum.REFUNDED,
                  FulfillmentStateEnum.NOT_REQUIRED,
                ],
              );
            }

            restored = restore.restored;
          }

          await this.setReconciliationState(
            manager,
            orderId,
            OrderReconciliationState.REFUND_CONFIRMED,
          );

          const actionId = await this.writeAudit(manager, {
            orderId,
            paymentId: dto.paymentId,
            action: PaymentActionType.CONFIRM_EXTERNAL_REFUND,
            actorUserId,
            reason: dto.reason,
            amount: dto.amount,
            externalReference: dto.externalReference,
            fromPaymentStatus: receipt.status,
            toPaymentStatus: PaymentStatusEnum.REFUNDED,
            fromOrderStatus: before.orderStatus,
            toOrderStatus,
            fromReconciliationState: before.reconciliationState,
            toReconciliationState: OrderReconciliationState.REFUND_CONFIRMED,
            idempotencyKey,
          });

          const after = await this.loadCaseRowOrThrow(manager, orderId);

          return {
            row: after,
            restored,
            result: {
              orderId,
              action: PaymentActionType.CONFIRM_EXTERNAL_REFUND,
              actionId,
              orderStatus: after.orderStatus,
              fulfillmentState: after.fulfillmentState,
              reconciliationState: OrderReconciliationState.REFUND_CONFIRMED,
              stockRestored,
              message: ReconciliationMessages.REFUND_CONFIRMED,
            },
          };
        }),
    );
  }

  /**
   * ACTION 4 — MARK AS BACKORDER.
   *
   * An explicit operator decision to keep a paid order open and wait for stock.
   * NO STOCK IS CONSUMED, none is promised, no availability is changed and no
   * money moves. The case deliberately STAYS IN THE QUEUE (`backordered` is
   * non-terminal) because the customer is still owed goods, and the order stays
   * `paid` with its recoverable fulfilment state so the recovery worker keeps
   * retrying it and it self-heals the moment stock returns.
   *
   * The customer sees `reviewState: 'under_review'` — true, and not a promise.
   */
  async markBackorder(
    orderId: number,
    dto: MarkBackorderDto,
    actorUserId: number,
    idempotencyKey: string,
  ): Promise<ReconciliationActionResultView> {
    return this.withIdempotency(
      orderId,
      idempotencyKey,
      { action: PaymentActionType.MARK_BACKORDER, orderId, ...dto },
      () =>
        this.dataSource.transaction(async (manager) => {
          const before = await this.lockCase(manager, orderId);
          this.assertNotResolved(before);

          if (
            before.orderStatus !== OrderStatusEnum.PAID ||
            !UNALLOCATED_FULFILMENT_STATES.includes(before.fulfillmentState)
          ) {
            throw new ConflictException({
              error: ReconciliationErrorCode.ORDER_NOT_BACKORDERABLE,
              message: ReconciliationMessages.ORDER_NOT_BACKORDERABLE,
              orderId,
              status: before.orderStatus,
              fulfillmentState: before.fulfillmentState,
            });
          }

          await this.setReconciliationState(
            manager,
            orderId,
            OrderReconciliationState.BACKORDERED,
          );

          const actionId = await this.writeAudit(manager, {
            orderId,
            paymentId: null,
            action: PaymentActionType.MARK_BACKORDER,
            actorUserId,
            reason: dto.reason,
            fromReconciliationState: before.reconciliationState,
            toReconciliationState: OrderReconciliationState.BACKORDERED,
            idempotencyKey,
          });

          const after = await this.loadCaseRowOrThrow(manager, orderId);

          return {
            row: after,
            result: {
              orderId,
              action: PaymentActionType.MARK_BACKORDER,
              actionId,
              orderStatus: after.orderStatus,
              fulfillmentState: after.fulfillmentState,
              reconciliationState: OrderReconciliationState.BACKORDERED,
              message: ReconciliationMessages.BACKORDER_RECORDED,
            },
          };
        }),
    );
  }

  /**
   * ACTION 5 — RESOLVE WITH NO FINANCIAL ACTION.
   *
   * "ONLY WHERE VALID" is enforced, not documented: a case marked
   * `refund_required` CANNOT be closed this way (409
   * `REFUND_PENDING_CONFIRMATION`), because doing so would silently discharge a
   * recorded obligation to give money back. Either the refund is confirmed, or
   * a different decision is recorded first.
   *
   * It writes `payment.reconciled_at` for the order's still-open flagged
   * receipts — the first and only writer that column has ever had — and NOTHING
   * ELSE about them. No status changes, no figures are rewritten, no row is
   * deleted. The receipts, their reasons and their evidence all stay exactly as
   * the gateway left them; what changes is that a human has now signed them off,
   * and who, when and why is in `payment_actions` forever.
   */
  async resolveNoAction(
    orderId: number,
    dto: ResolveReconciliationDto,
    actorUserId: number,
    idempotencyKey: string,
  ): Promise<ReconciliationActionResultView> {
    return this.withIdempotency(
      orderId,
      idempotencyKey,
      { action: PaymentActionType.RESOLVE_NO_ACTION, orderId, ...dto },
      () =>
        this.dataSource.transaction(async (manager) => {
          const before = await this.lockCase(manager, orderId);
          this.assertNotResolved(before);

          if (
            before.reconciliationState ===
            OrderReconciliationState.REFUND_REQUIRED
          ) {
            throw new ConflictException({
              error: ReconciliationErrorCode.REFUND_PENDING_CONFIRMATION,
              message: ReconciliationMessages.REFUND_PENDING_CONFIRMATION,
              orderId,
              reconciliationState: before.reconciliationState,
            });
          }

          // Sign off the open flagged receipts. Their status, amounts,
          // references and `paid_at` are untouched.
          await manager.query(
            `UPDATE payment
                SET reconciled_at = now(), updated_at = now()
              WHERE "orderId" = $1
                AND requires_reconciliation
                AND reconciled_at IS NULL`,
            [orderId],
          );

          await this.setReconciliationState(
            manager,
            orderId,
            OrderReconciliationState.RESOLVED,
          );

          const actionId = await this.writeAudit(manager, {
            orderId,
            paymentId: null,
            action: PaymentActionType.RESOLVE_NO_ACTION,
            actorUserId,
            // The explicit resolution type is prefixed onto the operator's
            // sentence so the audit row records WHICH claim was made, not only
            // that a claim was made. `reason` is append-only, so this is the
            // one chance to state it.
            reason: `[${dto.resolutionType}] ${dto.reason}`,
            fromReconciliationState: before.reconciliationState,
            toReconciliationState: OrderReconciliationState.RESOLVED,
            idempotencyKey,
          });

          const after = await this.loadCaseRowOrThrow(manager, orderId);

          return {
            row: after,
            result: {
              orderId,
              action: PaymentActionType.RESOLVE_NO_ACTION,
              actionId,
              orderStatus: after.orderStatus,
              fulfillmentState: after.fulfillmentState,
              reconciliationState: OrderReconciliationState.RESOLVED,
              message: ReconciliationMessages.CASE_RESOLVED,
            },
          };
        }),
    );
  }

  // =========================================================================
  // The case query
  // =========================================================================

  /**
   * ONE SELECT that computes every case fact, with all money aggregated and
   * compared IN POSTGRESQL and emitted as `::text`.
   *
   * `fulfilmentAuthorized` is the SAME predicate `FulfilmentService`'s
   * `readAuthorization` evaluates — status `success`, a usable gateway amount,
   * equal to what we asked for, equal to the order total, no unresolved amount
   * reason. It is repeated here as an `EXISTS` rather than called, because this
   * runs over a whole page of orders at once; the clause-by-clause breakdown on
   * the DETAIL endpoint is the promoted method itself, so an operator drilling
   * in always sees the authoritative computation.
   */
  private caseSelect(where: string): string {
    return `
      SELECT c.*
        FROM (
          SELECT o.id                                   AS "orderId",
                 o."orderNumber"                        AS "orderNumber",
                 o.channel::text                        AS channel,
                 o.status::text                         AS "orderStatus",
                 o."fulfillmentState"::text             AS "fulfillmentState",
                 o."branchId"                           AS "branchId",
                 o."userId"                             AS "userId",
                 o."reconciliationState"                AS "reconciliationState",
                 o."reconciliationResolvedAt"           AS "reconciliationResolvedAt",
                 o."paidAt"                             AS "paidAt",
                 o.created_at                           AS "createdAt",
                 o.total_price::text                    AS "orderTotal",
                 COALESCE((
                   SELECT SUM(COALESCE(p.gateway_amount, p.amount))
                     FROM payment p
                    WHERE p."orderId" = o.id
                      AND p.status::text IN ('success', 'confirmed_unapplied')
                 ), 0)::text                            AS "confirmedHeld",
                 COALESCE((
                   SELECT SUM(COALESCE(p.gateway_amount, p.amount))
                     FROM payment p
                    WHERE p."orderId" = o.id
                      AND p.status::text = 'confirmed_unapplied'
                 ), 0)::text                            AS "confirmedUnapplied",
                 COALESCE((
                   SELECT SUM(COALESCE(p.gateway_amount, p.amount))
                     FROM payment p
                    WHERE p."orderId" = o.id
                      AND p.status::text = 'refunded'
                 ), 0)::text                            AS "refundedTotal",
                 EXISTS (
                   SELECT 1 FROM payment p
                    WHERE p."orderId" = o.id
                      AND p.status::text IN ('success', 'confirmed_unapplied')
                      AND (p.gateway_amount IS NULL
                           OR p.gateway_amount <> p.amount
                           OR p.amount <> o.total_price)
                 )                                      AS "hasAmountDiscrepancy",
                 EXISTS (
                   SELECT 1 FROM payment p
                    WHERE p."orderId" = o.id
                      AND p.requires_reconciliation
                      AND p.reconciled_at IS NULL
                 )                                      AS "hasUnappliedReceipt",
                 EXISTS (
                   SELECT 1 FROM payment p
                    WHERE p."orderId" = o.id
                      AND p.status::text = 'success'
                      AND p.gateway_amount IS NOT NULL
                      AND p.gateway_amount >= 0
                      AND p.gateway_amount = p.amount
                      AND p.amount = o.total_price
                      AND (p.reconciliation_reason IS NULL
                           OR NOT (p.reconciliation_reason = ANY(
                                     ARRAY['amount_mismatch','amount_missing',
                                           'amount_invalid']))
                           OR p.reconciled_at IS NOT NULL)
                 )                                      AS "fulfilmentAuthorized",
                 (EXISTS (
                    SELECT 1 FROM payment p
                     WHERE p."orderId" = o.id
                       AND p.requires_reconciliation
                       AND p.reconciled_at IS NULL)
                  OR (o.status::text = 'paid'
                      AND o."fulfillmentState"::text
                            IN ('pending', 'awaiting_stock'))
                  OR o."reconciliationState" IS NOT NULL)
                                                        AS "isCase"
            FROM orders o
        ) c
       WHERE ${where}`;
  }

  /**
   * THE CASE STAGES — the three tabs an ordinary store manager actually works.
   *
   * The queue's own vocabulary (case type, fulfilment state, payment state,
   * closed flag) is precise and is what an engineer needs; it is not what a
   * manager opens the page to find out. These three answer "what do I have to
   * do", and they PARTITION the queue — every case is in exactly one, so a
   * manager who works all three has worked everything and no case can hide
   * between two tabs.
   *
   *   needs_action  nobody has decided anything yet. This is the default view.
   *   tracking      a decision has been made and is waiting on something
   *                 external — a refund to be performed in the gateway's own
   *                 panel, or stock to arrive.
   *   closed        finished, one way or the other.
   */
  private stagePredicate(stage: ReconciliationStage): string {
    switch (stage) {
      case 'needs_action':
        return `(c."reconciliationResolvedAt" IS NULL
                 AND (c."reconciliationState" IS NULL
                      OR c."reconciliationState" = 'open'))`;
      case 'tracking':
        return `(c."reconciliationResolvedAt" IS NULL
                 AND c."reconciliationState" IN ('refund_required', 'backordered'))`;
      case 'closed':
        return `c."reconciliationResolvedAt" IS NOT NULL`;
    }
  }

  /**
   * The counts behind the summary cards, in ONE query.
   *
   * Five `COUNT(*) FILTER` clauses over the same projection the list uses, so
   * the cards and the rows cannot disagree — and one round trip rather than
   * five, because this renders above the queue on first paint.
   *
   * "Resolved today" is the only date-bounded figure and it uses the Asia/Tehran
   * calendar day, computed in PostgreSQL, for the same reason the reports do:
   * a manager asking "what did we close today" means their day, not UTC's.
   */
  async queueSummary(): Promise<ReconciliationQueueSummaryView> {
    const rows = await this.dataSource.query<
      Array<{
        needsAction: string;
        tracking: string;
        closed: string;
        paidOrderIncomplete: string;
        stockProblem: string;
        refundRequired: string;
        unappliedReceipt: string;
        resolvedToday: string;
        amountDiscrepancy: string;
      }>
    >(
      `SELECT
         COUNT(*) FILTER (WHERE ${this.stagePredicate('needs_action')})::text
           AS "needsAction",
         COUNT(*) FILTER (WHERE ${this.stagePredicate('tracking')})::text
           AS "tracking",
         COUNT(*) FILTER (WHERE ${this.stagePredicate('closed')})::text
           AS "closed",
         COUNT(*) FILTER (
           WHERE c."reconciliationResolvedAt" IS NULL
             AND c."orderStatus" = 'paid'
             AND c."fulfillmentState" IN ('pending', 'awaiting_stock'))::text
           AS "paidOrderIncomplete",
         COUNT(*) FILTER (
           WHERE c."reconciliationResolvedAt" IS NULL
             AND (c."fulfillmentState" = 'awaiting_stock'
                  OR c."reconciliationState" = 'backordered'))::text
           AS "stockProblem",
         COUNT(*) FILTER (
           WHERE c."reconciliationResolvedAt" IS NULL
             AND c."reconciliationState" = 'refund_required')::text
           AS "refundRequired",
         COUNT(*) FILTER (
           WHERE c."reconciliationResolvedAt" IS NULL
             AND c."hasUnappliedReceipt")::text
           AS "unappliedReceipt",
         COUNT(*) FILTER (
           WHERE c."reconciliationResolvedAt"
                   >= (CAST((now() AT TIME ZONE $1)::date AS timestamp)
                       AT TIME ZONE $1)
             AND c."reconciliationResolvedAt"
                   <  (CAST((now() AT TIME ZONE $1)::date + INTERVAL '1 day'
                            AS timestamp) AT TIME ZONE $1))::text
           AS "resolvedToday",
         COUNT(*) FILTER (
           WHERE c."reconciliationResolvedAt" IS NULL
             AND c."hasAmountDiscrepancy")::text
           AS "amountDiscrepancy"
       FROM (${this.caseSelect('c."isCase"')}) c`,
      [this.timezone],
    );

    const row = rows[0];
    const read = (value: string | undefined): number => Number(value ?? 0);

    return {
      timezone: this.timezone,
      needsAction: read(row?.needsAction),
      tracking: read(row?.tracking),
      closed: read(row?.closed),
      paidOrderIncomplete: read(row?.paidOrderIncomplete),
      stockProblem: read(row?.stockProblem),
      refundRequired: read(row?.refundRequired),
      unappliedReceipt: read(row?.unappliedReceipt),
      resolvedToday: read(row?.resolvedToday),
      amountDiscrepancy: read(row?.amountDiscrepancy),
    };
  }

  /**
   * Translates the filter DTO into SQL over the case projection.
   *
   * Every value is a bound parameter — there is no interpolation of caller
   * input into the statement anywhere in this file. The case-type filters are
   * expressed against the SAME computed columns the projection returns, so what
   * an operator filters on and what they then read cannot disagree.
   */
  private buildQueueFilter(query: ReconciliationQueryDto): {
    where: string;
    params: unknown[];
  } {
    const clauses: string[] = ['c."isCase"'];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    switch (query.caseType) {
      case ReconciliationCaseType.UNAPPLIED_RECEIPT:
        clauses.push(`c."hasUnappliedReceipt"`);
        break;
      case ReconciliationCaseType.FULFILMENT_INCOMPLETE:
        clauses.push(
          `(c."orderStatus" = ${bind(OrderStatusEnum.PAID)}
            AND c."fulfillmentState" = ${bind(FulfillmentStateEnum.PENDING)})`,
        );
        break;
      case ReconciliationCaseType.AWAITING_STOCK:
        clauses.push(
          `(c."orderStatus" = ${bind(OrderStatusEnum.PAID)}
            AND c."fulfillmentState" = ${bind(
              FulfillmentStateEnum.AWAITING_STOCK,
            )})`,
        );
        break;
      case ReconciliationCaseType.OPERATOR_OPEN:
        clauses.push(
          `(c."reconciliationState" IS NOT NULL
            AND c."reconciliationResolvedAt" IS NULL)`,
        );
        break;
      default:
        break;
    }

    if (query.paymentStatus !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM payment p
                  WHERE p."orderId" = c."orderId"
                    AND p.status::text = ${bind(query.paymentStatus)})`,
      );
    }
    if (query.orderStatus !== undefined) {
      clauses.push(`c."orderStatus" = ${bind(query.orderStatus)}`);
    }
    if (query.fulfillmentState !== undefined) {
      clauses.push(`c."fulfillmentState" = ${bind(query.fulfillmentState)}`);
    }
    if (query.branchId !== undefined) {
      clauses.push(`c."branchId" = ${bind(query.branchId)}`);
    }
    if (query.createdFrom !== undefined) {
      clauses.push(`c."createdAt" >= ${bind(query.createdFrom)}::timestamptz`);
    }
    if (query.createdTo !== undefined) {
      clauses.push(`c."createdAt" <= ${bind(query.createdTo)}::timestamptz`);
    }
    if (query.resolved === true) {
      clauses.push(`c."reconciliationResolvedAt" IS NOT NULL`);
    } else if (query.resolved === false) {
      clauses.push(`c."reconciliationResolvedAt" IS NULL`);
    }

    /*
     * `stage` is the SIMPLE view and `resolved` is the technical one, and they
     * are ANDed rather than one overriding the other. That is deliberate: a
     * contradictory pair (`stage=closed&resolved=false`) then returns nothing,
     * which is the honest answer, instead of silently ignoring whichever the
     * implementation happened to check second.
     */
    if (query.stage !== undefined) {
      clauses.push(this.stagePredicate(query.stage));
    }

    return { where: clauses.join(' AND '), params };
  }

  // =========================================================================
  // Projection
  // =========================================================================

  private caseTypesOf(row: CaseRow): ReconciliationCaseType[] {
    const types: ReconciliationCaseType[] = [];
    if (row.hasUnappliedReceipt) {
      types.push(ReconciliationCaseType.UNAPPLIED_RECEIPT);
    }
    if (row.orderStatus === OrderStatusEnum.PAID) {
      if (row.fulfillmentState === FulfillmentStateEnum.PENDING) {
        types.push(ReconciliationCaseType.FULFILMENT_INCOMPLETE);
      } else if (row.fulfillmentState === FulfillmentStateEnum.AWAITING_STOCK) {
        types.push(ReconciliationCaseType.AWAITING_STOCK);
      }
    }
    if (
      row.reconciliationState !== null &&
      row.reconciliationResolvedAt === null
    ) {
      types.push(ReconciliationCaseType.OPERATOR_OPEN);
    }
    return types;
  }

  private toSummary(row: CaseRow): ReconciliationCaseSummaryView {
    return {
      orderId: Number(row.orderId),
      orderNumber: row.orderNumber ?? null,
      channel: row.channel,
      orderStatus: row.orderStatus,
      fulfillmentState: row.fulfillmentState,
      branchId: row.branchId === null ? null : Number(row.branchId),
      caseTypes: this.caseTypesOf(row),
      reconciliationState: row.reconciliationState,
      reconciliationResolvedAt: iso(row.reconciliationResolvedAt),
      fulfilmentAuthorized: row.fulfilmentAuthorized,
      money: {
        orderTotal: row.orderTotal,
        confirmedHeld: row.confirmedHeld,
        confirmedUnapplied: row.confirmedUnapplied,
        refundedTotal: row.refundedTotal,
        hasAmountDiscrepancy: row.hasAmountDiscrepancy,
      },
      paidAt: iso(row.paidAt),
      createdAt: iso(row.createdAt) as string,
    };
  }

  private async buildDetail(
    manager: EntityManager,
    row: CaseRow,
    actorPermissions: readonly string[] = [],
  ): Promise<ReconciliationCaseDetailView> {
    const orderId = Number(row.orderId);

    const receipts: Array<Record<string, unknown>> = await manager.query(
      `SELECT id,
              status::text          AS status,
              amount::text          AS amount,
              gateway_amount::text  AS gateway_amount,
              gateway_amount_raw,
              ref_number,
              requires_reconciliation,
              reconciliation_reason,
              reconciled_at,
              paid_at,
              created_at
         FROM payment
        WHERE "orderId" = $1
        ORDER BY id ASC`,
      [orderId],
    );

    // The promoted diagnosis — the authoritative computation, not a copy.
    const clauses = await this.fulfilment.readAuthorizationClauses(
      manager,
      orderId,
    );

    const contact: Array<{
      userId: number | null;
      customerId: number | null;
      mobile: string | null;
      displayName: string | null;
    }> = await manager.query(
      `SELECT o."userId"                       AS "userId",
              o."customerId"                   AS "customerId",
              COALESCE(c.mobile, u.mobile)     AS mobile,
              COALESCE(c.name, u.username)     AS "displayName"
         FROM orders o
         LEFT JOIN users u ON u.id = o."userId"
         LEFT JOIN customers c ON c.id = o."customerId"
        WHERE o.id = $1`,
      [orderId],
    );

    const stockRows: Array<{
      fulfilment_movements: string;
      net_delta: string | null;
      allocated: string | null;
      ordered: string | null;
    }> = await manager.query(
      `SELECT (SELECT COUNT(*) FROM stock_movements
                WHERE "orderId" = $1 AND reason::text = $2)::text
                 AS fulfilment_movements,
              (SELECT COALESCE(SUM(delta), 0) FROM stock_movements
                WHERE "orderId" = $1)::text AS net_delta,
              (SELECT COALESCE(SUM(quantity), 0) FROM stock_reservations
                WHERE "orderId" = $1 AND kind = 'order' AND status = 'active')::text
                 AS allocated,
              (SELECT COALESCE(SUM(quantity), 0) FROM order_items
                WHERE "orderId" = $1)::text AS ordered`,
      [orderId, StockMovementReason.ONLINE_FULFILLMENT],
    );
    const stock = stockRows[0];

    const actions = await manager.getRepository(PaymentAction).find({
      where: { orderId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    return {
      ...this.toSummary(row),
      customer: {
        userId: contact[0]?.userId === null ? null : Number(contact[0]?.userId),
        customerId:
          contact[0]?.customerId === null
            ? null
            : Number(contact[0]?.customerId),
        mobile: contact[0]?.mobile ?? null,
        displayName: contact[0]?.displayName ?? null,
      },
      receipts: receipts.map((r) => ({
        id: Number(r.id),
        status: r.status as PaymentStatusEnum,
        amount: r.amount as string,
        gatewayAmount: (r.gateway_amount as string | null) ?? null,
        gatewayAmountRaw: (r.gateway_amount_raw as string | null) ?? null,
        refNumber: (r.ref_number as string | null) ?? null,
        requiresReconciliation: Boolean(r.requires_reconciliation),
        reconciliationReason:
          r.reconciliation_reason as ReconciliationCaseDetailView['receipts'][number]['reconciliationReason'],
        reconciledAt: iso(r.reconciled_at as Date | null),
        paidAt: iso(r.paid_at as Date | null),
        createdAt: iso(r.created_at as Date) as string,
      })),
      authorizationClauses: clauses.map((clause) => ({
        paymentId: clause.id,
        isSuccess: clause.is_success,
        hasGatewayAmount: clause.has_gateway_amount,
        gatewayMatchesAmount: clause.gateway_matches_amount,
        amountMatchesOrder: clause.amount_matches_order,
        reasonResolved: clause.reason_resolved,
        qualifies:
          clause.is_success &&
          clause.has_gateway_amount &&
          clause.gateway_matches_amount &&
          clause.amount_matches_order &&
          clause.reason_resolved,
      })),
      stock: {
        fulfilmentMovements: Number(stock?.fulfilment_movements ?? '0'),
        netMovementDelta: Number(stock?.net_delta ?? '0'),
        activeAllocationUnits: Number(stock?.allocated ?? '0'),
        orderedUnits: Number(stock?.ordered ?? '0'),
      },
      actions: actions.map((action) => ({
        id: action.id,
        action: action.action,
        paymentId: action.paymentId,
        actorDisplaySnapshot: action.actorDisplaySnapshot,
        actorUserId: action.actorUserId,
        reason: action.reason,
        fromPaymentStatus: action.fromPaymentStatus,
        toPaymentStatus: action.toPaymentStatus,
        fromOrderStatus: action.fromOrderStatus,
        toOrderStatus: action.toOrderStatus,
        fromReconciliationState: action.fromReconciliationState,
        toReconciliationState: action.toReconciliationState,
        externalReference: action.externalReference,
        amount: action.amount === null ? null : String(action.amount),
        createdAt: iso(action.createdAt) as string,
      })),
      allowedActions: this.allowedActionsFor(row, actorPermissions),
    };
  }

  /**
   * Which buttons the server will honour from THIS state FOR THIS CALLER.
   *
   * It mirrors the guards in the mutations above and is never consulted by
   * them: the source-state validation happens under a row lock, inside the
   * transaction, where it cannot be raced.
   *
   * THE PERMISSION FILTER IS NEW, AND IT MATTERS. This used to answer from the
   * case's state alone, so a `reconciliation.read` auditor with no
   * `reconciliation.act` was handed all five critical-risk actions. The
   * console renders exactly this list, so they saw five live-looking buttons,
   * typed a mandatory reason into one, and collected a 403 — after composing
   * the justification. `adminOrderCapabilities(order, permissions)` already
   * took the caller into account for orders; this brings reconciliation into
   * line.
   *
   * Shaping a response is NOT authorising a request. Every mutation still
   * declares `reconciliation.read` + `reconciliation.act` on the route, and a
   * caller who forges past an empty list is refused by the guard.
   */
  private allowedActionsFor(
    row: CaseRow,
    actorPermissions: readonly string[] = [],
  ): ReconciliationActionName[] {
    if (!actorPermissions.includes('reconciliation.act')) {
      return [];
    }
    if (isTerminalReconciliationState(row.reconciliationState)) {
      return [];
    }

    const allowed: ReconciliationActionName[] = [];
    const unallocated =
      row.orderStatus === OrderStatusEnum.PAID &&
      UNALLOCATED_FULFILMENT_STATES.includes(row.fulfillmentState);

    if (unallocated) {
      allowed.push(ReconciliationActionName.RETRY_FULFILMENT);
      allowed.push(ReconciliationActionName.MARK_BACKORDER);
    }
    allowed.push(ReconciliationActionName.MARK_REFUND_REQUIRED);
    allowed.push(ReconciliationActionName.CONFIRM_EXTERNAL_REFUND);
    if (row.reconciliationState !== OrderReconciliationState.REFUND_REQUIRED) {
      allowed.push(ReconciliationActionName.RESOLVE_NO_ACTION);
    }
    return allowed;
  }

  // =========================================================================
  // Shared machinery
  // =========================================================================

  /**
   * The replay protocol, identical in shape to the POS sale's.
   *
   * `peek` runs first and OUTSIDE any write transaction, so an ordinary retry
   * never opens one. `claim` is then the FIRST WRITE of a short transaction of
   * its own — held only long enough to reserve the key — and `complete` stores
   * the response after the work committed.
   *
   * WHY THE KEY IS CLAIMED IN A SEPARATE TRANSACTION HERE, unlike the POS sale.
   * Two of these actions (`retryFulfilment`) delegate to `FulfilmentService`,
   * which opens transactions of its own and takes `FOR UPDATE SKIP LOCKED` on
   * the order; nesting that inside the claim transaction would make the claim
   * hold the order row and the SKIP LOCKED would then skip our own work. The
   * cost is a narrow window in which a crash between the claim and the effect
   * leaves an IN_PROGRESS key, which answers a retry with 409
   * `IDEMPOTENCY_REQUEST_IN_PROGRESS` rather than replaying — visible, safe,
   * and resolvable by issuing a new key. The alternative (no key at all, or a
   * key written after the effect) risks performing the decision twice, which is
   * the one thing that must not happen.
   */
  private async withIdempotency<T>(
    orderId: number,
    idempotencyKey: string,
    payload: unknown,
    work: () => Promise<ReconciliationEffect<T>>,
  ): Promise<T> {
    const requestHash = requestHashOf({ orderId, ...(payload as object) });

    const replay = await peekIdempotencyKey(
      this.dataSource.manager,
      IdempotencyScope.PAYMENT_RECONCILIATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay.responseBody as T;

    const claim = await this.dataSource
      .transaction((manager) =>
        claimIdempotencyKey(
          manager,
          IdempotencyScope.PAYMENT_RECONCILIATION,
          idempotencyKey,
          requestHash,
        ),
      )
      .catch((error: unknown) => {
        if (error instanceof IdempotentReplayError) return error;
        throw error;
      });
    if (claim instanceof IdempotentReplayError) {
      return claim.responseBody as T;
    }

    let effect: ReconciliationEffect<T>;
    try {
      effect = await work();
    } catch (error) {
      // THE DECISION DID NOT HAPPEN, SO ITS KEY MUST NOT SURVIVE.
      //
      // The claim committed in a transaction of its own (see above), so a
      // refused decision would otherwise leave an IN_PROGRESS row behind and
      // the operator's honest retry would answer 409
      // `IDEMPOTENCY_REQUEST_IN_PROGRESS` — hiding the REAL reason
      // (`ORDER_NOT_RETRYABLE`, `REFUND_AMOUNT_INVALID`, ...) behind a message
      // that says "wait". Releasing the key restores the POS contract's
      // property: a refused attempt may be retried with the SAME key once the
      // operator has fixed the request.
      //
      // Deleting is safe: nothing committed under this key, so there is no
      // stored response to protect, and a concurrent holder of the same key
      // cannot exist (it would have been refused by the unique index while we
      // held it).
      await this.releaseIdempotencyKey(idempotencyKey, requestHash);
      throw error;
    }

    // AFTER the business transaction committed, never inside it: an event
    // emitted from inside a transaction announces state that may still roll
    // back.
    this.publish(effect.row);
    for (const row of effect.restored ?? []) {
      this.realtime.emitStockEvent({
        variantId: row.variantId,
        newStock: row.balanceAfter,
        branchId: effect.row.branchId,
      });
    }
    /*
     * Restored units, and — new here — units CONSUMED by a
     * `retryFulfilment`. That action drives the fulfilment service and really
     * does move physical stock, but its effect object carried no `consumed`
     * list, so it announced nothing at all: an operator could rescue a paid
     * order from the reconciliation queue and no storefront would learn that
     * the stock had gone.
     */
    void this.realtime.publishAvailabilityInvalidation(
      [
        ...(effect.restored ?? []).map((row) => row.variantId),
        ...(effect.consumed ?? []).map((row) => row.variantId),
      ],
      'stock',
    );

    await this.dataSource.transaction((manager) =>
      completeIdempotencyKey(manager, claim, 200, effect.result),
    );
    return effect.result;
  }

  /** Best-effort release of a key whose decision was refused. */
  private async releaseIdempotencyKey(
    key: string,
    requestHash: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM idempotency_keys
          WHERE scope::text = $1 AND key = $2 AND "requestHash" = $3
            AND status::text = 'in_progress'`,
        [IdempotencyScope.PAYMENT_RECONCILIATION, key, requestHash],
      );
    } catch (error: unknown) {
      // Leaving the key behind is inconvenient, never unsafe — it can only
      // refuse a retry, never duplicate a decision. Do not mask the original
      // failure with this one.
      this.logger.warn(
        `could not release reconciliation idempotency key: ${String(error)}`,
      );
    }
  }

  /** `SELECT ... FOR UPDATE` on the order row, then the case projection. */
  private async lockCase(
    manager: EntityManager,
    orderId: number,
  ): Promise<CaseRow> {
    const locked: Array<{ id: number }> = await manager.query(
      `SELECT id FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (locked.length === 0) throw this.caseNotFound(orderId);

    const row = await this.loadCaseRowOrThrow(manager, orderId);
    this.assertAddressable(row);
    return row;
  }

  /**
   * The projection for ONE order, whether or not it is still a case.
   *
   * Used for the AFTER state of every mutation: a successful retry, a confirmed
   * refund and a resolution can all legitimately take the order out of the
   * queue, and answering 404 for the order the operator just fixed would be
   * absurd. The "is it a case at all" check lives in `lockCase`, which every
   * mutation runs FIRST.
   */
  private async loadCaseRowOrThrow(
    manager: EntityManager,
    orderId: number,
  ): Promise<CaseRow> {
    const rows: CaseRow[] = await manager.query(
      this.caseSelect(`c."orderId" = $1`),
      [orderId],
    );
    const row = rows[0];
    if (!row) throw this.caseNotFound(orderId);
    return row;
  }

  /**
   * The order must actually BE a reconciliation case — acting on an order with
   * nothing outstanding is not a reconciliation decision, and this API
   * deliberately does not duplicate `POST /orders/:id/void` or `/return`.
   *
   * A CASE THAT HAS ALREADY BEEN CLOSED IS STILL ADDRESSABLE. It is no longer
   * `isCase` (that is what "closed" means), but answering 404 for it would tell
   * an operator who just resolved it that it never existed, and would turn a
   * double-confirmation attempt — the exact thing that must be refused clearly —
   * into "not found". So a row carrying ANY `reconciliationState` passes here
   * and is refused a step later by `assertNotResolved`, with the precise code
   * `RECONCILIATION_ALREADY_RESOLVED`.
   */
  private assertAddressable(row: CaseRow): void {
    if (!row.isCase && row.reconciliationState === null) {
      throw this.caseNotFound(Number(row.orderId));
    }
  }

  private assertNotResolved(row: CaseRow): void {
    if (isTerminalReconciliationState(row.reconciliationState)) {
      throw new ConflictException({
        error: ReconciliationErrorCode.RECONCILIATION_ALREADY_RESOLVED,
        message: ReconciliationMessages.ALREADY_RESOLVED,
        orderId: Number(row.orderId),
        reconciliationState: row.reconciliationState,
        reconciliationResolvedAt: iso(row.reconciliationResolvedAt),
      });
    }
  }

  private caseNotFound(orderId: number): NotFoundException {
    return new NotFoundException({
      error: ReconciliationErrorCode.RECONCILIATION_CASE_NOT_FOUND,
      message: ReconciliationMessages.CASE_NOT_FOUND,
      orderId,
    });
  }

  /**
   * The ONLY writer of `orders."reconciliationState"` in this service.
   *
   * `"reconciliationResolvedAt"` is stamped from the DATABASE clock and only
   * for the two terminal states — which is also enforced by
   * `ck_orders_reconciliation_resolved`, so a future caller that gets this
   * wrong fails loudly instead of producing a row that claims to be resolved
   * without saying which resolution it was.
   */
  private async setReconciliationState(
    manager: EntityManager,
    orderId: number,
    next: OrderReconciliationState,
  ): Promise<void> {
    const terminal = isTerminalReconciliationState(next);
    await manager.query(
      `UPDATE orders
          SET "reconciliationState" = $2,
              "reconciliationResolvedAt" = ${terminal ? 'now()' : 'NULL'}
        WHERE id = $1`,
      [orderId, next],
    );
  }

  /**
   * Writes the append-only audit row. There is deliberately no update or delete
   * counterpart anywhere in this codebase, and the database refuses both.
   */
  private async writeAudit(
    manager: EntityManager,
    input: {
      orderId: number;
      paymentId: number | null;
      action: PaymentActionType;
      actorUserId: number;
      reason: string;
      amount?: number | null;
      externalReference?: string | null;
      fromPaymentStatus?: string | null;
      toPaymentStatus?: string | null;
      fromOrderStatus?: string | null;
      toOrderStatus?: string | null;
      fromReconciliationState?: string | null;
      toReconciliationState?: string | null;
      idempotencyKey: string;
    },
  ): Promise<number> {
    const actor = await this.loadActor(manager, input.actorUserId);
    const inserted = await manager.getRepository(PaymentAction).insert({
      orderId: input.orderId,
      paymentId: input.paymentId,
      action: input.action,
      actorUserId: actor.id,
      actorDisplaySnapshot: this.displayNameOf(actor),
      reason: input.reason,
      amount: input.amount ?? null,
      externalReference: input.externalReference ?? null,
      fromPaymentStatus: input.fromPaymentStatus ?? null,
      toPaymentStatus: input.toPaymentStatus ?? null,
      fromOrderStatus: input.fromOrderStatus ?? null,
      toOrderStatus: input.toOrderStatus ?? null,
      fromReconciliationState: input.fromReconciliationState ?? null,
      toReconciliationState: input.toReconciliationState ?? null,
      idempotencyKey: input.idempotencyKey,
    });

    /*
     * THE SECOND TRAIL, and why both exist.
     *
     * `payment_actions` is the CASE's history: it is what the reconciliation
     * screen renders, it carries the from/to states of every entity the
     * decision moved, and it is the record a dispute is settled from.
     * `admin_audit_log` is the ADMINISTRATOR's history: "what did this person
     * do across the whole system last week", which no per-case table can
     * answer.
     *
     * Written here rather than in each of the five actions, because this is
     * the one place all of them pass through — adding it per action is how the
     * sixth one ships without it. Same transaction, so a decision that
     * committed without a record of who made it is not representable.
     */
    await this.audit.record(
      {
        actor: {
          userId: actor.id,
          display: this.displayNameOf(actor),
          audience: 'admin',
        },
        action: AuditAction.RECONCILIATION_ACTION,
        targetType: AuditTarget.ORDER,
        targetId: input.orderId,
        summary: {
          decision: input.action,
          reason: input.reason,
          before: {
            paymentStatus: input.fromPaymentStatus ?? null,
            orderStatus: input.fromOrderStatus ?? null,
            reconciliationState: input.fromReconciliationState ?? null,
          },
          after: {
            paymentStatus: input.toPaymentStatus ?? null,
            orderStatus: input.toOrderStatus ?? null,
            reconciliationState: input.toReconciliationState ?? null,
          },
          amount: input.amount ?? null,
          externalReference: input.externalReference ?? null,
        },
      },
      manager,
    );

    return (inserted.identifiers[0] as { id: number }).id;
  }

  private async loadActor(
    manager: EntityManager,
    userId: number,
  ): Promise<User> {
    const user = await manager
      .getRepository(User)
      .findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(UserMessages.USER_NOT_FOUND);
    return user;
  }

  private displayNameOf(user: User): string {
    return user.username ?? user.mobile ?? `user#${user.id}`;
  }

  /**
   * SCOPED REALTIME ONLY.
   *
   * `emitOrderEvent` reaches admins plus the owning branch; `emitToUser`
   * reaches exactly one customer on their own room. There is no global
   * broadcast on any path in this service — a reconciliation case is, by
   * definition, information about one customer's money.
   *
   * The customer payload carries ONLY facts they are already entitled to about
   * their own order, and specifically no operator reason, no gateway figure or
   * reference, and no internal error text.
   */
  private publish(row: CaseRow): void {
    const orderId = Number(row.orderId);
    this.realtime.emitOrderEvent('order.status.updated', {
      orderId,
      status: row.orderStatus,
      fulfillmentState: row.fulfillmentState,
      reconciliationState: row.reconciliationState,
      branchId: row.branchId === null ? null : Number(row.branchId),
    });

    if (row.userId !== null && row.userId !== undefined) {
      // The customer's OWN room, and only facts about their own order. No
      // operator reason, no gateway figure or reference, no branch, no internal
      // error text — the customer-safe reading of this state is
      // `reviewState`, derived in `toCustomerOrderReviewState`.
      this.realtime.emitToUser(Number(row.userId), 'order.status.updated', {
        orderId,
        status: row.orderStatus,
        fulfillmentState: row.fulfillmentState,
      });
    }
  }
}

/** `Date | null` -> ISO-8601, the shape the wire shows anyway. */
function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined
    ? null
    : new Date(value).toISOString();
}
