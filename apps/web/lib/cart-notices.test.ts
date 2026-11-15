/**
 * `dedupeNotices` — which basket-level notices the customer actually sees.
 *
 * The case that matters most is FULL DISPLACEMENT: a till sells every unit a
 * customer was holding, the line leaves `data` entirely, and `notices` becomes
 * the only place `sold_in_store` appears in the whole response. These fixtures
 * are transcribed from a real `GET /cart` body captured in
 * `apps/api/test/integration/realtime-pos-cart-sync.int-spec.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { dedupeNotices } from "./cart-notices.ts";

type Line = Parameters<typeof dedupeNotices>[0][number];

function line(overrides: Partial<Line> & { id: number }): Line {
  return {
    status: "active",
    productId: 9,
    productTitle: "Reserved Kettle",
    productImages: [],
    variant: { id: 1, sku: "SKU-1", price: 500_000, attributeValues: [] },
    quantity: 2,
    reservedQuantity: 2,
    availableForBasket: 0,
    expiresAt: null,
    tranches: [],
    change: null,
    ...overrides,
  } as Line;
}

const SOLD = {
  reason: "sold_in_store",
  message: "Some of these units were sold in one of our stores before you checked out",
  at: "2026-09-13T06:01:24.635Z",
  quantityDelta: -4,
} as const;

const EXPIRED = {
  reason: "reservation_expired",
  message: "Your reservation expired",
  at: "2026-09-13T05:00:00.000Z",
  quantityDelta: -1,
} as const;

// ---------------------------------------------------------------------------
// Full displacement — the reason this function exists at all
// ---------------------------------------------------------------------------

test("keeps the notice for a line that is no longer in the basket", () => {
  // Exactly the shape the API returns: data empty, one removed line in notices.
  const removed = line({
    id: 1,
    status: "removed",
    quantity: 0,
    reservedQuantity: 0,
    change: { ...SOLD },
  });

  const kept = dedupeNotices([removed], []);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.change!.reason, "sold_in_store");
  assert.equal(kept[0]!.change!.quantityDelta, -4);
  // The product name has to survive: the row it describes is gone, so a notice
  // that cannot name the item asks the customer to guess.
  assert.equal(kept[0]!.productTitle, "Reserved Kettle");
});

// ---------------------------------------------------------------------------
// Partial displacement — the duplicate this function is named for
// ---------------------------------------------------------------------------

test("drops the notice for a line that is still on screen showing the same change", () => {
  const active = line({ id: 1, quantity: 2, change: { ...SOLD } });
  assert.deepEqual(dedupeNotices([active], [active]), []);
});

test("drops a notice that MATCHES an active line's change even with a different line id", () => {
  const active = line({ id: 1, change: { ...SOLD } });
  const sameEvent = line({ id: 2, status: "removed", change: { ...SOLD } });
  assert.deepEqual(dedupeNotices([sameEvent], [active]), []);
});

test("keeps a notice whose change differs from every active line's", () => {
  const active = line({ id: 1, change: { ...SOLD } });
  const other = line({ id: 2, status: "removed", change: { ...EXPIRED } });
  const kept = dedupeNotices([other], [active]);
  assert.deepEqual(
    kept.map((n) => n.change!.reason),
    ["reservation_expired"],
  );
});

// ---------------------------------------------------------------------------
// De-duplication within the notices array itself
// ---------------------------------------------------------------------------

test("collapses two notices describing the same instant and reason", () => {
  const a = line({ id: 1, status: "removed", change: { ...SOLD } });
  const b = line({ id: 2, status: "removed", change: { ...SOLD } });
  assert.equal(dedupeNotices([a, b], []).length, 1);
});

test("does NOT collapse two notices that only share a reason", () => {
  const a = line({ id: 1, status: "removed", change: { ...SOLD } });
  const b = line({
    id: 2,
    status: "removed",
    change: { ...SOLD, at: "2026-09-13T07:00:00.000Z" },
  });
  assert.equal(dedupeNotices([a, b], []).length, 2);
});

test("keeps every notice with a null instant rather than risk losing one", () => {
  // Two events that cannot be proven distinct are still shown twice: a lost
  // "your reservation expired" is worse than a repeated one.
  const a = line({ id: 1, status: "removed", change: { ...EXPIRED, at: null } });
  const b = line({ id: 2, status: "removed", change: { ...EXPIRED, at: null } });
  assert.equal(dedupeNotices([a, b], []).length, 2);
});

// ---------------------------------------------------------------------------
// Regressions the old implementation would have failed
// ---------------------------------------------------------------------------

test("does not collapse unrelated notices into one (the undefined-key bug)", () => {
  // Reading `notice.reason`/`notice.at` off a LINE yielded `undefined` for
  // both, so every notice hashed to the same key and all but the first were
  // dropped — a customer whose basket lost two different products was told
  // about one of them.
  const sold = line({ id: 1, status: "removed", change: { ...SOLD } });
  const expired = line({ id: 2, status: "removed", change: { ...EXPIRED } });
  const kept = dedupeNotices([sold, expired], []);
  assert.deepEqual(
    kept.map((n) => n.change!.reason).sort(),
    ["reservation_expired", "sold_in_store"],
  );
});

test("never yields a notice without a change for the renderer to read", () => {
  const noChange = line({ id: 1, status: "removed", change: null });
  assert.deepEqual(dedupeNotices([noChange], []), []);
});

test("an empty response produces nothing", () => {
  assert.deepEqual(dedupeNotices([], []), []);
});
