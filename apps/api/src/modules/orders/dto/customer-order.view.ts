import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OrderAddressSnapshot, Order } from '../entities/order.entity';
import { OrderItems } from '../entities/order-item.entity';
import { OrderChannel } from '../enums/order-channel.enum';
import { OrderStatusEnum } from '../enums/order-status.enum';
import { FulfillmentStateEnum } from '../enums/fulfillment-state.enum';
import { PaymentMethodEnum } from '../enums/payment-method.enum';
import {
  CustomerOrderReviewState,
  OrderReconciliationState,
} from '../enums/reconciliation-state.enum';

/**
 * ===========================================================================
 * THE CUSTOMER'S VIEW OF THEIR OWN ORDER  —  DEFAULT DENY
 * ===========================================================================
 *
 * WHY THIS FILE EXISTS. `GET /me/orders` and `GET /me/orders/:id` used to
 * serialize the raw `Order` / `OrderItems` entities. TypeORM hands the whole
 * row to `JSON.stringify`, so every column the ORDER table has ever grown
 * became part of the customer contract the moment its migration ran —
 * including `fulfillmentLastError`, a RAW INTERNAL ERROR STRING written by the
 * fulfilment worker, and the whole retry queue (`fulfillmentAttempts`,
 * `fulfillmentLastAttemptAt`, `fulfillmentNextAttemptAt`) that exists only so
 * that worker can rotate its batches. Staff attribution
 * (`cashierUserId`, `cashierDisplaySnapshot`, `branchId`,
 * `branchNameSnapshot`) went out with it.
 *
 * THE DESIGN PROPERTY THAT MATTERS is not the current field list — it is that
 * the mapping is an ALLOW-LIST built by a pure function. A column added to
 * `orders` by a future migration cannot appear in a customer response by
 * default; somebody has to come here and name it. A delete-list
 * (`delete row.fulfillmentLastError`) has the opposite failure mode: it is
 * correct only until the next migration.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, and why:
 *
 *   reconciliationState         operator case bookkeeping (migration 0018).
 *                               A customer-safe `reviewState` is DERIVED from
 *                               it instead; see `toCustomerOrderReviewState`.
 *   reconciliationResolvedAt    idem
 *   fulfillmentLastError        raw internal failure text (migration 0011)
 *   fulfillmentAttempts         recovery-worker retry bookkeeping
 *   fulfillmentLastAttemptAt    idem
 *   fulfillmentNextAttemptAt    idem — the due-time queue key
 *   cashierUserId               staff identity
 *   cashierDisplaySnapshot      staff identity
 *   branchId / branchNameSnapshot   internal store attribution
 *   customerId                  internal directory FK
 *   userId                      the caller's own id, restated; provenance only
 *   addressId                   points at a LIVE, editable address row; the
 *                               authoritative delivery record is
 *                               `addressSnapshot`
 *   paid_at                     the legacy naive-`timestamp` column whose two
 *                               writers disagree about which clock it holds
 *                               (see migration 0009). `paidAt` is the
 *                               zone-aware one and is the only one exposed.
 *   created_at / updated_at     row bookkeeping. `soldAt` is the business time.
 *   user / cashierUser / branch / customer / address / payments
 *                               relations — entire other entities
 *
 * PAYMENTS ARE NOT PROJECTED HERE ON PURPOSE. `payment` rows carry the
 * reconciliation ledger — `requires_reconciliation`,
 * `reconciliation_reason`, `reconciled_at`, `gateway_amount`,
 * `gateway_amount_raw`, `ref_number`, `track_id`, `reverify_attempts`,
 * `last_reverified_at`, `next_reverify_at` — which is operator bookkeeping
 * about money that may not have settled, and `PaymentStatusEnum` includes
 * `confirmed_unapplied`, an internal reconciliation state. The money state the
 * customer is owed is `status` (pending / paid / refunded / …) plus `paidAt`,
 * and neither needs the payment table. The customer read therefore loads no
 * payment relation at all, which is also why it cannot leak one.
 */

/**
 * Where the goods were actually sent, frozen at checkout.
 *
 * `backfilled` is NOT exposed: it is provenance about migration 0015 (whether
 * the snapshot was reconstructed from the then-current address rather than
 * captured at order time), which is a fact about our data repair, not about the
 * customer's delivery. `capturedAt` being null already tells a client the
 * instant is unknown.
 */
