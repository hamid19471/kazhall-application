/**
 * ============================================================================
 * PRODUCT CHANNEL VISIBILITY — «محل عرضه محصول».
 *
 * Migration 0030 (`1757000000030-ProductChannelVisibility.ts`) creates the
 * database objects named here. This file is the single place the RULES and the
 * SQL PREDICATES are written down, so that the six places which must filter by
 * visibility — public list, public detail, POS catalogue, POS search, cart and
 * the POS sale transaction — cannot each grow their own slightly different
 * version of the same condition.
 *
 * ---------------------------------------------------------------------------
 * THE DOMAIN BOUNDARY. READ THIS FIRST.
 * ---------------------------------------------------------------------------
 * THIS IS VISIBILITY, NOT INVENTORY. Nothing here splits stock per branch.
 *
 *   physical stock          still GLOBAL  (`product_variants.stock`)
 *   basket reservations     still GLOBAL  (`stock_reservations`, no branch)
 *   order allocations       still GLOBAL
 *   POS displacement        UNCHANGED
 *
 * Selecting three branches for a product does NOT give those branches three
 * separate stock pools; it decides WHERE THE PRODUCT MAY BE SOLD FROM, while
 * every one of those branches continues to sell out of the same single
 * quantity. Two cashiers in two selected branches selling the last unit race
 * for the same row and exactly one wins, precisely as two cashiers in one
 * branch do today.
 *
 * The Admin UI states this to the operator in Persian, and
 * `docs/FRONTEND-API-CONTRACT.md` states it to the client developer, because
 * "I selected my branch, so my branch has its own stock" is the single most
 * likely wrong inference from this feature.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL — two INDEPENDENT dimensions, never one enum
 * ---------------------------------------------------------------------------
 *   products."visibleOnSite"     boolean   — the Website channel
 *   products."branchVisibility"  enum      — the retail channel:
 *                                              'none' | 'all' | 'selected'
 *   product_branch_visibility    join rows — which branches, when 'selected'
 *
 * They are independent on purpose. The six cases the owner asked for are not
 * six values of one field, they are the product of two smaller decisions, and
 * modelling them as one enum would make "website plus selected branches"
 * unrepresentable the moment a seventh case is wanted:
 *
 *   | case                       | visibleOnSite | branchVisibility |
 *   | website only               | true          | none             |
 *   | all retail branches        | false         | all              |
 *   | selected retail branches   | false         | selected         |
 *   | website + selected         | true          | selected         |
 *   | website + all ("همه کانال‌ها") | true       | all              |
 *   | hidden / draft             | false         | none             |
 *
 * ---------------------------------------------------------------------------
 * WHY 'all' IS A MODE AND NOT A SET OF ROWS
 * ---------------------------------------------------------------------------
 * "All branches" is NOT implemented by inserting one row per current branch.
 * A branch opened next month must sell an "all branches" product on its first
 * day WITHOUT anybody revisiting the catalogue — and a materialised row set
 * cannot do that. It is a MODE, evaluated at read time, so it stays true for
 * branches that do not exist yet. `selected` is the opposite by design: a new
 * branch sells nothing that was explicitly scoped before it existed.
 *
 * ---------------------------------------------------------------------------
 * DEACTIVATED BRANCHES
 * ---------------------------------------------------------------------------
 * A deactivated branch exposes NOTHING, under either mode. This is enforced
 * where the branch is resolved (a cashier assigned to an inactive branch is
 * already refused at `POST /orders/pos`), not by deleting the mapping rows —
 * so REACTIVATING a branch restores exactly the visibility it had before,
 * with no administrative replay. That is why `branches.isActive` flipping does
 * not touch `product_branch_visibility` at all.
 * ============================================================================
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';

import {
  ProductVisibilityErrorCodes,
  ProductVisibilityMessages,
} from 'src/common/constants/product-visibility.messages';

/** The retail-channel dimension. Values match the PostgreSQL enum exactly. */
export const BRANCH_VISIBILITY_MODES = ['none', 'all', 'selected'] as const;
export type BranchVisibilityMode = (typeof BRANCH_VISIBILITY_MODES)[number];

export function isBranchVisibilityMode(
  value: unknown,
): value is BranchVisibilityMode {
  return (
    typeof value === 'string' &&
    (BRANCH_VISIBILITY_MODES as readonly string[]).includes(value)
  );
}

/** Database object names created by migration 0030. Authoritative. */
export const BRANCH_VISIBILITY_ENUM = 'products_branchvisibility_enum';
export const PRODUCT_BRANCH_VISIBILITY_TABLE = 'product_branch_visibility';
export const PK_PRODUCT_BRANCH_VISIBILITY = 'pk_product_branch_visibility';
export const FK_PBV_PRODUCT = 'fk_pbv_product';
export const FK_PBV_BRANCH = 'fk_pbv_branch';
export const IDX_PBV_BRANCH = 'idx_pbv_branch';
export const IDX_PRODUCT_VISIBLE_ON_SITE = 'idx_products_visible_on_site';
export const IDX_PRODUCT_BRANCH_VISIBILITY = 'idx_products_branch_visibility';

