import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  OnModuleInit,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiConflict,
  ApiInvalidInput,
  ApiNotFound,
  ApiPermissionForbidden,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { ProductMessages } from 'src/common/constants/product.messages';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';
import { AuditService } from 'src/modules/audit/audit.service';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { ProductsService } from 'src/modules/products/services/products.service';

import { AdminInventoryService } from './admin-inventory.service';
import { AdminAdjustStockDto } from './dto/admin-adjust-stock.dto';
import {
  AdminInventoryQueryDto,
  AdminVariantStockQueryDto,
} from './dto/admin-inventory-query.dto';
import { AdminMovementsQueryDto } from './dto/admin-movements-query.dto';
import { InventoryMessages } from './inventory.messages';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  STOCK_SCOPE,
  VARIANT_DETAIL_MOVEMENT_LIMIT,
} from './views/admin-inventory.view';

/** Swagger example of one stock row — the shape is the contract, so spell it. */
const STOCK_ROW_EXAMPLE = {
  variantId: 7,
  sku: 'IPH17-BLK-128',
  isActive: true,
  isDefault: false,
  productId: 12,
  productTitle: 'گوشی آیفون ۱۷',
  categories: [{ id: 2, title: 'موبایل' }],
  price: 480000000,
  effectivePrice: 480000000,
  physicalStock: 10,
  basketReserved: 2,
  orderAllocated: 1,
  availableForWeb: 7,
  availableForPos: 9,
  lowStock: false,
  outOfStock: false,
};