export class CustomerOrderAddressSnapshotView {
  @ApiProperty({
    example: 41,
    description:
      'The saved address this snapshot was taken from. Provenance only — the ' +
      'live row may since have been edited or deleted.',
  })
  addressId: number;

  @ApiProperty({ example: 'Tehran' })
  province: string;

  @ApiProperty({ example: 'Tehran' })
  city: string;

  @ApiProperty({ example: 'Somewhere 12' })
  address: string;

  @ApiProperty({ example: '1234567890' })
  postalCode: string;

  @ApiProperty({ example: '09120000000' })
  receiverMobile: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-10T09:12:44.001Z',
    description:
      'When the snapshot was taken. NULL on pre-migration orders, where the ' +
      'address text is a reconstruction and not a claim about order time.',
  })
  capturedAt: string | null;
}

/**
 * One line of the order, read from the IMMUTABLE `*Snapshot` columns.
 *
 * `productTitleSnapshot`, `variantSkuSnapshot`, `attributesSnapshot`,
 * `unitPrice` and `totalPrice` all come from `order_items`, never from the live
 * catalogue. That is the whole point of those columns: a later price change, a
 * rename, or a deleted product must not rewrite what a historical order says
 * it sold. `productId` / `variantId` are carried so a client can link to the
 * product page, and are nullable because the catalogue FKs are
 * `ON DELETE SET NULL`.
 */
export class CustomerOrderItemView {
  @ApiProperty({ example: 88, description: 'Numeric `order_items.id`.' })
  id: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description: 'NULL once the product has been deleted from the catalogue.',
  })
  productId: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 34,
    description: 'NULL once the variant has been deleted from the catalogue.',
  })
  variantId: number | null;

  @ApiProperty({
    example: 'iPhone 17 Pro',
    description: 'The title as it was at sale time. Never the live title.',
  })
  productTitleSnapshot: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'IPH17-BLK-128',
    description: 'The SKU as it was at sale time. NULL only on legacy rows.',
  })
  variantSkuSnapshot: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    example: { Colour: 'Black', Size: '128' },
    description: 'Variant attributes as they were at sale time.',
  })
  attributesSnapshot: Record<string, string> | null;

  @ApiProperty({ example: 3 })
  quantity: number;

  @ApiProperty({
    example: 250000,
    description: 'INTEGER RIAL, as charged. Not the live variant price.',
  })
  unitPrice: number;

  @ApiProperty({ example: 750000, description: 'INTEGER RIAL.' })
  totalPrice: number;
}

/**
 * One of the caller's own orders.
 *
 * The LIST and the DETAIL endpoint return this same shape on purpose, so one
 * piece of client code renders an order wherever it came from. (The list is
 * already loaded with its line items today; keeping them means "my orders" can
 * show what was in each order without n+1 requests.) The only difference
 * between the two routes is the scoping, the pagination wrapper and the 404.
 */
