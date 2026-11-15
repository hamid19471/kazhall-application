import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { ACCESS_TOKEN_SECURITY_SCHEME } from 'src/configs/swagger.config';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { Roles } from 'src/modules/auth/decorators/role.decorator';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  ApproveOrApplyDto,
  BulkItemsDto,
  ChangesQueryDto,
  CostEntryDto,
  CreatePlanDto,
  ItemListQueryDto,
  PlanListQueryDto,
  ReorderCostEntriesDto,
  UpdateCostEntryDto,
  UpdateItemDto,
  UpdatePlanDto,
} from './dto/pricing.dto';
import { PricingPlansService, PricingPrincipal } from './pricing-plans.service';

const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const IDEMPOTENCY = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '8..200 chars of [A-Za-z0-9._:-], generated once per submission. The same key with the same ' +
    'body returns the SAME run (nothing is done twice); the same key with a different body is 409.',
};

const MONEY =
  'Every Rial figure is an integer-Rial base-10 STRING; every rate is a two-decimal percent STRING. ' +
  'Tax and target profit are shares of the FINAL SELLING PRICE (of revenue).';

/**
 * Monthly cost-recovery pricing plans (docs/MONTHLY-PRICING.md).
 *
 * The fourth NON-delegable class, gated on the super_admin ROLE exactly like
 * sales reporting, profit reporting and purchase cost: a plan contains the
 * owner's monthly costs, revenue target and profit margin, and it rewrites
 * every selling price. There is deliberately no capability in
 * PERMISSION_CATALOG that could grant it, and the service repeats the check.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Monthly pricing plans')
@Roles(UserRoleEnum.superAdmin)
@Controller('admin/pricing-plans')
@Audiences('admin')
export class PricingController {
  constructor(private readonly plans: PricingPlansService) {}

  @ApiOperation({ summary: 'List pricing plans, newest month first' })
  @Get()
  async list(@Req() req: UserRequest, @Query() query: PlanListQueryDto) {
    return this.plans.listPlans(query, principalOf(req));
  }

  @ApiOperation({
    summary:
      'Create a DRAFT plan, optionally copying another plan’s inputs and cost entries',
    description: 'Creating or editing a plan NEVER changes a price. ' + MONEY,
  })
  @Post()
  async create(@Req() req: UserRequest, @Body() dto: CreatePlanDto) {
    return { data: await this.plans.createPlan(dto, principalOf(req)) };
  }

  @ApiOperation({
    summary:
      'One plan: inputs, cost entries, derived rates, validation and latest run',
    description: MONEY,
  })
  @Get(':planId')
  async get(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return { data: await this.plans.getPlan(planId, principalOf(req)) };
  }

  @ApiOperation({
    summary:
      'Edit plan inputs (DRAFT, READY_FOR_REVIEW, FAILED). Discards any preview; never changes a price.',
  })
  @Patch(':planId')
  async update(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Body() dto: UpdatePlanDto,
  ) {
    return { data: await this.plans.updatePlan(planId, dto, principalOf(req)) };
  }

  @ApiOperation({ summary: 'Delete a plan that was never applied' })
  @Delete(':planId')
  async remove(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return { data: await this.plans.deletePlan(planId, principalOf(req)) };
  }

  // ------------------------------------------------------------- costs

  @ApiOperation({ summary: 'Add a monthly cost entry' })
  @Post(':planId/costs')
  async addCost(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Body() dto: CostEntryDto,
  ) {
    return {
      data: await this.plans.addCostEntry(planId, dto, principalOf(req)),
    };
  }

  @ApiOperation({
    summary: 'Edit, activate or deactivate a monthly cost entry',
  })
  @Patch(':planId/costs/:entryId')
  async updateCost(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
    @Body() dto: UpdateCostEntryDto,
  ) {
    return {
      data: await this.plans.updateCostEntry(
        planId,
        entryId,
        dto,
        principalOf(req),
      ),
    };
  }

  @ApiOperation({ summary: 'Remove a cost entry from an editable plan' })
  @Delete(':planId/costs/:entryId')
  async removeCost(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
  ) {
    return {
      data: await this.plans.removeCostEntry(planId, entryId, principalOf(req)),
    };
  }

  @ApiOperation({
    summary: 'Reorder the cost entries (the complete ordered id list)',
  })
  @Put(':planId/costs/order')
  async reorderCosts(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Body() dto: ReorderCostEntriesDto,
  ) {
    return {
      data: await this.plans.reorderCostEntries(planId, dto, principalOf(req)),
    };
  }

  // ------------------------------------------------------------- preview

  @ApiOperation({
    summary:
      'Calculate the preview (202, asynchronous run). Never changes a price.',
    description:
      'Validates the inputs synchronously (400 with a stable code, e.g. PRICING_DENOMINATOR_NOT_POSITIVE), ' +
      'then queues a run that evaluates every variant from an immutable snapshot of the inputs.',
  })
  @ApiHeader(IDEMPOTENCY)
  @HttpCode(202)
  @Post(':planId/calculate')
  async calculate(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.plans.requestCalculation(planId, key, principalOf(req)),
    };
  }

  @ApiOperation({
    summary:
      'Preview summary: counts by state and the min / average / max percent change',
  })
  @Get(':planId/summary')
  async summary(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return { data: await this.plans.summary(planId, principalOf(req)) };
  }

  @ApiOperation({
    summary:
      'Paginated, filtered, sorted preview rows (default view: exceptions)',
    description: MONEY,
  })
  @Get(':planId/items')
  async items(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Query() query: ItemListQueryDto,
  ) {
    return this.plans.listItems(planId, query, principalOf(req));
  }

  @ApiOperation({
    summary: 'Include / exclude one row, or set / clear its manual price',
  })
  @Patch(':planId/items/:itemId')
  async updateItem(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: UpdateItemDto,
  ) {
    return {
      data: await this.plans.updateItem(planId, itemId, dto, principalOf(req)),
    };
  }

  @ApiOperation({
    summary: 'Include or exclude every row matching the given filters',
  })
  @Post(':planId/items/bulk')
  async bulk(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Body() dto: BulkItemsDto,
  ) {
    return { data: await this.plans.bulkItems(planId, dto, principalOf(req)) };
  }

  // ------------------------------------------------------------- lifecycle

  @ApiOperation({ summary: 'Approve the reviewed preview (freezes its rows)' })
  @Post(':planId/approve')
  async approve(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Body() dto: ApproveOrApplyDto,
  ) {
    return { data: await this.plans.approve(planId, dto, principalOf(req)) };
  }

  @ApiOperation({
    summary: 'Withdraw an approval so the preview can be edited again',
  })
  @Post(':planId/unapprove')
  async unapprove(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return { data: await this.plans.unapprove(planId, principalOf(req)) };
  }

  @ApiOperation({
    summary:
      'Apply the approved prices (202, asynchronous, all-or-nothing, idempotent)',
    description:
      'Writes every included, eligible, approved row in ONE transaction. Rows whose current price or ' +
      'cost changed since the calculation are marked stale and NOTHING is written. Past orders never change.',
  })
  @ApiHeader(IDEMPOTENCY)
  @HttpCode(202)
  @Post(':planId/apply')
  async apply(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Body() dto: ApproveOrApplyDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.plans.requestApply(planId, dto, key, principalOf(req)),
    };
  }

  @ApiOperation({
    summary:
      'What a rollback would restore, and which later price changes it would leave alone',
  })
  @Get(':planId/rollback-preview')
  async rollbackPreview(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return { data: await this.plans.rollbackPreview(planId, principalOf(req)) };
  }

  @ApiOperation({
    summary: 'Roll back an applied plan (202, asynchronous, idempotent)',
    description:
      'Restores each price this plan wrote, but only where the live price is still the one it wrote; ' +
      'a later legitimate change is never overwritten and is reported as a conflict.',
  })
  @ApiHeader(IDEMPOTENCY)
  @HttpCode(202)
  @Post(':planId/rollback')
  async rollback(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.plans.requestRollback(planId, key, principalOf(req)),
    };
  }

  @ApiOperation({
    summary: 'The plan’s runs, newest first (progress, result, error)',
  })
  @Get(':planId/runs')
  async runs(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return { data: await this.plans.listRuns(planId, principalOf(req)) };
  }

  @ApiOperation({ summary: 'One run’s progress and result' })
  @Get(':planId/runs/:runId')
  async run(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Param('runId', ParseIntPipe) runId: number,
  ) {
    return { data: await this.plans.getRun(planId, runId, principalOf(req)) };
  }

  @ApiOperation({
    summary: 'The plan’s price history: every price it wrote or restored',
  })
  @Get(':planId/changes')
  async changes(
    @Req() req: UserRequest,
    @Param('planId', ParseIntPipe) planId: number,
    @Query() query: ChangesQueryDto,
  ) {
    return this.plans.listChanges(planId, query, principalOf(req));
  }
}

/** The principal comes from the verified token, never from the body. */
function principalOf(req: UserRequest): PricingPrincipal {
  return {
    userId: req.user.sub,
    roles: req.user.roles,
    actor: auditActorFrom(req),
  };
}
