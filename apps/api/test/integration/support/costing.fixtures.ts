import { DataSource } from 'typeorm';
import * as request from 'supertest';

import { fixtureIdempotencyKey } from '../setup/fixture-ids';
import { CookieJar, TestApp, withCookies } from '../setup/test-app';

/**
 * Shared fixtures for the `/admin/costing/*` suites.
 *
 * Every Rial figure is read back from PostgreSQL as TEXT and compared as a
 * string or a BigInt — the suites assert the same no-`number`-for-money rule
 * the code under test follows.
 */

export const COSTING_KEY_HEADER = 'Idempotency-Key';

export function costingKey(label = 'costing'): string {
  return fixtureIdempotencyKey(label);
}

export interface PoolRow {
  stock: number;
  unvaluedQuantity: number;
  inventoryCostValue: string;
  lastPurchaseUnitCost: string | null;
  costStatus: string;
}

export async function poolOf(
  ds: DataSource,
  variantId: number,
): Promise<PoolRow> {
  const [row] = await ds.query<
    Array<{
      stock: number;
      unvaluedQuantity: number;
      inventoryCostValue: string;
      lastPurchaseUnitCost: string | null;
      costStatus: string;
    }>
  >(
    `SELECT stock, "unvaluedQuantity", "inventoryCostValue"::text AS "inventoryCostValue",
            "lastPurchaseUnitCost"::text AS "lastPurchaseUnitCost", "costStatus"
       FROM product_variants WHERE id = $1`,
    [variantId],
  );
  return {
    stock: Number(row.stock),
    unvaluedQuantity: Number(row.unvaluedQuantity),
    inventoryCostValue: row.inventoryCostValue,
    lastPurchaseUnitCost: row.lastPurchaseUnitCost,
    costStatus: row.costStatus,
  };
}

export interface MovementRow {
  id: number;
  reason: string;
  delta: number;
  balanceAfter: number;
  unitCost: string | null;
  costDelta: string | null;
  inventoryValueAfter: string | null;
  unvaluedQuantityDelta: number | null;
  unvaluedQuantityAfter: number | null;
  supplierReference: string | null;
  reasonText: string | null;
  orderId: number | null;
  actorUserId: number | null;
}

export async function movementsOf(
  ds: DataSource,
  variantId: number,
): Promise<MovementRow[]> {
  const rows = await ds.query<MovementRow[]>(
    `SELECT id, reason::text AS reason, delta, "balanceAfter",
            "unitCost"::text AS "unitCost", "costDelta"::text AS "costDelta",
            "inventoryValueAfter"::text AS "inventoryValueAfter",
            "unvaluedQuantityDelta", "unvaluedQuantityAfter",
            "supplierReference", "reasonText", "orderId", "actorUserId"
       FROM stock_movements WHERE "variantId" = $1 ORDER BY id`,
    [variantId],
  );
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    delta: Number(r.delta),
    balanceAfter: Number(r.balanceAfter),
  }));
}

/** Σ costDelta over a variant's movements, in BigInt. */
export async function sumCostDelta(
  ds: DataSource,
  variantId: number,
): Promise<string> {
  const [row] = await ds.query<Array<{ total: string }>>(
    `SELECT COALESCE(SUM("costDelta"), 0)::text AS total
       FROM stock_movements WHERE "variantId" = $1`,
    [variantId],
  );
  return row.total;
}

export interface OrderLineCost {
  id: number;
  costStatus: string;
  cogsTotal: string | null;
  costKnownQuantity: number | null;
  costUnknownQuantity: number | null;
}

export async function orderLinesOf(
  ds: DataSource,
  orderId: number,
): Promise<OrderLineCost[]> {
  return ds.query<OrderLineCost[]>(
    `SELECT id, "costStatus", "cogsTotal"::text AS "cogsTotal",
            "costKnownQuantity", "costUnknownQuantity"
       FROM order_items WHERE "orderId" = $1 ORDER BY id`,
    [orderId],
  );
}

export async function auditRowsFor(
  ds: DataSource,
  action: string,
): Promise<Array<{ targetId: string; summary: Record<string, unknown> }>> {
  return ds.query(
    `SELECT "targetId", summary FROM admin_audit_log WHERE action = $1 ORDER BY id`,
    [action],
  );
}

/** A costing client for one admin session. */
export function costing(ctx: TestApp, jar: CookieJar) {
  const client = withCookies(ctx, jar);
  const withKey = (req: request.Test, key: string | null) =>
    key === null ? req : req.set(COSTING_KEY_HEADER, key);
  return {
    variant: (variantId: number) =>
      client.get(`/admin/costing/variants/${variantId}`),
    product: (productId: number) =>
      client.get(`/admin/costing/products/${productId}`),
    unvalued: (query = '') => client.get(`/admin/costing/unvalued${query}`),
    receipt: (
      variantId: number,
      body: Record<string, unknown>,
      key: string | null = costingKey('receipt'),
    ) =>
      withKey(
        client.post(`/admin/costing/variants/${variantId}/receipts`),
        key,
      ).send(body),
    correction: (
      variantId: number,
      body: Record<string, unknown>,
      key: string | null = costingKey('correction'),
    ) =>
      withKey(
        client.post(`/admin/costing/variants/${variantId}/corrections`),
        key,
      ).send(body),
    valuation: (
      variantId: number,
      body: Record<string, unknown>,
      key: string | null = costingKey('valuation'),
    ) =>
      withKey(
        client.post(`/admin/costing/variants/${variantId}/valuation`),
        key,
      ).send(body),
    purchasePrice: (variantId: number, body: Record<string, unknown>) =>
      client
        .put(`/admin/costing/variants/${variantId}/purchase-price`)
        .send(body),
  };
}
