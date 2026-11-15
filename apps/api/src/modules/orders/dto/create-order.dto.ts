import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOrderDto {
  @ApiProperty({
    example: 19,
    description:
      'Id of one of YOUR saved addresses (see GET /me/addresses). An address ' +
      'belonging to another customer answers 404, exactly as a non-existent ' +
      'one does.',
  })
  @IsNotEmpty({ message: 'address is required' })
  @IsNumber({}, { message: 'address field must be a number' })
  address: number;

  @ApiPropertyOptional({ example: 'jfd^#F', description: 'discount code' })
  @IsString({ message: 'discount_code field must be a string' })
  @IsOptional()
  discount_code?: string;

  /**
   * THE CUSTOMER'S ACCEPTED PURCHASE, as issued and signed by the server.
   *
   * Obtain one from `POST /orders/quote`, or from the `details.quote.token` of
   * any 409 this endpoint returns. Show the customer the quote's lines and
   * total, and send the token back here when they accept.
   *
   * It replaces the previous `confirmChanges` boolean and `expectedTotal`
   * number, which are no longer accepted: `confirmChanges: true` suppressed the
   * very changes the server had just detected — including a mismatch against
   * the `expectedTotal` sent in the same request — so a client that set the
   * flag was charged whatever the server computed at that instant. A boolean
   * cannot express WHICH basket the customer agreed to buy, so it authorised
   * every future basket equally well.
   *
   * OPTIONAL IN THE DTO, MANDATORY IN THE CONTRACT — and the distinction is
   * deliberate. Omitting it does NOT place an order; it answers **409
   * `checkout_quote_required`** carrying a freshly priced quote, which is the
   * ordinary FIRST STEP of checkout: the customer has to see what they are
   * buying before they are charged for it.
   *
   * It was `@IsNotEmpty` (a 400) until the contract was reconciled. That split
   * the recovery path in two: a missing token produced a bare validation error
   * with no quote and nothing to show the customer, while an expired or
   * tampered one produced a 409 that carried everything needed to continue. The
   * documented `checkout_quote_required` code was also unreachable except by
   * sending whitespace. Now every quote problem — absent, expired, malformed,
   * tampered, foreign, or stale — is answered by a 409 carrying a fresh quote,
   * so a client has exactly ONE recovery path.
   *
   * Sending an old token is always safe: the worst outcome is a 409 carrying
   * the current basket. It is never a bypass.
   */
  @ApiPropertyOptional({
    example: 'kq1.eyJ2IjoxLCJ1c2VySWQiOjQyLC4uLn0.M8f_9xQ...',
    description:
      'Server-signed quote token from POST /orders/quote (or from the 409 this ' +
      'endpoint returns). Binds the order to the exact lines, quantities, ' +
      'prices and total the customer accepted, for a bounded period. Omit it to ' +
      'receive a 409 `checkout_quote_required` carrying a quote to review — no ' +
      'order is placed without one.',
  })
  @IsOptional()
  @IsString({ message: 'quoteToken must be a string' })
  /**
   * An upper bound only, to cap the work done on an unverified payload. There
   * is deliberately no minimum length and no format check: any string reaches
   * the service and is answered with the same 409 carrying a fresh quote.
   */
  @MaxLength(8192, { message: 'quoteToken is too long' })
  quoteToken?: string;
}
