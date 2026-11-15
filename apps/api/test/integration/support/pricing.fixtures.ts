/**
 * Fixtures for the monthly pricing specs (docs/MONTHLY-PRICING.md).
 */
import { DataSource } from 'typeorm';

import { PricingRunnerService } from 'src/modules/pricing/pricing-runner.service';

import { fixtureIdempotencyKey } from '../setup/fixture-ids';
import type { TestApp } from './catalog.harness';

/**
 * Give a variant a KNOWN weighted-average cost: `stock` units worth
 * `stock × unitCost`, none unvalued. Test-only direct write through the same
 * valuation-writer flag `forceStockForTest` uses; the real receipt path is
 * exercised separately by the end-to-end case.
 */
export async function valueVariant(
  ds: DataSource,
  variantId: number,
  options: { stock: number; unitCost: bigint; unvalued?: number },
): Promise<void> {
  const unvalued = options.unvalued ?? 0;
  const value = BigInt(options.stock - unvalued) * options.unitCost;
  await ds.transaction(async (m) => {
    await m.query(`SELECT set_config('kazhal.valuation_writer', 'on', true)`);
    await m.query(
      `UPDATE product_variants
          SET stock = $2, "unvaluedQuantity" = $3, "inventoryCostValue" = $4
        WHERE id = $1`,
      [variantId, options.stock, unvalued, value.toString()],
    );
    await m.query(`SELECT set_config('kazhal.valuation_writer', 'off', true)`);
  });
}

