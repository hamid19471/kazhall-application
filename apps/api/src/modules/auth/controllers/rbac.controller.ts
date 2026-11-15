import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
import { Audiences } from '../decorators/audience.decorator';
import { RequirePermissions } from '../permissions/permission.decorator';
import { RbacService } from '../services/rbac.service';
import {
  CreateRoleDto,
  SetRoleActiveDto,
  SetRolePermissionsDto,
  SetUserRolesDto,
  UpdateRoleDto,
} from '../dto/rbac.dto';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
import { RoleMessages } from 'src/common/constants/role.messages';
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
 * ACCESS CONTROL — roles, their capabilities, and who holds them.
 *
 * Reads need `rbac.read`; every write needs `rbac.manage`. They are separate
 * permissions on purpose: "let the office manager SEE who can do what" is a
 * reasonable delegation, and "let them CHANGE it" is the single most dangerous
 * one in the system, because `rbac.manage` is the permission that can alter
 * every other permission.
 *
 * Two server-side rules bound that danger and neither is negotiable by the
 * frontend:
 *
 *   - a built-in role cannot be renamed, deactivated or re-permissioned;
 *   - an actor cannot confer a capability it does not hold itself, whether by
 *     granting it to a role or by assigning that role to somebody.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Admin: access control')
@Controller('admin/access')
@Audiences('admin')
@RequirePermissions('rbac.read')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @ApiOperation({
    summary: 'The permission catalogue, grouped',
    description:
      'The fixed list of capabilities, each with its Persian label, its ' +
      'consequence sentence and its risk level. There is no endpoint that ' +
      'adds to it: a code no guard checks authorises nothing.',
  })
  @ApiOkResponse({
    description: 'Groups, in display order, each with its permissions.',
    schema: successEnvelopeSchema({
      properties: { groups: { type: 'array', items: { type: 'object' } } },
    }),
  })
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.read')
  @Get('permissions')
  catalogue() {
    return this.rbac.catalogue();
  }

  @ApiOperation({
    summary: 'Every role, with how many users hold it',
    description:
      'Bounded by construction — the role catalogue is small and entirely ' +
      'administrator-created. User counts come from ONE grouped query, not ' +
      'one per role.',
  })
  @ApiOkResponse({
    description: 'Built-in roles first, then custom roles by id.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
    }),
  })
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.read')
  @Get('roles')
  async listRoles() {
    return { data: await this.rbac.listRoles() };
  }

  @ApiOperation({
    summary: 'One role and every capability it confers',
    description:
      '`permissionsReadOnly` is true for built-in roles: their sets are ' +
      'defined in code and this API refuses to change them.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The role.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.read')
  @ApiNotFound('No role has that id.')
  @Get('roles/:id')
  async readRole(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.rbac.readRole(id) };
  }

  @ApiOperation({
    summary: 'Everything one user can do, combined across their roles',
    description:
      'Expanded exactly the way every authenticated request expands it, so ' +
      'what this screen shows is what the guards will actually enforce.',
  })
  @ApiParam({ name: 'userId', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'Roles, combined permissions, and the surfaces they open.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.read')
  @ApiNotFound('No user has that id.')
  @Get('users/:userId/effective')
  async effective(@Param('userId', ParseIntPipe) userId: number) {
    return { data: await this.rbac.effectiveAccess(userId) };
  }

  // =========================================================================
  // Writes — `rbac.manage`
  // =========================================================================

  @ApiOperation({
    summary: 'Create a custom role',
    description:
      'The role grants exactly the permission codes supplied, which must all ' +
      'exist AND all be held by the caller. To let the holder into the admin ' +
      'console at all, include `admin.access`.',
  })
  @ApiCreatedResponse({
    description: 'The created role.',
    schema: successEnvelopeSchema({
      message: RoleMessages.ROLE_CREATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 \`UNKNOWN_PERMISSION\` when a code is ` +
      'not in the catalogue.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.manage')
  @ApiConflict('`ROLE_NAME_TAKEN` — that machine name is already in use.')
  @RequirePermissions('rbac.read', 'rbac.manage')
  @Post('roles')
  async createRole(@Body() dto: CreateRoleDto, @Req() req: UserRequest) {
    const role = await this.rbac.createRole(
      {
        name: dto.name,
        titleFa: dto.titleFa,
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.permissions !== undefined
          ? { permissions: dto.permissions }
          : {}),
      },
      auditActorFrom(req),
      req.user.permissions,
    );
    return { message: RoleMessages.ROLE_CREATED, data: role };
  }

  @ApiOperation({
    summary: 'Rename or re-describe a custom role',
    description:
      'The machine `name` is deliberately NOT editable: it is written into ' +
      'audit rows that outlive the role, so renaming it would orphan history.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The updated role.',
    schema: successEnvelopeSchema({
      message: RoleMessages.ROLE_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.manage')
  @ApiNotFound('No role has that id.')
  @ApiConflict('`SYSTEM_ROLE_IMMUTABLE` — built-in roles cannot be edited.')
  @RequirePermissions('rbac.read', 'rbac.manage')
  @Patch('roles/:id')
  async updateRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoleDto,
    @Req() req: UserRequest,
  ) {
    const role = await this.rbac.updateRole(
      id,
      {
        ...(dto.titleFa !== undefined ? { titleFa: dto.titleFa } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
      },
      auditActorFrom(req),
    );
    return { message: RoleMessages.ROLE_UPDATED, data: role };
  }

  @ApiOperation({
    summary: 'Replace a custom role’s capabilities',
    description:
      'The body is the COMPLETE desired set — codes that are absent are ' +
      'revoked. Both the additions and the removals are checked against the ' +
      'caller’s own authority.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The role with its new capability set.',
    schema: successEnvelopeSchema({
      message: RoleMessages.ROLE_PERMISSIONS_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 ` +
      '`UNKNOWN_PERMISSION`.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.manage')
  @ApiNotFound('No role has that id.')
  @ApiConflict('`SYSTEM_ROLE_IMMUTABLE` — built-in roles cannot be edited.')
  @RequirePermissions('rbac.read', 'rbac.manage')
  @Put('roles/:id/permissions')
  async setPermissions(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetRolePermissionsDto,
    @Req() req: UserRequest,
  ) {
    const role = await this.rbac.setRolePermissions(
      id,
      dto.permissions,
      auditActorFrom(req),
      req.user.permissions,
    );
    return { message: RoleMessages.ROLE_PERMISSIONS_UPDATED, data: role };
  }

  @ApiOperation({
    summary: 'Activate or deactivate a custom role',
    description:
      'Deactivating removes every capability the role confers WITHOUT ' +
      'removing it from the users who hold it, so the change is reversible. ' +
      'Deleting a role would lose the assignments permanently — which is why ' +
      'this exists and why deletion is refused for a role anybody holds.',
  })
  @ApiParam({ name: 'id', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The role.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.manage')
  @ApiNotFound('No role has that id.')
  @ApiConflict('`SYSTEM_ROLE_IMMUTABLE` — built-in roles are always active.')
  @RequirePermissions('rbac.read', 'rbac.manage')
  @Patch('roles/:id/active')
  async setActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetRoleActiveDto,
    @Req() req: UserRequest,
  ) {
    const role = await this.rbac.setRoleActive(
      id,
      dto.isActive,
      auditActorFrom(req),
    );
    return {
      message: dto.isActive
        ? RoleMessages.ROLE_ACTIVATED
        : RoleMessages.ROLE_DEACTIVATED,
      data: role,
    };
  }

  @ApiOperation({
    summary: 'Replace a user’s roles',
    description:
      'Keyed on `roles.id`, so CUSTOM roles can be assigned — unlike ' +
      'PATCH /users/{id}, whose `role` field takes built-in names only. ' +
      'Refused with 409 `LAST_SUPER_ADMIN` when it would leave the system ' +
      'with no administrator who can still sign in.',
  })
  @ApiParam({ name: 'userId', type: Number, example: 4 })
  @ApiOkResponse({
    description: 'The user’s new effective access.',
    schema: successEnvelopeSchema({
      message: RoleMessages.USER_ROLES_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('rbac.manage')
  @ApiNotFound('No user has that id, or one of the roles does not exist.')
  @ApiConflict(
    '`LAST_SUPER_ADMIN` — the change would leave nobody able to administer ' +
      'the system.',
  )
  @RequirePermissions('rbac.read', 'rbac.manage')
  @Put('users/:userId/roles')
  async setUserRoles(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetUserRolesDto,
    @Req() req: UserRequest,
  ) {
    const access = await this.rbac.setUserRoles(
      userId,
      dto.roleIds,
      auditActorFrom(req),
      req.user.permissions,
    );
    return { message: RoleMessages.USER_ROLES_UPDATED, data: access };
  }
}
