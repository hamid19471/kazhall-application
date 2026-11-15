import {
  Controller,
  Post,
  Body,
  Param,
  Delete,
  Get,
  ParseIntPipe,
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
import { ACCESS_TOKEN_SECURITY_SCHEME } from 'src/configs/swagger.config';
import { AddRoleToUserDto } from '../dto/add-role-to-user.dto';
import { RoleService } from '../services/role.service';
import { RequirePermissions } from '../permissions/permission.decorator';
import { RoleMessages } from 'src/common/constants/role.messages';
import {
  ApiAuthRequired,
  ApiConflict,
  ApiInvalidInput,
  ApiNotFound,
  ApiRoleForbidden,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { auditActorFrom } from 'src/modules/audit/audit-actor';

/**
 * ===========================================================================
 * THE ROLE MODEL IS FIXED  —  `super_admin`, `sale`, `site`
 * ===========================================================================
 *
 * `super_admin` for every route here.
 *
 * WHY THERE IS NO `POST /roles` ANY MORE. There was one, and it was
 * unreachable by construction: `CreateRoleDto.name` carried
 * `@IsEnum(UserRoleEnum)`, so the ONLY names it accepted were the three
 * built-ins — and the seeder creates all three on bootstrap. Every possible
 * request therefore answered **400 `This role already exists`**. It was not a
 * feature with a bug in it; it was a documented capability that could not
 * succeed even once.
 *
 * It also contradicted the route below it. `DELETE /roles/:id` refuses those
 * same three names with **409 `ROLE_BUILTIN_PROTECTED`**, because the guards
 * are written against `UserRoleEnum` and deleting a `roles` row cascades
 * through `user_roles`. So the API simultaneously advertised "you may invent
 * roles" and "the only roles that exist are structural and untouchable". A
 * client cannot implement both.
 *
 * WHAT REPLACED IT: nothing. Authorization in this application is a fixed,
 * three-value vocabulary that the guards, the seeder, `UserRoleEnum` and
 * `BUILT_IN_ROLE_NAMES` all already agree on. A name in the catalogue grants
 * NOTHING on its own — no route consults it — so an endpoint for inventing
 * names could only ever produce rows that authorise nothing. Adding a role is a
 * code change (a guard has to refer to it), not an API call.
 *
 * `DELETE /roles/:id` IS DELIBERATELY KEPT, with every one of its safety
 * guarantees intact: built-ins undeletable, in-use roles undeletable, both
 * enforced inside one transaction holding a row lock. It is the only way to
 * remove a `roles` row that predates this change or was inserted out of band
 * (directly in SQL, by a fixture, by a future migration), and against the
 * shipped catalogue it can now only ever answer 409 or 404 — which is exactly
 * the point: the refusal is the contract.
 *
 * WHAT A FRONTEND MUST DO: drop any "create role" affordance. The role picker
 * is a fixed list of three values, obtainable from `GET /roles`.
 */
@ApiTags('Roles')
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@RequirePermissions('rbac.read')
@Controller('roles')
@Audiences('admin')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({
    summary: 'Get all roles',
    description:
      'The whole catalogue. **It is a FIXED list of three: `super_admin`, ' +
      '`sale`, `site`.** There is no endpoint that adds to it — a role name ' +
      'grants nothing on its own, because the guards are written against ' +
      '`UserRoleEnum`, so adding one is a code change rather than an API ' +
      'call. Use this to populate a role picker; do not offer a "new role" ' +
      'control.',
  })
  @ApiOkResponse({
    description: 'Every role in the catalogue.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
    }),
  })
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  async getAllRoles() {
    const roles = await this.roleService.getAllRoles();
    return { data: roles };
  }

  @RequirePermissions('rbac.read', 'rbac.manage')
  @Post('assign')
  @ApiOperation({
    summary: 'Assign role to user',
    description:
      'ADDS one role, leaving the user’s other roles alone — unlike ' +
      'PATCH /users/{id}, whose `role` field replaces the whole set.',
  })
  @ApiCreatedResponse({
    description: 'Role assigned.',
    schema: successEnvelopeSchema({ message: RoleMessages.ROLE_ASSIGNED }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 when the user already holds that role.`,
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that `userId`, or no role has that `roleId`.')
  async addRoleToUser(
    @Body() addRoleToUserDto: AddRoleToUserDto,
    @Req() req: UserRequest,
  ) {
    await this.roleService.addRoleToUser(
      addRoleToUserDto.userId,
      addRoleToUserDto.roleId,
      auditActorFrom(req),
    );
    return { message: RoleMessages.ROLE_ASSIGNED };
  }

  @RequirePermissions('rbac.read', 'rbac.manage')
  @Delete('remove')
  @ApiOperation({
    summary: 'Remove role from user',
    description:
      'Takes `userId` and `roleId` in the REQUEST BODY, not in the path — a ' +
      'DELETE with a body, so a client that strips bodies from DELETE ' +
      'requests will fail validation here.',
  })
  @ApiOkResponse({
    description: 'Role removed from the user.',
    schema: successEnvelopeSchema({ message: RoleMessages.ROLE_REMOVED }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 when the user does not hold that role.`,
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that `userId`, or no role has that `roleId`.')
  @ApiConflict(
    '`error: "LAST_SUPER_ADMIN"` — refused because this user is the last one ' +
      'holding `super_admin` (or the last one who can still log in while ' +
      'holding it), so the removal would leave the system with no ' +
      'administrator and no route able to restore one. `details` carries ' +
      '`{ roleName, userId }`.',
  )
  async removeRoleFromUser(
    @Body() addRoleToUserDto: AddRoleToUserDto,
    @Req() req: UserRequest,
  ) {
    await this.roleService.removeRoleFromUser(
      addRoleToUserDto.userId,
      addRoleToUserDto.roleId,
      auditActorFrom(req),
    );

    return { message: RoleMessages.ROLE_REMOVED };
  }

  @Get('users/:userId')
  @ApiOperation({
    summary: 'Get user roles',
    description: 'Every role currently held by one user.',
  })
  @ApiParam({
    name: 'userId',
    type: Number,
    description: 'Numeric `users.id`.',
    example: 4,
  })
  @ApiOkResponse({
    description: 'The roles that user holds.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that id.')
  async getUserRoles(@Param('userId', ParseIntPipe) userId: number) {
    const roles = await this.roleService.getUserRoles(userId);
    return { data: roles };
  }

  @RequirePermissions('rbac.read', 'rbac.manage')
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete role (built-ins are always refused)',
    description:
      'Removes a name from the role CATALOGUE. The id is a `roles.id`, not a ' +
      'user id.\n\n' +
      '**THE ROLE MODEL IS FIXED at `super_admin`, `sale` and `site`, and ' +
      'there is no endpoint that creates a role.** Against the shipped ' +
      'catalogue this route can therefore only ever answer **409 ' +
      '`ROLE_BUILTIN_PROTECTED`** or **404**. It exists to remove a `roles` ' +
      'row that predates that decision or was inserted out of band (directly ' +
      'in SQL, by a fixture, by a migration) — not to edit the vocabulary the ' +
      'guards are written against.\n\n' +
      'Two server-side refusals, both 409, both enforced inside one ' +
      'transaction holding a row lock on the role — do not rely on hiding the ' +
      'button. `user_roles."rolesId"` is `ON DELETE CASCADE`, so an ' +
      'unprotected delete would silently strip the role from every user who ' +
      'held it.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `roles.id`.',
    example: 3,
  })
  @ApiOkResponse({
    description: 'Role deleted from the catalogue.',
    schema: successEnvelopeSchema({ message: RoleMessages.ROLE_DELETED }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound(
    'No role has that id — including the case where a concurrent request ' +
      'deleted it first, so racing clients see one 200 and one 404.',
  )
  @ApiConflict(
    '`error: "ROLE_BUILTIN_PROTECTED"` — `super_admin`, `sale` and `site` are ' +
      'the names the guards are written against and are never deletable; ' +
      '`details` carries `{ roleName }`. Or `error: "ROLE_IN_USE"` — the role ' +
      'is still assigned to at least one user; `details` carries ' +
      '`{ roleName, assignedUserCount }`. Branch on `error`, never on ' +
      '`message`.',
  )
  async removeRole(
    @Param('id', ParseIntPipe) roleId: number,
    @Req() req: UserRequest,
  ) {
    await this.roleService.removeRole(roleId, auditActorFrom(req));

    return { message: RoleMessages.ROLE_DELETED };
  }
}
