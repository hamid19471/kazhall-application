import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ProductNotAvailableInBranchError } from 'src/modules/inventory/inventory.errors';
import {
  BranchVisibilityMode,
  HIDDEN_DRAFT,
  ProductVisibilityConfig,
  assertMayChangeVisibility,
  normaliseVisibilityConfig,
  rejectUnusableBranches,
  visibilityDiffers,
} from 'src/common/catalogue/product-visibility';

interface BranchRow {
  id: number;
  name: string;
  isActive: boolean;
}

/** What Admin reads back, with branch names resolved for display. */
export interface ProductVisibilityView {
  visibleOnSite: boolean;
  branchVisibility: BranchVisibilityMode;
  branches: Array<{ id: number; name: string; isActive: boolean }>;
  /** True when the product is offered nowhere at all. */
  hiddenDraft: boolean;
}

/**
 * ============================================================================
 * READING AND WRITING «محل عرضه محصول».
 *
 * Everything that touches a product's channel configuration goes through here,
 * so the authorization rule, the branch validation and the two-statement
 * persistence order exist exactly once.
 *
 * THIS IS VISIBILITY, NOT INVENTORY — nothing in this file consults or changes
 * stock. See `src/common/catalogue/product-visibility.ts`.
 * ============================================================================
 */
@Injectable()
export class ProductVisibilityService {
  /**
   * `EntityManager.query` is typed `Promise<any>`. Narrowing it once, here,
   * keeps every call site below genuinely typed instead of spreading `any` —
   * the same helper `PosCatalogService` uses for the same reason.
   */
  private rows<T>(
    manager: EntityManager,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    // No cast: the DECLARED RETURN TYPE is what narrows it, exactly as
    // `PosCatalogService.rows` does. An explicit `as Promise<T[]>` here is
    // flagged redundant and stripped by `--fix`, which is how `any` leaked
    // back into every call site the first time.
    return manager.query(sql, parameters);
  }

  /**
   * The stored configuration for one product.
   *
   * Used both to render Admin and — crucially — to decide whether an incoming
   * edit actually CHANGES anything, which is what lets a delegated editor
   * round-trip the fields the form showed them without being refused.
   */
  async read(
    manager: EntityManager,
    productId: number,
  ): Promise<ProductVisibilityConfig> {
    const rows = await this.rows<{
      visibleOnSite: boolean;
      mode: BranchVisibilityMode;
      branch_ids: number[] | null;
    }>(
      manager,
      `SELECT p."visibleOnSite", p."branchVisibility"::text AS mode,
              COALESCE(
                (SELECT array_agg(pbv."branchId" ORDER BY pbv."branchId")
                   FROM "product_branch_visibility" pbv
                  WHERE pbv."productId" = p."id"),
                '{}'
              ) AS branch_ids
         FROM "products" p
        WHERE p."id" = $1`,
      [productId],
    );

    const row = rows[0];
    if (row === undefined) return { ...HIDDEN_DRAFT, branchIds: [] };

    return {
      visibleOnSite: row.visibleOnSite,
      branchVisibility: row.mode,
      branchIds: (row.branch_ids ?? []).map(Number),
    };
  }

  /** The Admin-facing projection, with branch names and active flags. */
  async readView(
    manager: EntityManager,
    productId: number,
  ): Promise<ProductVisibilityView> {
    const config = await this.read(manager, productId);

    /*
     * Retired branches are STILL LISTED. A product scoped to a branch that has
     * since closed must keep showing that selection, or the operator sees a
     * shorter list than they chose and cannot tell whether the branch was
     * removed or is merely closed — and reactivating the branch would then
     * surprise them by restoring a selection the UI had stopped mentioning.
     */
    const branches =
      config.branchIds.length === 0
        ? []
        : await this.rows<BranchRow>(
            manager,
            `SELECT "id", "name", "isActive"
               FROM "branches"
              WHERE "id" = ANY($1::int[])
              ORDER BY "name" ASC`,
            [config.branchIds],
          );

    return {
      visibleOnSite: config.visibleOnSite,
      branchVisibility: config.branchVisibility,
      branches: branches.map((b) => ({
        id: Number(b.id),
        name: b.name,
        isActive: b.isActive,
      })),
      hiddenDraft: !config.visibleOnSite && config.branchVisibility === 'none',
    };
  }