export class CustomerOrderView {
  @ApiProperty({ example: 41, description: 'Numeric `orders.id`.' })
  id: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'WEB-20260910-000041',
    description:
      'The human-facing sale number printed on the receipt. NULL only for a ' +
      'row observed between insert and numbering.',
  })
  orderNumber: string | null;

  @ApiProperty({
    enum: OrderChannel,
    example: OrderChannel.ONLINE,
    description: '`online` for a web order, `pos` for an in-store sale.',
  })
  channel: OrderChannel;

  @ApiProperty({
    enum: OrderStatusEnum,
    example: OrderStatusEnum.PENDING,
    description:
      'The MONEY / commercial state of the order. This is the payment status a ' +
      'customer needs: `pending` (not paid yet), `paid`, `canceled`, `failed`, ' +
      '`refunded`, and the post-payment progression in between.',
  })
  status: OrderStatusEnum;

  @ApiProperty({
    enum: FulfillmentStateEnum,
    example: FulfillmentStateEnum.NOT_REQUIRED,
    description:
      'The state of the GOODS, tracked independently of the money. ' +
      '`awaiting_stock` means the payment is confirmed but stock could not yet ' +
      'be allocated. The reason a fulfilment attempt failed is NOT exposed.',
  })
  fulfillmentState: FulfillmentStateEnum;

  @ApiProperty({
    enum: PaymentMethodEnum,
    nullable: true,
    example: PaymentMethodEnum.ONLINE_GATEWAY,
    description: 'How the money was taken. NULL before a method is chosen.',
  })
  paymentMethod: PaymentMethodEnum | null;

  @ApiProperty({
    enum: CustomerOrderReviewState,
    nullable: true,
    example: null,
    description:
      'Set ONLY when this order is under manual review and the customer would ' +
      'otherwise be told nothing. `under_review` = "payment received, this ' +
      'order requires review"; `refund_in_progress` = a refund has been ' +
      'arranged and is being processed. NULL in the ordinary case.\n\n' +
      'It is DERIVED from the order row alone and is deliberately a two-word ' +
      'vocabulary: it never carries the operator’s reason, the gateway ' +
      'reference, an amount, or any internal error text, and it never says ' +
      '`fulfilled` about goods that have not moved or `refunded` about money ' +
      'that has not gone back. A completed refund is reported by `status` ' +
      'becoming `refunded` and by `refundedAt`, at which point this returns ' +
      'to NULL.',
  })
  reviewState: CustomerOrderReviewState | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-10T09:12:44.001Z',
    description:
      'When the order was placed. The order date. ALWAYS PRESENT — the ' +
      'underlying column is NOT NULL DEFAULT now() (migration 0003), so a ' +
      'client never has to render "unknown date" for an order it can see.',
  })
  soldAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-10T09:14:02.114Z',
    description:
      'When the money actually arrived. NULL means it never did (or, on very ' +
      'old rows, that the instant is unrecoverable).',
  })
  paidAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'When the sale was voided, if it was.',
  })
  voidedAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'When the money was given back, if it was.',
  })
  refundedAt: string | null;

  @ApiProperty({
    example: 750000,
    description: 'Sum of the line totals before order-level discounts. RIAL.',
  })
  subtotal: number;

  @ApiProperty({
    example: 750000,
    description: 'What the customer actually paid. INTEGER RIAL.',
  })
  totalPrice: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: null,
    description: 'The discount code the order was placed with, if any.',
  })
  discountCode: string | null;

  @ApiProperty({
    type: CustomerOrderAddressSnapshotView,
    nullable: true,
    description:
      'Where the goods were actually sent, FROZEN at checkout. Editing or ' +
      'deleting the saved address never rewrites this. NULL only on ' +
      'pre-migration-0015 orders whose source address was already gone.',
  })
  addressSnapshot: CustomerOrderAddressSnapshotView | null;

  @ApiProperty({ type: [CustomerOrderItemView] })
  items: CustomerOrderItemView[];
}

/** One page of the caller's own orders, newest first. */
export class CustomerOrderListView {
  @ApiProperty({ type: [CustomerOrderView] })
  data: CustomerOrderView[];

  @ApiProperty({ example: 7, description: 'Total orders this customer has.' })
  total: number;

  @ApiProperty({ example: 1, description: '1-based page number echoed back.' })
  page: number;

