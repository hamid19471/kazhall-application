import assert from "node:assert/strict";
import { test } from "node:test";

import { isProductSoldOut } from "./sellability";

test("a product with no sellable variant is sold out", () => {
  // The case the page got wrong: every variant retired, so the public
  // projection returned none, so nothing could be selected — and the old rule
  // read that as "not sold out" and offered an enabled add-to-basket.
  assert.equal(
    isProductSoldOut({ sellableVariantCount: 0, selectedInStock: null }),
    true,
  );
  // Even if a stale selection is still in state.
  assert.equal(
    isProductSoldOut({ sellableVariantCount: 0, selectedInStock: true }),
    true,
  );
});

test("nothing selected yet is NOT sold out when sellable variants exist", () => {
  // A multi-variant product before the customer picks one. The button is
  // blocked by `requiresSelection`, which is a different message: "choose a
  // variant first", not "unavailable".
  assert.equal(
    isProductSoldOut({ sellableVariantCount: 3, selectedInStock: null }),
    false,
  );
});

test("the selected variant's advisory inStock decides the normal case", () => {
  assert.equal(
    isProductSoldOut({ sellableVariantCount: 1, selectedInStock: true }),
    false,
  );
  assert.equal(
    isProductSoldOut({ sellableVariantCount: 1, selectedInStock: false }),
    true,
  );
});
