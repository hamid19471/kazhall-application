import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { NORMALIZED_MOBILE_PATTERN, normalizeMobile } from '../otp.policy';

export class VerifyOtpDto {
  /**
   * Normalized by the SAME function, before validation, for the same reason as
   * `SendOtpDto.mobile` — see the comment there.
   *
   * It matters twice as much here: the challenge is looked up by this string
   * and the `site` account is created under this string. A spelling mismatch
   * between send and verify would look to a user like "the code never works",
   * and a mismatch between verify and account creation would silently create a
   * SECOND user for the same human.
   */
  @ApiProperty({
    example: '09902172024',
    description:
      'The same mobile number `POST /auth/send-otp` was called with. Any of ' +
      'the accepted spellings works — both endpoints normalize to ' +
      '`09XXXXXXXXX` before looking anything up, so the two calls do not have ' +
      'to agree on formatting.',
  })
  @Transform(({ value }) => normalizeMobile(value))
  @IsNotEmpty({ message: 'mobile is required' })
  @IsString({ message: 'mobile is must be a string' })
  @Matches(NORMALIZED_MOBILE_PATTERN, {
    message: 'mobile must be a valid phone number',
  })
  mobile: string;

  /**
   * The code, as digits. Kept as a STRING and never parsed to a number: a
   * leading-zero code (`012345`) is a legitimate one — issuing codes over the
   * full `000000`-`999999` range is what keeps the keyspace at 10^6 — and
   * `Number('012345')` would destroy it.
   *
   * The 4-6 length range is retained from the original DTO so a shorter code
   * from an older SMS template still reaches the service; it simply will not
   * match a hash and is refused like any other wrong code.
   */
  @ApiProperty({ example: '123456', description: 'OTP code received via SMS' })
  @IsNotEmpty({ message: 'OTP code is required' })
  @IsString({ message: 'OTP code must be number' })
  @Length(4, 6, { message: 'OTP code must be between 4 and 6 characters' })
  code: string;
}