  @ApiProperty({
    example: 10,
    description:
      'Rows per page echoed back. 10 by default — `PaginationDto` substitutes ' +
      'its own default before the handler runs.',
  })
  limit: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

// ===========================================================================
// The mapping. Pure functions, allow-list, no `delete`.
// ===========================================================================

/** `Date | null` -> ISO-8601 string, which is what the wire shows anyway. */
const iso = (value: Date | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

/**
 * Same conversion for a column the SCHEMA guarantees is present, returning
 * `string` rather than `string | null`.
 *
 * Separate from `iso` on purpose: routing a NOT NULL column through `iso` and
 * then asserting `as string` at the call site hides the guarantee behind a cast
 * that would keep compiling if the column ever became nullable again.
 */
const isoRequired = (value: Date | string): string =>
  new Date(value).toISOString();

/**
 * THE ONLY THING A CUSTOMER LEARNS ABOUT A RECONCILIATION CASE.
 *
 * Derived from two order columns and nothing else — no payment row is loaded on
 * this path, so no gateway figure, reference or reconciliation reason can reach
 * here even by accident.
 *
 * The mapping is an ALLOW-LIST over `OrderReconciliationState`, exactly like
 * the field mapping below: a state added to that enum later produces `null`
 * here until somebody deliberately decides what the customer should be told.
 *
 *   refund_required   -> refund_in_progress   money is going back, not yet gone
 *   open, backordered -> under_review         money received, a human is on it
 *   refund_confirmed  -> null                 `status` is `refunded` and
 *                                             `refundedAt` is set; that is the
 *                                             honest, complete answer
 *   resolved          -> null                 nothing outstanding
 *   NULL              -> under_review IF the order is PAID and its goods were
 *                       never allocated and the fulfilment worker has given up
 *                       on getting them (`awaiting_stock`). A freshly paid
 *                       order sitting in `pending` for a few seconds while
 *                       phase 2 runs is NOT under review and must not say so.
 */
export function toCustomerOrderReviewState(
  order: Order,
): CustomerOrderReviewState | null {
  switch (order.reconciliationState) {
    case OrderReconciliationState.REFUND_REQUIRED:
      return CustomerOrderReviewState.REFUND_IN_PROGRESS;
    case OrderReconciliationState.OPEN:
    case OrderReconciliationState.BACKORDERED:
      return CustomerOrderReviewState.UNDER_REVIEW;
    case OrderReconciliationState.REFUND_CONFIRMED:
    case OrderReconciliationState.RESOLVED:
      return null;
    default:
      return order.status === OrderStatusEnum.PAID &&
        order.fulfillmentState === FulfillmentStateEnum.AWAITING_STOCK
        ? CustomerOrderReviewState.UNDER_REVIEW
        : null;
  }
}

export function toCustomerOrderAddressSnapshotView(
  snapshot: OrderAddressSnapshot | null | undefined,
): CustomerOrderAddressSnapshotView | null {
  if (!snapshot) return null;
  return {
    addressId: snapshot.addressId,
    province: snapshot.province,
    city: snapshot.city,
    address: snapshot.address,
    postalCode: snapshot.postalCode,
    receiverMobile: snapshot.receiverMobile,
    capturedAt: snapshot.capturedAt ?? null,
  };
}

/**
 * IMMUTABLE SNAPSHOTS ONLY. Nothing here is read from `item.product` or
 * `item.variant`, so a price change or a rename in the catalogue cannot alter
 * a historical order — which is exactly why those columns exist.
 */
export function toCustomerOrderItemView(
  item: OrderItems,
): CustomerOrderItemView {
  return {
    id: item.id,
    productId: item.productId ?? null,
    variantId: item.variantId ?? null,
    productTitleSnapshot: item.productTitleSnapshot,
    variantSkuSnapshot: item.variantSkuSnapshot ?? null,
    attributesSnapshot: item.attributesSnapshot ?? null,
    quantity: item.quantity,
    unitPrice: item.unit_price,
    totalPrice: item.total_price,
  };
}

/**
 * The one and only place an `Order` row becomes something a customer may see.
 *
 * Every field is named explicitly. Adding a column to `orders` does not add it
 * here, and that is the point.
 */
export function toCustomerOrderView(order: Order): CustomerOrderView {
  return {
    id: order.id,
    orderNumber: order.orderNumber ?? null,
    channel: order.channel,
    status: order.status,
    fulfillmentState: order.fulfillmentState,
    paymentMethod: order.paymentMethod ?? null,
    // Derived, customer-safe, and the ONLY reconciliation fact that crosses
    // this boundary. `reconciliationState` / `reconciliationResolvedAt` are
    // operator bookkeeping and are deliberately not projected.
    reviewState: toCustomerOrderReviewState(order),
    soldAt: isoRequired(order.soldAt),
    paidAt: iso(order.paidAt),
    voidedAt: iso(order.voidedAt),
    refundedAt: iso(order.refundedAt),
    subtotal: order.subtotal,
    totalPrice: order.total_price,
    discountCode: order.discount_code ?? null,
    addressSnapshot: toCustomerOrderAddressSnapshotView(order.addressSnapshot),
    // `items` is only absent if the caller forgot to ask for the relation; an
    // empty array is the honest answer either way and is never a silent leak.
    items: (order.items ?? []).map(toCustomerOrderItemView),
  };
}

export function toCustomerOrderListView(page: {
  data: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}): CustomerOrderListView {
  return {
    data: page.data.map(toCustomerOrderView),
    total: page.total,
    page: page.page,
    limit: page.limit,
    totalPages: page.totalPages,
  };
}
