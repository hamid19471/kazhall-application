import {
  Body,
  Controller,
  Delete,
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
import { BranchService } from './branch.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { BranchQueryDto } from './dto/branch-query.dto';
import { SetBranchActiveDto } from './dto/set-branch-active.dto';
import {
  ConsultsPermissions,
  RequirePermissions,
} from '../auth/permissions/permission.decorator';
import { assertPermission } from '../auth/permissions/assert-permission';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
import { BranchMessages } from 'src/common/constants/branch.messages';
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
 * Store / branch directory and lifecycle.
 *
 * WHAT CHANGED, AND WHY. Every route used to be gated on the `super_admin`
 * ROLE, which meant the owner could not let a regional manager rename a shop
 * without also handing them the ability to void paid sales. They are now gated
 * on `branches.*` capabilities, which is the whole point of the permission
 * model.
 *
 * `DELETE` is no longer a hard delete against a table two foreign keys point
 * at. It refuses with 409 `BRANCH_IN_USE` the moment any staff member or any
 * order references the branch — which, for a branch that has ever traded, is
 * always. Retiring a branch is `PATCH /branch/:id/active`, which keeps every
 * row and every `branchNameSnapshot` intact and is reversible.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Branches')
@Controller('branch')
@Audiences('admin')
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  @RequirePermissions('branches.create')
  @ApiOperation({
    summary: 'Create a branch',
    description: 'Branch names are unique; a duplicate is refused with 409.',
  })
  @ApiCreatedResponse({
    description: 'The created branch.',
    schema: successEnvelopeSchema({
      message: BranchMessages.BRANCH_CREATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('branches.create')
  @ApiConflict('`BRANCH_NAME_TAKEN` — that name is already in use.')
  @Post()
  async create(@Body() dto: CreateBranchDto, @Req() req: UserRequest) {
    const branch = await this.branchService.create(dto, auditActorFrom(req));
    return { message: BranchMessages.BRANCH_CREATED, data: branch };
  }

  @RequirePermissions('branches.read')
  @ApiOperation({
    summary: 'List branches, with staff and order counts',
    description:
      'Paginated and filterable. `activeStaffCount`, `orderCount` and ' +
      '`openOrderCount` come from correlated sub-selects in the SAME query, ' +
      'never one round trip per branch.',
  })
  @ApiOkResponse({
    description: 'One page of branches.',
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
  @ApiPermissionForbidden('branches.read')
  @Get()
  list(@Query() query: BranchQueryDto) {
    return this.branchService.list(query);
  }

  /**
   * DECLARED BEFORE `:id`, and that ordering is load-bearing: Nest matches
   * routes in declaration order, so with `@Get(':id')` first this path would
   * reach it as `id = "mine"` and `ParseIntPipe` would answer 400.
   */
  @Audiences('admin', 'pos')
  @ApiOperation({
    summary: 'The branch the CALLER is assigned to',
    description:
      'Reachable from the till as well as the console, and deliberately ' +
      'permission-free: it discloses nothing the caller does not already ' +
      'have — `branchId` is on their own session — and it exists so the POS ' +
      'header can print the shop’s NAME instead of falling back to its ' +
      'number after a failed authenticated request. Answers `data: null` for ' +
      'a principal with no branch (a branchless administrator), never a 404.',
  })
  @ApiOkResponse({
    description: 'The caller’s branch, or null.',
    schema: successEnvelopeSchema({ data: { type: 'object', nullable: true } }),
  })
  @ApiAuthRequired()
  @Get('mine')
  async mine(@Req() req: UserRequest) {
    if (req.user.branch === null) return { data: null };
    const branch = await this.branchService.findOne(req.user.branch);
    return {
      data: {
        id: branch.id,
        name: branch.name,
        address: branch.address ?? null,
        phone: branch.phone ?? null,
        isActive: branch.isActive !== false,
      },
    };
  }

  @RequirePermissions('branches.read')
  @ApiOperation({
    summary: 'One branch, with the staff assigned to it',
    description:
      'Staff are capped at 200 rows. `openOrderCount` is what a manager ' +
      'should look at before retiring a branch — deactivation is still ' +
      'allowed with open orders, because it only stops NEW sales.',
  })
  @ApiParam({ name: 'id', type: Number, example: 2 })
  @ApiOkResponse({
    description: 'The branch.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('branches.read')
  @ApiNotFound('No branch has that id.')
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.branchService.detail(id) };
  }

  @RequirePermissions('branches.update')
  @ApiOperation({
    summary: 'Update a branch',
    description:
      'Renaming does NOT rewrite history: orders keep the ' +
      '`branchNameSnapshot` taken when they were sold.',
  })
  @ApiParam({ name: 'id', type: Number, example: 2 })
  @ApiOkResponse({
    description: 'The updated branch.',
    schema: successEnvelopeSchema({
      message: BranchMessages.BRANCH_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('branches.update')
  @ApiNotFound('No branch has that id.')
  @ApiConflict('`BRANCH_NAME_TAKEN`.')
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBranchDto,
    @Req() req: UserRequest,
  ) {
    const branch = await this.branchService.update(
      id,
      dto,
      auditActorFrom(req),
    );
    return { message: BranchMessages.BRANCH_UPDATED, data: branch };
  }

  /**
   * Two permissions on one route, chosen by the body.
   *
   * `branches.activate` and `branches.deactivate` are separate capabilities —
   * reopening a shop and closing one are not the same authority — so the
   * handler resolves which is required rather than declaring one for both. The
   * declaration is still server-side and still explicit; it is simply a
   * conditional guard instead of a static one, which is why it is written out
   * here rather than hidden in a decorator.
   */
  @RequirePermissions('branches.read')
  @ApiOperation({
    summary: 'Activate or deactivate a branch',
    description:
      'Deactivating stops NEW sales from this branch: a cashier assigned to ' +
      'it is refused at `POST /orders/pos` with 409 `BRANCH_INACTIVE`. Staff ' +
      'are NOT moved and past orders are untouched. Requires ' +
      '`branches.activate` or `branches.deactivate` depending on the value ' +
      'sent.',
  })
  @ApiParam({ name: 'id', type: Number, example: 2 })
  @ApiOkResponse({
    description: 'The branch, with its staff and counts.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('branches.activate / branches.deactivate')
  @ApiNotFound('No branch has that id.')
  @HttpCode(200)
  @Patch(':id/active')
  // Decided in the handler from `dto.isActive`, so a decorator cannot state
  // it. Declared here so the capability-coverage spec can see it in the
  // container instead of inferring it from source text.
  @ConsultsPermissions('branches.activate', 'branches.deactivate')
  async setActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetBranchActiveDto,
    @Req() req: UserRequest,
  ) {
    assertPermission(
      req,
      dto.isActive ? 'branches.activate' : 'branches.deactivate',
    );
    const branch = await this.branchService.setActive(
      id,
      dto.isActive,
      auditActorFrom(req),
    );
    return {
      message: dto.isActive
        ? BranchMessages.BRANCH_ACTIVATED
        : BranchMessages.BRANCH_DEACTIVATED,
      data: branch,
    };
  }

  @RequirePermissions('branches.deactivate')
  @ApiOperation({
    summary: 'Delete a branch that nothing references',
    description:
      'Refuses with 409 `BRANCH_IN_USE` as soon as any staff member or any ' +
      'order points at the branch — which, for one that has ever traded, is ' +
      'always. This exists to remove a branch created by mistake. To retire a ' +
      'real branch use `PATCH /branch/{id}/active`.',
  })
  @ApiParam({ name: 'id', type: Number, example: 2 })
  @ApiOkResponse({
    description: 'The branch is gone.',
    schema: successEnvelopeSchema({ message: BranchMessages.BRANCH_DELETED }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('branches.deactivate')
  @ApiNotFound('No branch has that id.')
  @ApiConflict(
    '`BRANCH_IN_USE` — `details` carries `staffCount` and `orderCount`.',
  )
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: UserRequest) {
    await this.branchService.remove(id, auditActorFrom(req));
    return { message: BranchMessages.BRANCH_DELETED };
  }
}