/**
 * The DEFERRABLE constraint trigger that makes the two invalid combinations
 * unrepresentable rather than merely unwritten by the service:
 *
 *   mode = 'selected' with ZERO mapping rows   — "selected branches: none"
 *   mode <> 'selected' with mapping rows       — orphaned selections
 *
 * DEFERRABLE INITIALLY DEFERRED is load-bearing. Switching a product from
 * 'all' to 'selected' is necessarily two statements (UPDATE the mode, INSERT
 * the rows) and one of the two orders is momentarily invalid whichever way you
 * write it. Deferring to COMMIT means the service may write them in the
 * natural order and still cannot commit an invalid pair.
 */
export const TRG_PRODUCT_BRANCH_VISIBILITY_CONSISTENT =
  'trg_product_branch_visibility_consistent';
export const FN_ASSERT_BRANCH_VISIBILITY =
  'assert_product_branch_visibility_consistent';

/**
 * THE PUBLIC (WEBSITE) PREDICATE.
 *
 * `alias` is the `products` alias in the caller's query. Everything the
 * storefront can reach — list, detail, search, category filter, cart add,
 * quote, checkout — goes through this one string, so "is it on the site"
 * has exactly one definition.
 */
export function productVisibleOnSiteSql(alias = 'p'): string {
  return `"${alias}"."visibleOnSite" = true`;
}

/**
 * THE RETAIL (POS) PREDICATE, for ONE branch.
 *
 * Note what is NOT here: any check of `branches.isActive`. The branch is
 * resolved and its active state asserted before this predicate is ever
 * reached, so that an inactive branch fails ONCE with a clear refusal rather
 * than silently returning an empty catalogue that looks like an empty shop.
 *
 * `:branchId` must be bound by the caller. It is a bound parameter and never
 * interpolated — a branch id reaches this from a JWT and is not trusted.
 */
export function productVisibleInBranchSql(
  alias = 'p',
  branchParam = ':branchId',
): string {
  return `(
    "${alias}"."branchVisibility" = 'all'
    OR (
      "${alias}"."branchVisibility" = 'selected'
      AND EXISTS (
        SELECT 1
          FROM "${PRODUCT_BRANCH_VISIBILITY_TABLE}" pbv
         WHERE pbv."productId" = "${alias}"."id"
           AND pbv."branchId" = ${branchParam}
      )
    )
  )`;
}

/** The complete visibility configuration, as Admin reads and writes it. */
export interface ProductVisibilityConfig {
  visibleOnSite: boolean;
  branchVisibility: BranchVisibilityMode;
  /** Present and non-empty only when mode is `selected`. */
  branchIds: number[];
}

/**
 * HIDDEN / DRAFT — offered nowhere.
 *
 * This is the default a delegated (non-super_admin) editor's new product gets,
 * and it is the only state such an editor can leave a product in. Publishing
 * is a super_admin act.
 */
export const HIDDEN_DRAFT: ProductVisibilityConfig = Object.freeze({
  visibleOnSite: false,
  branchVisibility: 'none',
  branchIds: [],
}) as ProductVisibilityConfig;

/** True when the product is offered nowhere at all. */
export function isHiddenDraft(config: {
  visibleOnSite: boolean;
  branchVisibility: BranchVisibilityMode;
}): boolean {
  return !config.visibleOnSite && config.branchVisibility === 'none';
}

/**
 * Normalise and validate a submitted visibility configuration.
 *
 * Returns the configuration to persist. Rejections are 400s naming the field,
 * so the Admin form can render each one beside the control that caused it.
 *
 * `branchIds` is de-duplicated here rather than being allowed to reach the
 * database and be absorbed by the primary key: silently accepting `[3, 3]`
 * and storing one row is fine, but so is telling the truth, and the composite
 * primary key remains the thing that makes a duplicate IMPOSSIBLE rather than
 * merely unlikely.
 */
