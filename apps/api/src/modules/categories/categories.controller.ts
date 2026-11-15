import {
  Controller,
  Get,
  Post,
  Body,
  Delete,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { QueryCategoriesDto } from './dto/query-categories.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CategoryMessages } from 'src/common/constants/categories.messages';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/permissions/permission.decorator';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import { auditActorFrom } from 'src/modules/audit/audit-actor';
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
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';

/**
 * Auth is annotated PER HANDLER: `GET /categories` is `@Public()`, so a
 * class-level `@ApiCookieAuth` would put a lock icon on a route that needs no
 * cookie.
 *
 * ---------------------------------------------------------------------------
 * `DELETE /categories/removeOnlyCategory/:id` HAS BEEN REMOVED.
 *
 * It detached every product from the category and then deleted it, and
 * answered 200. That is data loss wearing a delete's clothes: the
 * `product_category` rows it dropped are the catalogue's navigation structure,
 * nothing records what was removed, and no admin can reconstruct which of 544
 * products used to be in "Mobile". The refusal below (`DELETE /categories/:id`,
 * 409 `CATEGORY_IN_USE` with the count) is the honest version of the same
 * intent: to delete a category you first move its products out, deliberately,
 * through the product endpoints that own membership.
 * ---------------------------------------------------------------------------
 */
@ApiTags('Product Categories')
@Controller('categories')
@Audiences('admin')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('categories.create')
  @ApiOperation({
    summary: 'Create new category',
    description:
      'Titles are unique GLOBALLY, and the rule is enforced by a UNIQUE INDEX ' +
      '(`uq_categories_title_norm`, migration 0025) — not only by the ' +
      'service. Two simultaneous creates of the same title therefore end as ' +
      'exactly one 201 and one 409.\n\n' +
      'Comparison is NORMALISED: leading/trailing blanks are trimmed, case is ' +
      'ignored, and the Arabic/Persian look-alikes are folded — ' +
      '`ك`/`ک` and `ي`/`ی`, so «کیف» and «كيف» are the SAME title. A ' +
      'whitespace-only title is a 400.',
  })
  @ApiCreatedResponse({
    description: 'Category created.',
    schema: successEnvelopeSchema({
      message: CategoryMessages.CATEGORY_CREATED,
      data: { type: 'object', description: 'The created category.' },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('categories.create')
  @ApiConflict(
    '`error: "CATEGORY_TITLE_TAKEN"` — another category already has this ' +
      'title (compared normalised: trimmed, case-insensitive, ك/ک and ي/ی ' +
      'folded). `details` carries `{ title }`. Raised by the service pre-check ' +
      'and, when two creates race, by the unique index — same code, same ' +
      'message either way.',
  )
  @Post()
  async create(
    @Req() req: UserRequest,
    @Body() createCategoryDto: CreateCategoryDto,
  ) {
    const category = await this.categoriesService.create(
      createCategoryDto,
      auditActorFrom(req),
    );
    return { message: CategoryMessages.CATEGORY_CREATED, data: category };
  }

  // PUBLIC: an anonymous storefront must be able to render the category nav.
  // Returns id/title/productCount only -- never the products themselves.
  @Public()
  @ApiOperation({
    summary: 'Get all categories (public)',
    description:
      'No cookie required. Returns { id, title, productCount }. Use ' +
      'GET /products?categoryId=<id> for the (paginated) products of a category.',
  })
  @ApiOkResponse({
    description: 'Every category with its product count.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            title: { type: 'string', example: 'Mobile' },
            productCount: { type: 'integer', example: 42 },
          },
        },
      },
    }),
  })
  @Get()
  async findAll() {
    const categories = await this.categoriesService.findAll();
    return { data: categories };
  }

  /**
   * Declared BEFORE `:id`-shaped routes would be, and kept distinct from the
   * public list rather than adding parameters to it: the storefront list is
   * cached for an hour and an admin must never be shown their own write
   * missing.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('categories.read')
  @ApiOperation({
    summary: 'Get categories (admin, paginated)',
    description:
      'Paginated and searchable (`search` is a case-insensitive substring of ' +
      'the title). Ordered by title, with the id as tiebreaker so the page ' +
      'boundary stays deterministic. Never served from cache.',
  })
  @ApiOkResponse({
    description:
      'One page of categories. The pagination keys are spread at the TOP ' +
      'level of the envelope, beside `data`.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            title: { type: 'string', example: 'Mobile' },
            productCount: { type: 'integer', example: 42 },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      properties: {
        total: { type: 'integer', example: 17 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 10 },
        totalPages: { type: 'integer', example: 2 },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('categories.read')
  @Get('admin')
  async findAllAdmin(@Query() query: QueryCategoriesDto) {
    return this.categoriesService.findAllAdmin(query);
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('categories.update')
  @ApiOperation({
    summary: 'Rename a category',
    description:
      'Title only. Which products are IN the category is owned by the product ' +
      'endpoints (`categoryIds` on product create/update is the complete ' +
      'desired set), so membership cannot be edited from here.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `categories.id`.',
    example: 1,
  })
  @ApiOkResponse({
    description: 'Category renamed.',
    schema: successEnvelopeSchema({
      message: CategoryMessages.CATEGORY_UPDATED,
      data: { type: 'object', description: 'The updated category.' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('categories.update')
  @ApiNotFound('No category has that id.')
  @ApiConflict(
    '`error: "CATEGORY_TITLE_TAKEN"` — another category already has the new ' +
      'title (compared normalised: trimmed, case-insensitive, ك/ک and ي/ی ' +
      'folded). Backed by the same unique index as create, so two concurrent ' +
      'renames onto one title also end as one 200 and one 409.',
  )
  @Patch(':id')
  async update(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ) {
    const category = await this.categoriesService.rename(
      id,
      updateCategoryDto.title,
      auditActorFrom(req),
    );
    return { message: CategoryMessages.CATEGORY_UPDATED, data: category };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('categories.delete')
  @ApiOperation({
    summary: 'Delete an EMPTY category',
    description:
      'Refused with **409 `CATEGORY_IN_USE`** while any product is still in ' +
      'the category; `details.productCount` says how many. Move the products ' +
      'out first — this endpoint never detaches them for you, because the ' +
      'membership it would drop is not recorded anywhere and cannot be ' +
      'reconstructed.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `categories.id`.',
    example: 1,
  })
  @ApiOkResponse({
    description: 'Category deleted.',
    schema: successEnvelopeSchema({
      message: CategoryMessages.CATEGORY_DELETED,
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('categories.delete')
  @ApiNotFound('No category has that id.')
  @ApiConflict(
    '`error: "CATEGORY_IN_USE"` — products are still attached. `details` ' +
      'carries `{ categoryId, productCount }`.',
  )
  @Delete(':id')
  async remove(@Req() req: UserRequest, @Param('id', ParseIntPipe) id: number) {
    await this.categoriesService.safeRemove(id, auditActorFrom(req));
    return { message: CategoryMessages.CATEGORY_DELETED };
  }
}
