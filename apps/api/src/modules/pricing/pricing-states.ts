import { PlanStatus } from './dto/pricing.dto';
import { PricingErrorCodes as E, pricingError } from './pricing.errors';

/**
 * The state machine (docs/MONTHLY-PRICING.md §4). Every status change in this
 * module and in the runner goes through `assertTransition`, so an illegal
 * transition is a refusal, never an accident.
 */
export const PLAN_TRANSITIONS: Readonly<
  Record<PlanStatus, readonly PlanStatus[]>
> = {
  DRAFT: ['CALCULATING'],
  CALCULATING: ['READY_FOR_REVIEW', 'FAILED'],
  READY_FOR_REVIEW: ['CALCULATING', 'APPROVED', 'DRAFT'],
  APPROVED: ['READY_FOR_REVIEW', 'APPLYING'],
  APPLYING: ['APPLIED', 'FAILED', 'READY_FOR_REVIEW'],
  APPLIED: ['ROLLED_BACK'],
  FAILED: ['CALCULATING', 'DRAFT', 'APPLYING'],
  ROLLED_BACK: [],
};

/** Keyed by the stored status TEXT, so an unknown value simply allows nothing. */
const TRANSITIONS_BY_STATUS: ReadonlyMap<string, readonly PlanStatus[]> =
  new Map(Object.entries(PLAN_TRANSITIONS));

export function assertTransition(from: string, to: PlanStatus): void {
  const allowed = TRANSITIONS_BY_STATUS.get(from) ?? [];
  if (!allowed.includes(to)) {
    throw pricingError.conflict(E.PRICING_PLAN_STATE_CONFLICT, { from, to });
  }
}
