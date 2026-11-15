import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { IdempotencyScope } from 'src/common/entities/idempotency-key.entity';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_REQUEST_IN_PROGRESS,
} from 'src/common/services/idempotency.service';
import { CatalogCacheService } from 'src/database/cache.service';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { StockMovementReason } from 'src/modules/inventory/entities/stock-movement.entity';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import {
  CostingErrorCodes,
  costingError,
} from 'src/modules/inventory/valuation/costing.errors';
import {
  parseCostTotal,
  parsePurchaseCost,
  requirePurchaseCost,
} from 'src/modules/inventory/valuation/purchase-cost';
import { INT8_MAX } from 'src/modules/inventory/valuation/valuation';
import {
  IdempotentReplayError,
  claimIdempotencyKey,
  completeIdempotencyKey,
  peekIdempotencyKey,
  requestHashOf,
} from 'src/modules/orders/idempotency.helper';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import { CostingConsoleMessages } from './costing.messages';
import {
  InitialiseValuationDto,
  RecordCorrectionDto,
  RecordReceiptDto,
  SetPurchasePriceDto,
  UnvaluedQueryDto,
} from './dto/costing.dto';
import {
  COSTING_RECENT_MOVEMENT_LIMIT,
  CostingProductView,
  CostingVariantDetailView,
  CostingVariantView,
  MOVEMENT_VIEW_SELECT,
  MovementViewRow,
  PoolView,
  VARIANT_VIEW_SELECT,
  VariantViewRow,
  movementViewOf,
  poolView,
  variantViewOf,
} from './views/costing.view';

/**
 * Who is asking. Built by the controller from the VERIFIED request
 * (`req.user`), never from the body.
 */
export interface CostingPrincipal {
  userId: number;
  roles: UserRoleEnum[];
  /** The audit actor, which also carries the display snapshot for the ledger. */
  actor: AuditActor;
}

export interface ReceiptResponse {
  movementId: number;
  variantId: number;
  quantity: number;
  unitCost: string;
  incomingValue: string;
  before: PoolView;
  after: PoolView;
}

export interface CorrectionResponse {
  movementId: number;
  variantId: number;
  quantityDelta: number;
  costPolicy: 'valued' | 'unvalued' | 'removed';
  costRemoved: string | null;
  before: PoolView;
  after: PoolView;
}

export interface ValuationResponse {
  movementId: number;
  variantId: number;
  valuedUnits: number;
  totalValue: string;
  before: PoolView;
  after: PoolView;
}

/** What a committed write did to physical stock, for the post-commit events. */
interface StockEffect {
  variantId: number;
  balanceAfter: number;
}

/**
 * ============================================================================
 * PURCHASE COST AND INVENTORY VALUATION — the super_admin costing console.
 * ============================================================================
 *
 * Contract: docs/PURCHASE-COST-ACCOUNTING.md §6, §8, §13. This service owns
 * NO cost arithmetic: every pool step is `InventoryService.receiveValued` /
 * `correctStock` / `initialiseValuation`, which run the pure functions of
 * `valuation.ts` under the variant row lock and write through the one
 * compare-and-set writer. What lives here is the request contract around them:
 * input policy, idempotency, authorization, audit and the post-commit events.
 *
 * AUTHORIZATION IS ASSERTED AGAIN HERE (§8). The controller is
 * `@Audiences('admin')` + `@Roles(super_admin)`; every public method below
 * repeats the role check against the principal it is handed, exactly as
 * `ReportsService.assertReportViewer` does. A future route that forgets the
 * decorator, or a caller inside the application that reaches this service
 * directly, still cannot read or move a cost.
 *
 * ONE TRANSACTION PER WRITE, AND THE IDEMPOTENCY KEY IS ITS FIRST WRITE. The
 * key is claimed before any variant lock (lock order §7: idempotency key →
 * product_variants), so a duplicate submission blocks on the key's unique
 * index and then replays the winner's stored response, rather than queueing
 * on the variant and applying the receipt twice. The claim, the pool write,
 * the movement, the audit row and the stored response commit or roll back
 * together.
 *
 * NO COST LEAVES THROUGH A SIDE CHANNEL. The realtime events carry the stock
 * count the writer RETURNINGed and nothing else; the audit summaries carry
 * quantities, ids and booleans only, because `audit.read` is a DELEGABLE
 * capability and a delegated reader must not learn a Rial cost from the trail.
 */
