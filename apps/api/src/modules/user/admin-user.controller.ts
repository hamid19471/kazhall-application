import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AdminUserService } from './admin-user.service';
import {
  AdminUserKindFilter,
  AdminUserQueryDto,
} from './dto/admin-user-query.dto';
import {
  CreateStaffUserDto,
  ResetUserPasswordDto,
  UpdateStaffUserDto,
} from './dto/admin-user.dto';
import { SetActiveDto } from './dto/set-active.dto';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import {
  ConsultsPermissions,
  RequirePermissions,
} from 'src/modules/auth/permissions/permission.decorator';
import {
  assertPermission,
  hasPermission,
} from 'src/modules/auth/permissions/assert-permission';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
import { UserMessages } from 'src/common/constants/user.messages';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiConflict,
  ApiInvalidInput,
  ApiNotFound,
  ApiPermissionForbidden,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';

/**
 * STAFF ADMINISTRATION.
 *
 * Everything here is capability-gated rather than role-gated, which is the
 * point: the owner can now let an office manager create and reset cashier
 * accounts without also handing them the ability to void paid sales or edit
 * the role model.
 *
 * ===========================================================================
 * THE USER-MANAGEMENT PERMISSION MATRIX, IN ONE PLACE
 * ===========================================================================
 *
 * `users.create` DOES NOT IMPLY EVERY USER-MANAGEMENT POWER. Each capability
 * below is separately grantable, and nothing on this controller silently
 * assumes another:
 *
 *   ACTION                     ROUTE                                 REQUIRES
 *   ------------------------------------------------------------------------
 *   list users                 GET    /admin/users                   users.read
 *   read one user              GET    /admin/users/:id               users.read
 *   list assignable roles      GET    /admin/users/assignable-roles  users.create
 *                                                                    OR users.update
 *   create a user              POST   /admin/users                   users.create
 *   update profile fields      PATCH  /admin/users/:id               users.update
 *     (username, mobile)
 *   assign a BRANCH            PATCH  /admin/users/:id               users.update
 *   assign ROLES               PUT    /admin/access/users/:id/roles  rbac.read
 *                                                                    + rbac.manage
 *   reset the password         POST   /admin/users/:id/password      users.password.reset
 *   deactivate the user        PATCH  /admin/users/:id/active        users.read
 *                                                                    + users.deactivate
 *   reactivate the user        PATCH  /admin/users/:id/active        users.read
 *                                                                    + users.activate
 *   revoke sessions            POST   /admin/users/:id/revoke-sessions
 *                                                                    users.sessions.revoke
 *
 * FIVE THINGS THAT MATRIX IS SAYING DELIBERATELY:
 *
 *  1. CREATING IS NOT READING. `users.create` does not admit
 *     `GET /admin/users`. Somebody who onboards staff does not thereby get the
 *     whole directory, including customers and their mobile numbers.
 *  2. A BRANCH IS A PROFILE FIELD, not an authority. Moving a cashier between
 *     shops is `users.update`; it confers no capability, and the branch is
 *     enforced server-side on every till operation regardless.
 *  3. ROLE ASSIGNMENT IS NOT HERE AND IS NOT `users.*`. It lives on
 *     `PUT /admin/access/users/{id}/roles` and needs `rbac.manage`, because
 *     "who may create a cashier" and "who may decide what a cashier can do"
 *     are different authorities; merging them would make `users.create` a
 *     backdoor into the permission model. The ONE exception is `roleIds` on
 *     CREATE, which is checked with the same no-escalation rule (see
 *     `assignable-roles.ts`) precisely so that it cannot become one.
 *  4. DEACTIVATION AND REACTIVATION ARE SEPARATE CAPABILITIES, chosen by the
 *     request body — a "critical" one and a "sensitive" one. An operator who
 *     may restore access is not thereby able to remove it.
 *  5. RESETTING A PASSWORD AND REVOKING SESSIONS ARE SEPARATE. Cutting
 *     somebody's sessions is the low-risk incident-response action; handing
 *     them a password you know is the high-risk one, and it is the only route
 *     here that can produce a credential.
 *
 * THERE IS NO DELETE ROUTE, deliberately. `orders.cashierUserId` is ON DELETE
 * RESTRICT and stock movements and audit rows reference staff; retiring
 * somebody is deactivation, which keeps every attribution intact and is
 * reversible.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Admin: users')
@Controller('admin/users')
@Audiences('admin')
export class AdminUserController {
  constructor(private readonly users: AdminUserService) {}

  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'Paginated staff and customer directory',
    description:
      'Search covers username and mobile. `canAccess` says which surfaces ' +
      'each account can currently open a session on — derived from effective ' +
      'permissions exactly the way login derives it, so it is the real answer ' +
      'to "can this cashier log into the till". Never returns password ' +
      'hashes, token hashes or OTP state.',
  })
  @ApiOkResponse({
    description: 'One page of accounts.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
        totalPages: { type: 'integer' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.read')
  @Get()
  list(@Query() query: AdminUserQueryDto) {
    return this.users.list(query);
  }

  /**
   * =====================================================================
   * THE ROLES THIS PRINCIPAL COULD ACTUALLY CONFER
   * =====================================================================
   *
   * WHY IT EXISTS. The create-user form needs a role to submit, and the only
   * list of roles was `GET /admin/access/roles`, gated on `rbac.read`. A
   * delegated user manager holding `users.create` could therefore OPEN the
   * form and never complete it — and the obvious workaround, granting them
   * `rbac.read`, hands over the entire access-control catalogue, every custom
   * role, and every user's effective permissions, as an accidental dependency
   * of being allowed to hire a cashier. That is capability creep caused by
   * form layout, and this route is the fix.
   *
   * WHY THE PERMISSION IS CHECKED IN THE HANDLER. `@RequirePermissions` is
   * AND-only, deliberately (see `permission.decorator.ts`), and the rule here
   * is genuinely an OR: a principal who may CREATE a user needs this list, and
   * so does one who may UPDATE an existing user's roles. Declaring either code
   * alone on the route would lock out the other half. The refusal below is the
   * same shape the guard would have thrown, so a client cannot tell the
   * difference.
   *
   * WHAT IT DOES NOT EXPOSE — the whole reason it is not just a proxy for
   * `GET /admin/access/roles`:
   *
   *   - no `permissions` array (a COUNT, never the codes),
   *   - no risk metadata, catalogue grouping or capability descriptions,
   *   - no inactive roles, so it cannot enumerate switched-off ones,
   *   - no role this principal could not actually confer, so it cannot be
   *     used to discover the existence of higher-privileged roles.
   *
   * AND IT GRANTS NOTHING. `POST /admin/users` and
   * `PUT /admin/access/users/:id/roles` re-apply the identical rule from the
   * identical module on the way in. Asking first is a convenience; it is never
   * the authorisation.
   *
   * DECLARED BEFORE `@Get(':id')`. Nest matches in declaration order, so the
   * parameterised route would otherwise swallow this path and `ParseIntPipe`
   * would answer 400 for `assignable-roles`.
   */
  @ApiOperation({
    summary: 'Roles this principal may assign, for the user form',
    description:
      'Available to a principal holding `users.create` OR `users.update`. ' +
      'Returns only ACTIVE roles whose every conferred capability the caller ' +
      'already holds, so the list is exactly what `POST /admin/users` and ' +
      '`PUT /admin/access/users/{id}/roles` would accept from this caller.\n\n' +
      'It is NOT a substitute for `GET /admin/access/roles`: there is no ' +
      'permission list, no risk metadata and no inactive role in the ' +
      'response, and `rbac.read` is still required to read the access-control ' +
      'catalogue itself.',
  })
  @ApiOkResponse({
    description:
      'The assignable roles, built-in first. `permissionCount` is a SIZE, ' +
      'never the codes themselves.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 2 },
            name: { type: 'string', example: 'sale' },
            titleFa: { type: 'string', nullable: true, example: 'صندوق‌دار' },
            description: { type: 'string', nullable: true },
            isSystem: { type: 'boolean', example: true },
            isActive: {
              type: 'boolean',
              example: true,
              description: 'Always true — inactive roles are never listed.',
            },
            permissionCount: { type: 'integer', example: 3 },
          },
        },
      },
    }),
  })
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.create')
  // `users.create` OR `users.update`, decided in the handler because
  // `@RequirePermissions` is AND-only. Declared for the coverage spec.
  @ConsultsPermissions('users.create', 'users.update')
  @Get('assignable-roles')
  async assignableRoles(@Req() req: UserRequest) {
    if (
      !hasPermission(req, 'users.create') &&
      !hasPermission(req, 'users.update')
    ) {
      // Same envelope the guard produces, listing BOTH codes so the client can
      // say which capability is missing rather than guessing.
      throw new ForbiddenException({
        error: AuthErrorCodes.PERMISSION_DENIED,
        message: AuthMessages.PERMISSION_DENIED,
        requiredPermissions: ['users.create', 'users.update'],
        missingPermissions: ['users.create', 'users.update'],
      });
    }

    return {
      data: await this.users.listAssignableRoles(req.user?.permissions ?? []),
    };
  }

  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'One account, with its effective permissions and live sessions',
    description:
      '`permissions` is the combined set across every active role the user ' +
      'holds. `sessionsByAudience` counts live refresh tokens per surface — ' +
      'counts only; no token, no hash, no fragment of one.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The account.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.read')
  @ApiNotFound('No user has that id.')
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.users.detail(id) };
  }

  @RequirePermissions('users.create')
  @ApiOperation({
    summary: 'Create a staff account',
    description:
      'The administrator types the initial password and hands it over out of ' +
      'band; it is hashed immediately and is never readable again. Unless ' +
      '`mustChangePassword` is explicitly false the account must replace it ' +
      'at first sign-in.\n\n' +
      'Roles are conferred here, so the caller must already hold every ' +
      'capability those roles grant — otherwise 403 `PERMISSION_ESCALATION`.',
  })
  @ApiCreatedResponse({
    description: 'The created account.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_CREATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${VALIDATION_PIPE_400}. Also 400 for an unknown branch.`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.create')
  @ApiNotFound('One of the role ids does not exist.')
  @ApiConflict('`USERNAME_TAKEN` or `MOBILE_TAKEN`.')
  @Post()
  async create(@Body() dto: CreateStaffUserDto, @Req() req: UserRequest) {
    const user = await this.users.create(
      dto,
      auditActorFrom(req),
      req.user.permissions,
    );
    return { message: UserMessages.USER_CREATED, data: user };
  }

  @RequirePermissions('users.update')
  @ApiOperation({
    summary: 'Update a staff account’s identity or branch',
    description:
      'A branch change takes effect on the user’s NEXT request: the branch is ' +
      'read from the database on every call, never from their token.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The updated account.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.update')
  @ApiNotFound('No user has that id.')
  @ApiConflict('`USERNAME_TAKEN` or `MOBILE_TAKEN`.')
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStaffUserDto,
    @Req() req: UserRequest,
  ) {
    const user = await this.users.update(id, dto, auditActorFrom(req));
    return { message: UserMessages.USER_UPDATED, data: user };
  }

  /**
   * One route, two permissions, chosen by the body — `users.activate` and
   * `users.deactivate` are separate authorities and a static decorator cannot
   * express "whichever the body asks for". The refusal shape is identical to
   * the guard's, so a client branches on one code.
   */
  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'Activate or deactivate an account',
    description:
      'DEACTIVATION ALSO REVOKES EVERY SESSION, in every audience, in the ' +
      'same transaction — otherwise a later reactivation would silently ' +
      'resurrect sessions that were open when the account was suspended.\n\n' +
      'Refused with 409 `LAST_SUPER_ADMIN` when it would leave the system ' +
      'with no administrator who can still sign in.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The account.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.activate / users.deactivate')
  @ApiNotFound('No user has that id.')
  @ApiConflict('`LAST_SUPER_ADMIN`.')
  @HttpCode(200)
  // `users.activate` or `users.deactivate`, chosen by `dto.isActive`.
  @ConsultsPermissions('users.activate', 'users.deactivate')
  @Patch(':id/active')
  async setActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetActiveDto,
    @Req() req: UserRequest,
  ) {
    assertPermission(req, dto.isActive ? 'users.activate' : 'users.deactivate');
    const user = await this.users.setActive(
      id,
      dto.isActive,
      auditActorFrom(req),
    );
    return {
      message: dto.isActive
        ? UserMessages.USER_REACTIVATED
        : UserMessages.USER_DEACTIVATED,
      data: user,
    };
  }

  @RequirePermissions('users.sessions.revoke')
  @ApiOperation({
    summary: 'Sign this user out of every device and every surface',
    description:
      'Revokes every refresh token. Does NOT deactivate the account and does ' +
      'not clear anybody’s cookies; the access tokens already issued expire ' +
      'within `JWT_ACCESS_EXPIRATION`. Use deactivation when the person must ' +
      'not be able to sign back in.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'Sessions revoked.',
    schema: successEnvelopeSchema({
      message: UserMessages.SESSIONS_REVOKED,
      properties: { revoked: { type: 'integer', example: 2 } },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.sessions.revoke')
  @ApiNotFound('No user has that id.')
  @HttpCode(200)
  @Post(':id/revoke-sessions')
  async revoke(@Param('id', ParseIntPipe) id: number, @Req() req: UserRequest) {
    const { revoked } = await this.users.revokeSessions(
      id,
      auditActorFrom(req),
    );
    return { message: UserMessages.SESSIONS_REVOKED, revoked };
  }

  @RequirePermissions('users.password.reset')
  @ApiOperation({
    summary: 'Set a temporary password',
    description:
      'THE SYSTEM NEVER GENERATES AND DISPLAYS A PASSWORD. The administrator ' +
      'types one and hands it over out of band; it is hashed immediately and ' +
      'the existing password is never shown (the column holds a bcrypt hash — ' +
      'it cannot be).\n\n' +
      'Every session of the target is revoked, and the account is flagged so ' +
      'the next sign-in must replace the value: until it does, every route ' +
      'except introspection, rotation, sign-out and the change itself answers ' +
      '403 `PASSWORD_CHANGE_REQUIRED`.\n\n' +
      'Customer accounts (mobile + OTP, no username) are refused with 400 ' +
      '`NOT_A_STAFF_ACCOUNT` — they have no password to reset.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'Temporary password set; sessions revoked.',
    schema: successEnvelopeSchema({
      message: UserMessages.PASSWORD_RESET,
      properties: { revoked: { type: 'integer', example: 2 } },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.password.reset')
  @ApiNotFound('No user has that id.')
  @HttpCode(200)
  @Post(':id/password')
  async resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetUserPasswordDto,
    @Req() req: UserRequest,
  ) {
    const { revoked } = await this.users.resetPassword(
      id,
      dto,
      auditActorFrom(req),
    );
    return { message: UserMessages.PASSWORD_RESET, revoked };
  }
}

/**
 * CASHIER / POS STAFF.
 *
 * The same capabilities and the same service — this is a FILTERED VIEW, not a
 * second implementation, because two code paths for "create a staff account"
 * is how one of them ends up missing the escalation check.
 *
 * What it adds is the POS-shaped question the general directory does not
 * answer: is this person actually able to sell right now? That needs three
 * facts together — the account is active, it holds `pos.access`, and its
 * branch exists and is itself active — and a manager should not have to
 * assemble them from three screens.
 *
 * ON "DEACTIVATE POS": this deactivates a cashier ACCOUNT. The schema has no
 * terminal/register entity at all — there is no `pos_terminals` table, no
 * device registration, and nothing in a sale identifies which physical till
 * rang it up beyond the cashier and the branch. Deactivating a register is
 * therefore not something this system can do, and nothing here pretends
 * otherwise. See the delivery report.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Admin: cashiers')
@Controller('admin/cashiers')
@Audiences('admin')
export class AdminCashierController {
  constructor(private readonly users: AdminUserService) {}

  @RequirePermissions('users.read')
  @ApiOperation({
    summary: 'POS staff, with whether each can currently sell',
    description:
      'The directory filtered to accounts that hold `pos.access`. ' +
      '`canSellNow` is the honest composite: the account is active, it can ' +
      'open a POS session, it has a branch, and that branch is active — ' +
      '`POST /orders/pos` refuses on any of those failing, so the list says ' +
      'so before the cashier finds out at the till.',
  })
  @ApiOkResponse({
    description: 'One page of cashiers.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
        totalPages: { type: 'integer' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('users.read')
  @Get()
  async list(@Query() query: AdminUserQueryDto) {
    // Staff only: a customer account can never hold `pos.access`, and
    // including them would make the page's counts meaningless.
    const page = await this.users.list({
      ...query,
      kind: AdminUserKindFilter.STAFF,
    });

    const cashiers = page.data
      .filter((user) => user.canAccess.pos)
      .map((user) => ({
        ...user,
        canSellNow:
          user.isActive &&
          user.canAccess.pos &&
          user.branchId !== null &&
          user.branchIsActive === true,
        blockedReason: blockedReason(user),
      }));

    /*
     * `total` is the UNFILTERED page total, and saying so matters: the
     * `pos.access` test is applied in application code (it depends on
     * expanding roles into capabilities, which SQL cannot do here), so the
     * page may contain fewer cashiers than `limit`. The UI must page on
     * `total`, not on `data.length`, and `filteredOut` is what lets it explain
     * the gap rather than looking broken.
     */
    return {
      ...page,
      data: cashiers,
      filteredOut: page.data.length - cashiers.length,
    };
  }
}

function blockedReason(user: {
  isActive: boolean;
  branchId: number | null;
  branchIsActive: boolean | null;
  mustChangePassword: boolean;
}): string | null {
  if (!user.isActive) return 'account_deactivated';
  if (user.branchId === null) return 'no_branch';
  if (user.branchIsActive === false) return 'branch_inactive';
  if (user.mustChangePassword) return 'password_change_required';
  return null;
}