/**
 * ============================================================================
 * ADMIN INVENTORY — the stockroom screen.
 * ============================================================================
 *
 * SEPARATE FROM `InventoryController` ON PURPOSE. That controller is
 * `@Audiences('pos', 'admin')` and serves a till: its routes are reachable
 * with a POS cookie. Everything here is admin-only and permission-gated, and
 * hanging admin-only handlers off a POS-audience class would make "which
 * surface may reach this" a per-handler override that is easy to forget on the
 * next route added. The class-level declaration is the safer default.
 *
 * STOCK IS GLOBAL. There is no per-branch stock in this system, so no route
 * here takes a branch: see `STOCK_SCOPE`, which the list puts on the wire so
 * the console renders that disclosure from the API rather than from a hard-
 * coded sentence.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Inventory management')
@Controller('admin/inventory')
@Audiences('admin')
export class AdminInventoryController implements OnModuleInit {
  /**
   * Resolved through `ModuleRef` rather than injected, and that is a
   * deliberate trade, not laziness.
   *
   * `ProductsModule` already imports `InventoryModule` (the catalog delegates
   * every stock edit through `IInventoryService`). Importing `ProductsModule`
   * back into `InventoryModule` to get `ProductsService` would close that into
   * a module cycle, which then has to be held open by `forwardRef()` on both
   * sides and breaks according to which module file the loader happens to
   * reach first. The alternative — re-implementing the adjustment
   * orchestration here — would fork the refusal semantics of the one write in
   * this system that reconciles the database to the real world.
   *
   * So: one lazy lookup at boot, no cycle, and exactly one code path for a
   * stock adjustment. `strict: false` searches the whole application, which is
   * what makes it work without the import.
   */
  private products: ProductsService;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly inventory: AdminInventoryService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.products = this.moduleRef.get(ProductsService, { strict: false });
  }

  // ==========================================================================
  // 1. The stock list
  // ==========================================================================

  @ApiOperation({
    summary: 'The stock list — one row per sellable variant',
    description:
      'ONE ROW IS ONE VARIANT, not one product, because the variant is the ' +
      'only sellable unit: a product whose black SKU is exhausted while its ' +
      'white one is full is neither in stock nor out of stock at product ' +
      'level.\n\n' +
      'Four quantities, never interchangeable: `physicalStock` is what is on ' +
      'the shelf; `basketReserved` is held by ecommerce baskets; ' +
      '`orderAllocated` is held by paid/created online orders; ' +
      '`availableForWeb` = physicalStock − basketReserved − orderAllocated and ' +
      '`availableForPos` = physicalStock − orderAllocated. The gap between the ' +
      'last two is exactly what a POS sale may take from baskets. Both are ' +
      'clamped at 0 for display.\n\n' +
      '`effectivePrice` is `COALESCE(variant.price, product.basePrice)` in ' +
      'integer Rial. A `null` variant `price` means it INHERITS; zero is a ' +
      'real price.\n\n' +
      '`summary` is computed over the WHOLE filtered set, not over the page, ' +
      'so a header does not need a second request. `scope` is `global`: stock ' +
      'in this system is a single pool, not a per-branch one.\n\n' +
      'Ordered by product title then variant id — deterministic, because ' +
      'titles are not unique.',
  })
  @ApiOkResponse({
    description: 'One page of variants with their live stock position.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
        totalPages: { type: 'integer' },
        summary: {
          type: 'object',
          properties: {
            lowStockCount: { type: 'integer' },
            outOfStockCount: { type: 'integer' },
            trackedVariantCount: { type: 'integer' },
          },
        },
        scope: { type: 'string', example: STOCK_SCOPE },
      },
    }),
    examples: {
      default: {
        summary: 'As it appears on the wire',
        value: {
          success: true,
          timeStamp: '2026-09-11T09:12:44.001Z',
          data: [STOCK_ROW_EXAMPLE],
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
          summary: {
            lowStockCount: 0,
            outOfStockCount: 0,
            trackedVariantCount: 1,
          },
          scope: STOCK_SCOPE,
        },
      },
    },
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('inventory.read')
  @RequirePermissions('inventory.read')
  @Get()
  async list(@Query() query: AdminInventoryQueryDto) {
    return this.inventory.listStock(query);
  }

  // ==========================================================================
  // 2. The ledger
  // ==========================================================================

  @ApiOperation({
    summary: 'The physical-stock ledger',
    description:
      'Append-only: `stock_movements` rows are never updated or deleted, so ' +
      'this is the complete history of every unit that entered or left the ' +
      'shelf. Newest first, with `id` as the tiebreaker — `createdAt` comes ' +
      'from one clock per operation, so a multi-SKU sale writes several rows ' +
      'sharing it exactly.\n\n' +
      '`balanceAfter` is the COMMITTED physical stock immediately after the ' +
      'movement, read back from the database inside the writing transaction.\n\n' +
      '`reason` is the MACHINE reason and the only one a client may branch ' +
      'on. `reasonText` beside it is the HUMAN sentence an administrator ' +
      'typed when adjusting stock, stored on the ledger row itself. It is ' +
      '`null` for every SYSTEM movement (POS sale, online fulfilment, ' +
      'cancellation/return restore) — nobody authored one — and `null` on ' +
      'rows written before the column existed, whose explanations are only in ' +
      'the administrative audit trail (`GET /admin/audit`, action ' +
      '`stock.adjusted`). It is never an empty string. Render both fields: ' +
      'the enum is what the filter accepts, the text is what a reader needs.\n\n' +
      '`orderNumber` is a LEFT JOIN, so a movement with no order (a manual ' +
      'adjustment) still renders with `orderId: null`.',
  })
  @ApiOkResponse({
    description: 'One page of ledger rows.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
        totalPages: { type: 'integer' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('inventory.movements.read')
  @RequirePermissions('inventory.movements.read')
  @Get('movements')
  async movements(@Query() query: AdminMovementsQueryDto) {
    return this.inventory.listMovements(query);
  }

  // ==========================================================================
  // 3. One variant
  // ==========================================================================

  @ApiOperation({
    summary: "One variant's stock position and its recent ledger",
    description:
      'The same row shape as `GET /admin/inventory`, plus the most recent ' +
      `${VARIANT_DETAIL_MOVEMENT_LIMIT} movements for that variant in the same ` +
      'shape as `GET /admin/inventory/movements`. Retired variants resolve ' +
      'here too (with `isActive: false`), because their history has to stay ' +
      'readable.',
  })
  @ApiParam({
    name: 'variantId',
    type: Number,
    description:
      'Numeric `product_variants.id` — the VARIANT, not the product.',
    example: 7,
  })
  @ApiOkResponse({
    description: 'The variant with its stock position and recent movements.',
    schema: successEnvelopeSchema({
      data: { type: 'object' },
      properties: { scope: { type: 'string', example: STOCK_SCOPE } },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('inventory.read')
  @ApiNotFound('No variant has that id.')
  @RequirePermissions('inventory.read')
  @Get('variants/:variantId')
  async variant(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Query() query: AdminVariantStockQueryDto,
  ) {
    const row = await this.inventory.findVariantStock(
      variantId,
      query.lowStockThreshold,
    );
    if (!row) throw new NotFoundException(InventoryMessages.VARIANT_NOT_FOUND);

    const recentMovements = await this.inventory.recentMovementsForVariant(
      variantId,
      VARIANT_DETAIL_MOVEMENT_LIMIT,
    );

    return { data: { ...row, recentMovements }, scope: STOCK_SCOPE };
  }

  // ==========================================================================
  // 4. The explicit adjustment
  // ==========================================================================

  /**
   * THE ONLY WRITE ON THIS CONTROLLER, and it owns no stock logic.
   *
   * It delegates to `ProductsService.adjustVariantStock`, which delegates to
   * `IInventoryService.adjustStock`, which takes the variant row lock, repeats
   * the reservation check under it and writes the `stock_movements` row. Every
   * refusal therefore behaves EXACTLY as it does on the existing
   * `POST /products/variants/:variantId/stock/adjust` route, because it is
   * literally the same code: 409 `STOCK_BELOW_RESERVED` from the unlocked
   * pre-check, 400 when the authoritative locked re-check catches it instead,
   * 400 for a negative result, always. Duplicating any of that here would be
   * one refactor away from two subtly different answers to the same request.
   *
   * -------------------------------------------------------------------------
   * WHERE THE REASON GOES — IT IS NOW WRITTEN IN TWO PLACES, ON PURPOSE.
   *
   * `reason` is MANDATORY on this route (4–500 characters AFTER trimming, so
   * a string of spaces is a 400, not an explanation), and since migration 0024
   * it lands in BOTH of these:
   *
   *   1. `stock_movements.reasonText`, written by
   *      `InventoryService.adjustStock` INSIDE the adjustment's own
   *      transaction. This is the authoritative copy: a committed stock change
   *      whose explanation is missing is not representable. It sits beside the
   *      machine `reason` enum (`manual_adjustment`), which is untouched and
   *      remains the only field anything branches on, so "why" is now readable
   *      in the same query as "what" — `GET /admin/inventory/movements`.
   *
   *   2. `admin_audit_log`, action `stock.adjusted`, alongside the rest of the
   *      administrative record (who, which target, the before/after numbers).
   *      This copy is NOT redundant: the audit trail answers "what has this
   *      administrator been doing across the whole console", a question the
   *      stock ledger cannot answer at all, and it is append-only at the
   *      database level (a trigger raises on UPDATE and DELETE).
   *
   * The two are written at different times and the difference matters — see
   * the note on the audit write below.
   * -------------------------------------------------------------------------
   *
   * The audit row is written with `recordDetached` AFTER the adjustment
   * commits, not inside its transaction, because `adjustVariantStock` opens
   * and owns that transaction and does not expose the `EntityManager`. The
   * consequence is stated plainly: a stock change whose audit write failed is
   * possible here (it is logged, not swallowed silently), which is the correct
   * trade against the alternative — rolling back a committed physical-stock
   * correction because a log line did not land. The ledger's own copy of the
   * sentence has no such gap, because it is part of the same commit; that is
   * exactly why the ledger copy, not this one, is the authoritative one.
   */
  @ApiOperation({
    summary: 'Adjust the physical stock of one variant',
    description:
      '`mode: "set"` makes `value` the new absolute physical stock — the shape ' +
      'a stock count produces. `mode: "delta"` applies a signed change.\n\n' +
      '`reason` is MANDATORY, 4–500 characters AFTER TRIMMING — a string of ' +
      'spaces is a 400, not an explanation. It is recorded in TWO places: on ' +
      'the ledger row itself as `stock_movements.reasonText` (inside the ' +
      "adjustment's own transaction, and returned by " +
      '`GET /admin/inventory/movements` beside the machine `reason`), and in ' +
      'the administrative audit trail (`GET /admin/audit?action=' +
      'stock.adjusted`) alongside the before/after numbers.\n\n' +
      'RESERVATION AWARENESS. Physical stock is not sellable stock. An ' +
      'adjustment that would drop it below `basketReserved + orderAllocated` ' +
      'is REFUSED unless `allowBelowReserved: true`. That refusal has TWO ' +
      'statuses depending on where it is caught: **409** with ' +
      '`error: STOCK_BELOW_RESERVED` from the pre-check, **400** from the ' +
      'authoritative re-check taken under the variant lock. Treat both as the ' +
      'same refusal. A negative result is always refused.\n\n' +
      'The response carries the adjustment result plus the RECOMPUTED ' +
      'availability, so the caller does not have to re-read the row.',
  })
  @ApiParam({
    name: 'variantId',
    type: Number,
    description:
      'Numeric `product_variants.id` — the VARIANT, not the product.',
    example: 7,
  })
  @ApiOkResponse({
    description: 'Stock adjusted; the new position is reported back.',
    schema: successEnvelopeSchema({
      message: ProductMessages.STOCK_ADJUSTED,
      data: { type: 'object' },
      properties: { scope: { type: 'string', example: STOCK_SCOPE } },
    }),
    examples: {
      default: {
        summary: 'As it appears on the wire',
        value: {
          success: true,
          timeStamp: '2026-09-11T09:12:44.001Z',
          message: ProductMessages.STOCK_ADJUSTED,
          data: {
            variantId: 7,
            productId: 12,
            sku: 'IPH17-BLK-128',
            previousStock: 10,
            balanceAfter: 12,
            basketReserved: 2,
            orderAllocated: 1,
            belowReserved: false,
            availability: {
              physicalStock: 12,
              basketReserved: 2,
              orderAllocated: 1,
              availableForWeb: 9,
              availableForPos: 11,
              lowStock: false,
              outOfStock: false,
            },
          },
          scope: STOCK_SCOPE,
        },
      },
    },
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 when the target ` +
      'stock would be negative, and when the below-reserved refusal is ' +
      'detected under the lock rather than by the pre-check.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('inventory.adjust')
  @ApiNotFound('No variant has that id.')
  @ApiConflict(
    'Result would fall below `basketReserved + orderAllocated` and ' +
      '`allowBelowReserved` was not set. `error` is `STOCK_BELOW_RESERVED`; ' +
      'the reserved quantities are reported inside `message`.',
  )
  @RequirePermissions('inventory.adjust')
  @HttpCode(200)
  @Post('variants/:variantId/adjust')
  async adjust(
    @Req() req: UserRequest,
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: AdminAdjustStockDto,
  ) {
    const result = await this.products.adjustVariantStock(
      variantId,
      {
        mode: dto.mode,
        value: dto.value,
        reason: dto.reason,
        allowBelowReserved: dto.allowBelowReserved,
      },
      { userId: req.user.sub, displaySnapshot: req.user.identifier },
    );

    // Written before the availability re-read, so a failure to re-read cannot
    // cost the trail the record of a change that has already committed.
    // The summary is an explicit allow-list of scalars — no request body, no
    // identity beyond the actor the framework resolved.
    await this.audit.recordDetached({
      actor: auditActorFrom(req),
      action: AuditAction.STOCK_ADJUSTED,
      targetType: AuditTarget.VARIANT,
      targetId: variantId,
      targetLabel: result.sku,
      summary: {
        mode: dto.mode,
        value: dto.value,
        previousStock: result.previousStock,
        balanceAfter: result.balanceAfter,
        basketReserved: result.basketReserved,
        orderAllocated: result.orderAllocated,
        belowReserved: result.belowReserved,
        reason: dto.reason,
      },
    });

    const row = await this.inventory.findVariantStock(
      variantId,
      DEFAULT_LOW_STOCK_THRESHOLD,
    );

    return {
      message: ProductMessages.STOCK_ADJUSTED,
      data: {
        ...result,
        availability: row
          ? {
              physicalStock: row.physicalStock,
              basketReserved: row.basketReserved,
              orderAllocated: row.orderAllocated,
              availableForWeb: row.availableForWeb,
              availableForPos: row.availableForPos,
              lowStock: row.lowStock,
              outOfStock: row.outOfStock,
            }
          : null,
      },
      scope: STOCK_SCOPE,
    };
  }
}
