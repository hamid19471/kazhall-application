import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { PaginationDto } from 'src/common/dto/pagination.dto';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import UserRoleEnum from '../user/enums/user-role.enum';
import { Roles } from '../auth/decorators/role.decorator';
import { OrdersService } from './orders.service';
import {
  CustomerOrderAddressSnapshotView,
  CustomerOrderItemView,
  CustomerOrderListView,
  CustomerOrderView,
} from './dto/customer-order.view';
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

/**
 * A CUSTOMER'S OWN ORDERS.
 *
 * WHY THIS EXISTS. Every read on `OrdersController` is `@Roles(superAdmin,
 * sale)` and scoped by BRANCH — the staff view. A `site` user could place an
 * order and then had no route by which to look at it, while the branch-scoped
 * handlers were the only order reads in the system. Adding customer access to
 * those handlers would have meant a scoping rule that switches on the caller's
 * role inside a shared method, which is exactly the shape that eventually
 * leaks: one early `return` for super-admins and the branch check never runs.
 *
 * Instead the customer view is its own controller, its own URL space and its
 * own service methods, all of which take the owner as a mandatory argument.
 * Another customer's order is answered 404, not 403, so order ids (which are
 * sequential) cannot be enumerated.
 *
 * BOTH ROUTES RETURN A BOUNDED PROJECTION, never the `Order` entity. See the
 * header of `dto/customer-order.view.ts`: the mapping is an allow-list, so a
 * column added to `orders` by a future migration cannot appear here by
 * accident. It used to be the entity, which is how `fulfillmentLastError` — a
 * raw internal failure string — and the fulfilment retry queue became part of
 * the customer contract.
 */
@Roles(UserRoleEnum.site, UserRoleEnum.sale, UserRoleEnum.superAdmin)
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('My Account')
@ApiExtraModels(
  CustomerOrderListView,
  CustomerOrderView,
  CustomerOrderItemView,
  CustomerOrderAddressSnapshotView,
)
@Controller('me/orders')
@Audiences('storefront')
export class CustomerOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @ApiOperation({
    summary: 'List my orders',
    description:
      'Scoped to the authenticated user by `orders."userId"`. In-store (POS) ' +
      'sales are not included unless they were placed against this account.\n\n' +
      'Rows are `CustomerOrderView`, the same shape `GET /me/orders/:id` ' +
      'returns, so one piece of client code renders an order from either ' +
      'route. Line items come from the IMMUTABLE `order_items` snapshots, so a ' +
      'later price change or product rename never rewrites a past order.',
  })
  @ApiOkResponse({
    description:
      'One page of the caller’s own orders, newest first. NOTE the double ' +
      'nesting: the paginated object is placed WHOLE under the envelope’s ' +
      '`data`, so the rows are at `data.data`.',
    schema: successEnvelopeSchema({
      data: { $ref: getSchemaPath(CustomerOrderListView) },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @Get()
  async findAll(@Req() req: UserRequest, @Query() query: PaginationDto) {
    return {
      data: await this.ordersService.findAllForUser(
        req.user.sub,
        query.page ?? 1,
        query.limit ?? 20,
      ),
    };
  }

  @ApiOperation({
    summary: 'Get one of my orders',
    description:
      'Includes the immutable `addressSnapshot` — where the goods were actually ' +
      'sent, which does not change if the customer later edits or deletes that ' +
      'saved address. Another customer’s order answers 404.\n\n' +
      'The live `addresses` row is deliberately NOT returned, and neither is ' +
      'any fulfilment retry bookkeeping, staff attribution or branch ' +
      'attribution.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id`, which must belong to the caller.',
    example: 41,
  })
  @ApiOkResponse({
    description: 'One of the caller’s own orders, with its line items.',
    schema: successEnvelopeSchema({
      data: { $ref: getSchemaPath(CustomerOrderView) },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @ApiNotFound(
    'No such order, OR it belongs to another customer — deliberately ' +
      'indistinguishable, because order ids are sequential.',
  )
  @Get(':id')
  async findOne(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return {
      data: await this.ordersService.findOneForUser(id, req.user.sub),
    };
  }
}
