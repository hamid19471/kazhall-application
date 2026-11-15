import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import {
  ProductImageUploadExceptionFilter,
  UPLOAD_HARD_CEILING_BYTES,
} from 'src/common/storage/product-image-upload-exception.filter';

import { ProductsService } from '../services/products.service';
import { ProductCodeService } from '../services/product-code.service';
import { GenerateVariantCodeDto } from '../dto/generate-variant-code.dto';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { Roles } from 'src/modules/auth/decorators/role.decorator';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { BookmarkProductDto } from '../dto/bookmark-product.dto';
import { QueryProductsDto } from '../dto/query-products.dto';
import { QueryAdminProductsDto } from '../dto/query-admin-products.dto';
import { AdjustVariantStockDto } from '../dto/adjust-stock.dto';
import { ProductMessages } from 'src/common/constants/product.messages';
import { Public } from 'src/modules/auth/decorators/public.decorator';
import {
  ConsultsPermissions,
  RequirePermissions,
} from 'src/modules/auth/permissions/permission.decorator';
import {
  assertPermission,
  hasPermission,
} from 'src/modules/auth/permissions/assert-permission';
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
 * Is the caller the built-in `super_admin`?
 *
 * Read from `req.user.roles`, which `JwtStrategy` fills from the DATABASE row
 * on this request — never from a token claim the caller could have shaped.
 *
 * This decides only whether the SERVICE is told the actor is privileged; the
 * service re-asserts the rule itself, so a future route that forgets to pass
 * the flag fails closed rather than silently publishing.
 */
function isSuperAdmin(req: UserRequest): boolean {
  return (req.user?.roles ?? []).includes(UserRoleEnum.superAdmin);
}

/**
 * Auth is annotated PER HANDLER, not on the class: `GET /products` and
 * `GET /products/:id` are `@Public()` storefront reads and must not advertise
 * a cookie a caller does not need.
 */