export function normaliseVisibilityConfig(input: {
  visibleOnSite?: unknown;
  branchVisibility?: unknown;
  branchIds?: unknown;
}): ProductVisibilityConfig {
  if (typeof input.visibleOnSite !== 'boolean') {
    throw new BadRequestException({
      error: ProductVisibilityErrorCodes.VISIBILITY_INVALID,
      message: ProductVisibilityMessages.SITE_FLAG_INVALID,
      field: 'visibleOnSite',
    });
  }

  if (!isBranchVisibilityMode(input.branchVisibility)) {
    throw new BadRequestException({
      error: ProductVisibilityErrorCodes.VISIBILITY_INVALID,
      message: ProductVisibilityMessages.BRANCH_MODE_INVALID,
      field: 'branchVisibility',
      allowed: [...BRANCH_VISIBILITY_MODES],
    });
  }

  const mode = input.branchVisibility;
  const rawIds = input.branchIds;

  if (mode !== 'selected') {
    /*
     * Branch ids under 'none' or 'all' are REFUSED, not quietly dropped. A
     * form that sends them is out of step with its own mode control, and
     * accepting the request would persist a configuration the operator did not
     * see on screen — the mode wins, and their carefully picked branches
     * silently evaporate.
     */
    if (Array.isArray(rawIds) && rawIds.length > 0) {
      throw new BadRequestException({
        error: ProductVisibilityErrorCodes.BRANCHES_NOT_ALLOWED_FOR_MODE,
        message: ProductVisibilityMessages.BRANCHES_NOT_ALLOWED_FOR_MODE,
        field: 'branchIds',
        branchVisibility: mode,
      });
    }
    return {
      visibleOnSite: input.visibleOnSite,
      branchVisibility: mode,
      branchIds: [],
    };
  }

  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new BadRequestException({
      error: ProductVisibilityErrorCodes.BRANCHES_REQUIRED,
      message: ProductVisibilityMessages.BRANCHES_REQUIRED,
      field: 'branchIds',
    });
  }

  const ids: number[] = [];
  /*
   * `Array.isArray` on an `unknown` narrows to `any[]`, not `unknown[]`, so the
   * element would be `any` and every use of it unchecked. Re-stating the
   * element type is what keeps the loop honest.
   */
  for (const raw of rawIds as unknown[]) {
    const id = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(id) || id < 1) {
      throw new BadRequestException({
        error: ProductVisibilityErrorCodes.VISIBILITY_INVALID,
        message: ProductVisibilityMessages.BRANCH_ID_INVALID,
        field: 'branchIds',
        value: raw,
      });
    }
    if (!ids.includes(id)) ids.push(id);
  }

  return {
    visibleOnSite: input.visibleOnSite,
    branchVisibility: 'selected',
    branchIds: ids.sort((a, b) => a - b),
  };
}

/**
 * The refusal for branch ids that do not exist, or that exist but are
 * deactivated and are being NEWLY selected.
 *
 * Both are one 400 with the offending ids listed, because from the operator's
 * side they are the same mistake — "this branch cannot be chosen" — and
 * distinguishing "no such branch" from "closed branch" would let a caller
 * probe which branch ids exist.
 */
export function rejectUnusableBranches(
  unknownIds: number[],
  inactiveIds: number[],
): never {
  throw new BadRequestException({
    error: ProductVisibilityErrorCodes.BRANCHES_UNUSABLE,
    message: ProductVisibilityMessages.BRANCHES_UNUSABLE,
    field: 'branchIds',
    ...(unknownIds.length > 0 ? { unknownBranchIds: unknownIds } : {}),
    ...(inactiveIds.length > 0 ? { inactiveBranchIds: inactiveIds } : {}),
  });
}

/**
 * THE AUTHORIZATION RULE, in one place.
 *
 * Only the built-in `super_admin` role may set or change channel/branch
 * visibility. A delegated catalogue editor keeps every ordinary product
 * permission it already had and gains nothing here: it cannot publish to the
 * site, cannot assign branches, and cannot widen OR NARROW an existing
 * configuration.
 *
 * "Cannot narrow" is deliberate and worth stating. Unpublishing looks
 * harmless — it removes rather than grants reach — but it takes a product off
 * the storefront and out of every till, which is a commercial decision with
 * the same blast radius as publishing.
 *
 * This is enforced in the SERVICE, never only on a route decorator and never
 * in React. It is re-asserted here even on routes that already carry
 * `@Roles(UserRoleEnum.superAdmin)`, matching how `reports.service.ts` and
 * `dashboard.service.ts` re-assert their own role gate: a decorator protects
 * one HTTP path, while this protects the operation however it is reached.
 */
export function assertMayChangeVisibility(isSuperAdmin: boolean): void {
  if (isSuperAdmin) return;
  throw new ForbiddenException({
    error: ProductVisibilityErrorCodes.VISIBILITY_FORBIDDEN,
    message: ProductVisibilityMessages.VISIBILITY_FORBIDDEN,
    field: 'visibility',
  });
}

/**
 * Does this payload try to change visibility at all?
 *
 * Used so a delegated editor's ORDINARY edit (title, price, images) is not
 * refused merely because the form round-tripped the fields it was shown. Only
 * a payload that actually DIFFERS from the stored configuration is treated as
 * an attempt to change it.
 */
export function visibilityDiffers(
  next: ProductVisibilityConfig,
  current: ProductVisibilityConfig,
): boolean {
  if (next.visibleOnSite !== current.visibleOnSite) return true;
  if (next.branchVisibility !== current.branchVisibility) return true;
  if (next.branchIds.length !== current.branchIds.length) return true;
  const a = [...next.branchIds].sort((x, y) => x - y);
  const b = [...current.branchIds].sort((x, y) => x - y);
  return a.some((id, i) => id !== b[i]);
}
