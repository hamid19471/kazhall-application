/**
 * Domain vocabulary for the till: roles, enum labels, order dates.
 *
 * Everything here is framework-agnostic and dependency-free. It exists so the
 * screens never invent a Persian label for a server enum inline, and never
 * guess at a role rule the server actually owns.
 */

import type { Session, UserRole } from "@kazhal/api-client";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * THE CAPABILITY that opens the till, and the same one the server decides with.
 *
 * `AUDIENCE_ACCESS_PERMISSION.pos` is `pos.access`: it is what
 * `isEligibleForAudience` checks before a POS session is minted and what the
 * realtime gateway re-checks on every handshake and every reconciliation pass.
 */
export const POS_ACCESS_PERMISSION = "pos.access";

/**
 * The built-in roles that carry {@link POS_ACCESS_PERMISSION}, used ONLY as a
 * fallback for a session from an API old enough not to send `permissions`.
 *
 * They are not the rule. Treating them as the rule is what made a CUSTOM role
 * holding `pos.access` unusable: the server minted its POS session, the
 * gateway admitted its socket, and this screen still answered "this account
 * has no till access" — which is the whole point of having a permission model
 * rather than hard-coded role names.
 */
export const POS_ROLES: readonly UserRole[] = ["sale", "super_admin"] as const;

/**
 * May this session operate the till?
 *
 * This gate is for NAVIGATION ONLY. The server re-reads the effective
 * permission set from the database on every request and on every socket
 * handshake; a UI check is a courtesy, never an authorization.
 */
export function canOperatePos(session: Session | null | undefined): boolean {
  if (!session) return false;
  /*
   * `permissions` is the EFFECTIVE set the server expanded for this request,
   * so when it is present it is the authority — including when it is empty,
   * which is exactly what a revoked capability looks like. Only an absent list
   * (an older API) falls back to role names.
   */
  if (session.permissions !== undefined) {
    return session.permissions.includes(POS_ACCESS_PERMISSION);
  }
  return session.roles.some((role) => POS_ROLES.includes(role));
}


/**
 * `POST /orders/pos` answers `400 USER_NOT_IN_BRANCH` when the token carries no
 * branch, so a sale is refused before it is attempted rather than after.
 *
 * The branch is SERVER-DERIVED (`Session.branchId`, from `GET /auth/me`). It is
 * never an input: the request body's `branchId`/`cashierId` are documented as
 * ignored, and this app never sends them.
 */
export function hasSellableBranch(session: Session | null | undefined): boolean {
  return typeof session?.branchId === "number";
}

// ---------------------------------------------------------------------------
// Server enums → Persian labels
// ---------------------------------------------------------------------------

/** `PaymentMethodEnum`. `card_terminal` is a MANUAL record — no hardware. */
export const PAYMENT_METHODS = ["cash", "card_terminal", "other"] as const;
export type PosPaymentMethod = (typeof PAYMENT_METHODS)[number];

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "نقدی",
  card_terminal: "کارت‌خوان",
  online_gateway: "درگاه اینترنتی",
  other: "سایر",
};

/**
 * `online_gateway` is deliberately absent from {@link PAYMENT_METHODS}: it is
 * the ecommerce channel and a till has no way to take that money, so offering
 * it as a tender button would let a cashier record a payment that never
 * happened. It still has a LABEL, because reporting shows online orders.
 */
export function paymentMethodLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return PAYMENT_METHOD_LABELS[value] ?? value;
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  processing: "در حال آماده‌سازی",
  shipped: "ارسال‌شده",
  delivered: "تحویل‌شده",
  canceled: "لغوشده",
  failed: "ناموفق",
  refunded: "مرجوع‌شده",
};


export function orderStatusLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return ORDER_STATUS_LABELS[value] ?? value;
}

const CHANNEL_LABELS: Record<string, string> = {
  pos: "فروش حضوری",
  online: "فروش اینترنتی",
};

export function channelLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return CHANNEL_LABELS[value] ?? value;
}



/*
 * `AVAILABILITY_BATCH_SIZE` and `chunk` used to live here.
 *
 * They existed because the till batched `GET /inventory/availability` itself
 * while the storefront did not — the same endpoint cap expressed twice, and
 * differently. The cap is a property of the ENDPOINT, so it moved into
 * `@kazhal/api-client`'s `inventory.availability`, which now chunks for every
 * caller. The till stopped double-chunking when its availability reads moved
 * to the authoritative channel, which left these two with no consumers
 * anywhere in either app.
 */

/** An Iranian mobile, matching what `@IsPhoneNumber('IR')` will accept. */
export function isIranianMobile(value: string): boolean {
  return /^09\d{9}$/.test(value);
}
