/**
 * How the money for an order was taken.
 *
 * `CARD_TERMINAL` is a *manual record* of a payment taken on an external POS
 * terminal -- there is deliberately no hardware integration here. The cashier
 * states which tender was used and that statement is stored, attributed and
 * auditable. `ONLINE_GATEWAY` is the ecommerce channel (Zibal).
 */
export enum PaymentMethodEnum {
  CASH = 'cash',
  CARD_TERMINAL = 'card_terminal',
  ONLINE_GATEWAY = 'online_gateway',
  OTHER = 'other',
}