/** A variant's live selling price, as text (bigint) or null. */
export async function livePrice(
  ds: DataSource,
  variantId: number,
): Promise<string | null> {
  const [row] = await ds.query(
    `SELECT price::text AS price FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return row?.price ?? null;
}

/**
 * `count` simple products, each with one valued default variant, inserted in
 * two statements. Costs cycle through a small set so the preview has a mix of
 * READY, UNCHANGED and NEEDS_REVIEW rows; every 10th variant is left unvalued
 * (BLOCKED) so the exception view is never empty.
 */
export async function seedPricedCatalog(
  ds: DataSource,
  count: number,
  prefix = 'BULK',
): Promise<{ productIds: number[]; variantIds: number[] }> {
  const products: { id: number }[] = await ds.query(
    `INSERT INTO products (title, description, "productCode", "basePrice", "visibleOnSite", "branchVisibility")
     SELECT 'کالای انبوه ' || g, 'bulk fixture', $2 || '-' || g, 1000000, true, 'none'
       FROM generate_series(1, $1::int) AS g
     RETURNING id`,
    [count, prefix],
  );
  const variants: { id: number }[] = await ds.transaction(async (m) => {
    await m.query(`SELECT set_config('kazhal.valuation_writer', 'on', true)`);
    const rows = await m.query(
      `INSERT INTO product_variants
         ("productId", sku, "variantCode", price, stock, "unvaluedQuantity", "inventoryCostValue", "isDefault")
       SELECT p.id, p."productCode" || '-SKU', p."productCode" || '-V1',
              -- current price: 1 900 000 for most, 2 000 000 (unchanged), 3 000 000 (decrease)
              CASE WHEN (p.n % 7) = 0 THEN 2000000 WHEN (p.n % 11) = 0 THEN 3000000 ELSE 1900000 END,
              10,
              CASE WHEN (p.n % 10) = 0 THEN 10 ELSE 0 END,
              CASE WHEN (p.n % 10) = 0 THEN 0 ELSE 10 * 1000000 END,
              true
         FROM (SELECT id, "productCode", row_number() OVER (ORDER BY id) AS n
                 FROM products WHERE id = ANY($1::int[])) p
       RETURNING id`,
      [products.map((p) => p.id)],
    );
    await m.query(`SELECT set_config('kazhal.valuation_writer', 'off', true)`);
    return rows;
  });
  return {
    productIds: products.map((p) => Number(p.id)),
    variantIds: variants.map((v) => Number(v.id)),
  };
}

// ---------------------------------------------------------------------------
// Typed readers for response bodies.
//
// supertest types `res.body` as `any`. These narrow it with runtime checks, so
// a spec never passes an unchecked value on as a typed argument, and a wrong
// response shape fails loudly with the field it was missing.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(what: string, value: unknown): never {
  throw new Error(
    `unexpected response shape: ${what} (${JSON.stringify(value)?.slice(0, 200)})`,
  );
}

/** A record field that must be a number. */
export function numberAt(record: Json, key: string): number {
  const value = record[key];
  return typeof value === 'number'
    ? value
    : fail(`${key} is not a number`, record);
}

/** A record field that must be a string. */
export function stringAt(record: Json, key: string): string {
  const value = record[key];
  return typeof value === 'string'
    ? value
    : fail(`${key} is not a string`, record);
}

/** A record field that must itself be a record. */
export function recordAt(record: Json, key: string): Json {
  const value = record[key];
  return isRecord(value) ? value : fail(`${key} is not an object`, record);
}

/** A record field that must be an array. */
export function listAt(record: Json, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) return fail(`${key} is not an array`, record);
  const list: unknown[] = value;
  return list;
}

/** A response row: any JSON record whose `id` is a number. */
export type Row = Json & { id: number };

function asRow(value: unknown, what: string): Row {
  if (!isRecord(value)) return fail(`${what} is not an object`, value);
  return { ...value, id: numberAt(value, 'id') };
}

/** `{ data: {...} }` → the record. */
export function dataOf(res: { body: unknown }): Json {
  const body: unknown = res.body;
  if (!isRecord(body) || !isRecord(body.data))
    return fail('body.data is not an object', body);
  return body.data;
}

/** `{ data: {... id} }` → the row. */
export function rowOf(res: { body: unknown }): Row {
  return asRow(dataOf(res), 'body.data');
}

/** `{ data: [...] }` (list endpoints) → the rows. */
export function rowsOf(res: { body: unknown }): Row[] {
  const body: unknown = res.body;
  if (!isRecord(body) || !Array.isArray(body.data))
    return fail('body.data is not an array', body);
  const rows: unknown[] = body.data;
  return rows.map((row, index) => asRow(row, `body.data[${index}]`));
}

/** The first row whose field equals `value`; fails if there is none. */
export function rowWhere(rows: Row[], key: string, value: unknown): Row {
  return (
    rows.find((row) => row[key] === value) ??
    fail(`no row with ${key}=${String(value)}`, rows)
  );
}

/** A plan detail with its cost entries as rows. */
export function planOf(res: { body: unknown }): Row & { costEntries: Row[] } {
  const plan = rowOf(res);
  const entries: unknown = plan.costEntries;
  if (!Array.isArray(entries)) return fail('costEntries is not an array', plan);
  const list: unknown[] = entries;
  return {
    ...plan,
    costEntries: list.map((entry, index) =>
      asRow(entry, `costEntries[${index}]`),
    ),
  };
}

/** The preview summary's `applicable` count. */
export function applicableOf(res: { body: unknown }): number {
  return numberAt(dataOf(res), 'applicable');
}

export const EXAMPLE_INPUTS = {
  targetMonthlyRevenueRial: '5000000000',
  taxRatePercent: '10',
  targetProfitMarginPercent: '20',
  roundingStepRial: 1,
};

export function pricingClient(ctx: TestApp, cookie: string) {
  const base = '/admin/pricing-plans';
  const as = <T extends { set(k: string, v: string): T }>(req: T): T =>
    req.set('Cookie', cookie);
  return {
    create: (body: Record<string, unknown>) =>
      as(ctx.request().post(base)).send(body),
    get: (planId: number) => as(ctx.request().get(`${base}/${planId}`)),
    update: (planId: number, body: Record<string, unknown>) =>
      as(ctx.request().patch(`${base}/${planId}`)).send(body),
    remove: (planId: number) => as(ctx.request().delete(`${base}/${planId}`)),
    addCost: (planId: number, body: Record<string, unknown>) =>
      as(ctx.request().post(`${base}/${planId}/costs`)).send(body),
    updateCost: (
      planId: number,
      entryId: number,
      body: Record<string, unknown>,
    ) =>
      as(ctx.request().patch(`${base}/${planId}/costs/${entryId}`)).send(body),
    removeCost: (planId: number, entryId: number) =>
      as(ctx.request().delete(`${base}/${planId}/costs/${entryId}`)),
    reorder: (planId: number, entryIds: number[]) =>
      as(ctx.request().put(`${base}/${planId}/costs/order`)).send({ entryIds }),
    calculate: (planId: number, key = fixtureIdempotencyKey('calc')) =>
      as(ctx.request().post(`${base}/${planId}/calculate`))
        .set('Idempotency-Key', key)
        .send({}),
    summary: (planId: number) =>
      as(ctx.request().get(`${base}/${planId}/summary`)),
    items: (
      planId: number,
      query: Record<string, string | number | boolean> = {},
    ) => as(ctx.request().get(`${base}/${planId}/items`)).query(query),
    updateItem: (
      planId: number,
      itemId: number,
      body: Record<string, unknown>,
    ) =>
      as(ctx.request().patch(`${base}/${planId}/items/${itemId}`)).send(body),
    bulk: (planId: number, body: Record<string, unknown>) =>
      as(ctx.request().post(`${base}/${planId}/items/bulk`)).send(body),
    approve: (planId: number, expectedChangeCount: number) =>
      as(ctx.request().post(`${base}/${planId}/approve`)).send({
        expectedChangeCount,
      }),
    unapprove: (planId: number) =>
      as(ctx.request().post(`${base}/${planId}/unapprove`)).send({}),
    apply: (
      planId: number,
      expectedChangeCount: number,
      key = fixtureIdempotencyKey('apply'),
    ) =>
      as(ctx.request().post(`${base}/${planId}/apply`))
        .set('Idempotency-Key', key)
        .send({ expectedChangeCount }),
    rollbackPreview: (planId: number) =>
      as(ctx.request().get(`${base}/${planId}/rollback-preview`)),
    rollback: (planId: number, key = fixtureIdempotencyKey('rollback')) =>
      as(ctx.request().post(`${base}/${planId}/rollback`))
        .set('Idempotency-Key', key)
        .send({}),
    runs: (planId: number) => as(ctx.request().get(`${base}/${planId}/runs`)),
    run: (planId: number, runId: number) =>
      as(ctx.request().get(`${base}/${planId}/runs/${runId}`)),
    changes: (planId: number, query: Record<string, string | number> = {}) =>
      as(ctx.request().get(`${base}/${planId}/changes`)).query(query),
  };
}

/** Wait for the in-process runner to finish, then read the run. */
export async function settledRun(
  ctx: TestApp,
  cookie: string,
  planId: number,
  runId: number,
) {
  const runner = ctx.app.get(PricingRunnerService, { strict: false });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await runner.idle();
    const res = await pricingClient(ctx, cookie).run(planId, runId).expect(200);
    const run = rowOf(res);
    if (['succeeded', 'failed'].includes(stringAt(run, 'status'))) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Create a plan with the worked-example inputs and 1 000 000 000 of costs. */
export async function examplePlan(
  ctx: TestApp,
  cookie: string,
  extra: Record<string, unknown> = {},
) {
  const client = pricingClient(ctx, cookie);
  const created = await client
    .create({ title: 'برنامهٔ آزمون', effectiveYear: 1405, effectiveMonth: 7 })
    .expect(201);
  const planId = rowOf(created).id;
  await client.update(planId, { ...EXAMPLE_INPUTS, ...extra }).expect(200);
  await client
    .addCost(planId, { title: 'اجاره', amountRial: '600000000' })
    .expect(201);
  await client
    .addCost(planId, { title: 'حقوق', amountRial: 400000000 })
    .expect(201);
  return planId;
}

/** Calculate and wait; returns the settled run. */
export async function calculated(ctx: TestApp, cookie: string, planId: number) {
  const res = await pricingClient(ctx, cookie).calculate(planId).expect(202);
  return settledRun(ctx, cookie, planId, rowOf(res).id);
}