  /**
   * Validate a submitted configuration and decide whether the actor may apply
   * it — WITHOUT writing anything.
   *
   * Split from `persist` so a caller inside a create/update transaction can
   * fail fast, before it has written a product row it would have to roll back.
   *
   * `current` is `null` on create. On update it is compared against the
   * submitted value so an UNCHANGED configuration is not treated as an attempt
   * to change it — a delegated editor may keep editing titles and prices
   * through a form that round-trips the visibility fields it rendered.
   */
  async resolve(
    manager: EntityManager,
    input: {
      visibleOnSite?: unknown;
      branchVisibility?: unknown;
      branchIds?: unknown;
    },
    options: { isSuperAdmin: boolean; current: ProductVisibilityConfig | null },
  ): Promise<ProductVisibilityConfig> {
    const next = normaliseVisibilityConfig(input);

    const changes =
      options.current === null
        ? // On create, anything other than hidden/draft is a publish.
          visibilityDiffers(next, HIDDEN_DRAFT)
        : visibilityDiffers(next, options.current);

    if (changes) assertMayChangeVisibility(options.isSuperAdmin);

    if (next.branchVisibility === 'selected') {
      await this.assertBranchesUsable(
        manager,
        next.branchIds,
        options.current?.branchIds ?? [],
      );
    }

    return next;
  }

  /**
   * Write the configuration for `productId`.
   *
   * ORDER MATTERS, and the deferrable constraint trigger is what makes the
   * natural order legal: the mode is written first and the rows second, which
   * is momentarily inconsistent and would be refused by an immediate
   * constraint. The trigger defers to COMMIT, so only the END STATE has to be
   * valid — see migration 0030.
   *
   * The mapping rows are replaced wholesale rather than diffed. The set is
   * small, the write is inside the caller's transaction, and a delete-then-
   * insert cannot drift the way an incremental diff can.
   */
  async persist(
    manager: EntityManager,
    productId: number,
    config: ProductVisibilityConfig,
  ): Promise<void> {
    await manager.query(
      `UPDATE "products"
          SET "visibleOnSite" = $2,
              "branchVisibility" = $3::"public"."products_branchvisibility_enum"
        WHERE "id" = $1`,
      [productId, config.visibleOnSite, config.branchVisibility],
    );

    await manager.query(
      `DELETE FROM "product_branch_visibility" WHERE "productId" = $1`,
      [productId],
    );

    if (config.branchVisibility === 'selected' && config.branchIds.length > 0) {
      await manager.query(
        `INSERT INTO "product_branch_visibility" ("productId", "branchId")
         SELECT $1, unnest($2::int[])`,
        [productId, config.branchIds],
      );
    }
  }

