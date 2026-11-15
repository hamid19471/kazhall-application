import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
  ParseIntPipe,
} from '@nestjs/common';
import { AddressService } from './address.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { AddressMessages } from 'src/common/constants/address.messages';
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
 * ADMIN, UNSCOPED address administration. `super_admin` for every route.
 *
 * A customer managing their OWN address book uses `/me/addresses`, which is
 * scoped to the access token and cannot reach another customer's rows.
 */
/*
 * Gated on `users.read` for the same reason `/customer` is: this is the
 * ADMIN directory of customer addresses — postal codes and receiver phone
 * numbers — which is customer-identity data, not a catalogue. Customers reach
 * their own addresses through `/me/addresses`, which is unchanged.
 */
@RequirePermissions('users.read')
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Addresses Management')
@Controller('address')
@Audiences('admin')
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @ApiOperation({
    summary: 'Create new address',
    description:
      'The owner is the CALLING admin (taken from the access token), not a ' +
      'user named in the body.',
  })
  @ApiCreatedResponse({
    description: 'Address created.',
    schema: successEnvelopeSchema({
      message: AddressMessages.ADDRESS_CREATED,
      data: { type: 'object', description: 'The created address.' },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('The calling user id no longer exists.')
  @Post()
  async create(
    @Req() req: UserRequest,
    @Body() createAddressDto: CreateAddressDto,
  ) {
    const userId = req.user.sub;
    const address = await this.addressService.create(createAddressDto, userId);
    return { message: AddressMessages.ADDRESS_CREATED, data: address };
  }

  @ApiOperation({
    summary: 'Get all addresses (every customer’s)',
    description:
      'Unscoped: this is the administrative list, not the caller’s own ' +
      'addresses. `page` and `limit` come from `PaginationDto`.',
  })
  @ApiOkResponse({
    description:
      'One page of addresses. NOTE the double nesting: the paginated object is ' +
      'placed WHOLE under the envelope’s `data`, so the rows are at ' +
      '`data.data`. The page-count key is spelled `tatalPage` on this route ' +
      '(`totalPage` on GET /me/addresses) — both spellings are shipped.',
    schema: successEnvelopeSchema({
      data: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer', example: 120 },
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 10 },
          tatalPage: { type: 'integer', example: 12 },
        },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @Get()
  async findAll(@Query() query: PaginationDto) {
    const addresses = await this.addressService.findAll(query);
    return { data: addresses };
  }

  @ApiOperation({
    summary: 'Get one address by id',
    description: 'Unscoped: any address, whoever owns it.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `addresses.id`.',
    example: 3,
  })
  @ApiOkResponse({
    description: 'The address.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No address has that id.')
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const address = await this.addressService.findOne(id);
    return { data: address };
  }

  @ApiOperation({
    summary: 'Update one address by id',
    description:
      'Does not alter any past order: every order carries its own immutable ' +
      '`addressSnapshot`.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `addresses.id`.',
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
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No address has that id.')
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateAddressDto: UpdateAddressDto,
  ) {
    const address = await this.addressService.update(id, updateAddressDto);
    return { message: AddressMessages.ADDRESS_UPDATED, data: address };
  }

  @ApiOperation({
    summary: 'Delete one address by id',
    description:
      'Past orders keep the address they were actually shipped to, so this ' +
      'never rewrites history.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `addresses.id`.',
    example: 3,
  })
  @ApiOkResponse({
    description: 'Address deleted.',
    schema: successEnvelopeSchema({
      message: AddressMessages.ADDRESS_DELETED,
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiRoleForbidden('super_admin')
  @ApiNotFound('No address has that id.')
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.addressService.remove(id);
    return { message: AddressMessages.ADDRESS_DELETED };
  }
}
