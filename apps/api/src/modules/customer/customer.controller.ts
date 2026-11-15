import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { CustomerService } from './customer.service';

import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PaginationDto } from 'src/common/dto/pagination.dto';
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

/**
 * Admin customer directory. `super_admin` for both routes (class-level
 * `@Roles`) — the controller carried no `@ApiTags` and no security annotation
 * at all, so both routes previously read as ungrouped and unauthenticated.
 *
 * A customer reading their OWN data uses the `/me/*` routes.
 */
/*
 * Gated on `users.read`, and that reuse is deliberate rather than lazy.
 *
 * `customers` is a separate table from `users` — a walk-in POS buyer gets a
 * customer row and no account — but from a delegation point of view both are
 * the same authority: "may see who our customers are, including their
 * telephone numbers". Minting a `customers.read` code that always travels
 * with `users.read` would be a distinction the owner has to maintain without
 * ever using.
 */
@RequirePermissions('users.read')
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Customers')
@Controller('customer')
@Audiences('admin')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @ApiOperation({
    summary: 'Get all customers',
    description:
      'Paginated. `page` and `limit` come from `PaginationDto` and are listed ' +
      'under **Parameters** below.',
  })
  @ApiOkResponse({
    description:
      'One page of customers. This handler returns the paginated object ' +
      'DIRECTLY, so `data` holds the rows and `total` / `page` / `limit` / ' +
      '`totalPages` sit beside it at the top level of the envelope.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        total: { type: 'integer', example: 340 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 10 },
        totalPages: { type: 'integer', example: 34 },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @Get()
  async findAll(@Query() query: PaginationDto) {
    return await this.customerService.findAll(query);
  }

  @ApiOperation({
    summary: 'Get one customer by id',
    description:
      'The id is a `customers.id`, which is NOT the same as the `users.id` ' +
      'the /users routes take.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `customers.id`.',
    example: 8,
  })
  @ApiOkResponse({
    description: 'The customer.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No customer has that id.')
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const customer = await this.customerService.findOne(id);
    return { data: customer };
  }
}
