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
import { CreateAttributeDto } from '../dto/create-attribute.dto';
import {
  AddAttributeValuesDto,
  RenameAttributeDto,
  RenameAttributeValueDto,
} from '../dto/update-attribute.dto';
import { QueryAttributesDto } from '../dto/query-attributes.dto';
import { AttributeService } from '../services/attribute.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AttributeMessages } from 'src/common/constants/attribute.message';
import { Public } from 'src/modules/auth/decorators/public.decorator';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';
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
 * Auth is annotated PER HANDLER, not on the class: `GET /attributes` and
 * `GET /attributes/:id` are `@Public()`, and a class-level `@ApiCookieAuth`
 * would have advertised a lock on them that the guards do not enforce.
 */
@ApiTags('Products Attribute Management')
@Controller('attributes')
@Audiences('admin')
export class AttributeController {
  constructor(private readonly attributeService: AttributeService) {}

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.create')
  @ApiOperation({
    summary: 'Create new attribute',
    description:
      'Creates the attribute and its values in one call.\n\n' +
      '**The name** is unique GLOBALLY, enforced by a unique index ' +
      '(`uq_product_attribute_name_norm`, migration 0025), so two simultaneous ' +
      'creates end as one 201 and one 409.\n\n' +
      '**The values** are unique WITHIN THIS ATTRIBUTE only. This endpoint ' +
      'used to refuse a value that existed anywhere in the vocabulary; that ' +
      'was narrower than `POST /attributes/{id}/values` promised for the same ' +
      'question, and the narrow (per-attribute) rule is now the only one — ' +
      '«قرمز» may belong to both «رنگ» and «رنگ آستر». Values repeated inside ' +
      'one payload are collapsed rather than refused.\n\n' +
      'All comparison is NORMALISED: trimmed, case-insensitive, with `ك`/`ک` ' +
      'and `ي`/`ی` folded together. Blank names or values are a 400. ' +
      '`data` is the created attribute WITH its id.',
  })
  @ApiCreatedResponse({
    description: 'Attribute created.',
    schema: successEnvelopeSchema({
      message: AttributeMessages.ATTRIBUTE_CREATED,
      data: { type: 'object', description: 'The created attribute.' },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.create')
  @ApiConflict(
    '`error: "ATTRIBUTE_ALREADY_EXISTS"` — an attribute already has this ' +
      'name (compared normalised). **This was a 400 before and is now a 409**, ' +
      'matching what `PATCH /attributes/{id}` already answered for the ' +
      'identical refusal.',
  )
  @Post()
  async create(
    @Req() req: UserRequest,
    @Body() createAttributeDto: CreateAttributeDto,
  ) {
    const attribute = await this.attributeService.create(
      createAttributeDto,
      auditActorFrom(req),
    );
    return { message: AttributeMessages.ATTRIBUTE_CREATED, data: attribute };
  }

  // PUBLIC: the storefront needs the attribute vocabulary (colour, size, ...)
  // to render variant pickers before the customer has logged in.
  @Public()
  @ApiOperation({
    summary: 'Get all attributes (public)',
    description: 'No cookie required. Served from cache.',
  })
  @ApiOkResponse({
    description: 'The whole attribute vocabulary with its values.',
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
    }),
  })
  @Get()
  async findAll() {
    const attributes = await this.attributeService.findAll();
    return { data: attributes };
  }

  /**
   * Declared BEFORE `:id`, or `/attributes/admin` is parsed as an id and
   * answers 400 from `ParseIntPipe`.
   */
  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.read')
  @ApiOperation({
    summary: 'Get attributes with usage counts (admin)',
    description:
      'ATTRIBUTES are paginated (default 50, max 100); the VALUES of each are ' +
      'returned in full, because half a colour list answers no question an ' +
      'admin has. Each value carries `variantCount` — how many product ' +
      'variants use it — so the screen can say why a delete will be refused ' +
      'before the admin presses it. Never served from cache.',
  })
  @ApiOkResponse({
    description: 'One page of the vocabulary.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'colour' },
            values: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer', example: 4 },
                  value: { type: 'string', example: 'red' },
                  variantCount: { type: 'integer', example: 12 },
                },
              },
            },
          },
        },
      },
      properties: {
        total: { type: 'integer', example: 3 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 50 },
        totalPages: { type: 'integer', example: 1 },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.read')
  @Get('admin')
  async findAllAdmin(@Query() query: QueryAttributesDto) {
    return this.attributeService.findAllAdmin(query);
  }

  @Public()
  @ApiOperation({
    summary: 'Get one attribute by id (public)',
    description: 'No cookie required.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `attributes.id`.',
    example: 1,
  })
  @ApiOkResponse({
    description: 'The attribute and its values.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiNotFound('No attribute has that id.')
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const attribute = await this.attributeService.findOne(id);
    return { data: attribute };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.update')
  @ApiOperation({
    summary: 'Rename an attribute',
    description:
      'Name only — values are not settable here (see POST ' +
      '/attributes/{id}/values and PATCH /attributes/values/{id}). Names are ' +
      'compared NORMALISED — trimmed, case-insensitive, `ك`/`ک` and `ي`/`ی` ' +
      'folded — so neither `Colour` beside `colour` nor «كيف» beside «کیف» ' +
      'is accepted. Backed by a unique index, so concurrent renames onto one ' +
      'name end as one 200 and one 409.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `attributes.id`.',
  })
  @ApiOkResponse({
    description: 'Attribute renamed.',
    schema: successEnvelopeSchema({
      message: AttributeMessages.ATTRIBUTE_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.update')
  @ApiNotFound('No attribute has that id.')
  @ApiConflict(
    '`error: "ATTRIBUTE_ALREADY_EXISTS"` — another attribute already has that ' +
      'name (compared normalised). `details` carries `{ name }`.',
  )
  @Patch(':id')
  async renameAttribute(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenameAttributeDto,
  ) {
    const attribute = await this.attributeService.renameAttribute(
      id,
      dto.name,
      auditActorFrom(req),
    );
    return { message: AttributeMessages.ATTRIBUTE_UPDATED, data: attribute };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.create')
  @ApiOperation({
    summary: 'Add values to an existing attribute',
    description:
      'ADDS; it never replaces. Values already on THIS attribute are refused ' +
      'with 409; the same word under a DIFFERENT attribute is fine and always ' +
      'was — the scope is per-attribute, and `POST /attributes` now agrees ' +
      '(it used to refuse a value existing anywhere in the vocabulary). ' +
      'Enforced by `uq_product_attribute_value_per_attribute_norm`, so two ' +
      'concurrent adds of the same value end as one 201 and one 409. ' +
      'Comparison is normalised (trimmed, case-insensitive, `ك`/`ک` and ' +
      '`ي`/`ی` folded); duplicates inside one payload are collapsed.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `attributes.id`.',
  })
  @ApiCreatedResponse({
    description: 'Values added; the whole attribute is returned.',
    schema: successEnvelopeSchema({
      message: AttributeMessages.ATTRIBUTE_VALUE_CREATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.create')
  @ApiNotFound('No attribute has that id.')
  @ApiConflict(
    '`error: "ATTRIBUTE_VALUE_ALREADY_EXISTS"` — `details` carries ' +
      '`{ attributeId, values }` naming the ones that clashed.',
  )
  @Post(':id/values')
  async addValues(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddAttributeValuesDto,
  ) {
    const attribute = await this.attributeService.addValues(
      id,
      dto.values,
      auditActorFrom(req),
    );
    return {
      message: AttributeMessages.ATTRIBUTE_VALUE_CREATED,
      data: attribute,
    };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.update')
  @ApiOperation({
    summary: 'Rename one attribute value',
    description:
      'The id is an `attribute_values.id`, NOT an `attributes.id`.\n\n' +
      '**This does not rewrite history.** `order_items.attributesSnapshot` ' +
      'froze the text as it stood when each order was placed, which is the ' +
      'whole reason that column exists: a past receipt keeps saying what the ' +
      'customer actually bought. Renaming changes the catalogue from now on ' +
      'only.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description:
      'Numeric `attribute_values.id` (the value, not the attribute).',
  })
  @ApiOkResponse({
    description: 'Value renamed.',
    schema: successEnvelopeSchema({
      message: AttributeMessages.ATTRIBUTE_VALUE_UPDATED,
      data: { type: 'object' },
    }),
  })
  @ApiInvalidInput(`${PARSE_INT_PIPE_400}. ${VALIDATION_PIPE_400}`)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.update')
  @ApiNotFound('No attribute value has that id.')
  @ApiConflict(
    '`error: "ATTRIBUTE_VALUE_ALREADY_EXISTS"` — the PARENT ATTRIBUTE already ' +
      'carries that value (compared normalised). Another attribute carrying ' +
      'it is not a conflict.',
  )
  @Patch('values/:id')
  async renameValue(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenameAttributeValueDto,
  ) {
    const value = await this.attributeService.renameValue(
      id,
      dto.value,
      auditActorFrom(req),
    );
    return { message: AttributeMessages.ATTRIBUTE_VALUE_UPDATED, data: value };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.delete')
  @ApiOperation({
    summary: 'Delete one attribute by id',
    description:
      'Refused with **409 `ATTRIBUTE_IN_USE`** while any of its values is ' +
      'still on a product variant; `details.variantCount` says how many. The ' +
      'check and the delete run in ONE transaction — ' +
      '`variant_product_attribute_value` is `ON DELETE CASCADE`, so a delete ' +
      'that raced the check would strip the options off live variants.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `attributes.id`.',
  })
  @ApiOkResponse({
    description: 'Attribute deleted.',
    schema: successEnvelopeSchema({
      message: AttributeMessages.ATTRIBUTE_DELETED,
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.delete')
  @ApiNotFound('No attribute has that id.')
  @ApiConflict(
    '`error: "ATTRIBUTE_IN_USE"` — `details` carries `{ attributeId, ' +
      'variantCount }`. This was a 400 before and is now a 409.',
  )
  @Delete(':id')
  async deleteAttribute(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.attributeService.deleteAttribute(id, auditActorFrom(req));
    return { message: AttributeMessages.ATTRIBUTE_DELETED };
  }

  @ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
  @RequirePermissions('attributes.delete')
  @ApiOperation({
    summary: 'Delete one attribute value by id',
    description:
      'The id is an `attribute_values.id`, NOT an `attributes.id`. Refused ' +
      'with **409 `ATTRIBUTE_IN_USE`** while a product variant still uses the ' +
      'value, checked and deleted in one transaction.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description:
      'Numeric `attribute_values.id` (the value, not the attribute).',
  })
  @ApiOkResponse({
    description: 'Attribute value deleted.',
    schema: successEnvelopeSchema({
      message: AttributeMessages.ATTRIBUTE_VALUE_DELETED,
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('attributes.delete')
  @ApiNotFound('No attribute value has that id.')
  @ApiConflict(
    '`error: "ATTRIBUTE_IN_USE"` — `details` carries `{ attributeValueId, ' +
      'variantCount }`. This was a 400 before and is now a 409.',
  )
  @Delete('values/:id')
  async deleteAttributeValue(
    @Req() req: UserRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.attributeService.deleteAttributeValue(id, auditActorFrom(req));
    return { message: AttributeMessages.ATTRIBUTE_VALUE_DELETED };
  }
}
