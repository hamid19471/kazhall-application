import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { IdempotencyScope } from 'src/common/entities/idempotency-key.entity';
import { OrderMessages } from 'src/common/constants/order.messages';
import { UserMessages } from 'src/common/constants/user.messages';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_REQUEST_IN_PROGRESS,
} from 'src/common/services/idempotency.service';
import { AuditService, AuditActor } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { InventoryService } from '../inventory/inventory.service';
import { ConsumedVariantResult } from '../inventory/inventory.types';
import { StockMovementReason } from '../inventory/entities/stock-movement.entity';
import {
  LineCostState,
  ValuationInvariantError,
  reverseRevenue,
} from '../inventory/valuation/valuation';
import {
  CostingErrorCodes,
  costingError,
} from '../inventory/valuation/costing.errors';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import UserRoleEnum from '../user/enums/user-role.enum';
import { User } from '../user/entities/user.entity';
import { OrderStatusEnum } from './enums/order-status.enum';
import {
  CreateLineAdjustmentDto,
  LineAdjustmentKind,
  REFUNDING_KINDS,
  RETURNING_KINDS,
} from './dto/create-line-adjustment.dto';
import {
  IdempotentReplayError,
  claimIdempotencyKey,
  completeIdempotencyKey,
  peekIdempotencyKey,
  requestHashOf,
} from './idempotency.helper';

/**
 * The statuses a LINE may be adjusted in: the money was taken and the sale has
 * not been reversed wholesale. It is `ELIGIBLE_SALE_STATUSES` minus
 * `refunded` — a refunded order has nothing left to give back — and the void
 * re-inclusion is absent on purpose: a voided sale is already fully reversed.
 */
export const ADJUSTABLE_ORDER_STATUSES: readonly OrderStatusEnum[] =
  Object.freeze([
    OrderStatusEnum.PAID,
    OrderStatusEnum.PROCESSING,
    OrderStatusEnum.SHIPPED,
    OrderStatusEnum.DELIVERED,
  ]);

/**
 * Persian, operator-facing. The stable machine codes live in
 * `costing.errors.ts`; only refusals that have NO contract code (a line that
 * is not part of the order) are phrased here.
 */
export const LineAdjustmentMessages = Object.freeze({
  CREATED: 'برگشت / بازپرداخت اقلام ثبت شد.',
  LINE_NOT_IN_ORDER: 'این قلم متعلق به این سفارش نیست.',
  IDEMPOTENCY_KEY_REQUIRED:
    'سرآیند Idempotency-Key برای ثبت برگشت اقلام الزامی است. برنامهٔ مدیریت برای هر ثبت یک کلید (UUIDv4) می‌سازد و در تلاش دوباره همان را می‌فرستد؛ کاربر هرگز آن را تایپ نمی‌کند.',
  IDEMPOTENCY_KEY_INVALID:
    'Idempotency-Key نامعتبر است: ۸ تا ۲۰۰ نویسه، فقط حروف، ارقام و . _ : - (بدون فاصله و ویرگول).',
  IDEMPOTENCY_KEY_REUSED:
    'این کلید تکرار قبلاً برای درخواست دیگری استفاده شده است؛ برای ثبت جدید کلید تازه بسازید.',
  IDEMPOTENCY_REQUEST_IN_PROGRESS:
    'درخواست دیگری با همین کلید در حال انجام است؛ کمی بعد دوباره تلاش کنید.',
  FORBIDDEN: 'فقط مدیر کل می‌تواند برگشت یا بازپرداخت اقلام را ثبت کند.',
});

/** The authenticated principal, as the token describes it. */
export interface LineAdjustmentActor {
  userId: number;
  roles: UserRoleEnum[];
  audit: AuditActor;
}

/** One row of the response — contract §13. Money is an integer-Rial string. */
export interface LineAdjustmentView {
  id: number;
  orderItemId: number;
  revenueQuantity: number;
  revenueReversed: string;
  restockedKnownQuantity: number;
  restockedUnknownQuantity: number;
  cogsReversed: string;
}

