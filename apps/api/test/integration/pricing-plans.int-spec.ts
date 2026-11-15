/**
 * Monthly cost-recovery pricing plans — the API contract end to end
 * (docs/MONTHLY-PRICING.md). Formula through the API, validation, eligibility,
 * the persisted and paginated preview, review decisions and the lifecycle up
 * to approval. Applying and rolling back are in pricing-apply.int-spec.ts.
 */
import { PricingRunnerService } from 'src/modules/pricing/pricing-runner.service';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  createTestApp,
  resetDatabase,
  TestApp,
} from './support/catalog.harness';
import {
  createCategory,
  createProduct,
  createVariant,
} from './setup/seed-helpers';
import {
  EXAMPLE_INPUTS,
  calculated,
  examplePlan,
  listAt,
  livePrice,
  planOf,
  pricingClient,
  recordAt,
  rowWhere,
  rowsOf,
  seedPricedCatalog,
  valueVariant,
} from './support/pricing.fixtures';

describe('monthly pricing plans (int)', () => {
  let ctx: TestApp;
  let cookie: string;
  let client: ReturnType<typeof pricingClient>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  // A run kicked by a test's last request must finish before the next test
  // truncates the tables it is writing.
  afterEach(async () => {
    await ctx.app.get(PricingRunnerService, { strict: false }).idle();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    cookie = (await ctx.loginAs([UserRoleEnum.superAdmin])).cookie;
    client = pricingClient(ctx, cookie);
  });

  /** A simple product whose default variant costs `cost` and sells at `price`. */
  async function simpleVariant(
    cost: bigint,
    price: number | null,
    opts: { stock?: number } = {},
  ) {
    const product = await createProduct(ctx.dataSource);
    const variant = await createVariant(ctx.dataSource, product, {
      price: price ?? 0,
    });
    await ctx.dataSource.query(
      `UPDATE product_variants SET "isDefault" = true WHERE id = $1`,
      [variant.id],
    );
    if (price === null) {
      await ctx.dataSource.query(
        `UPDATE product_variants SET price = NULL WHERE id = $1`,
        [variant.id],
      );
    }
    await valueVariant(ctx.dataSource, variant.id, {
      stock: opts.stock ?? 10,
      unitCost: cost,
    });
    return { productId: product.id, variantId: variant.id };
  }

  async function itemFor(planId: number, variantId: number) {
    const res = await client
      .items(planId, { view: 'all', limit: 100 })
      .expect(200);
    return rowWhere(rowsOf(res), 'variantId', variantId);
  }

  // ==========================================================================
  // Formula
  // ==========================================================================

  it('prices the worked example at 2 000 000 Rial from an immutable input snapshot', async () => {
    const v = await simpleVariant(1_000_000n, 1_900_000);
    const planId = await examplePlan(ctx, cookie);
    await client
      .addCost(planId, {
        title: 'غیرفعال',
        amountRial: '999000000',
        isActive: false,
      })
      .expect(201);

    const plan = (await client.get(planId).expect(200)).body.data;
    expect(plan.monthlyCostsTotalRial).toBe('1000000000');
    expect(plan.operatingCostRatePercent).toBe('20.00');
    expect(plan.denominatorPercent).toBe('50.00');
    expect(plan.inputProblems).toEqual([]);
    expect(plan.taxRatePercent).toBe('10.00');
    expect(plan.targetProfitMarginPercent).toBe('20.00');

    const run = await calculated(ctx, cookie, planId);
    expect(run.status).toBe('succeeded');
    expect(run.inputsSnapshot).toMatchObject({
      calculationMethod: 'TARGET_REVENUE',
      formulaVersion: 1,
      monthlyCostsTotalRial: '1000000000',
      targetMonthlyRevenueRial: '5000000000',
      taxRateBps: 1000,
      targetProfitMarginBps: 2000,
      operatingCostRatePercent: '20.00',
    });
    expect(listAt(recordAt(run, 'inputsSnapshot'), 'costEntries')).toHaveLength(
      3,
    );

    const item = await itemFor(planId, v.variantId);
    expect(item).toMatchObject({
      costBasisRial: '1000000',
      currentPriceRial: '1900000',
      rawPrice: '2000000.0000',
      proposedPriceRial: '2000000',
      finalPriceRial: '2000000',
      changeRial: '100000',
      changePercent: '5.26',
      status: 'READY',
      included: true,
      applicable: true,
      formulaVersion: 1,
      calculationMethod: 'TARGET_REVENUE',
    });

    // Saving and calculating never touch the live price.
    expect(await livePrice(ctx.dataSource, v.variantId)).toBe('1900000');

    // Later edits to the plan do not rewrite the calculation's snapshot.
    await client.update(planId, { taxRatePercent: '9' }).expect(200);
    const again = (await client.runs(planId).expect(200)).body.data[0];
    expect(again.inputsSnapshot.taxRateBps).toBe(1000);
  });

  it('rounds up to the configured step', async () => {
    const v = await simpleVariant(1_000_001n, 1_900_000);
    const planId = await examplePlan(ctx, cookie, {
      roundingStepRial: '10000',
    });
    await calculated(ctx, cookie, planId);
    const item = await itemFor(planId, v.variantId);
    expect(item.rawPrice).toBe('2000002.0000');
    expect(item.proposedPriceRial).toBe('2010000');
  });

  // ==========================================================================
  // Validation
  // ==========================================================================

  it('refuses unusable inputs with stable codes and a Persian explanation', async () => {
    await simpleVariant(1_000_000n, 1_900_000);
    const created = await client
      .create({ title: 'ناقص', effectiveYear: 1405, effectiveMonth: 7 })
      .expect(201);
    const planId = Number(created.body.data.id);

    // incomplete
    let res = await client.calculate(planId).expect(400);
    expect(res.body.error).toBe('PRICING_INPUTS_INCOMPLETE');

    // denominator at exactly 100 %: 20 % costs + 10 % tax + 70 % profit
    await client
      .update(planId, { ...EXAMPLE_INPUTS, targetProfitMarginPercent: '70' })
      .expect(200);
    await client
      .addCost(planId, { title: 'اجاره', amountRial: '1000000000' })
      .expect(201);
    const plan = (await client.get(planId).expect(200)).body.data;
    expect(plan.denominatorPercent).toBe('0.00');
    expect(plan.inputProblems[0].code).toBe('PRICING_DENOMINATOR_NOT_POSITIVE');
    res = await client.calculate(planId).expect(400);
    expect(res.body.error).toBe('PRICING_DENOMINATOR_NOT_POSITIVE');
    expect(res.body.message).toMatch(/۱۰۰٪/);
    expect(res.body.message).toMatch(/فروش ماهانهٔ هدف را بیشتر کنید/);

    // revenue target zero
    await client
      .update(planId, {
        targetProfitMarginPercent: '20',
        targetMonthlyRevenueRial: 0,
      })
      .expect(200);
    res = await client.calculate(planId).expect(400);
    expect(res.body.error).toBe('PRICING_TARGET_REVENUE_NOT_POSITIVE');

    // malformed values are refused at the edit, before they are stored
    expect(
      (
        await client
          .update(planId, { targetMonthlyRevenueRial: '-5' })
          .expect(400)
      ).body.error,
    ).toBe('PRICING_AMOUNT_NEGATIVE');
    expect(
      (
        await client
          .update(planId, { targetMonthlyRevenueRial: '1.5' })
          .expect(400)
      ).body.error,
    ).toBe('PRICING_AMOUNT_INVALID');
    expect(
      (await client.update(planId, { taxRatePercent: '100' }).expect(400)).body
        .error,
    ).toBe('PRICING_TAX_RATE_OUT_OF_RANGE');
    await client.update(planId, { taxRatePercent: '12.345' }).expect(400);
    await client.update(planId, { taxRatePercent: 10 }).expect(400); // a number, not text
    expect(
      (await client.update(planId, { roundingStepRial: 0 }).expect(400)).body
        .error,
    ).toBe('PRICING_ROUNDING_STEP_INVALID');
    expect(
      (
        await client
          .addCost(planId, { title: 'منفی', amountRial: -1 })
          .expect(400)
      ).body.error,
    ).toBe('PRICING_AMOUNT_NEGATIVE');
  });

  it('refuses to calculate when no variant has a fully known cost', async () => {
    const product = await createProduct(ctx.dataSource);
    const variant = await createVariant(ctx.dataSource, product, {
      price: 1_000_000,
    });
    await valueVariant(ctx.dataSource, variant.id, {
      stock: 5,
      unitCost: 0n,
      unvalued: 5,
    });
    const planId = await examplePlan(ctx, cookie);
    const res = await client.calculate(planId).expect(400);
    expect(res.body.error).toBe('PRICING_NO_ELIGIBLE_VARIANTS');
  });

  // ==========================================================================
  // Eligibility
  // ==========================================================================

  it('classifies simple, multi-variant, unknown-cost, inactive, unoffered and unchanged variants', async () => {
    const simple = await simpleVariant(1_000_000n, 1_900_000);

    // one product, three variants priced independently
    const multi = await createProduct(ctx.dataSource);
    const small = await createVariant(ctx.dataSource, multi, {
      price: 900_000,
    });
    const large = await createVariant(ctx.dataSource, multi, {
      price: 3_000_000,
    });
    const unknown = await createVariant(ctx.dataSource, multi, {
      price: 1_000_000,
    });
    await valueVariant(ctx.dataSource, small.id, {
      stock: 4,
      unitCost: 400_000n,
    }); // → 800 000 (decrease)
    await valueVariant(ctx.dataSource, large.id, {
      stock: 4,
      unitCost: 1_600_000n,
    }); // → 3 200 000 (+6.67 %)
    await valueVariant(ctx.dataSource, unknown.id, {
      stock: 4,
      unitCost: 0n,
      unvalued: 4,
    });

    const partial = await simpleVariant(1_000_000n, 1_900_000);
    await valueVariant(ctx.dataSource, partial.variantId, {
      stock: 5,
      unitCost: 1_000_000n,
      unvalued: 2,
    });
    const inactive = await simpleVariant(1_000_000n, 1_900_000);
    await ctx.dataSource.query(
      `UPDATE product_variants SET "isActive" = false WHERE id = $1`,
      [inactive.variantId],
    );
    const hidden = await simpleVariant(1_000_000n, 1_900_000);
    await ctx.dataSource.query(
      `UPDATE products SET "visibleOnSite" = false, "branchVisibility" = 'none' WHERE id = $1`,
      [hidden.productId],
    );
    const same = await simpleVariant(1_000_000n, 2_000_000);
    const bigJump = await simpleVariant(1_000_000n, 1_000_000); // +100 %
    const noPrice = await simpleVariant(1_000_000n, null);
    const empty = await simpleVariant(1_000_000n, 1_900_000, { stock: 0 });

    const planId = await examplePlan(ctx, cookie);
    const run = await calculated(ctx, cookie, planId);
    expect(run.status).toBe('succeeded');

    const expectations: [number, string, string[]][] = [
      [simple.variantId, 'READY', []],
      [small.id, 'NEEDS_REVIEW', ['PRICE_DECREASE']],
      [large.id, 'READY', []],
      [unknown.id, 'BLOCKED', ['COST_UNKNOWN']],
      [partial.variantId, 'BLOCKED', ['COST_PARTIALLY_UNKNOWN']],
      [inactive.variantId, 'BLOCKED', ['VARIANT_INACTIVE']],
      [hidden.variantId, 'BLOCKED', ['PRODUCT_NOT_OFFERED']],
      [same.variantId, 'UNCHANGED', []],
      [bigJump.variantId, 'NEEDS_REVIEW', ['LARGE_INCREASE']],
      [noPrice.variantId, 'NEEDS_REVIEW', ['CURRENT_PRICE_MISSING']],
      [empty.variantId, 'BLOCKED', ['NO_COST_BASIS']],
    ];
    for (const [variantId, status, reasons] of expectations) {
      const item = await itemFor(planId, variantId);
      expect({ variantId, status: item.status, reasons: item.reasons }).toEqual(
        { variantId, status, reasons },
      );
    }
    expect((await itemFor(planId, large.id)).proposedPriceRial).toBe('3200000');
    expect((await itemFor(planId, small.id)).proposedPriceRial).toBe('800000');
    // a blocked unknown-cost row never carries a price guessed from anything
    expect((await itemFor(planId, unknown.id)).proposedPriceRial).toBeNull();
    // only READY rows start included
    expect((await itemFor(planId, small.id)).included).toBe(false);
    expect((await itemFor(planId, simple.variantId)).included).toBe(true);

    const summary = (await client.summary(planId).expect(200)).body.data;
    expect(summary).toMatchObject({
      evaluated: 11,
      ready: 2,
      unchanged: 1,
      needsReview: 3,
      blocked: 5,
      applicable: 2,
    });
  });

  // ==========================================================================
  // Review decisions
  // ==========================================================================

  it('includes, excludes, overrides and bulk-approves with validation', async () => {
    const ready = await simpleVariant(1_000_000n, 1_900_000);
    const decrease = await simpleVariant(1_000_000n, 2_500_000);
    const same = await simpleVariant(1_000_000n, 2_000_000);
    const blocked = await simpleVariant(1_000_000n, 1_900_000);
    await valueVariant(ctx.dataSource, blocked.variantId, {
      stock: 3,
      unitCost: 0n,
      unvalued: 3,
    });
    const planId = await examplePlan(ctx, cookie);
    await calculated(ctx, cookie, planId);

    const readyItem = await itemFor(planId, ready.variantId);
    const decreaseItem = await itemFor(planId, decrease.variantId);
    const sameItem = await itemFor(planId, same.variantId);
    const blockedItem = await itemFor(planId, blocked.variantId);

    // exclude / include a READY row
    let res = await client
      .updateItem(planId, readyItem.id, { included: false })
      .expect(200);
    expect(res.body.data.included).toBe(false);
    res = await client
      .updateItem(planId, readyItem.id, { included: true })
      .expect(200);
    expect(res.body.data).toMatchObject({ included: true, reviewed: true });

    // approving a NEEDS_REVIEW row is including it
    res = await client
      .updateItem(planId, decreaseItem.id, { included: true })
      .expect(200);
    expect(res.body.data).toMatchObject({
      included: true,
      reviewed: true,
      applicable: true,
    });

    // manual price: below cost refused, invalid refused, valid includes the row
    expect(
      (
        await client
          .updateItem(planId, readyItem.id, { overridePriceRial: '999999' })
          .expect(400)
      ).body.error,
    ).toBe('PRICING_OVERRIDE_BELOW_COST');
    expect(
      (
        await client
          .updateItem(planId, readyItem.id, { overridePriceRial: '12.5' })
          .expect(400)
      ).body.error,
    ).toBe('PRICING_OVERRIDE_INVALID');
    await client
      .updateItem(planId, readyItem.id, { overridePriceRial: 0 })
      .expect(400);
    res = await client
      .updateItem(planId, readyItem.id, { overridePriceRial: '2150000' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      overridePriceRial: '2150000',
      finalPriceRial: '2150000',
      proposedPriceRial: '2000000',
      changeRial: '250000',
      included: true,
    });
    res = await client
      .updateItem(planId, readyItem.id, { overridePriceRial: null })
      .expect(200);
    expect(res.body.data.finalPriceRial).toBe('2000000');

    // an UNCHANGED row cannot be included as it is, only with a different price
    expect(
      (
        await client
          .updateItem(planId, sameItem.id, { included: true })
          .expect(409)
      ).body.error,
    ).toBe('PRICING_ITEM_UNCHANGED');
    res = await client
      .updateItem(planId, sameItem.id, { overridePriceRial: '2100000' })
      .expect(200);
    expect(res.body.data).toMatchObject({ included: true, applicable: true });

    // a BLOCKED row can be neither included nor overridden
    await client
      .updateItem(planId, blockedItem.id, { included: true })
      .expect(409);
    await client
      .updateItem(planId, blockedItem.id, { overridePriceRial: '5000000' })
      .expect(409);

    // bulk: exclude everything in the "all" view, then include READY rows only
    res = await client
      .bulk(planId, { filters: { view: 'all' }, included: false })
      .expect(201);
    expect(res.body.data.summary.included).toBe(0);
    res = await client
      .bulk(planId, { filters: { view: 'all' }, included: true })
      .expect(201);
    // READY + UNCHANGED-with-override; the decrease still needs its own approval
    expect(res.body.data.summary.included).toBe(2);
    res = await client
      .bulk(planId, {
        filters: { view: 'all', status: 'NEEDS_REVIEW' },
        included: true,
        approveNeedsReview: true,
      })
      .expect(201);
    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.summary.approvedReview).toBe(1);
    expect(res.body.data.summary.applicable).toBe(3);

    // nothing of this touched a live price
    for (const v of [ready, decrease, same, blocked]) {
      const before = {
        [ready.variantId]: '1900000',
        [decrease.variantId]: '2500000',
        [same.variantId]: '2000000',
        [blocked.variantId]: '1900000',
      };
      expect(await livePrice(ctx.dataSource, v.variantId)).toBe(
        before[v.variantId],
      );
    }
  });

  // ==========================================================================
  // 1 000+ rows: persisted, paginated, filtered and sorted server-side
  // ==========================================================================

  it('handles a 1 050-variant preview with server-side paging, filters and sorting', async () => {
    const category = await createCategory(ctx.dataSource);
    const catalog = await seedPricedCatalog(ctx.dataSource, 1_050);
    await ctx.dataSource.query(
      `INSERT INTO product_category (product_id, category_id) SELECT unnest($1::int[]), $2`,
      [catalog.productIds.slice(0, 30), category.id],
    );
    const planId = await examplePlan(ctx, cookie);
    const run = await calculated(ctx, cookie, planId);
    expect(run).toMatchObject({
      status: 'succeeded',
      totalItems: 1050,
      processedItems: 1050,
    });

    const summary = (await client.summary(planId).expect(200)).body.data;
    // n % 10 = 0 → blocked (105); n % 7 = 0 → unchanged; n % 11 = 0 → decrease (review)
    expect(summary.evaluated).toBe(1050);
    expect(summary.blocked).toBe(105);
    expect(
      summary.ready + summary.unchanged + summary.needsReview + summary.blocked,
    ).toBe(1050);
    expect(summary.minChangePercent).toBe('-33.33');
    expect(summary.maxChangePercent).toBe('5.26');
    expect(summary.averageChangePercent).toMatch(/^-?\d+\.\d{2}$/);

    // default view = exceptions only
    const exceptions = await client.items(planId, { limit: 100 }).expect(200);
    expect(exceptions.body.total).toBe(summary.needsReview + summary.blocked);
    expect(
      exceptions.body.data.every((row: { status: string }) =>
        ['NEEDS_REVIEW', 'BLOCKED'].includes(row.status),
      ),
    ).toBe(true);

    // stable, non-overlapping pages across the whole preview
    const seen = new Set<number>();
    for (let page = 1; page <= 11; page += 1) {
      const res = await client
        .items(planId, { view: 'all', limit: 100, page, sort: 'product' })
        .expect(200);
      expect(res.body.total).toBe(1050);
      for (const row of rowsOf(res)) seen.add(row.id);
    }
    expect(seen.size).toBe(1050);
    await client.items(planId, { limit: 101 }).expect(400);

    // filters
    const decreases = await client
      .items(planId, { view: 'all', direction: 'decrease', limit: 1 })
      .expect(200);
    expect(decreases.body.total).toBeGreaterThan(0);
    expect(Number(decreases.body.data[0].changeRial)).toBeLessThan(0);
    const range = await client
      .items(planId, {
        view: 'all',
        minChangePercent: '5',
        maxChangePercent: '6',
        limit: 5,
      })
      .expect(200);
    expect(
      range.body.data.every(
        (row: { changePercent: string }) => row.changePercent === '5.26',
      ),
    ).toBe(true);
    const byCategory = await client
      .items(planId, { view: 'all', categoryId: category.id })
      .expect(200);
    expect(byCategory.body.total).toBe(30);
    const search = await client
      .items(planId, { view: 'all', search: 'BULK-1049' })
      .expect(200);
    expect(search.body.total).toBe(1);
    const searchWildcard = await client
      .items(planId, { view: 'all', search: '%' })
      .expect(200);
    expect(searchWildcard.body.total).toBe(0); // % is a literal, not a wildcard
    const excluded = await client
      .items(planId, { view: 'all', included: false, limit: 1 })
      .expect(200);
    expect(excluded.body.total).toBe(1050 - summary.included);
    const siteOnly = await client
      .items(planId, { view: 'all', channel: 'site', limit: 1 })
      .expect(200);
    expect(siteOnly.body.total).toBe(1050);

    // sorting by change, descending, puts the largest increase first
    const sorted = await client
      .items(planId, {
        view: 'all',
        sort: 'changePercent',
        order: 'desc',
        limit: 3,
      })
      .expect(200);
    expect(sorted.body.data[0].changePercent).toBe('5.26');
    const ascending = await client
      .items(planId, {
        view: 'all',
        sort: 'changePercent',
        order: 'asc',
        limit: 1,
      })
      .expect(200);
    expect(ascending.body.data[0].changePercent).toBe('-33.33');

    // bulk include by filter covers the whole filtered set, not the page
    const bulk = await client
      .bulk(planId, {
        filters: { view: 'all', status: 'NEEDS_REVIEW' },
        included: true,
        approveNeedsReview: true,
      })
      .expect(201);
    expect(bulk.body.data.updated).toBe(summary.needsReview);
  });

  // ==========================================================================
  // Lifecycle and the state machine
  // ==========================================================================

  it('enforces the state machine and discards the preview when inputs change', async () => {
    await simpleVariant(1_000_000n, 1_900_000);
    const planId = await examplePlan(ctx, cookie);

    // DRAFT: nothing to approve or apply
    expect((await client.approve(planId, 1).expect(409)).body.error).toBe(
      'PRICING_PLAN_STATE_CONFLICT',
    );
    await client.apply(planId, 1).expect(409);
    await client.rollback(planId).expect(409);

    await calculated(ctx, cookie, planId);
    expect((await client.get(planId).expect(200)).body.data.status).toBe(
      'READY_FOR_REVIEW',
    );

    // approving with a stale count is refused
    expect((await client.approve(planId, 99).expect(409)).body.error).toBe(
      'PRICING_APPLY_COUNT_MISMATCH',
    );
    await client.approve(planId, 1).expect(201);
    const approved = (await client.get(planId).expect(200)).body.data;
    expect(approved.status).toBe('APPROVED');

    // an approved plan is frozen
    expect(
      (await client.update(planId, { title: 'تغییر' }).expect(409)).body.error,
    ).toBe('PRICING_PLAN_NOT_EDITABLE');
    const [item] = rowsOf(
      await client.items(planId, { view: 'all' }).expect(200),
    );
    await client.updateItem(planId, item.id, { included: false }).expect(409);
    await client.calculate(planId).expect(409);

    // un-approve, edit → back to DRAFT with the preview gone
    await client.unapprove(planId).expect(201);
    await client.update(planId, { taxRatePercent: '9' }).expect(200);
    const draft = (await client.get(planId).expect(200)).body.data;
    expect(draft).toMatchObject({
      status: 'DRAFT',
      hasPreview: false,
      summary: null,
    });
  });

  it('manages ordered, active/inactive, branch-scoped cost entries and copies a plan', async () => {
    const [branch] = await ctx.dataSource.query(
      `INSERT INTO branches (name) VALUES ('شعبهٔ آزمون') RETURNING id`,
    );
    const planId = await examplePlan(ctx, cookie);
    let plan = planOf(await client.get(planId).expect(200));
    const [rent, salary] = plan.costEntries;
    expect(plan.costEntries.map((e) => e.title)).toEqual(['اجاره', 'حقوق']);

    plan = planOf(
      await client
        .addCost(planId, {
          title: 'برق شعبه',
          amountRial: '5000000',
          scope: 'branch',
          branchId: Number(branch.id),
        })
        .expect(201),
    );
    const power = plan.costEntries[2];
    expect(power).toMatchObject({ scope: 'branch', branchName: 'شعبهٔ آزمون' });
    await client
      .addCost(planId, { title: 'بدون شعبه', amountRial: 1, scope: 'branch' })
      .expect(400);

    plan = planOf(
      await client
        .updateCost(planId, power.id, { isActive: false })
        .expect(200),
    );
    expect(plan.monthlyCostsTotalRial).toBe('1000000000');

    plan = planOf(
      await client.reorder(planId, [power.id, salary.id, rent.id]).expect(200),
    );
    expect(plan.costEntries.map((e) => e.id)).toEqual([
      power.id,
      salary.id,
      rent.id,
    ]);
    await client.reorder(planId, [power.id, salary.id]).expect(400);

    plan = planOf(await client.removeCost(planId, power.id).expect(200));
    expect(plan.costEntries).toHaveLength(2);

    const copy = await client
      .create({
        title: 'رونوشت',
        effectiveYear: 1405,
        effectiveMonth: 8,
        copyFromPlanId: planId,
      })
      .expect(201);
    expect(copy.body.data).toMatchObject({
      status: 'DRAFT',
      copiedFromPlanId: planId,
      targetMonthlyRevenueRial: '5000000000',
      monthlyCostsTotalRial: '1000000000',
      hasPreview: false,
    });
    expect(
      copy.body.data.costEntries.map((e: { title: string }) => e.title),
    ).toEqual(['حقوق', 'اجاره']);

    // a never-applied plan may be deleted
    await client.remove(Number(copy.body.data.id)).expect(200);
    await client.get(Number(copy.body.data.id)).expect(404);
  });

  it('keeps the calculation snapshot immutable at the database', async () => {
    await simpleVariant(1_000_000n, 1_900_000);
    const planId = await examplePlan(ctx, cookie);
    await calculated(ctx, cookie, planId);
    await expect(
      ctx.dataSource.query(
        `UPDATE pricing_plan_items SET "proposedPriceRial" = 1 WHERE "planId" = $1`,
        [planId],
      ),
    ).rejects.toThrow(/snapshot is immutable/);
    await expect(
      ctx.dataSource.query(
        `UPDATE pricing_plan_runs SET "inputsSnapshot" = '{}'::jsonb WHERE "planId" = $1`,
        [planId],
      ),
    ).rejects.toThrow(/immutable/);
    // the review half stays writable
    await ctx.dataSource.query(
      `UPDATE pricing_plan_items SET included = false WHERE "planId" = $1`,
      [planId],
    );
  });
});
