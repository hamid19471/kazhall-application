import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  Patch,
  ParseIntPipe,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { FindAllUsersDto } from './dto/find-all-users.dto';
import { UserMessages } from 'src/common/constants/user.messages';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiInvalidInput,
  ApiNotFound,
  ApiRoleForbidden,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';

/** STAFF accounts. `super_admin` for every route (class-level `@Roles`). */
/*
 * THE LEGACY STAFF ROUTES, now capability-gated.
 *
 * `/admin/users` is the console's surface and is the one to build against;
 * these remain because `@kazhal/api-client` and the Swagger contract already
 * name them. Each handler declares the narrowest capability it needs, so a
 * delegated role can be given the directory without the lifecycle.
 */
@RequirePermissions('users.read')
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Users Management')
@Controller('users')
@Audiences('admin')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({
    summary: 'Create a new user',
    description:
      'At least one role name is required. `POST /auth/register` is the ' +
      'variant that also rejects a username that is already taken; this route ' +
      'does not pre-check uniqueness.',
  })
  @ApiCreatedResponse({
    description: 'User created.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_CREATED,
      data: { type: 'object', description: 'The created user.' },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 when \`role\` is missing or empty, and ` +
      'when `branchId` does not exist (a 400 here, not a 404).',
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('One of the requested role names does not exist.')
  @RequirePermissions('users.read', 'users.create')
  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    const user = await this.userService.create(createUserDto);
    return { message: UserMessages.USER_CREATED, data: user };
  }

  @ApiOperation({
    summary: 'Get all users',
    description:
      'Paginated staff directory. `page`, `limit` and `role` come from ' +
      '`FindAllUsersDto` and are listed under **Parameters** below.',
  })
  @ApiOkResponse({
    description:
      'One page of users. NOTE the double nesting: the paginated object is ' +
      'placed WHOLE under the envelope’s `data`, so the rows are at ' +
      '`data.data`.',
    schema: successEnvelopeSchema({
      data: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer', example: 12 },
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 10 },
          totalPages: { type: 'integer', example: 2 },
        },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @Get()
  async findAll(@Query() findAllUsersDto: FindAllUsersDto) {
    const users = await this.userService.findAll(findAllUsersDto);
    return { data: users };
  }

  @ApiOperation({
    summary: 'Update user',
    description:
      'Sending `role` REPLACES the user’s roles with the named set. Use ' +
      '/roles/assign and /roles/remove for single-role changes.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `users.id`.',
    example: 4,
  })
  @ApiOkResponse({
    description: 'User updated.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_UPDATED,
      data: { type: 'object', description: 'The updated user.' },
    }),
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 when a non-null ` +
      '`branchId` does not exist.',
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that id, or a named role does not exist.')
  @RequirePermissions('users.read', 'users.update')
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    const user = await this.userService.update(id, dto);
    return { message: UserMessages.USER_UPDATED, data: user };
  }

  @ApiOperation({
    summary: 'Delete user',
    description:
      'A user who has sales history is soft-deactivated instead of deleted, so ' +
      'past sales keep their seller. A user with no history is deleted.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `users.id`.',
    example: 4,
  })
  @ApiOkResponse({
    description:
      'The user is gone or deactivated. `data.softDeactivated` says which ' +
      'happened, and `message` matches it.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_DELETED,
      data: {
        type: 'object',
        properties: { softDeactivated: { type: 'boolean', example: false } },
      },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that id.')
  @RequirePermissions('users.read', 'users.deactivate')
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const { softDeactivated } = await this.userService.remove(id);
    return {
      message: softDeactivated
        ? UserMessages.USER_DEACTIVATED
        : UserMessages.USER_DELETED,
      data: { softDeactivated },
    };
  }

  @ApiOperation({
    summary: 'Deactivate a user (they can no longer log in)',
    description:
      'Stops NEW logins only. Sessions already open keep working until their ' +
      'tokens expire — end them with ' +
      'POST /auth/users/{userId}/revoke-sessions.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `users.id`.',
    example: 4,
  })
  @ApiOkResponse({
    description: 'User deactivated.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_DEACTIVATED,
      data: { type: 'object', description: 'The deactivated user.' },
    }),
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. Also 400 when the user is already deactivated.`,
  )
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that id.')
  @RequirePermissions('users.read', 'users.deactivate')
  @Patch(':id/deactivate')
  async deactivate(@Param('id', ParseIntPipe) id: number) {
    const user = await this.userService.deactivate(id);
    return { message: UserMessages.USER_DEACTIVATED, data: user };
  }

  @ApiOperation({
    summary: 'Reactivate a previously deactivated user',
    description:
      'Idempotent, unlike /deactivate: reactivating an already-active user is ' +
      'a silent no-op rather than a 400.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `users.id`.',
    example: 4,
  })
  @ApiOkResponse({
    description: 'User reactivated.',
    schema: successEnvelopeSchema({
      message: UserMessages.USER_REACTIVATED,
      data: { type: 'object', description: 'The reactivated user.' },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No user has that id.')
  @RequirePermissions('users.read', 'users.activate')
  @Patch(':id/activate')
  async reactivate(@Param('id', ParseIntPipe) id: number) {
    const user = await this.userService.reactivate(id);
    return { message: UserMessages.USER_REACTIVATED, data: user };
  }
}
