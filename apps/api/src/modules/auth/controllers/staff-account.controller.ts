import {
  Controller,
  Post,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { Audiences } from '../decorators/audience.decorator';
import { RequirePermissions } from '../permissions/permission.decorator';
import { RegisterDto } from '../dto/register.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AuthMessages } from 'src/common/constants/auth.messages';
import { ACCESS_TOKEN_SECURITY_SCHEME } from 'src/configs/swagger.config';
import {
  ApiAuthRequired,
  ApiInvalidInput,
  ApiNotFound,
  ApiRoleForbidden,
  PARSE_INT_PIPE_400,
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
@ApiTags('auth:admin')
@Controller('auth')
@Audiences('admin')
export class StaffAccountController {
  constructor(private readonly authService: AuthService) {}

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('users.create')
  @ApiOperation({
    summary: 'Register staff user',
    description:
      'Creates a STAFF account with the roles named in the body. Unlike ' +
      'POST /users this route also rejects a username that is already taken. ' +
      'No cookie is issued — the new user logs in themselves.',
  })
  @ApiCreatedResponse({
    description:
      'Staff user created. NOTE the key: the new user is returned under ' +
      '`user`, not under `data`.',
    schema: successEnvelopeSchema({
      message: AuthMessages.REGISTER_SUCCESS,
      properties: {
        user: { type: 'object', description: 'The created staff user.' },
      },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 when the username is taken, when no ` +
      'role is given, and when `branchId` does not exist.',
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('One of the requested role names does not exist.')
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    const user = await this.authService.register(registerDto);
    return { message: AuthMessages.REGISTER_SUCCESS, user };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('users.sessions.revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke every refresh token of a given user',
    description:
      'Admin revoke-all, used when staff are compromised or deactivated: ' +
      '`users.deactivatedAt` stops new logins, this ends the sessions already ' +
      'open. It does NOT clear anybody’s cookies and does not deactivate the ' +
      'account. An unknown user id answers 200 with `revoked: 0`.',
  })
  @ApiParam({
    name: 'userId',
    type: Number,
    description: 'Numeric `users.id` whose sessions are to be ended.',
    example: 4,
  })
  @ApiOkResponse({
    description: 'Every session of that user is revoked. 200, not 201.',
    schema: successEnvelopeSchema({
      message: AuthMessages.SESSIONS_REVOKED,
      properties: {
        revoked: {
          type: 'integer',
          example: 2,
          description: 'Refresh tokens revoked; 0 for an unknown user id.',
        },
      },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @Post('users/:userId/revoke-sessions')
  async revokeUserSessions(@Param('userId', ParseIntPipe) userId: number) {
    const revoked = await this.authService.revokeAllSessions(userId);
    return { message: AuthMessages.SESSIONS_REVOKED, revoked };
  }
}