export interface LineAdjustmentResponse {
  orderId: number;
  kind: LineAdjustmentKind;
  adjustments: LineAdjustmentView[];
  totals: {
    revenueReversed: string;
    cogsReversed: string;
    unitsRestocked: number;
  };
}

type LoadedLine = Awaited<
  ReturnType<InventoryService['loadLineCostStates']>
>[number];

/**
 * ============================================================================
 * PARTIAL RETURNS AND REFUNDS — `POST /admin/orders/:orderId/line-adjustments`
 * ============================================================================
 *
 * Contract: docs/PURCHASE-COST-ACCOUNTING.md §5, §5.1, §13.
 *
 * WHAT A LINE ADJUSTMENT IS. A recorded FACT about units of one sale: the
 * customer brought some back, or was given some money back, or both. Every
 * figure it writes is derived from the line's own history — revenue from the
 * line's unreversed total, COGS from the line's unreversed recognised cost —
 * and NEVER from the variant's current average. A unit sold at 10 000 and
 * returned after a receipt moved the average to 12 000 goes back at 10 000.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   - It never changes `orders.status`, `voidedAt` or `refundedAt`. The order
 *     is still a sale; the sales summary subtracts the partial refund through
 *     `lineRefundedTotal` (§5.1), dated by the adjustment's own `eventAt`.
 *   - It never touches `payments`. Like `confirmExternalRefund`, a refund here
 *     records money the operator ALREADY returned outside the system (cash
 *     from the till, a card-terminal reversal, a bank transfer). There is no
 *     gateway call, and marking the payment row refunded would be false: most
 *     of the payment still stands.
 *
 * LOCKS (§7): idempotency key → orders row → product_variants ASC (inside
 * `restockOrderLines`). Every read of what the line has already reversed is
 * taken under the order row lock, so two adjustments racing for the same line
 * serialise on the order and the second one sees the first one's rows. The
 * bounds trigger on `order_item_adjustments` re-checks the sums regardless.
 *
 * WHY THE WHOLE-ORDER PATHS REFUSE AFTERWARDS. The sales summary books a
 * whole-order refund at the order's full `total_price`; letting one follow a
 * partial refund would count the partial amount twice. So once any `line` row
 * exists, void/return/external refund answer 409 `ORDER_HAS_LINE_ADJUSTMENTS`
 * (`InventoryService.assertNoLineAdjustments`) and the rest of the order is
 * reversed here.
 */
