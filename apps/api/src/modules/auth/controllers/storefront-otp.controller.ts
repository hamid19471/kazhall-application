import { Controller, Post, Body, Res, Req } from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { AuthCookieService } from '../services/auth-cookie.service';
import { Audiences } from '../decorators/audience.decorator';
import { Public } from '../decorators/public.decorator';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { SendOtpDto } from '../dto/send-otp.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { AuthMessages } from 'src/common/constants/auth.messages';
import {
  ApiErrorEnvelope,
  ApiInvalidInput,
  ApiNotFound,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';

/**
 * The identity the per-IP OTP send limit is bucketed by.
 *
 * `X-Forwarded-For`, `X-Real-IP` AND EVERY OTHER FORWARDED HEADER ARE
 * DELIBERATELY IGNORED. This application sets no `trust proxy` anywhere (there
 * is no `app.set('trust proxy', …)` in `src/`), so Express's default applies
 * and `req.ip` is the DIRECT SOCKET PEER. Under that default, reading
 * `X-Forwarded-For` would be strictly worse than useless: any client can send
 * the header, so a rate limit keyed on it is bypassed by rotating one string,
 * and it becomes a cache-poisoning-style knob for framing a real address.
 *
 * DEPLOYMENT PREREQUISITE — READ BEFORE PUTTING A PROXY IN FRONT OF THIS API.
 * Behind a reverse proxy or load balancer, EVERY request arrives from the
 * proxy's address, so this limit degrades into one global 20-per-hour bucket
 * for the whole internet: legitimate customers will be refused, and no
 * attacker will be isolated. Fixing that is a two-part change and BOTH parts
 * are required:
 *
 *   1. configure `trust proxy` in `main.ts` with the NUMBER OF HOPS you
 *      actually operate (or the proxy's address/subnet) — never `true`, which
 *      trusts the whole header chain and hands the client control of `req.ip`
 *      again;
 *   2. make sure the proxy OVERWRITES (not appends to) any inbound
 *      `X-Forwarded-For`, so a client-supplied value cannot survive to be
 *      counted as the leftmost hop.
 *
 * Until both are true, this function is the correct, conservative reading.
 * The fallback chain exists only so a socket with no resolvable address
 * (possible on some transports) lands in one shared bucket instead of `NaN`.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
@ApiTags('auth:storefront')
@Controller('auth/storefront')
@Audiences('storefront')
export class StorefrontOtpController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookieService,
  ) {}

  @Public()
  @Post('send-otp')
  @ApiOperation({
    summary: 'Send OTP code',
    description:
      'PUBLIC — no cookie required. Issues a short-lived code for the mobile ' +
      'number and hands it to the SMS sender. No token is issued here; call ' +
      'POST /auth/verify-otp next.\n\n' +
      'NO ACCOUNT IS CREATED HERE. The customer row is created on the FIRST ' +
      'SUCCESSFUL verification, not on the request for a code — otherwise a ' +
      'loop over this endpoint creates unbounded real accounts for numbers ' +
      'the caller does not control.\n\n' +
      'ENUMERATION-SAFE: the response is byte-identical (bar the timestamp) ' +
      'whether or not the number belongs to an existing customer. Do not ' +
      'infer registration from it — the endpoint does not look.\n\n' +
      'RATE LIMITED THREE WAYS, all answering 429: a 60-second cooldown per ' +
      'number (`error: OTP_COOLDOWN`), 5 sends per number per hour and 20 ' +
      'sends per client IP per hour (both `error: OTP_SEND_RATE_LIMITED`). ' +
      'Every 429 carries `details.retryAfterSeconds`; there is no ' +
      '`Retry-After` header.',
  })
  @ApiCreatedResponse({
    description:
      'The code was issued. IDENTICAL for a registered and an unregistered ' +
      'number.',
    schema: successEnvelopeSchema({ message: AuthMessages.OTP_SENT }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiErrorEnvelope(
    429,
    'Refused by the cooldown (`error: OTP_COOLDOWN`) or by a send rate limit ' +
      '(`error: OTP_SEND_RATE_LIMITED`, per number or per client IP). ' +
      '`details.retryAfterSeconds` says how long to wait.',
  )
  async sendOtp(@Body() sendOtpDto: SendOtpDto, @Req() req: Request) {
    await this.authService.sendOtp(sendOtpDto.mobile, clientIp(req));
    return { message: AuthMessages.OTP_SENT };
  }

  @Public()
  @Post('verify-otp')
  @ApiOperation({
    summary: 'Verify OTP and authenticate customer',
    description:
      'PUBLIC — no cookie required; this is one of the two routes that CREATE ' +
      'the session cookies. On success the tokens are returned as httpOnly ' +
      'cookies and never in the body.\n\n' +
      'THIS IS WHERE THE CUSTOMER ACCOUNT IS CREATED, on the first successful ' +
      'verification of a number. A first-time customer and a returning one ' +
      'are indistinguishable in the response.\n\n' +
      'ALL FAILURES ARE ONE IDENTICAL 401 (`error: OTP_INVALID`, message ' +
      '"Invalid or expired OTP."): no challenge for that number, wrong code, ' +
      'expired code, and attempt bound reached are deliberately impossible to ' +
      'tell apart, so the endpoint cannot be used to discover which numbers ' +
      'are registered or which are mid-login. CONSEQUENCE FOR THE UI: the ' +
      'client is never told "too many attempts" and must offer "resend code" ' +
      'after ANY failure. A code survives at most 5 wrong guesses and 120 ' +
      'seconds, and works exactly ONCE — replaying a correct code gives the ' +
      'same 401.',
  })
  @ApiCreatedResponse({
    description: 'Authenticated; the session cookies are set.',
    headers: {
      'Set-Cookie': {
        description:
          'TWO httpOnly cookies: `access_token` and `refresh_token`, both ' +
          '`Secure`, `SameSite=Strict`, `Path=/`, with lifetimes matching the ' +
          'tokens they carry. The tokens are NOT in the body — a browser ' +
          'client needs no code to store them, but every subsequent request ' +
          'must be sent with credentials.',
        schema: { type: 'string' },
      },
    },
    schema: successEnvelopeSchema({ message: AuthMessages.LOGIN_SUCCESS }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiErrorEnvelope(
    401,
    'ONE indistinguishable response for: no challenge for that number, wrong ' +
      'code, expired code, attempt bound reached, and a replayed code — all ' +
      '`error: OTP_INVALID`. A soft-deactivated account also answers 401, ' +
      'with `ACCOUNT_DEACTIVATED`; that one is only reachable by somebody who ' +
      'has already proven control of the phone, so it is not an enumeration ' +
      'channel.',
  )
  @ApiNotFound(
    'The `site` role row is missing from the database — a deployment fault, ' +
      'not a client error. Nothing about the mobile number is implied.',
  )
  async verifyOtp(
    @Body() verifyOtpDto: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.verifyOtp(
      verifyOtpDto.mobile,
      verifyOtpDto.code,
    );
    this.cookies.clearLegacySession(res);
    this.cookies.setSession(res, 'storefront', accessToken, refreshToken);
    return { message: AuthMessages.LOGIN_SUCCESS };
  }
}