  /**
   * ========================================================================
   * THE POS SALE GATE — refuse a line the cashier's branch does not carry.
   * ========================================================================
   *
   * Called INSIDE the sale transaction, after the variant rows are locked and
   * before anything is written. It answers from AUTHORITATIVE DATABASE STATE,
   * never from a cached catalogue page, because the page the cashier tapped
   * may be seconds old and a withdrawal may have committed since.
   *
   * ---------------------------------------------------------------------
   * THE LOCK, AND WHY IT IS `FOR SHARE`
   * ---------------------------------------------------------------------
   * The product rows are locked `FOR SHARE`, ordered by id, which gives the
   * race a defined serial order in both directions:
   *
   *   • if an admin's visibility UPDATE commits FIRST, this SELECT waits for
   *     it and then reads the new configuration — the sale is refused;
   *   • if this SELECT takes its share lock first, the admin's UPDATE blocks
   *     until the sale commits — the sale is allowed, and the withdrawal
   *     applies to everything after it.
   *
   * Either way exactly one of the two outcomes happens and neither observes a
   * half-applied change. What is ruled out is the third possibility: reading
   * stale visibility and committing a sale against it.
   *
   * `FOR SHARE` rather than `FOR UPDATE` deliberately: two cashiers in two
   * branches selling the same product must not serialise behind each other.
   * They share the lock; only the writer is excluded.
   *
   * THIS DEPENDS ON `persist()` ALWAYS ISSUING ITS `UPDATE "products"` — even
   * when only the branch LIST changed and the mode did not. That UPDATE takes
   * the row-exclusive lock this share lock contends with, and it is what makes
   * a mapping-only change serialise against a sale too. Do not "optimise" it
   * into a conditional update.
   *
   * ORDERING: products are locked AFTER `product_variants`, ascending by id.
   * The admin path never locks variants, so no cycle exists with the global
   * `product_variants -> stock_reservations -> cart_items` order.
   */
  async assertSellableInBranch(
    manager: EntityManager,
    variantIds: readonly number[],
    branchId: number,
  ): Promise<void> {
    if (variantIds.length === 0) return;

    const rows = await this.rows<{
      variantId: number;
      variantCode: string | null;
      productId: number;
      productCode: string | null;
      mode: BranchVisibilityMode;
      selected: boolean;
    }>(
      manager,
      `SELECT v."id"            AS "variantId",
              v."variantCode"   AS "variantCode",
              p."id"            AS "productId",
              p."productCode"   AS "productCode",
              p."branchVisibility"::text AS mode,
              EXISTS (
                SELECT 1 FROM "product_branch_visibility" pbv
                 WHERE pbv."productId" = p."id"
                   AND pbv."branchId" = $2
              ) AS selected
         FROM "product_variants" v
         JOIN "products" p ON p."id" = v."productId"
        WHERE v."id" = ANY($1::int[])
        ORDER BY p."id" ASC
          FOR SHARE OF p`,
      [[...variantIds], branchId],
    );

    for (const row of rows) {
      const allowed =
        row.mode === 'all' || (row.mode === 'selected' && row.selected);
      if (allowed) continue;

      throw new ProductNotAvailableInBranchError(
        Number(row.productId),
        row.productCode,
        Number(row.variantId),
        row.variantCode,
        branchId,
      );
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Every submitted branch must exist, and every NEWLY selected one must be
   * active.
   *
   * ALREADY-SELECTED inactive branches are tolerated on purpose. A product
   * scoped to three branches, one of which later closed, must remain editable:
   * refusing the whole save would mean the operator cannot change the title of
   * that product until somebody reopens a shop. What is forbidden is ADDING a
   * closed branch, which is a new decision rather than an inherited one.
   */
  private async assertBranchesUsable(
    manager: EntityManager,
    requested: readonly number[],
    alreadySelected: readonly number[],
  ): Promise<void> {
    const rows = await this.rows<BranchRow>(
      manager,
      `SELECT "id", "name", "isActive"
         FROM "branches"
        WHERE "id" = ANY($1::int[])`,
      [[...requested]],
    );

    const found = new Map(rows.map((r) => [Number(r.id), r]));
    const inherited = new Set(alreadySelected);

    const unknownIds: number[] = [];
    const inactiveIds: number[] = [];

    for (const id of requested) {
      const row = found.get(id);
      if (row === undefined) {
        unknownIds.push(id);
        continue;
      }
      if (!row.isActive && !inherited.has(id)) inactiveIds.push(id);
    }

    if (unknownIds.length > 0 || inactiveIds.length > 0) {
      rejectUnusableBranches(unknownIds, inactiveIds);
    }
  }
}
