import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * The COMPLETE body of `POST /payment/verify`: one gateway-issued track id.
 *
 * THERE IS DELIBERATELY NO `userId` FIELD, AND NONE MAY BE ADDED.
 *
 * Who the caller is comes from the `access_token` cookie
 * (`req.user.sub`, resolved against the database by `JwtStrategy`) and is
 * checked against `orders."userId"` in `PaymentService.verifyForCaller`. An
 * identity a caller can type into a JSON body is not an identity — accepting
 * one here would hand back the ownership check it exists to enforce.
 *
 * The global `ValidationPipe` runs with `whitelist: true` and
 * `forbidNonWhitelisted: true`, so a body carrying `userId` (or any other key
 * not declared below) is REJECTED with 400 rather than quietly stripped. That
 * is asserted in `test/integration/payment-verify-ownership.int-spec.ts`: a
 * silent strip would look identical from the outside today and would become a
 * privilege-escalation vector the moment somebody added the field back.
 */
export class VerifyPaymentDto {
  @ApiProperty({
    example: 'ZBL-1732000000-42',
    description:
      'The gateway-issued track id from `POST /payment/start`. A string, not ' +
      'a number. It identifies the payment ATTEMPT, not the order, and it ' +
      'does not authorize anything on its own: the attempt must belong to an ' +
      'order the caller owns (or the caller must be a `super_admin`), or the ' +
      'request answers 404.',
  })
  @IsNotEmpty({ message: 'trackId is required' })
  @IsString({ message: 'trackId must be a string' })
  trackId: string;
}
