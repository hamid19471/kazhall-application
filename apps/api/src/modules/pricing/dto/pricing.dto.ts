import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullableTrim = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const MONEY_INPUT =
  'Integer Rial as a JSON integer or a base-10 integer string (e.g. 1000000000 or "1000000000"). ' +
  'No fractions, exponents, negatives or separators.';

const PERCENT_INPUT =
  'A percent as TEXT, 0 to 99.99 with at most two decimals ("10", "12.5", "33.33"). ' +
  'Text, not a JSON number, so a rate never passes through a float. ' +
  'Tax and profit are shares of the FINAL SELLING PRICE (of revenue), not mark-ups on cost.';

const PERCENT_TEXT = /^\d{1,3}(\.\d{1,2})?$/;

export const PLAN_STATUSES = [
  'DRAFT',
  'CALCULATING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'APPLYING',
  'APPLIED',
  'FAILED',
  'ROLLED_BACK',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export class PlanListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PLAN_STATUSES })
  @IsOptional()
  @IsIn(PLAN_STATUSES)
  status?: PlanStatus;
}

export class CreatePlanDto {
  @ApiProperty({ maxLength: 120, example: 'قیمت‌گذاری مهر ۱۴۰۵' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiProperty({
    minimum: 1300,
    maximum: 1700,
    example: 1405,
    description: 'Persian (Jalali) year.',
  })
  @IsInt()
  @Min(1300)
  @Max(1700)
  effectiveYear: number;

  @ApiProperty({
    minimum: 1,
    maximum: 12,
    example: 7,
    description: 'Persian month, 1 = Farvardin.',
  })
  @IsInt()
  @Min(1)
  @Max(12)
  effectiveMonth: number;

  @ApiPropertyOptional({
    description:
      'Copy the inputs, review rules and cost entries of this plan into the new DRAFT. ' +
      'Nothing about its preview, approvals or history is copied.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  copyFromPlanId?: number;
}

export class UpdatePlanDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ minimum: 1300, maximum: 1700 })
  @IsOptional()
  @IsInt()
  @Min(1300)
  @Max(1700)
  effectiveYear?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  effectiveMonth?: number;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description: MONEY_INPUT,
  })
  @Allow()
  targetMonthlyRevenueRial?: unknown;

  @ApiPropertyOptional({
    type: String,
    example: '10',
    description: PERCENT_INPUT,
  })
  @IsOptional()
  @IsString()
  @Matches(PERCENT_TEXT)
  taxRatePercent?: string;

  @ApiPropertyOptional({
    type: String,
    example: '20',
    description: PERCENT_INPUT,
  })
  @IsOptional()
  @IsString()
  @Matches(PERCENT_TEXT)
  targetProfitMarginPercent?: string;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description: `Round every proposed price UP to a multiple of this. ${MONEY_INPUT} 1..10 000 000.`,
  })
  @Allow()
  roundingStepRial?: unknown;

  @ApiPropertyOptional({
    type: String,
    example: '20',
    description:
      'An increase ABOVE this percent needs review. Text, 0..10000 with ≤ 2 decimals.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,5}(\.\d{1,2})?$/)
  reviewMaxIncreasePercent?: string;

  @ApiPropertyOptional({ description: 'Any price decrease needs review.' })
  @IsOptional()
  @IsBoolean()
  reviewDecreases?: boolean;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @Transform(nullableTrim)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export const COST_SCOPES = ['general', 'branch'] as const;

export class CostEntryDto {
  @ApiProperty({ maxLength: 120, example: 'اجارهٔ فروشگاه' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiProperty({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description: MONEY_INPUT,
  })
  @Allow()
  amountRial: unknown;

  @ApiPropertyOptional({
    enum: COST_SCOPES,
    default: 'general',
    description:
      '`general` = all stores. `branch` = a cost incurred by one branch (pass `branchId`). ' +
      'Every ACTIVE entry counts toward the monthly total either way: prices are global.',
  })
  @IsOptional()
  @IsIn(COST_SCOPES)
  scope?: (typeof COST_SCOPES)[number];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  branchId?: number | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @Transform(nullableTrim)
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCostEntryDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description: MONEY_INPUT,
  })
  @Allow()
  amountRial?: unknown;

  @ApiPropertyOptional({ enum: COST_SCOPES })
  @IsOptional()
  @IsIn(COST_SCOPES)
  scope?: (typeof COST_SCOPES)[number];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  branchId?: number | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @Transform(nullableTrim)
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReorderCostEntriesDto {
  @ApiProperty({
    type: [Number],
    description: 'EVERY cost-entry id of the plan, in the new order.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  entryIds: number[];
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export const ITEM_STATUSES = [
  'READY',
  'UNCHANGED',
  'NEEDS_REVIEW',
  'BLOCKED',
] as const;
export const ITEM_VIEWS = ['exceptions', 'all', 'applicable'] as const;
export const ITEM_DIRECTIONS = ['increase', 'decrease', 'none'] as const;
export const ITEM_CHANNELS = ['site', 'branches', 'both', 'none'] as const;
export const ITEM_SORTS = [
  'product',
  'changePercent',
  'changeRial',
  'currentPrice',
  'finalPrice',
  'costBasis',
  'status',
] as const;

const PERCENT_BOUND = /^-?\d{1,6}(\.\d{1,2})?$/;

/**
 * The server-side filter set, shared by the paginated list and by the bulk
 * include/exclude so "apply to everything I am looking at" means exactly the
 * rows the list shows.
 */
export class ItemFilterDto {
  @ApiPropertyOptional({
    enum: ITEM_VIEWS,
    default: 'exceptions',
    description:
      '`exceptions` (default) = NEEDS_REVIEW, BLOCKED or stale rows. `applicable` = rows the apply would write.',
  })
  @IsOptional()
  @IsIn(ITEM_VIEWS)
  view?: (typeof ITEM_VIEWS)[number];

  @ApiPropertyOptional({
    maxLength: 120,
    description: 'Product title, product code, variant code or SKU.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: ITEM_STATUSES })
  @IsOptional()
  @IsIn(ITEM_STATUSES)
  status?: (typeof ITEM_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({
    enum: ITEM_CHANNELS,
    description: 'Where the product was offered at calculation time.',
  })
  @IsOptional()
  @IsIn(ITEM_CHANNELS)
  channel?: (typeof ITEM_CHANNELS)[number];

  @ApiPropertyOptional({ enum: ITEM_DIRECTIONS })
  @IsOptional()
  @IsIn(ITEM_DIRECTIONS)
  direction?: (typeof ITEM_DIRECTIONS)[number];

  @ApiPropertyOptional({
    type: String,
    example: '-10',
    description: 'Minimum percent change, inclusive.',
  })
  @IsOptional()
  @IsString()
  @Matches(PERCENT_BOUND)
  minChangePercent?: string;

  @ApiPropertyOptional({
    type: String,
    example: '50',
    description: 'Maximum percent change, inclusive.',
  })
  @IsOptional()
  @IsString()
  @Matches(PERCENT_BOUND)
  maxChangePercent?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  included?: boolean;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  stale?: boolean;
}

export class ItemListQueryDto extends ItemFilterDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @ApiPropertyOptional({ enum: ITEM_SORTS, default: 'product' })
  @IsOptional()
  @IsIn(ITEM_SORTS)
  sort?: (typeof ITEM_SORTS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class UpdateItemDto {
  @ApiPropertyOptional({
    description:
      'Include (true) or exclude (false). Including a NEEDS_REVIEW row is its approval and is recorded.',
  })
  @IsOptional()
  @IsBoolean()
  included?: boolean;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }],
    description:
      `A manual price replacing the proposed one (${MONEY_INPUT}); null clears it. ` +
      'Must be ≥ 1, ≤ MAX_RIAL and not below the variant cost basis. Setting it includes the row.',
  })
  @Allow()
  overridePriceRial?: unknown;
}

export class BulkItemsDto {
  @ApiProperty({
    type: ItemFilterDto,
    description: 'Exactly the filters of the list being looked at.',
  })
  @ValidateNested()
  @Type(() => ItemFilterDto)
  filters: ItemFilterDto;

  @ApiProperty({
    description:
      'true = include every eligible filtered row; false = exclude every filtered row.',
  })
  @IsBoolean()
  included: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'When including, also approve NEEDS_REVIEW rows among the filtered ones. Without it only READY rows are included.',
  })
  @IsOptional()
  @IsBoolean()
  approveNeedsReview?: boolean;
}

export class ApproveOrApplyDto {
  @ApiProperty({
    minimum: 1,
    description:
      'The number of variant prices the person was shown would change. Refused (409) when it no longer matches.',
  })
  @IsInt()
  @Min(1)
  expectedChangeCount: number;
}

export class ChangesQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['apply', 'rollback'] })
  @IsOptional()
  @IsIn(['apply', 'rollback'])
  kind?: 'apply' | 'rollback';
}