@Injectable()
export class OrderAdjustmentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * DEFENCE IN DEPTH, like `ReportsService.assertReportViewer`: the route
   * declares `@Roles(super_admin)`, and the data is protected again here so a
   * decorator lost in a refactor does not open cost figures to anyone else.
   * The ROLE, never a capability — cost is not delegable (§8, owner decision
   * B-2).
   */
  private assertSuperAdmin(actor: LineAdjustmentActor): void {
    if (!actor.roles.includes(UserRoleEnum.superAdmin)) {
      throw new ForbiddenException(LineAdjustmentMessages.FORBIDDEN);
    }
  }

  async create(
    orderId: number,
    dto: CreateLineAdjustmentDto,
    idempotencyKey: string,
    actor: LineAdjustmentActor,
  ): Promise<LineAdjustmentResponse> {
    this.assertSuperAdmin(actor);

    const reason = dto.reason.trim();
    /*
     * THE HASHED REQUEST. The lines are hashed in ascending `orderItemId`, so
     * the same adjustment sent with its lines in another order is the same
     * request — it produces exactly the same rows. The order id is part of it:
     * one key cannot be replayed onto a different order.
     */
    const requestHash = requestHashOf({
      orderId,
      kind: dto.kind,
      reason,
      lines: [...dto.lines]
        .map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity }))
        .sort((a, b) => a.orderItemId - b.orderItemId),
    });

    const replay = await this.withIdempotencyCodes(() =>
      peekIdempotencyKey(
        this.dataSource.manager,
        IdempotencyScope.ORDER_LINE_ADJUSTMENT,
        idempotencyKey,
        requestHash,
      ),
    );
    if (replay) return replay.responseBody as LineAdjustmentResponse;

    let restored: ConsumedVariantResult[] = [];
    let branchId: number | null = null;

    let response: LineAdjustmentResponse;
    try {
      response = await this.dataSource.transaction(async (manager) => {
        // FIRST WRITE: the key. A concurrent twin blocks here, before any row
        // lock, and replays once this commits.
        const claim = await this.withIdempotencyCodes(() =>
          claimIdempotencyKey(
            manager,
            IdempotencyScope.ORDER_LINE_ADJUSTMENT,
            idempotencyKey,
            requestHash,
          ),
        );

        const result = await this.apply(manager, {
          orderId,
          kind: dto.kind,
          reason,
          lines: dto.lines,
          idempotencyKey,
          actor,
        });
        restored = result.restored;
        branchId = result.branchId;

        await completeIdempotencyKey(manager, claim, 201, result.response);
        return result.response;
      });
    } catch (error) {
      if (error instanceof IdempotentReplayError) {
        return error.responseBody as LineAdjustmentResponse;
      }
      throw error;
    }

    /*
     * AFTER COMMIT, the same announcements `OrdersService.reverseOrder` makes
     * for restored stock: the staff stock frame with the new COUNT and the
     * customer-safe availability invalidation. Stock numbers only — never a
     * cost, never a Rial amount. A refund_only adjustment restores nothing and
     * so announces nothing.
     */
    for (const row of restored) {
      this.realtimeGateway.emitStockEvent({
        variantId: row.variantId,
        newStock: row.balanceAfter,
        branchId,
      });
    }
    if (restored.length > 0) {
      await this.realtimeGateway.publishAvailabilityInvalidation(
        restored.map((row) => row.variantId),
        'stock',
      );
    }

    return response;
  }

  /** Everything between the key claim and its completion, under one lock. */
  private async apply(
    manager: EntityManager,
    input: {
      orderId: number;
      kind: LineAdjustmentKind;
      reason: string;
      lines: Array<{ orderItemId: number; quantity: number }>;
      idempotencyKey: string;
      actor: LineAdjustmentActor;
    },
  ): Promise<{
    response: LineAdjustmentResponse;
    restored: ConsumedVariantResult[];
    branchId: number | null;
  }> {
    const { orderId, kind } = input;
    const refunds = REFUNDING_KINDS.includes(kind);
    const returns = RETURNING_KINDS.includes(kind);
    const now = new Date();

    // ---------------------------------------------------------------- lock
    const orders = await manager.query<
      Array<{
        id: number;
        status: string;
        voidedAt: Date | null;
        branchId: number | null;
        orderNumber: string | null;
      }>
    >(
      `SELECT id, status::text AS status, "voidedAt", "branchId", "orderNumber"
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = orders[0];
    if (!order) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);

    /*
     * ADJUSTABLE = a completed sale that has not been reversed wholesale.
     * `status` alone would admit nothing wrong today (a void sets CANCELED, a
     * return REFUNDED), but `voidedAt` is the reporting fact the summary keys
     * on, so it is checked by name rather than inferred.
     */
    if (
      order.voidedAt !== null ||
      !ADJUSTABLE_ORDER_STATUSES.includes(order.status as OrderStatusEnum)
    ) {
      throw costingError.conflict(CostingErrorCodes.ORDER_NOT_ADJUSTABLE, {
        orderId,
        status: order.status,
      });
    }

    const actorUser = await manager
      .getRepository(User)
      .findOne({ where: { id: input.actor.userId } });
    if (!actorUser) throw new NotFoundException(UserMessages.USER_NOT_FOUND);
    const actorDisplay =
      actorUser.username ?? actorUser.mobile ?? `user#${actorUser.id}`;

    // ------------------------------------------------------------- validate
    const states = await this.inventory.loadLineCostStates(manager, orderId);
    const byId = new Map(states.map((line) => [line.id, line]));

    const requested: Array<{ line: LoadedLine; quantity: number }> = [];
    input.lines.forEach((entry, index) => {
      const line = byId.get(entry.orderItemId);
      if (!line) {
        /*
         * 400, not 404 and not 409. The order exists and is adjustable; the
         * REQUEST named a line that is not part of it, which is malformed
         * input about this order — and answering 404 would let a caller probe
         * which `order_items` ids exist on other orders.
         */
        throw new BadRequestException({
          message: LineAdjustmentMessages.LINE_NOT_IN_ORDER,
          field: `lines[${index}].orderItemId`,
          orderItemId: entry.orderItemId,
        });
      }
      requested.push({ line, quantity: entry.quantity });
    });

    for (const { line, quantity } of requested) {
      if (line.costStatus === 'pending') {
        // Never consumed: an unfulfilled web order is cancelled, not refunded
        // piecemeal (§5.1).
        throw costingError.conflict(
          CostingErrorCodes.ORDER_LINE_NOT_FULFILLED,
          { orderItemId: line.id },
        );
      }
      const remaining = OrderAdjustmentsService.remainingOf(line);
      if (
        (refunds && quantity > remaining.revenueUnits) ||
        (returns && quantity > remaining.restockUnits)
      ) {
        throw costingError.conflict(CostingErrorCodes.ADJUSTMENT_EXCEEDS_LINE, {
          orderItemId: line.id,
          requested: quantity,
          remaining,
        });
      }
    }

    // ------------------------------------------------------------- restock
    let perLine = new Map<
      number,
      {
        knownQuantity: number;
        unknownQuantity: number;
        cogsReversed: bigint;
        movementId: number | null;
      }
    >();
    let restored: ConsumedVariantResult[] = [];
    if (returns) {
      const result = await this.inventory.restockOrderLines(manager, {
        orderId,
        reason: StockMovementReason.RETURN_RESTORE,
        actorUserId: actorUser.id,
        actorDisplaySnapshot: actorDisplay,
        reasonText: input.reason,
        lines: requested.map(({ line, quantity }) => ({
          orderItemId: line.id,
          // Non-null: `remainingOf` gives a variant-less line 0 restockable
          // units, so the bound above has already refused it.
          variantId: line.variantId as number,
          state: line.state,
          units: quantity,
        })),
        now,
      });
      perLine = result.perLine;
      restored = result.restored;
    }

    // -------------------------------------------------------------- ledger
    const adjustments: LineAdjustmentView[] = [];
    let revenueTotal = 0n;
    let cogsTotal = 0n;
    let unitsRestocked = 0;

    // Ascending line id: the response and the ledger rows read in the same
    // order whatever order the caller listed them in.
    requested.sort((a, b) => a.line.id - b.line.id);
    for (const { line, quantity } of requested) {
      const revenueReversed = refunds
        ? OrderAdjustmentsService.revenueFor(line.id, line.state, quantity)
        : 0n;
      const split = perLine.get(line.id) ?? {
        knownQuantity: 0,
        unknownQuantity: 0,
        cogsReversed: 0n,
        movementId: null,
      };
      if (returns && split.knownQuantity + split.unknownQuantity !== quantity) {
        throw costingError.invariant(
          `line ${line.id}: restocked ${split.knownQuantity + split.unknownQuantity} of ${quantity} unit(s)`,
        );
      }

      const id = await this.inventory.insertAdjustment(manager, {
        orderId,
        orderItemId: line.id,
        kind,
        scope: 'line',
        revenueQuantity: refunds ? quantity : 0,
        revenueReversed,
        restockedKnownQuantity: split.knownQuantity,
        restockedUnknownQuantity: split.unknownQuantity,
        cogsReversed: split.cogsReversed,
        eventAt: now,
        actorUserId: actorUser.id,
        actorDisplaySnapshot: actorDisplay,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        stockMovementId: split.movementId,
      });

      adjustments.push({
        id,
        orderItemId: line.id,
        revenueQuantity: refunds ? quantity : 0,
        revenueReversed: revenueReversed.toString(),
        restockedKnownQuantity: split.knownQuantity,
        restockedUnknownQuantity: split.unknownQuantity,
        cogsReversed: split.cogsReversed.toString(),
      });
      revenueTotal += revenueReversed;
      cogsTotal += split.cogsReversed;
      unitsRestocked += split.knownQuantity + split.unknownQuantity;
    }

    /*
     * THE AUDIT ROW, IN THE SAME TRANSACTION. Unlike void/return (whose
     * transaction `OrdersService` owns and does not expose, hence
     * `recordDetached` after the fact), this service owns its transaction, so
     * the codebase's own convention applies: the row commits with the change
     * it describes, a replay (which never reaches here) writes no second row,
     * and a failed audit write rolls the adjustment back.
     *
     * IDS, KIND AND QUANTITIES ONLY. `audit.read` is delegable; a Rial figure
     * here — revenue or cost — would hand cost data to whoever holds it (§8).
     * The reason text stays on the super_admin-only adjustment rows.
     */
    await this.audit.record(
      {
        actor: input.actor.audit,
        action: AuditAction.ORDER_LINES_ADJUSTED,
        targetType: AuditTarget.ORDER,
        targetId: orderId,
        targetLabel: order.orderNumber,
        summary: {
          orderId,
          kind,
          adjustmentIds: adjustments.map((a) => a.id),
          lines: adjustments.map((a) => ({
            orderItemId: a.orderItemId,
            revenueQuantity: a.revenueQuantity,
            restockedQuantity:
              a.restockedKnownQuantity + a.restockedUnknownQuantity,
          })),
          unitsRestocked,
        },
      },
      manager,
    );

    return {
      response: {
        orderId,
        kind,
        adjustments,
        totals: {
          revenueReversed: revenueTotal.toString(),
          cogsReversed: cogsTotal.toString(),
          unitsRestocked,
        },
      },
      restored,
      branchId: order.branchId === null ? null : Number(order.branchId),
    };
  }

  /**
   * What is left on a line, in the two independent senses §5 bounds:
   * revenue units not yet refunded, and consumed units not yet restocked. A
   * refund_only leaves the second untouched and a return_only the first, so
   * they are NOT the same number in general.
   *
   * A line whose variant no longer exists has nowhere to restock to, so it has
   * no restockable units; its money can still be refunded.
   */
  static remainingOf(line: LoadedLine): {
    revenueUnits: number;
    restockUnits: number;
  } {
    const s = line.state;
    return {
      revenueUnits: s.quantity - s.reversedRevenueQuantity,
      restockUnits:
        line.variantId === null
          ? 0
          : s.costKnownQuantity +
            s.costUnknownQuantity -
            s.restockedKnownQuantity -
            s.restockedUnknownQuantity,
    };
  }

  /** `reverseRevenue` with a pool invariant turned into the stable 500. */
  private static revenueFor(
    orderItemId: number,
    state: LineCostState,
    units: number,
  ): bigint {
    try {
      return reverseRevenue(state, units);
    } catch (error) {
      if (error instanceof ValuationInvariantError) {
        throw costingError.invariant(`line ${orderItemId}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * The shared helper answers a reused or in-flight key with `code` in
   * `details`; the costing contract (§13) puts the machine code in `error`,
   * like every other refusal on this route. Re-shaped here rather than in the
   * helper, whose envelope the POS vendors integrate against.
   */
  private async withIdempotencyCodes<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ConflictException) {
        const body = error.getResponse() as { code?: unknown };
        if (body?.code === IDEMPOTENCY_KEY_REUSED) {
          throw new ConflictException({
            error: IDEMPOTENCY_KEY_REUSED,
            code: IDEMPOTENCY_KEY_REUSED,
            message: LineAdjustmentMessages.IDEMPOTENCY_KEY_REUSED,
          });
        }
        if (body?.code === IDEMPOTENCY_REQUEST_IN_PROGRESS) {
          throw new ConflictException({
            error: IDEMPOTENCY_REQUEST_IN_PROGRESS,
            code: IDEMPOTENCY_REQUEST_IN_PROGRESS,
            message: LineAdjustmentMessages.IDEMPOTENCY_REQUEST_IN_PROGRESS,
          });
        }
      }
      throw error;
    }
  }
}
