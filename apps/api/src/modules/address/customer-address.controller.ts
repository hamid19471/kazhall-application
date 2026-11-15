import {
  Body,
  Controller,
  Delete,
  Get,
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

import { AddressMessages } from 'src/common/constants/address.messages';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import UserRoleEnum from '../user/enums/user-role.enum';
import { Roles } from '../auth/decorators/role.decorator';
import { AddressService } from './address.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
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
 * A CUSTOMER'S OWN ADDRESS BOOK.
 *
 * WHY THIS EXISTS. `AddressController` is annotated `@Roles(superAdmin)` at the
 * class level, so before this file there was no route by which a `site`
 * (customer) user could list, edit or delete their own addresses at all — while
 * `POST /orders` happily accepted any address id they cared to name, because
 * `AddressService.findOne()` did not check ownership. The permission model was
 * therefore simultaneously too strict (no self-service) and too loose (no
 * scoping on the one path customers could reach).
 *
 * Every route here is scoped by `req.user.sub` from the verified access token.
 * There is no route parameter, query parameter or body field that can widen the
 * scope to another customer.
 *
 * Mounted at `/me/addresses` rather than as extra verbs on `/address` so that
 * "administrative, unscoped" and "self-service, scoped" are different URL
 * spaces. Blending them is how an unscoped handler eventually gets added to a
 * customer-reachable controller by accident.
 */
@Roles(UserRoleEnum.site, UserRoleEnum.sale, UserRoleEnum.superAdmin)
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('My Account')
@Controller('me/addresses')
@Audiences('storefront')
export class CustomerAddressController {
  constructor(private readonly addressService: AddressService) {}

  @ApiOperation({
    summary: 'List my saved addresses',
    description:
      'Scoped to the authenticated user. Never returns another customer’s address.',
  })
  @ApiOkResponse({
    description:
      'One page of the caller’s addresses. NOTE the double nesting: the ' +
      'paginated object is placed WHOLE under the envelope’s `data`, so the ' +
      'rows are at `data.data`. The page-count key is spelled `totalPage` here ' +
      'and `tatalPage` on the admin GET /address — both spellings are shipped.',
    schema: successEnvelopeSchema({
      data: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer', example: 3 },
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 10 },
          totalPage: { type: 'integer', example: 1 },
        },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @Get()
  async findAll(@Req() req: UserRequest, @Query() query: PaginationDto) {
    return {
      data: await this.addressService.findAllOwnedBy(req.user.sub, query),
    };
  }

  @ApiOperation({
    summary: 'Save a new address to my address book',
    description:
      'The owner is the caller, taken from the access token. No body field can ' +
      'assign the address to anybody else.',
  })
  @ApiCreatedResponse({
    description: 'Address saved to the caller’s address book.',
    schema: successEnvelopeSchema({
      message: AddressMessages.ADDRESS_CREATED,
      data: { type: 'object', description: 'The created address.' },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @ApiNotFound('The calling user id no longer exists.')
  @Post()
  async create(@Req() req: UserRequest, @Body() dto: CreateAddressDto) {
    const address = await this.addressService.create(dto, req.user.sub);
    return { message: AddressMessages.ADDRESS_CREATED, data: address };
  }

  @ApiOperation({
    summary: 'Get one of my addresses',
    description:
      'An address that exists but belongs to someone else answers 404, not 403 — ' +
      'a 403 would confirm the id is real and let anyone enumerate other ' +
      'customers’ address ids.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `addresses.id`, which must belong to the caller.',
    example: 3,
  })
  @ApiOkResponse({
    description: 'One of the caller’s own addresses.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @ApiNotFound(
    'No such address, OR it belongs to another customer — the two are ' +
      'deliberately indistinguishable.',
  )
  @Get(':id')
  async findOne(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return {
      data: await this.addressService.findOneOwnedBy(id, req.user.sub),
    };
  }

  @ApiOperation({
    summary: 'Update one of my addresses',
    description:
      'Does not alter any past order: since migration 0015 every order carries ' +
      'its own immutable `addressSnapshot`.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `addresses.id`, which must belong to the caller.',
    example: 3,
  })
  @ApiOkResponse({
    description: 'Address updated.',
    schema: successEnvelopeSchema({
      message: AddressMessages.ADDRESS_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @ApiNotFound(
    'No such address, OR it belongs to another customer (both answer 404).',
  )
  @Patch(':id')
  async update(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAddressDto,
  ) {
    const address = await this.addressService.updateOwnedBy(
      id,
      req.user.sub,
      dto,
    );
    return { message: AddressMessages.ADDRESS_UPDATED, data: address };
  }

  @ApiOperation({
    summary: 'Delete one of my addresses',
    description:
      'Past orders keep the address they were actually shipped to (order ' +
      '`addressSnapshot`), so removing an address never rewrites history.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `addresses.id`, which must belong to the caller.',
    example: 3,
  })
  @ApiOkResponse({
    description: 'Address deleted.',
    schema: successEnvelopeSchema({ message: AddressMessages.ADDRESS_DELETED }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('site, sale or super_admin')
  @ApiNotFound(
    'No such address, OR it belongs to another customer (both answer 404).',
  )
  @Delete(':id')
  async remove(@Req() req: UserRequest, @Param('id', ParseIntPipe) id: number) {
    await this.addressService.removeOwnedBy(id, req.user.sub);
    return { message: AddressMessages.ADDRESS_DELETED };
  }
}
