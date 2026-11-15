import { businessDateStamp } from './business-time';
import { OrderChannel } from './enums/order-channel.enum';

/**
 * ===========================================================================
 * THE HUMAN-FACING SALE NUMBER — one definition, one length bound
 * ===========================================================================
 *
 * `orders.orderNumber` is printed on receipts and quoted by customers over the
 * phone. It is deliberately NOT the primary key: it must stay stable and
 * readable even if the surrogate key strategy ever changes.
 *
 * FORMAT: `<POS|WEB>-<yyyyMMdd business-local>-<zero-padded id>`
 *   POS-20261011-000041
 *   WEB-20260910-000041
 *
 * -------------------------------------------------------------------------
 * WHY THE LENGTH IS A NAMED CONSTANT AND NOT A LITERAL IN FOUR PLACES.
 *
 * The entity has always declared `varchar(40)`. The migration that created the
 * column (0003) declared `character varying` — UNBOUNDED. Nothing failed,
 * because no generated value has ever come close to 40 characters, so the two
 * declarations simply disagreed in silence and `typeorm schema:log` proposed
 * the same ALTER on every single run, which is how a real pending change
 * eventually gets lost in the noise.
 *
 * Migration 0026 aligns the database with the entity. This constant is what
 * stops them drifting again: the entity reads it, the generator asserts
 * against it, and the query DTO bounds its search term by it.
 *
 * WHY 40 IS COMFORTABLE. The prefix is 3, the two separators are 2, the date
 * stamp is 8 — 13 fixed characters — leaving 27 for the zero-padded id. The
 * padding floor is 6 digits, so the number is 19 characters until `orders.id`
 * passes 999 999 and grows one character per decimal digit after that. A
 * 27-digit id is not reachable by a `SERIAL` column, whose maximum is
 * 2 147 483 647 (10 digits, a 23-character order number).
 * -------------------------------------------------------------------------
 */
export const ORDER_NUMBER_MAX_LENGTH = 40;

/** The zero-padding floor for the id segment. Six digits, then natural growth. */
const ID_PAD = 6;

/**
 * Builds the order number for a sale.
 *
 * THE ASSERTION IS NOT DECORATION. The value is about to go into a column that
 * is now `varchar(40)` with a UNIQUE constraint, so an over-long value would
 * fail at COMMIT — inside the transaction that takes the customer's money, as
 * a 500 with a PostgreSQL error string, after the stock has already been
 * decremented. Refusing here fails in the same place with a sentence that says
 * what happened. It is unreachable with a `SERIAL` id (see above); that is the
 * point of checking it rather than assuming it.
 */
export function buildOrderNumber(
  channel: OrderChannel,
  id: number,
  at: Date,
  timezone: string,
): string {
  const prefix = channel === OrderChannel.POS ? 'POS' : 'WEB';
  const value = `${prefix}-${businessDateStamp(at, timezone)}-${String(id).padStart(ID_PAD, '0')}`;

  if (value.length > ORDER_NUMBER_MAX_LENGTH) {
    throw new Error(
      `buildOrderNumber produced ${value.length} characters, which exceeds ` +
        `orders."orderNumber" (${ORDER_NUMBER_MAX_LENGTH}). Value: ${value}`,
    );
  }
  return value;
}