@ApiTags('Products Management')
@Controller('products')
@Audiences('admin')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly productCodes: ProductCodeService,
  ) {}

  /**
   * ========================================================================
   * CODE GENERATION — «تولید خودکار کد»
   * ========================================================================
   *
   * Two narrow endpoints behind BOTH the admin audience (class level) and
   * `@Roles(super_admin)`. They allocate from a PostgreSQL sequence, so two
   * admins clicking at the same instant can never receive the same value —
   * which is the whole reason the button calls the server instead of building
   * a code in React.
   *
   * A generated code is NOT reserved. Abandoning the form leaves a gap in the
   * sequence, which is harmless: a code is an identifier, not a count. No
   * reservation table and no expiry sweeper exist to tidy those gaps up,
   * deliberately.
   *
   * The unique indexes remain the guarantee. These endpoints only avoid
   * handing an operator a code that is visibly already taken.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @Roles(UserRoleEnum.superAdmin)
  @ApiOperation({
    summary: 'Allocate a fresh, unused product code (super_admin only)',
  })
  @ApiCreatedResponse({
    description: 'A code that was unused at the moment it was allocated.',
    schema: {
      example: { success: true, data: { productCode: 'KZ-P-000042' } },
    },
  })
  @ApiAuthRequired()
  @HttpCode(200)
  @Post('admin/codes/product')
  async generateProductCode() {
    return { data: { productCode: await this.productCodes.nextProductCode() } };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @Roles(UserRoleEnum.superAdmin)
  @ApiOperation({
    summary: 'Allocate a fresh variant code under a product (super_admin only)',
  })
  @ApiCreatedResponse({
    description:
      'The NORMALISED parent code and a unique child code beneath it.',
    schema: {
      example: {
        success: true,
        data: {
          productCode: 'KZ-P-000042',
          variantCode: 'KZ-P-000042-V000007',
        },
      },
    },
  })
  @ApiAuthRequired()
  @HttpCode(200)
  @Post('admin/codes/variant')
  async generateVariantCode(@Body() dto: GenerateVariantCodeDto) {
    return { data: await this.productCodes.nextVariantCode(dto.productCode) };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('products.create')
  /*
   * `inventory.adjust` IS CONSULTED, NOT REQUIRED.
   *
   * A positive `initialStock` puts units into the system, which is an
   * inventory act whoever performs it, so it additionally demands
   * `inventory.adjust`. That cannot be a `@RequirePermissions` entry: the
   * decorator is AND-only, and requiring it here would stop a delegated
   * catalogue editor from creating a product at all — including one with no
   * stock, which is exactly what they are supposed to be able to do.
   *
   * So the floor stays `products.create` where a reader and the coverage spec
   * can see it, and the value-dependent rule is decided in the service.
   * Declared here so the coverage spec reads it from the container rather than
   * from a regex over this file.
   */
  @ConsultsPermissions('inventory.adjust')
  @ApiOperation({
    summary: 'Create new product',
    description:
      'Creates the product, its categories, its images and its variants in a ' +
      'single transaction. Image ids must come from POST /products/uploadImage ' +
      'and must not already belong to another product.\n\n' +
      'SIMPLE PRODUCTS: omit `variants` and the API creates one hidden default ' +
      'variant carrying the product price. `initialStock` then sets its opening ' +
      'quantity in the same transaction, writing an `initial_stock` stock ' +
      'movement — a positive value additionally requires `inventory.adjust`. ' +
      'The quantity is GLOBAL across the website and every eligible branch.',
  })
  @ApiCreatedResponse({
    description: 'Product created (admin projection).',
    schema: successEnvelopeSchema({
      message: ProductMessages.PRODUCT_CREATED,
      data: { type: 'object', description: 'The created product.' },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 for duplicate SKUs inside the payload, ` +
      'duplicate image ids, or an image already owned by another product.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('products.create')
  @ApiNotFound(
    'An unknown `categoryIds` entry, `attributeValueIds` entry, or image id.',
  )
  @ApiConflict('A variant SKU already exists (unique violation).')
  @Post()
  async create(
    @Req() req: UserRequest,
    @Body() createProductDto: CreateProductDto,
  ) {
    const product = await this.productsService.create(
      createProductDto,
      auditActorFrom(req),
      /*
       * The caller's capabilities, because `initialStock` carries its own
       * requirement (`inventory.adjust`) that depends on the VALUE rather than
       * on the route — a decorator cannot say "only when the number is above
       * zero". The floor stays declared on the route; the service decides the
       * rest, and the coverage spec reads both from the container.
       */
      req.user?.permissions ?? [],
      { isSuperAdmin: isSuperAdmin(req) },
    );
    return { message: ProductMessages.PRODUCT_CREATED, data: product };
  }

  /**
   * PUBLIC. Anonymous storefront browsing.
   *
   * Returns `PublicProductListItemView` -- never a raw entity. No cart rows,
   * no bookmarking users, no stock integers.
   */
  @Public()
  @ApiOperation({
    summary: 'Browse the catalog (public)',
    description:
      'No cookie required. Paginated. Filters: search (title, ' +
      'case-insensitive), categoryId, minPrice, maxPrice, inStockOnly. Sort: ' +
      'newest | price_asc | price_desc — every parameter is documented under ' +
      '**Parameters** below and comes from `QueryProductsDto`.\n\n' +
      'The `inStock` flag is INDICATIVE only -- the authoritative stock check ' +
      'happens when the item is added to a basket or sold.',
  })
  @ApiOkResponse({
    description:
      'One page of the catalog. The pagination keys are spread at the TOP ' +
      'level of the envelope, beside `data` — they are not nested inside it.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: { type: 'object' },
        description: 'PublicProductListItemView rows.',
      },
      properties: {
        total: { type: 'integer', example: 544 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 10 },
        totalPages: { type: 'integer', example: 55 },
      },
    }),
    examples: {
      default: {
        summary: 'First page, as it appears on the wire',
        value: {
          success: true,
          timeStamp: '2026-09-10T09:12:44.001Z',
          data: [
            {
              id: 12,
              title: 'Samsung Galaxy A55',
              basePrice: 120000000,
              effectivePrice: 118000000,
              primaryImage: { id: 9, url: 'https://.../a.png', sortOrder: 0 },
              categories: [{ id: 1, title: 'Mobile' }],
              inStock: true,
              variantCount: 3,
            },
          ],
          total: 544,
          page: 1,
          limit: 10,
          totalPages: 55,
        },
      },
    },
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. Also 400 when \`minPrice\` exceeds \`maxPrice\`.`,
  )
  @Get()
  async findAll(@Query() query: QueryProductsDto) {
    return this.productsService.findAll(query);
  }

  /**
   * ADMIN list. Declared before `:id` so that `/products/admin` is not parsed
   * as a product id and rejected by `ParseIntPipe`.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('products.read')
  @Audiences('admin')
  @ApiOperation({
    summary: 'The catalogue as an administrator sees it',
    description:
      'The admin twin of `GET /products` and NOT the same query: this one ' +
      'counts retired variants, reports physical stock, and is **never ' +
      'cached** — an admin who has just adjusted stock or retired a SKU must ' +
      'not be shown a page that predates their own write.\n\n' +
      'Filters: `search` (product title OR any variant SKU, case-insensitive), ' +
      '`categoryId`, `sellable` (tri-state: has ≥1 active variant / every ' +
      'variant inactive), `stockState` (`in_stock` | `low_stock` | ' +
      '`out_of_stock`, banded on the ACTIVE-variant stock total).\n\n' +
      '`sellableOnWeb` and `sellableOnPos` are always EQUAL, and that is the ' +
      'model being honest rather than a defect: there is no per-surface ' +
      'activation flag, so a product with at least one active variant is ' +
      'offerable on both. What differs is availability, and that is reported ' +
      'separately by `hasWebAvailableStock` (stock minus basket holds minus ' +
      'order allocations) and `hasPosAvailableStock` (stock minus order ' +
      'allocations only — a basket hold never blocks a till sale).',
  })
  @ApiOkResponse({
    description:
      'One page of the catalogue. The pagination keys are spread at the TOP ' +
      'level of the envelope, beside `data`.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: { type: 'object' },
        description: 'AdminProductListItemView rows.',
      },
      properties: {
        total: { type: 'integer', example: 544 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 10 },
        totalPages: { type: 'integer', example: 55 },
      },
    }),
    examples: {
      default: {
        summary: 'First page, as it appears on the wire',
        value: {
          success: true,
          timeStamp: '2026-09-10T09:12:44.001Z',
          data: [
            {
              id: 12,
              title: 'Samsung Galaxy A55',
              basePrice: 120000000,
              categories: [{ id: 1, title: 'Mobile' }],
              primaryImage: { id: 9, url: 'https://.../a.png', sortOrder: 0 },
              variantCount: 4,
              activeVariantCount: 3,
              totalStock: 7,
              effectivePrice: 118000000,
              maxEffectivePrice: 132000000,
              sellableOnWeb: true,
              sellableOnPos: true,
              hasWebAvailableStock: true,
              hasPosAvailableStock: true,
              createdAt: '2026-08-01T10:00:00.000Z',
              updatedAt: '2026-09-09T14:22:10.000Z',
            },
          ],
          total: 544,
          page: 1,
          limit: 10,
          totalPages: 55,
        },
      },
    },
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('products.read')
  @Get('admin')
  async findAllAdmin(@Query() query: QueryAdminProductsDto) {
    return this.productsService.findAllAdmin(query);
  }

  /**
   * ADMIN detail. Adds physical stock, deactivated variants and timestamps.
   * Declared before `:id` so that `/products/admin/1` is not swallowed by it.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Get one product by id (admin projection)',
    description:
      'The admin twin of `GET /products/{id}`: adds physical stock, ' +
      'deactivated variants and timestamps, none of which the public ' +
      'projection exposes.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `products.id`.',
    example: 12,
  })
  @ApiOkResponse({
    description: 'The product in the admin projection.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('products.read')
  @ApiNotFound('No product has that id.')
  @Get('admin/:id')
  async findOneAdmin(@Param('id', ParseIntPipe) id: number) {
    const product = await this.productsService.findOneAdmin(id);
    return { data: product };
  }

  /** PUBLIC. Storefront product detail. */
  @Public()
  @ApiOperation({
    summary: 'Get one product by id (public)',
    description:
      'No cookie required. Only ACTIVE variants are listed. ' +
      '`variants[].availability` is indicative and is recomputed per request ' +
      '-- it is never served from cache and must not be treated as a ' +
      'reservation.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `products.id`.',
    example: 12,
  })
  @ApiOkResponse({
    description: 'The product in the public projection.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiNotFound('No product has that id.')
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const product = await this.productsService.findOnePublic(id);
    return { data: product };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('products.update')
  @ApiOperation({
    summary: 'Update one product by id',
    description:
      'Single transaction. categoryIds and images are COMPLETE desired sets; ' +
      'variants is a partial upsert list (no id = create, id = update, ' +
      'isActive:false = deactivate). Variant stock is NOT settable here -- use ' +
      'POST /products/variants/:variantId/stock/adjust.\n\n' +
      'AUTHORISATION: `products.update` is the floor. A variant entry that ' +
      'CHANGES `isActive` additionally requires `products.deactivate` (true ' +
      '-> false) or `products.activate` (false -> true), and is refused with ' +
      "PERMISSION_DENIED otherwise. Restating a variant's existing " +
      '`isActive` is not a change and needs neither.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `products.id`.',
    example: 12,
  })
  @ApiOkResponse({
    description: 'Product updated (admin projection).',
    schema: successEnvelopeSchema({
      message: ProductMessages.PRODUCT_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 for duplicate ` +
      'SKUs in the payload, a new variant missing `sku` or ' +
      '`attributeValueIds`, `stock` sent for an existing variant (use the ' +
      'stock-adjust route), a variant id belonging to another product, and ' +
      'duplicate or foreign image ids.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('products.update')
  @ApiNotFound(
    'Unknown product id, categoryId, attributeValueId, variant id or image id.',
  )
  @ApiConflict('A variant SKU already exists (unique violation).')
  /*
   * `products.update` is the declared FLOOR. A variant entry that CHANGES
   * `isActive` additionally needs `products.activate` / `products.deactivate`,
   * and that is only knowable once the existing row has been read inside the
   * transaction — see `ProductsService.update`. Declared here so the two
   * capabilities are visible on the route and to the coverage spec.
   */
  @ConsultsPermissions('products.activate', 'products.deactivate')
  @Patch(':id')
  async update(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    const product = await this.productsService.update(
      id,
      updateProductDto,
      auditActorFrom(req),
      req.user?.permissions ?? [],
      { isSuperAdmin: isSuperAdmin(req) },
    );
    return { message: ProductMessages.PRODUCT_UPDATED, data: product };
  }

  /**
   * Toggle the CALLER's bookmark. The user is taken from the verified access
   * token; `userId` is no longer accepted in the body.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @ApiOperation({
    summary: "Toggle the caller's bookmark on a product",
    description:
      'Any authenticated user; there is no role restriction. The owner is ' +
      'taken from the access token — `userId` is not accepted in the body. ' +
      'The call TOGGLES: `data.bookmarked` says which way it went.',
  })
  @ApiCreatedResponse({
    description: 'Bookmark added or removed.',
    schema: successEnvelopeSchema({
      message: ProductMessages.PRODUCT_BOOKMARKED,
      data: {
        type: 'object',
        properties: { bookmarked: { type: 'boolean', example: true } },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiNotFound('No product has that id.')
  @Audiences('storefront')
  @Post('bookmark')
  async bookmark(
    @Req() req: UserRequest,
    @Body() bookmarkDto: BookmarkProductDto,
  ) {
    const result = await this.productsService.bookmark(
      req.user.sub,
      bookmarkDto.productId,
    );
    return {
      message: result.bookmarked
        ? ProductMessages.PRODUCT_BOOKMARKED
        : ProductMessages.PRODUCT_BOOKMARK_REMOVED,
      data: result,
    };
  }

  /**
   * Reservation-aware admin stock adjustment. Delegates to
   * `IInventoryService.adjustStock`; reports basketReserved / orderAllocated.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('inventory.adjust')
  @ApiOperation({
    summary: 'Adjust the physical stock of a variant',
    description:
      'Rejected when the result would fall below the currently reserved ' +
      'quantity, unless `allowBelowReserved=true`.\n\n' +
      'That refusal has TWO statuses depending on where it is detected: the ' +
      'pre-check answers **409** with `error: STOCK_BELOW_RESERVED`, while the ' +
      'authoritative re-check taken under the variant lock answers **400**. A ' +
      'client must treat both as the same refusal.',
  })
  @ApiParam({
    name: 'variantId',
    type: Number,
    description:
      'Numeric `product_variants.id` — the VARIANT, not the product.',
    example: 7,
  })
  @ApiCreatedResponse({
    description: 'Stock adjusted; the reservation counters are reported back.',
    schema: successEnvelopeSchema({
      message: ProductMessages.STOCK_ADJUSTED,
      data: { type: 'object' },
    }),
    examples: {
      default: {
        summary: 'As it appears on the wire',
        value: {
          success: true,
          timeStamp: '2026-09-10T09:12:44.001Z',
          message: 'Variant stock adjusted successfully',
          data: {
            variantId: 7,
            productId: 12,
            sku: 'IPH17-BLK-128',
            previousStock: 10,
            balanceAfter: 7,
            basketReserved: 2,
            orderAllocated: 1,
            belowReserved: false,
          },
        },
      },
    },
  })
  @ApiInvalidInput(
    `${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}. Also 400 when the target ` +
      'stock would be negative, and when the below-reserved refusal is ' +
      'detected under the lock rather than by the pre-check.',
  )
  @ApiAuthRequired()
  @ApiPermissionForbidden('inventory.adjust')
  @ApiNotFound('No variant has that id.')
  @ApiConflict(
    'Result would fall below `basketReserved + orderAllocated` and ' +
      '`allowBelowReserved` was not set. `error` is `STOCK_BELOW_RESERVED` and ' +
      '`details` carries requestedStock / physicalStock / basketReserved / ' +
      'orderAllocated.',
  )
  // stock adjustment audit is owned by the inventory workstream
  @Post('variants/:variantId/stock/adjust')
  async adjustStock(
    @Req() req: UserRequest,
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: AdjustVariantStockDto,
  ) {
    const data = await this.productsService.adjustVariantStock(variantId, dto, {
      userId: req.user.sub,
      displaySnapshot: req.user.identifier,
    });
    return { message: ProductMessages.STOCK_ADJUSTED, data };
  }

  /**
   * WHY THE REQUIREMENT IS AN "OR" AND NOT A DECORATOR.
   *
   * This route used to declare `products.update` alone, which broke the CREATE
   * flow: the new-product form uploads its images before the product exists,
   * so a role granted `products.read` + `products.create` — whose own Persian
   * description promises it covers "adding a new product together with its
   * variants, price and category" — could fill the whole form and then watch
   * every image upload fail with a code nobody told them they needed.
   *
   * `@RequirePermissions(...)` is AND-only, deliberately, so the floor stays
   * on the route where a reader and the coverage spec can see it, and the
   * either-or is asserted in the handler with the same refusal shape the guard
   * would have thrown.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Upload a product image',
    description:
      'Returns a detached ProductImage. Attach it by passing its id in the ' +
      '`images` array of a product create/update.\n\n' +
      'AUTHORISATION: `products.read` plus EITHER `products.create` OR ' +
      '`products.update` — an image is uploaded before it is attached, so ' +
      'both the create and the edit flow legitimately reach this route.\n\n' +
      'ACCEPTED: JPEG, PNG and WebP, decided by the file signature and NOT by ' +
      'the filename or the declared Content-Type. SVG is refused deliberately ' +
      '(it can carry script). Anything larger than `PRODUCT_IMAGE_MAX_BYTES` ' +
      '(default 5 MiB) is refused with 413.\n\n' +
      'STORAGE FAILURES ANSWER 503, never 500: `IMAGE_STORAGE_UNAVAILABLE` ' +
      'when object storage is unconfigured or unreachable, and ' +
      '`IMAGE_STORAGE_BUCKET_MISSING` when it answers but the configured ' +
      'bucket does not exist. Both are operator faults and neither is fixed ' +
      'by retrying.',
  })
  /*
   * `products.read` is the declared FLOOR; the either-or above it is decided
   * in the handler. Declared here so the coverage spec reads both codes from
   * the container rather than from a regex over this file.
   */
  @ConsultsPermissions('products.create', 'products.update')
  @Post('uploadImage')
  /*
   * MEMORY STORAGE with a HARD CEILING.
   *
   * The bytes are held in the process only long enough to verify and forward
   * them, so there is no temp file to clean up and no window where a rejected
   * upload exists on disk. The ceiling is what stops that being a denial of
   * service: without `limits.fileSize`, a single request could stream an
   * unbounded amount into the heap before any handler saw it.
   *
   * It is a CONSTANT and not `PRODUCT_IMAGE_MAX_BYTES` because decorator
   * options are evaluated at class-definition time, before configuration
   * exists. It is set to the highest value that variable may take, so the
   * configured business limit is always the one that actually refuses — see
   * `MulterUploadExceptionFilter`.
   */
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: UPLOAD_HARD_CEILING_BYTES, files: 1 },
    }),
  )
  /*
   * Restates the multipart layer's own refusals in this route's error
   * contract. Without it, exceeding the interceptor ceiling or misnaming the
   * part answers an English string with no machine-readable code — see the
   * filter's header. Refusals this route throws deliberately pass through it
   * untouched.
   */
  @UseFilters(ProductImageUploadExceptionFilter)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'One `file` part. The field name must be exactly `file`.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Image stored and a detached ProductImage returned.',
    schema: successEnvelopeSchema({
      message: ProductMessages.IMAGE_UPLOADED,
      data: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 9 },
          url: { type: 'string', example: 'https://.../a.png' },
        },
      },
    }),
  })
  @ApiInvalidInput(
    'No `file` part was sent (`IMAGE_FILE_REQUIRED`), or the bytes are not a ' +
      'usable image (`IMAGE_MALFORMED`).',
  )
  @ApiResponse({
    status: 413,
    description: '`IMAGE_TOO_LARGE` — larger than `PRODUCT_IMAGE_MAX_BYTES`.',
  })
  @ApiResponse({
    status: 415,
    description:
      '`IMAGE_TYPE_UNSUPPORTED` — not a JPEG, PNG or WebP by file signature.',
  })
  @ApiResponse({
    status: 503,
    description:
      '`IMAGE_STORAGE_UNAVAILABLE` or `IMAGE_STORAGE_BUCKET_MISSING` — the ' +
      'storage subsystem is not usable. An operator fault, not a caller one.',
  })
  @ApiAuthRequired()
  @ApiPermissionForbidden(
    'products.read + (products.create OR products.update)',
  )
  async upload(
    @Req() req: UserRequest,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (
      !hasPermission(req, 'products.create') &&
      !hasPermission(req, 'products.update')
    ) {
      // Reported as create-or-update rather than picking one, so the message
      // names what would actually unblock the caller.
      assertPermission(req, 'products.create');
    }
    const image = await this.productsService.upload(file);
    return { message: ProductMessages.IMAGE_UPLOADED, data: image };
  }
}
