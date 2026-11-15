/**
 * Persian copy for basket-change reasons.
 *
 * The case that matters: `labelOf`'s fallback only covers null / undefined /
 * "", so a reason code the map does not know is printed AT THE CUSTOMER as the
 * raw English identifier. `not_sellable` was exactly that — a value the server
 * can now produce and the storefront had no phrase for — which is why its
 * presence is asserted rather than assumed, and why `hasCartChangeReasonLabel`
 * exists for the one caller that has a better fallback of its own.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cartChangeReasonLabel, hasCartChangeReasonLabel } from "./labels.ts";

test("a deactivated SKU is explained in Persian, not as a raw code", () => {
  const label = cartChangeReasonLabel("not_sellable");
  assert.notEqual(label, "not_sellable");
  assert.match(label, /دیگر برای فروش موجود نیست/);
  // It must ask for the line to be removed — that is the only thing that
  // unblocks the order — and must not claim the line was already removed.
  assert.match(label, /از سبد بردارید/);
  assert.doesNotMatch(label, /برداشته شد/);
});

test("it does not invite the customer to try again later", () => {
  // `POST /orders` refuses the whole basket with VARIANT_INACTIVE while the
  // line is in it, so "try again" or "back in stock" would be a dead end.
  for (const reason of ["not_sellable", "channel_unavailable"]) {
    const label = cartChangeReasonLabel(reason);
    assert.doesNotMatch(label, /دوباره تلاش/, reason);
    assert.doesNotMatch(label, /موجود شد/, reason);
  }
});

test("a product withdrawn from the website is not called deactivated", () => {
  /*
   * `channel_unavailable` is NOT `not_sellable`. The SKU may be active and
   * selling over the counter; only this channel stopped offering it. So the
   * sentence has to name the WEBSITE, and must not say the item is
   * deactivated, discontinued or out of stock — each of which would be a false
   * statement about a product still on a shop shelf.
   */
  const label = cartChangeReasonLabel("channel_unavailable");
  assert.notEqual(label, "channel_unavailable");
  assert.match(label, /وب‌سایت/);
  assert.doesNotMatch(label, /غیرفعال/);
  assert.doesNotMatch(label, /برای فروش موجود نیست/);
  assert.doesNotMatch(label, /ناموجود/);
  // Like the retired SKU it blocks the order, so it asks for removal and must
  // not claim the line has already gone.
  assert.match(label, /از سبد بردارید/);
  assert.doesNotMatch(label, /برداشته شد/);
  assert.equal(hasCartChangeReasonLabel("channel_unavailable"), true);
});

test("the reasons the server already emitted keep their own sentences", () => {
  const sold = cartChangeReasonLabel("sold_in_store");
  const expired = cartChangeReasonLabel("reservation_expired");
  const retired = cartChangeReasonLabel("not_sellable");
  const withdrawn = cartChangeReasonLabel("channel_unavailable");
  // Four conditions, four distinct explanations. A shared sentence would undo
  // the whole point of classifying them apart — and `not_sellable` and
  // `channel_unavailable` are exactly the pair the server split on purpose.
  assert.equal(new Set([sold, expired, retired, withdrawn]).size, 4);
  assert.match(sold, /فروش حضوری/);
  assert.match(expired, /چهار‌ساعته/);
});

test("privacy: no sentence names a cashier, a branch or a shop", () => {
  /*
   * The API deliberately sends no staff, branch or other-customer identity
   * with a change, and the copy must not invent one.
   *
   * `sold_in_store` does say "به مشتری دیگری" — AN unnamed other customer —
   * and that is the accepted existing wording: it names a channel and an
   * anonymous someone, which is what actually happened, without identifying
   * anybody. What must never appear is a role, a branch or a shop.
   */
  for (const reason of [
    "not_sellable",
    "channel_unavailable",
    "sold_in_store",
    "reservation_expired",
  ]) {
    const label = cartChangeReasonLabel(reason);
    for (const forbidden of ["صندوق‌دار", "فروشنده", "شعبه", "فروشگاه", "انبار"]) {
      assert.ok(!label.includes(forbidden), `${reason} leaked "${forbidden}": ${label}`);
    }
    assert.doesNotMatch(label, /\d/, `${reason} carries a number: ${label}`);
  }
});

test("hasCartChangeReasonLabel distinguishes known from unknown", () => {
  assert.equal(hasCartChangeReasonLabel("not_sellable"), true);
  assert.equal(hasCartChangeReasonLabel("sold_in_store"), true);
  // A checkout-only kind has no basket sentence, so the checkout list falls
  // back to the server's own message rather than printing the code.
  assert.equal(hasCartChangeReasonLabel("price_changed"), false);
  assert.equal(hasCartChangeReasonLabel("total_changed"), false);
  assert.equal(hasCartChangeReasonLabel(""), false);
  assert.equal(hasCartChangeReasonLabel(null), false);
  assert.equal(hasCartChangeReasonLabel(undefined), false);
});

test("an unknown reason still falls back rather than throwing", () => {
  assert.equal(typeof cartChangeReasonLabel("who_knows"), "string");
  assert.equal(cartChangeReasonLabel(null), "سبد شما تغییر کرد.");
});
