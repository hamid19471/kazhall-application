import {
  Controller,
  Post,
  Body,
  Param,
  Delete,
  Req,
  ParseIntPipe,
  Get,
  Patch,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { CartMessages } from 'src/common/constants/cart.messages';
import { CartService } from './cart.service';
import { CreateCartItemDto } from './dto/create-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiInvalidInput,
  ApiNotFound,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';

/**
 * Every route is scoped to the caller from the verified access token. There is
 * no `@Roles` here — any authenticated user has a basket — so these routes can
 * answer 401 but never 403.
 *
 * A basket line the caller does not own is reported as 404, not 403, so line
 * ids cannot be enumerated.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Cart Management')
@Controller('cart')
@Audiences('storefront')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @ApiOperation({
    summary: 'Add product to basket (reserves stock for 4 hours)',
    description:
      'The reservation is real: it decrements what other baskets may take and ' +
      'expires four hours after it is made. `variantId` may be omitted only ' +
      'for a product that is not sold by option.',
  })
  @ApiCreatedResponse({
    description: 'Line added (or merged into an existing line) and reserved.',
    schema: successEnvelopeSchema({
      message: CartMessages.CART_ITEM_ADDED,
      data: { type: 'object', description: 'The resulting basket line.' },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 for a non-positive quantity, a product ` +
      'with no active variant, a missing `variantId` on a product sold by ' +
      'option, a variant that is retired or belongs to another product, and ' +
      'for insufficient stock (`Not enough stock: requested N, available M`).',
  )
  @ApiAuthRequired()
  @ApiNotFound('No product has that id, or the variant row has disappeared.')
  @Post()
  async create(
    @Req() req: UserRequest,
    @Body() createCartItemDto: CreateCartItemDto,
  ) {
    const userId = req.user.sub;
    const cart = await this.cartService.create(createCartItemDto, userId);
    return { message: CartMessages.CART_ITEM_ADDED, data: cart };
  }

  /**
   * Server-authoritative basket read.
   *
   * This is the recovery path for a missed realtime event: it lazily expires
   * due reservations, returns the true reserved/available quantities and
   * `expiresAt`, and explains any line that a POS sale or an expiry changed.
   */
  @ApiOperation({
    summary: 'Get current cart (server-authoritative)',
    description:
      'Lazily expires due reservations before answering, so this is the ' +
      'recovery path after a missed realtime event. `notices` explains every ' +
      'line an expiry or an in-store sale changed since the client last looked.',
  })
  @ApiOkResponse({
    description: 'The caller’s basket plus any change notices.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: { type: 'object' },
        description: 'The ACTIVE basket lines.',
      },
      properties: {
        notices: {
          type: 'array',
          items: { type: 'object' },
          description:
            'One entry per line whose quantity or availability changed since ' +
            'the client last read the basket. Spread at the TOP level next to ' +
            '`data`, not inside it.',
        },
      },
    }),
  })
  @ApiAuthRequired()
  @ApiNotFound('A variant referenced by a basket line no longer exists.')
  @Get()
  async findAll(@Req() req: UserRequest) {
    const userId = req.user.sub;
    const { items, notices } = await this.cartService.findAll(userId);
    return { data: items, notices };
  }

  @ApiOperation({
    summary: 'Set the absolute quantity of a basket line',
    description:
      'ABSOLUTE, not a delta. `quantity: 0` removes the line and answers with ' +
      '`data: null`, so the response `message` tells the two outcomes apart.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `cart_items.id` — the basket LINE, not a product id.',
    example: 31,
  })
  @ApiOkResponse({
    description: 'Line updated, or removed when `quantity` was 0.',
    schema: successEnvelopeSchema({
      message: CartMessages.CART_ITEM_UPDATED,
      data: {
        type: 'object',
        nullable: true,
        description: 'The updated line, or null when the line was removed.',
      },
    }),
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 for a negative ` +
      'quantity and when an increase exceeds availability.',
  )
  @ApiAuthRequired()
  @ApiNotFound(
    'No ACTIVE basket line with that id belongs to the caller. Another ' +
      'customer’s line is reported as 404 rather than 403 on purpose.',
  )
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: UserRequest,
    @Body() dto: UpdateCartItemDto,
  ) {
    const userId = req.user.sub;
    const line = await this.cartService.updateQuantity(
      id,
      dto.quantity,
      userId,
    );
    return {
      message: line
        ? CartMessages.CART_ITEM_UPDATED
        : CartMessages.CART_ITEM_REMOVED,
      data: line,
    };
  }

  @ApiOperation({
    summary: 'Remove product from basket',
    description:
      'Releases the line’s reservation. NOT idempotent: deleting the same line ' +
      'twice answers 404 the second time.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `cart_items.id` — the basket LINE, not a product id.',
    example: 31,
  })
  @ApiOkResponse({
    description: 'Line removed and its reservation released.',
    schema: successEnvelopeSchema({ message: CartMessages.CART_ITEM_REMOVED }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiNotFound(
    'No ACTIVE basket line with that id belongs to the caller (404, not 403).',
  )
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: UserRequest) {
    const userId = req.user.sub;
    await this.cartService.remove(id, userId);
    return { message: CartMessages.CART_ITEM_REMOVED };
  }
}