@Injectable()
export class CostingService {
  private readonly logger = new Logger(CostingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly catalogCache: CatalogCacheService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ==========================================================================
  // Authorization
  // ==========================================================================

  private assertCostManager(principal: CostingPrincipal): void {
    if (!principal?.roles?.includes(UserRoleEnum.superAdmin)) {
      throw costingError.forbidden(CostingErrorCodes.PURCHASE_COST_FORBIDDEN);
    }
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async getVariant(
    variantId: number,
    principal: CostingPrincipal,
  ): Promise<CostingVariantDetailView> {
    this.assertCostManager(principal);
    const rows = await this.dataSource.query<VariantViewRow[]>(
      `${VARIANT_VIEW_SELECT} WHERE v.id = $1`,
      [variantId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(CostingConsoleMessages.VARIANT_NOT_FOUND);
    }
    const movements = await this.dataSource.query<MovementViewRow[]>(
      `${MOVEMENT_VIEW_SELECT}
        WHERE m."variantId" = $1
        ORDER BY m."createdAt" DESC, m.id DESC
        LIMIT $2`,
      [variantId, COSTING_RECENT_MOVEMENT_LIMIT],
    );
    return {
      ...variantViewOf(rows[0]),
      recentMovements: movements.map(movementViewOf),
    };
  }

  async getProduct(
    productId: number,
    principal: CostingPrincipal,
  ): Promise<CostingProductView> {
    this.assertCostManager(principal);
    const products = await this.dataSource.query<
      Array<{ id: number | string; title: string; productCode: string }>
    >(`SELECT id, title, "productCode" FROM products WHERE id = $1`, [
      productId,
    ]);
    if (products.length === 0) {
      throw new NotFoundException(CostingConsoleMessages.PRODUCT_NOT_FOUND);
    }
    const rows = await this.dataSource.query<VariantViewRow[]>(
      `${VARIANT_VIEW_SELECT}
        WHERE v."productId" = $1
        ORDER BY v."isDefault" DESC, v.id ASC`,
      [productId],
    );
    const variants = rows.map(variantViewOf);

    // Totals are folded from the per-variant figures in BigInt — the same
    // strings the rows carry, so the header cannot disagree with its rows.
    let stock = 0;
    let unvaluedQuantity = 0;
    let value = 0n;
    for (const v of variants) {
      stock += v.stock;
      unvaluedQuantity += v.unvaluedQuantity;
      value += BigInt(v.inventoryCostValue);
    }
    return {
      productId: Number(products[0].id),
      productTitle: products[0].title,
      productCode: products[0].productCode,
      variants,
      totals: {
        stock,
        unvaluedQuantity,
        inventoryCostValue: value.toString(),
      },
    };
  }

  /** The legacy-valuation work list: every variant still holding unvalued units. */
  async listUnvalued(
    query: UnvaluedQueryDto,
    principal: CostingPrincipal,
  ): Promise<{
    data: CostingVariantView[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    this.assertCostManager(principal);
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const [{ total }] = await this.dataSource.query<Array<{ total: number }>>(
      `SELECT count(*)::int AS total FROM product_variants WHERE "unvaluedQuantity" > 0`,
    );
    const rows = await this.dataSource.query<VariantViewRow[]>(
      `${VARIANT_VIEW_SELECT}
        WHERE v."unvaluedQuantity" > 0
        ORDER BY v.id ASC
        LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    return {
      data: rows.map(variantViewOf),
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  /**
   * A purchase receipt: `quantity` units in at `unitCost` each. The pool grows
   * by exactly `quantity × unitCost` (§3.1 `receive`), and the unit cost is
   * remembered as the next receipt's default.
   */
  async recordReceipt(
    variantId: number,
    dto: RecordReceiptDto,
    idempotencyKey: string,
    principal: CostingPrincipal,
  ): Promise<ReceiptResponse> {
    this.assertCostManager(principal);
    const unitCost = requirePurchaseCost(dto.unitCost, 'unitCost');
    const supplierReference = blankToNull(dto.supplierReference);
    const note = blankToNull(dto.note);

    return this.idempotent<ReceiptResponse>({
      scope: IdempotencyScope.STOCK_RECEIPT,
      key: idempotencyKey,
      conflictCode: CostingErrorCodes.STOCK_RECEIPT_IDEMPOTENCY_CONFLICT,
      payload: {
        variantId,
        quantity: dto.quantity,
        unitCost: unitCost.toString(),
        supplierReference,
        note,
      },
      work: async (manager) => {
        const sku = await this.lockForWrite(manager, variantId);
        const result = await this.inventory.receiveValued(manager, {
          variantId,
          quantity: dto.quantity,
          unitCost,
          reason: StockMovementReason.STOCK_RECEIPT,
          reasonText: note,
          supplierReference,
          actorUserId: principal.userId,
          actorDisplaySnapshot: principal.actor.display,
          now: new Date(),
        });
        const movementId = requireMovement(variantId, result.movementId);

        await this.audit.record(
          {
            actor: principal.actor,
            action: AuditAction.INVENTORY_RECEIPT_RECORDED,
            targetType: AuditTarget.VARIANT,
            targetId: variantId,
            targetLabel: sku,
            // QUANTITIES, IDS AND BOOLEANS ONLY — see the class comment. Not
            // the unit cost, not the incoming value, and not the supplier
            // reference or note text either: both are free text an operator
            // can (and will) type a price into.
            summary: {
              movementId,
              quantity: dto.quantity,
              stockBefore: result.before.stock,
              stockAfter: result.after.stock,
              unvaluedQuantityAfter: result.after.unvaluedQuantity,
              hasSupplierReference: supplierReference !== null,
              hasNote: note !== null,
            },
          },
          manager,
        );

        return {
          response: {
            movementId,
            variantId,
            quantity: dto.quantity,
            unitCost: unitCost.toString(),
            incomingValue: (
              result.after.value - result.before.value
            ).toString(),
            before: poolView(result.before),
            after: poolView(result.after),
          },
          stock: { variantId, balanceAfter: result.balanceAfter },
        };
      },
    });
  }

  /**
   * A stock-count correction with an explicit cost policy (§6):
   *
   *   positive + unitCost          → 'valued'   (value += q × unitCost)
   *   positive + costUnknown: true → 'unvalued' (unknown, never zero)
   *   negative, neither            → 'removed'  (unknown-cost units first,
   *                                  then an exact allocation — an inventory
   *                                  loss on the movement, never sales COGS)
   */
  async recordCorrection(
    variantId: number,
    dto: RecordCorrectionDto,
    idempotencyKey: string,
    principal: CostingPrincipal,
  ): Promise<CorrectionResponse> {
    this.assertCostManager(principal);
    const quantityDelta = dto.quantityDelta;
    const unitCost = parsePurchaseCost(dto.unitCost, 'unitCost') ?? null;
    const costUnknown = dto.costUnknown === true;
    assertCorrectionPolicy(quantityDelta, unitCost, costUnknown);
    const costPolicy: CorrectionResponse['costPolicy'] =
      quantityDelta < 0 ? 'removed' : costUnknown ? 'unvalued' : 'valued';
    const allowBelowReserved = dto.allowBelowReserved === true;

    return this.idempotent<CorrectionResponse>({
      scope: IdempotencyScope.INVENTORY_CORRECTION,
      key: idempotencyKey,
      conflictCode: IDEMPOTENCY_KEY_REUSED,
      payload: {
        variantId,
        quantityDelta,
        reason: dto.reason,
        unitCost: unitCost === null ? null : unitCost.toString(),
        costUnknown,
        allowBelowReserved,
      },
      work: async (manager) => {
        const sku = await this.lockForWrite(manager, variantId);
        const result = await this.inventory.correctStock(manager, {
          variantId,
          quantityDelta,
          unitCost,
          costUnknown,
          reasonText: dto.reason,
          allowBelowReserved,
          actorUserId: principal.userId,
          actorDisplaySnapshot: principal.actor.display,
          now: new Date(),
        });
        const movementId = requireMovement(variantId, result.movementId);

        await this.audit.record(
          {
            actor: principal.actor,
            action: AuditAction.INVENTORY_CORRECTION_RECORDED,
            targetType: AuditTarget.VARIANT,
            targetId: variantId,
            targetLabel: sku,
            /*
             * No Rial figure — neither the unit cost nor the value removed —
             * and NOT the reason text. `stock.adjusted` does record its
             * reason, but that route has no cost in it; a correction's reason
             * is exactly where "10 units damaged, bought at 120 000" gets
             * typed. The sentence is on the ledger row (`reasonText`), which
             * only this super_admin console reads alongside cost.
             */
            summary: {
              movementId,
              quantityDelta,
              costPolicy,
              stockBefore: result.before.stock,
              stockAfter: result.after.stock,
              unvaluedQuantityBefore: result.before.unvaluedQuantity,
              unvaluedQuantityAfter: result.after.unvaluedQuantity,
              basketReserved: result.basketReserved,
              orderAllocated: result.orderAllocated,
              allowBelowReserved,
            },
          },
          manager,
        );

        return {
          response: {
            movementId,
            variantId,
            quantityDelta,
            costPolicy,
            costRemoved:
              costPolicy === 'removed'
                ? (result.before.value - result.after.value).toString()
                : null,
            before: poolView(result.before),
            after: poolView(result.after),
          },
          stock: { variantId, balanceAfter: result.balanceAfter },
        };
      },
    });
  }

  /**
   * Values a variant's legacy UNVALUED units for the first time (§6). Moves
   * value, not stock — the movement is the one reason allowed `delta = 0` — so
   * there is no availability to announce afterwards.
   */
  async initialiseValuation(
    variantId: number,
    dto: InitialiseValuationDto,
    idempotencyKey: string,
    principal: CostingPrincipal,
  ): Promise<ValuationResponse> {
    this.assertCostManager(principal);
    const unitCost = parsePurchaseCost(dto.unitCost, 'unitCost');
    const givenTotal = parseCostTotal(dto.totalValue, 'totalValue');
    if (unitCost !== undefined && givenTotal !== undefined) {
      throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
        field: 'totalValue',
        detail: 'Send exactly one of unitCost or totalValue.',
      });
    }
    if (unitCost === undefined && givenTotal === undefined) {
      throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_REQUIRED, {
        field: 'unitCost',
        detail: 'Send exactly one of unitCost or totalValue.',
      });
    }
    const expected = dto.expectedUnvaluedQuantity;
    // With a unit cost the total is that cost for every unit the operator
    // confirmed. If the count moved since, `initialiseValuation` refuses it as
    // stale, so this product is never applied to a different number of units.
    const totalValue =
      unitCost !== undefined ? unitCost * BigInt(expected) : givenTotal!;
    if (totalValue > INT8_MAX) {
      throw costingError.badRequest(
        CostingErrorCodes.PURCHASE_COST_OUT_OF_RANGE,
        { field: 'unitCost' },
      );
    }
    const note = blankToNull(dto.note);

    return this.idempotent<ValuationResponse>({
      scope: IdempotencyScope.INVENTORY_VALUATION,
      key: idempotencyKey,
      conflictCode: IDEMPOTENCY_KEY_REUSED,
      payload: {
        variantId,
        expectedUnvaluedQuantity: expected,
        unitCost: unitCost === undefined ? null : unitCost.toString(),
        totalValue: givenTotal === undefined ? null : givenTotal.toString(),
        note,
      },
      work: async (manager) => {
        const sku = await this.lockForWrite(manager, variantId);
        const result = await this.inventory.initialiseValuation(manager, {
          variantId,
          totalValue,
          expectedUnvaluedQuantity: expected,
          reasonText: note,
          actorUserId: principal.userId,
          actorDisplaySnapshot: principal.actor.display,
          now: new Date(),
        });
        const movementId = requireMovement(variantId, result.movementId);
        const valuedUnits = result.before.unvaluedQuantity;

        await this.audit.record(
          {
            actor: principal.actor,
            action: AuditAction.INVENTORY_VALUATION_INITIALIZED,
            targetType: AuditTarget.VARIANT,
            targetId: variantId,
            targetLabel: sku,
            summary: {
              movementId,
              valuedUnits,
              stock: result.after.stock,
              enteredAs: unitCost !== undefined ? 'unit_cost' : 'total_value',
              hasNote: note !== null,
            },
          },
          manager,
        );

        return {
          response: {
            movementId,
            variantId,
            valuedUnits,
            totalValue: (result.after.value - result.before.value).toString(),
            before: poolView(result.before),
            after: poolView(result.after),
          },
          stock: null,
        };
      },
    });
  }

  /**
   * Sets (or clears, with `null`) the remembered purchase price the receipt
   * form pre-fills. Not a valuation: no stock, no value, no movement. It is
   * naturally idempotent — the same PUT twice leaves the same state — so it
   * takes no key.
   */
  async setPurchasePrice(
    variantId: number,
    dto: SetPurchasePriceDto,
    principal: CostingPrincipal,
  ): Promise<{ variantId: number; lastPurchaseUnitCost: string | null }> {
    this.assertCostManager(principal);
    const unitCost =
      dto.unitCost === null
        ? null
        : requirePurchaseCost(dto.unitCost, 'unitCost');

    return this.dataSource.transaction(async (manager) => {
      const sku = await this.lockForWrite(manager, variantId);
      const [previous] = await manager.query<
        Array<{ lastPurchaseUnitCost: string | null }>
      >(
        `SELECT "lastPurchaseUnitCost"::text AS "lastPurchaseUnitCost"
           FROM product_variants WHERE id = $1`,
        [variantId],
      );
      await this.inventory.rememberPurchaseCost(manager, variantId, unitCost);
      const next = unitCost === null ? null : unitCost.toString();

      await this.audit.record(
        {
          actor: principal.actor,
          action: AuditAction.PURCHASE_COST_CHANGED,
          targetType: AuditTarget.VARIANT,
          targetId: variantId,
          targetLabel: sku,
          // Whether a price was set, cleared or changed — never which.
          summary: {
            hadPurchasePrice: previous?.lastPurchaseUnitCost != null,
            hasPurchasePrice: next !== null,
            changed: (previous?.lastPurchaseUnitCost ?? null) !== next,
          },
        },
        manager,
      );
      return { variantId, lastPurchaseUnitCost: next };
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Takes the variant row lock (R1) and returns its SKU for the audit label.
   * The inventory method re-takes the same lock inside the same transaction,
   * which is a no-op; taking it here first makes a missing variant a clean
   * 404 before anything else happens.
   */
  private async lockForWrite(
    manager: EntityManager,
    variantId: number,
  ): Promise<string> {
    const locked = await this.inventory.lockVariants(manager, [variantId]);
    return locked.get(variantId)!.sku;
  }

  /**
   * The replay protocol, identical in shape to the POS sale's:
   *
   *   peek (outside any write transaction) → a completed identical request
   *   replays its stored response without opening one;
   *   claim (the FIRST write of the business transaction) → a concurrent
   *   duplicate blocks on the unique index and then replays;
   *   complete (same transaction) → the response is stored with the effect.
   *
   * Post-commit, and only for a request that actually did the work, the
   * catalogue availability cache is dropped and the stock events are sent —
   * in that order, for the reason `ProductsService.adjustVariantStock`
   * documents. A replay announces nothing: nothing changed.
   */
  private async idempotent<T>(input: {
    scope: IdempotencyScope;
    key: string;
    conflictCode: string;
    payload: Record<string, unknown>;
    work: (
      manager: EntityManager,
    ) => Promise<{ response: T; stock: StockEffect | null }>;
  }): Promise<T> {
    const requestHash = requestHashOf({
      scope: input.scope,
      ...input.payload,
    });

    let outcome: { response: T; stock: StockEffect | null };
    try {
      const replay = await peekIdempotencyKey(
        this.dataSource.manager,
        input.scope,
        input.key,
        requestHash,
      );
      if (replay) return replay.responseBody as T;

      outcome = await this.dataSource.transaction(async (manager) => {
        const claim = await claimIdempotencyKey(
          manager,
          input.scope,
          input.key,
          requestHash,
        );
        const result = await input.work(manager);
        await completeIdempotencyKey(manager, claim, 201, result.response);
        return result;
      });
    } catch (err) {
      if (err instanceof IdempotentReplayError) return err.responseBody as T;
      throw translateIdempotencyConflict(err, input.conflictCode);
    }

    if (outcome.stock) await this.announceStock(outcome.stock);
    return outcome.response;
  }

  /**
   * Stock numbers only — `emitStockEvent` gets the committed `balanceAfter`,
   * the invalidation gets variant ids. Never a cost.
   */
  private async announceStock(effect: StockEffect): Promise<void> {
    try {
      await this.catalogCache.invalidateVariantAvailability([effect.variantId]);
    } catch (err) {
      // Advisory: the stock change has committed and must not be reported
      // as failed because a cache could not be reached.
      this.logger.warn(
        `availability cache invalidation failed for variant ${effect.variantId}: ${String(err)}`,
      );
    }
    this.realtime.emitStockEvent({
      variantId: effect.variantId,
      newStock: effect.balanceAfter,
      branchId: null,
    });
    await this.realtime.publishAvailabilityInvalidation(
      [effect.variantId],
      'stock',
    );
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function blankToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Every write here changes the ledger, so the writer must have produced a
 * movement. It cannot fail to (quantity and delta are never zero, and the
 * valuation movement is the one zero-delta reason) — a missing id is a
 * broken invariant, not input.
 */
function requireMovement(variantId: number, movementId: number | null): number {
  if (movementId === null) {
    throw costingError.invariant(
      `variant ${variantId}: the costing write produced no stock movement`,
    );
  }
  return movementId;
}

/**
 * The correction cost policy (§6): a positive delta states exactly one of a
 * unit cost or "unknown"; a negative one states neither, because the cost of
 * units leaving is the pool's allocation, not the operator's opinion. Every
 * violation is `PURCHASE_COST_INVALID`, naming the field at fault.
 */
function assertCorrectionPolicy(
  quantityDelta: number,
  unitCost: bigint | null,
  costUnknown: boolean,
): void {
  const refuse = (field: string, detail: string) =>
    costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
      field,
      detail,
    });
  if (quantityDelta > 0) {
    if (unitCost !== null && costUnknown) {
      throw refuse(
        'costUnknown',
        'A positive correction takes exactly one of unitCost or costUnknown: true, not both.',
      );
    }
    if (unitCost === null && !costUnknown) {
      throw refuse(
        'unitCost',
        'A positive correction needs unitCost, or costUnknown: true to record the units as unvalued.',
      );
    }
    return;
  }
  if (unitCost !== null) {
    throw refuse(
      'unitCost',
      'A negative correction takes no unitCost: the removed cost is allocated from the pool.',
    );
  }
  if (costUnknown) {
    throw refuse(
      'costUnknown',
      'A negative correction takes no costUnknown: units leaving are costed by the pool.',
    );
  }
}

/**
 * The shared helper answers a reused or in-flight key with `code` in the
 * payload — the POS envelope, which POS vendors integrated against. The
 * `GlobalExceptionFilter` keeps only `error` and `message` at the top level,
 * so for this console the code is moved to `error`, where the contract (§13)
 * promises it: `STOCK_RECEIPT_IDEMPOTENCY_CONFLICT` for receipts,
 * `IDEMPOTENCY_KEY_REUSED` for the others.
 */
function translateIdempotencyConflict(
  err: unknown,
  conflictCode: string,
): unknown {
  if (!(err instanceof ConflictException)) return err;
  const payload = err.getResponse() as { code?: unknown } | string;
  const code = typeof payload === 'object' ? payload.code : undefined;
  if (code === IDEMPOTENCY_KEY_REUSED) {
    return new ConflictException({
      error: conflictCode,
      message: CostingConsoleMessages.IDEMPOTENCY_KEY_REUSED,
    });
  }
  if (code === IDEMPOTENCY_REQUEST_IN_PROGRESS) {
    return new ConflictException({
      error: IDEMPOTENCY_REQUEST_IN_PROGRESS,
      message: CostingConsoleMessages.IDEMPOTENCY_REQUEST_IN_PROGRESS,
    });
  }
  return err;
}
