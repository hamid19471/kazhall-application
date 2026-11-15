import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { NORMALIZED_MOBILE_PATTERN, normalizeMobile } from '../otp.policy';

export class SendOtpDto {
  /**
   * NORMALIZED BEFORE VALIDATION, exactly once, by the same function the
   * service uses (`otp.policy.ts#normalizeMobile`).
   *
   * WHY THE `@Transform` IS LOAD-BEARING. Cooldown, both send rate limits,
   * challenge lookup and user creation are all keyed by this string. If two
   * spellings of one number reached the service as two different strings, they
   * would be two buckets and every one of those controls could be bypassed by
   * alternating spellings: request a code as `09121234567`, again as
   * `+989121234567`, again as `9121234567`, and the 60-second cooldown never
   * fires once.
   *
   * `@Transform` runs during `plainToInstance`, i.e. BEFORE `@Matches`, so the
   * pattern below validates the CANONICAL form. Anything that cannot be
   * canonicalized becomes `''` and is rejected by `@IsNotEmpty`, so junk is
   * still a 400 rather than being silently stripped down to a valid-looking
   * number.
   *
   * This ACCEPTS STRICTLY MORE than before (E.164, the `0098`/`98` prefixes,
   * the bare 10-digit national form, Persian and Arabic-Indic digits, and
   * spaces/hyphens/brackets) and rejects nothing that was previously accepted,
   * so no existing client breaks. The service normalizes again defensively —
   * the function is idempotent, so that costs nothing.
   */
  @ApiProperty({
    example: '09902172024',
    description:
      'Customer mobile number. Accepted as `09XXXXXXXXX`, `9XXXXXXXXX`, ' +
      '`+989XXXXXXXXX`, `00989XXXXXXXXX` or `989XXXXXXXXX`, with optional ' +
      'spaces, hyphens or brackets, and with Persian/Arabic-Indic digits. It ' +
      'is normalized to `09XXXXXXXXX` before anything else happens, and that ' +
      'canonical form is the key for the cooldown, the rate limits and the ' +
      'account itself.',
  })
  @Transform(({ value }) => normalizeMobile(value))
  @IsNotEmpty({ message: 'mobile is required' })
  @IsString({ message: 'mobile is must be a string' })
  @Matches(NORMALIZED_MOBILE_PATTERN, {
    message: 'mobile must be a valid phone number',
  })
  mobile: string;
}
