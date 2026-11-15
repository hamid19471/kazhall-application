import { NotFoundException } from '@nestjs/common';

import { OrderMessages } from 'src/common/constants/order.messages';
import type { UserRequest } from 'src/common/interfaces/user-request.interface';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { OrderChannel } from '../enums/order-channel.enum';
import type { Order } from '../entities/order.entity';

/**
 * What a cashier may see of an order, and when.
 *
 * THE RULE, from the owner: a cashier completes a sale and reprints the slip
 * for THAT sale. They do not browse sales, and they do not read a colleague's.
 *
 * WHY A BRANCH CHECK WAS NOT ENOUGH. The previous guard allowed any order in
 * the caller's branch. Cashiers 1 and 2 both work in Sanandaj, so each could
 * read the other's sale — the seller's name, the line items and the total.
 * Ownership has to be checked against `cashierUserId`, not just the branch.
 *
 * NON-ENUMERATION. Every refusal here is a 404: absent, another cashier's,
 * another branch's, and an online customer's order are all indistinguishable
 * to a cashier walking ids. The route used to answer 403 for an out-of-branch
 * order on purpose, so that a cashier could tell "exists elsewhere" from "does
 * not exist" — useful for a supervisor, but precisely the signal that turns a
 * numeric id into an enumeration oracle once the permission narrows to one
 * person's own sales. `super_admin` keeps the management semantics, where a
 * 404 still means genuinely absent.
 */

export interface CashierReceiptItemView {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitleSnapshot: string | null;
  variantSkuSnapshot: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface CashierReceiptView {
  id: number;
  orderNumber: string | null;
  channel: string;
  status: string;
  paymentMethod: string | null;
  /** Never null: `orders."soldAt"` is NOT NULL DEFAULT now() (migration 0003). */
  soldAt: Date;
  voidedAt: Date | null;
  refundedAt: Date | null;
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  branchId: number | null;
  branchNameSnapshot: string | null;
  subtotal: number;
  total_price: number;
  items: CashierReceiptItemView[];
}

/**
 * Refuses unless this is the caller's own POS sale, at the caller's own branch.
 *
 * The cashier id and branch are taken from the VERIFIED SESSION, which
 * `JwtStrategy` re-reads from the database on every request — never from
 * anything the client sent.
 */
export function assertOwnPosSale(
  order: Order,
  user: UserRequest['user'],
): void {
  if (user.roles.includes(UserRoleEnum.superAdmin)) return;

  const ownSale =
    order.channel === OrderChannel.POS &&
    order.cashierUserId !== null &&
    order.cashierUserId === user.sub &&
    order.branchId !== null &&
    order.branchId === user.branch;

  if (!ownSale) {
    throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);
  }
}

/**
 * The slip, and nothing else.
 *
 * Deliberately absent: the customer and their address, every payment row,
 * fulfilment retry state, reconciliation state, and the `cashierUser` relation.
 * None of it is printed on a receipt, and a till has no business holding it.
 */
export function toCashierReceiptView(order: Order): CashierReceiptView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    channel: order.channel,
    status: order.status,
    paymentMethod: order.paymentMethod,
    // No `?? null`: the column is NOT NULL, so the fallback could only ever
    // have fired on a receipt for an order that does not exist. Leaving it in
    // would keep claiming a printed slip might have no sale time on it.
    soldAt: order.soldAt,
    voidedAt: order.voidedAt ?? null,
    refundedAt: order.refundedAt ?? null,
    cashierUserId: order.cashierUserId ?? null,
    cashierDisplaySnapshot: order.cashierDisplaySnapshot ?? null,
    branchId: order.branchId ?? null,
    branchNameSnapshot: order.branchNameSnapshot ?? null,
    subtotal: order.subtotal,
    total_price: order.total_price,
    items: (order.items ?? []).map((item) => ({
      id: item.id,
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      productTitleSnapshot: item.productTitleSnapshot ?? null,
      variantSkuSnapshot: item.variantSkuSnapshot ?? null,
      // «کد محصول» / «کد گونه» as they were at sale time (0032). The till
      // prints the variant code on a reprint, and a retyped catalogue code must
      // not change what the slip says was sold. Codes are sales data, not cost.
      productCodeSnapshot: item.productCodeSnapshot ?? null,
      variantCodeSnapshot: item.variantCodeSnapshot ?? null,
      attributesSnapshot: item.attributesSnapshot ?? null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
    })),
  };
}
