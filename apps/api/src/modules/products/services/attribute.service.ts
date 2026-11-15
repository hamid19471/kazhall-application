import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ProductAttribute } from '../entities/product-attribute.entity';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ProductAttributeValue } from '../entities/product-attribute-value.entity';
import { CreateAttributeDto } from '../dto/create-attribute.dto';
import { QueryAttributesDto } from '../dto/query-attributes.dto';
import { CacheService, CATALOG_NAMESPACES } from 'src/database/cache.service';
import {
  AttributeErrorCodes,
  AttributeMessages,
} from 'src/common/constants/attribute.message';
import {
  catalogueConflictOr,
  catalogueNormExpr,
  normaliseCatalogueTerm,
} from 'src/common/catalogue/catalogue-uniqueness';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';

const ATTRIBUTE_CACHE_TTL_SECONDS = 3600;

/** The two cache keys this service owns. Built here so that every write path
 * invalidates exactly what the read paths wrote — the previous code spelled
 * `attribute:${id}` out at three call sites and missed it at two others. */
const attributeKeys = {
  list: (version: number) => `attributes:list:v${version}`,
  detail: (id: number) => `attribute:${id}`,
};

export interface AdminAttributeValueView {
  id: number;
  value: string;
  /** How many product variants currently carry this value. */
  variantCount: number;
}

export interface AdminAttributeView {
  id: number;
  name: string;
  values: AdminAttributeValueView[];
}

export interface PaginatedAttributes {
  data: AdminAttributeView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class AttributeService {
  constructor(
    @InjectRepository(ProductAttribute)
    private readonly productAttributeRepository: Repository<ProductAttribute>,
    private readonly cacheService: CacheService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create an attribute together with its initial values.
   *
   * RETURNS the created attribute. It used to return `undefined` while the
   * controller cheerfully answered `{ data: undefined }`, so a client had no id
   * to follow up with and no way to tell a success from a silent no-op.
   *
   * ---------------------------------------------------------------------
   * TWO DELIBERATE CHANGES OF CONTRACT HERE
   * ---------------------------------------------------------------------
   * 1. THE NAME CLASH IS NOW A 409, NOT A 400, and carries the stable
   *    `ATTRIBUTE_ALREADY_EXISTS` code. `renameAttribute` already answered 409
   *    with that code for the identical refusal; a client could not branch on
   *    "this name is taken" without knowing which endpoint it had called.
   *
   * 2. THE VALUE CHECK IS NOW PER-ATTRIBUTE, not global. It used to refuse a
   *    value that existed ANYWHERE in the vocabulary (`In(values)` across the
   *    whole table), while `addValues` — the endpoint used for every value
   *    added after the first minute of the attribute's life — refused only
   *    values already on THIS attribute. The API therefore promised two
   *    different rules for the same question. The narrow rule is the correct
   *    one and is now the only one: «قرمز» may legitimately belong to both
   *    «رنگ» and «رنگ آستر», and a global rule makes an axis unextendable for
   *    a reason the store manager can neither see nor fix. Migration 0025
   *    enforces exactly this scope in the database
   *    (`uq_product_attribute_value_per_attribute_norm`).
   *
   * The attribute is brand new, so "already on this attribute" can only mean
   * "twice in this payload" — which is what the normalised de-duplication
   * below catches, using the same folding the index uses.
   */
  async create(
    createAttributeDto: CreateAttributeDto,
    actor: AuditActor,
  ): Promise<ProductAttribute> {
    // Trimmed again for callers that bypass the ValidationPipe (seeders, other
    // services). The DTO does it for every HTTP request.
    const name = createAttributeDto.name.trim();
    const values = this.dedupeValues(createAttributeDto.values);
    if (!values.length) {
      throw new BadRequestException(
        AttributeMessages.ATTRIBUTE_VALUE_NOT_FOUND,
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const attributeRepo = manager.getRepository(ProductAttribute);

      // Pre-check for the good message. `uq_product_attribute_name_norm` is
      // the actual guarantee — this SELECT-then-INSERT races, and two
      // simultaneous creates of «رنگ» both reach it.
      const taken = await attributeRepo
        .createQueryBuilder('a')
        .where(
          `${catalogueNormExpr('a.name')} = ${catalogueNormExpr(':name')}`,
          {
            name,
          },
        )
        .getExists();
      if (taken) {
        throw new ConflictException({
          error: AttributeErrorCodes.ATTRIBUTE_ALREADY_EXISTS,
          message: AttributeMessages.ATTRIBUTE_ALREADY_EXISTS,
          name,
        });
      }

      const attribute = await attributeRepo
        .save(
          attributeRepo.create({
            name,
            values: values.map((value) => ({ value })),
          }),
        )
        .catch((error: unknown) => {
          throw catalogueConflictOr(error, { name, values });
        });

      await this.audit.record(
        {
          actor,
          action: AuditAction.ATTRIBUTE_CREATED,
          targetType: AuditTarget.ATTRIBUTE,
          targetId: attribute.id,
          targetLabel: attribute.name,
          summary: { after: { name, values: [...values] } },
        },
        manager,
      );

      return attribute;
    });

    await this.invalidate();
    return saved;
  }

  async findAll() {
    const version = await this.cacheService.getVersion(
      CATALOG_NAMESPACES.ATTRIBUTES,
    );

    return this.cacheService.getOrSet(
      attributeKeys.list(version),
      ATTRIBUTE_CACHE_TTL_SECONDS,
      async () => {
        return this.productAttributeRepository.find({
          relations: { values: true },
        });
      },
    );
  }

  /**
   * ADMIN vocabulary. Every value carries the number of variants using it, so
   * the screen can tell an admin BEFORE they press delete that the refusal is
   * coming and why.
   *
   * The counts are ONE grouped query over `variant_product_attribute_value` for
   * the whole page — not one per value. A colour axis with 30 values would
   * otherwise issue 30 counts per page render.
   *
   * Not cached: the public `findAll` document has an hour-long TTL, and an
   * admin who just added a value must not be shown the vocabulary without it.
   */
  async findAllAdmin(query: QueryAttributesDto): Promise<PaginatedAttributes> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const total = await this.productAttributeRepository.count();
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    if (total === 0 || (page - 1) * limit >= total) {
      return { data: [], total, page, limit, totalPages };
    }

    // `id ASC` is a tiebreaker, not decoration: `name` is unique today, but an
    // ordering whose determinism depends on a constraint elsewhere in the
    // schema breaks silently the day that constraint moves.
    const attributes = await this.productAttributeRepository.find({
      relations: { values: true },
      order: { name: 'ASC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const valueIds = attributes.flatMap((a) =>
      (a.values ?? []).map((v) => v.id),
    );
    const counts = await this.countVariantsPerValue(this.dataSource, valueIds);

    return {
      data: attributes.map((attribute) => ({
        id: attribute.id,
        name: attribute.name,
        values: (attribute.values ?? [])
          .slice()
          .sort((a, b) => a.id - b.id)
          .map((value) => ({
            id: value.id,
            value: value.value,
            variantCount: counts.get(value.id) ?? 0,
          })),
      })),
      total,
      page,
      limit,
      totalPages,
    };
  }

  async findOne(id: number) {
    return this.cacheService.getOrSet(
      attributeKeys.detail(id),
      ATTRIBUTE_CACHE_TTL_SECONDS,
      async () => {
        const attribute = await this.productAttributeRepository.findOne({
          where: { id },
          relations: { values: true },
        });
        if (!attribute)
          throw new NotFoundException(AttributeMessages.ATTRIBUTE_NOT_FOUND);
        return attribute;
      },
    );
  }

  /**
   * Rename an attribute. Its values are untouched.
   *
   * The read BYPASSES THE CACHE (`manager`, not `findOne`): `findOne` serves an
   * hour-old document, and writing a value back from it would let a stale name
   * overwrite the authoritative row.
   */
  async renameAttribute(
    id: number,
    rawName: string,
    actor: AuditActor,
  ): Promise<ProductAttribute> {
    const name = rawName.trim();

    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProductAttribute);
      const attribute = await repo.findOne({
        where: { id },
        relations: { values: true },
      });
      if (!attribute)
        throw new NotFoundException(AttributeMessages.ATTRIBUTE_NOT_FOUND);

      const before = attribute.name;
      if (normaliseCatalogueTerm(before) !== normaliseCatalogueTerm(name)) {
        // Compared through `catalogue_norm()` — the SAME expression
        // `uq_product_attribute_name_norm` is built on. It used to be
        // `LOWER(a.name) = LOWER(:name)`, which accepted «كيف» beside «کیف»;
        // the index refuses that pair, so the two would have disagreed and the
        // rename would have died as a 500 instead of a 409.
        const taken = await repo
          .createQueryBuilder('a')
          .where(
            `${catalogueNormExpr('a.name')} = ${catalogueNormExpr(':name')}`,
            { name },
          )
          .andWhere('a.id <> :id', { id })
          .getExists();
        if (taken) {
          throw new ConflictException({
            error: AttributeErrorCodes.ATTRIBUTE_ALREADY_EXISTS,
            message: AttributeMessages.ATTRIBUTE_ALREADY_EXISTS,
            name,
          });
        }
      }

      attribute.name = name;
      // Two concurrent renames onto the same new name both pass the probe
      // above; the index refuses the loser and this turns its 23505 into the
      // identical 409.
      const updated = await repo.save(attribute).catch((error: unknown) => {
        throw catalogueConflictOr(error, { name });
      });

      await this.audit.record(
        {
          actor,
          action: AuditAction.ATTRIBUTE_UPDATED,
          targetType: AuditTarget.ATTRIBUTE,
          targetId: id,
          targetLabel: name,
          summary: { before: { name: before }, after: { name } },
        },
        manager,
      );

      return updated;
    });

    await this.invalidate(id);
    return saved;
  }

  /**
   * Add values to an existing attribute.
   *
   * The duplicate check is PER ATTRIBUTE, unlike `create`'s global one. Once an
   * axis exists, "does this attribute already offer red" is the question an
   * admin is actually asking; refusing because some other attribute happens to
   * own the string would make an existing axis unextendable for a reason the
   * admin cannot see or fix.
   */
  async addValues(
    id: number,
    values: string[],
    actor: AuditActor,
  ): Promise<ProductAttribute> {
    // De-duplicated through `normaliseCatalogueTerm`, not `Set` over the raw
    // strings: `["کیف", "كيف"]` is ONE value as far as the unique index is
    // concerned, and sending both used to insert one row and then 23505 on the
    // other, failing the whole request with a 500.
    const deduped = this.dedupeValues(values);
    if (!deduped.length) {
      throw new BadRequestException(
        AttributeMessages.ATTRIBUTE_VALUE_NOT_FOUND,
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const attributeRepo = manager.getRepository(ProductAttribute);
      const valueRepo = manager.getRepository(ProductAttributeValue);

      const attribute = await attributeRepo.findOne({
        where: { id },
        relations: { values: true },
      });
      if (!attribute)
        throw new NotFoundException(AttributeMessages.ATTRIBUTE_NOT_FOUND);

      // Normalised the same way the index is, so the probe cannot accept a
      // value the index will refuse. `toLowerCase()` alone let «كيف» past when
      // «کیف» was already on the attribute.
      const existing = new Set(
        (attribute.values ?? []).map((v) => normaliseCatalogueTerm(v.value)),
      );
      const clashes = deduped.filter((v) =>
        existing.has(normaliseCatalogueTerm(v)),
      );
      if (clashes.length) {
        throw new ConflictException({
          error: AttributeErrorCodes.ATTRIBUTE_VALUE_ALREADY_EXISTS,
          message: AttributeMessages.ATTRIBUTE_SOME_VALUES_ALREADY_EXISTS,
          attributeId: id,
          values: clashes,
        });
      }

      const created = await valueRepo
        .save(deduped.map((value) => valueRepo.create({ value, attribute })))
        .catch((error: unknown) => {
          // Two admins adding «قرمز» to the same attribute at the same moment
          // both saw it free above. The index decides; this reports its
          // verdict in the same words the probe would have used.
          throw catalogueConflictOr(error, {
            attributeId: id,
            values: deduped,
          });
        });

      // One audit row per value, rather than one row listing them all: the
      // trail is read by `targetId`, and a row whose target is "several things"
      // cannot be linked back to any of them.
      for (const value of created) {
        await this.audit.record(
          {
            actor,
            action: AuditAction.ATTRIBUTE_VALUE_CREATED,
            targetType: AuditTarget.ATTRIBUTE_VALUE,
            targetId: value.id,
            targetLabel: value.value,
            summary: {
              after: {
                attributeId: id,
                attributeName: attribute.name,
                value: value.value,
              },
            },
          },
          manager,
        );
      }

      return attributeRepo.findOneOrFail({
        where: { id },
        relations: { values: true },
      });
    });

    await this.invalidate(id);
    return saved;
  }

  /**
   * Rename one value.
   *
   * THIS DOES NOT REWRITE HISTORY, BY DESIGN. `order_items.attributesSnapshot`
   * froze the text as it stood when the order was placed, and that is the whole
   * reason the column exists: a receipt has to keep saying what the customer
   * actually bought. Renaming "red" to "crimson" changes the catalogue from now
   * on; every past order still reads "red", and no repair job exists or should.
   */
  async renameValue(
    id: number,
    rawValue: string,
    actor: AuditActor,
  ): Promise<ProductAttributeValue> {
    const value = rawValue.trim();

    const { saved, attributeId } = await this.dataSource.transaction(
      async (manager) => {
        const repo = manager.getRepository(ProductAttributeValue);
        const attributeValue = await repo.findOne({
          where: { id },
          relations: { attribute: true },
        });
        if (!attributeValue)
          throw new NotFoundException(
            AttributeMessages.ATTRIBUTE_VALUE_NOT_FOUND,
          );

        const before = attributeValue.value;
        const parentId = attributeValue.attribute?.id;

        if (
          normaliseCatalogueTerm(before) !== normaliseCatalogueTerm(value) &&
          parentId
        ) {
          // SCOPED TO THE PARENT ATTRIBUTE, and normalised the same way
          // `uq_product_attribute_value_per_attribute_norm` is. Renaming a
          // «رنگ» value to «قرمز» is refused only when «رنگ» already offers it
          // — the «قرمز» that belongs to «رنگ آستر» is a different thing.
          const taken = await repo
            .createQueryBuilder('v')
            .where('v."attributeId" = :parentId', { parentId })
            .andWhere(
              `${catalogueNormExpr('v.value')} = ${catalogueNormExpr(':value')}`,
              { value },
            )
            .andWhere('v.id <> :id', { id })
            .getExists();
          if (taken) {
            throw new ConflictException({
              error: AttributeErrorCodes.ATTRIBUTE_VALUE_ALREADY_EXISTS,
              message: AttributeMessages.ATTRIBUTE_SOME_VALUES_ALREADY_EXISTS,
              attributeId: parentId,
              values: [value],
            });
          }
        }

        attributeValue.value = value;
        const updated = await repo
          .save(attributeValue)
          .catch((error: unknown) => {
            throw catalogueConflictOr(error, {
              attributeId: parentId,
              values: [value],
            });
          });

        await this.audit.record(
          {
            actor,
            action: AuditAction.ATTRIBUTE_VALUE_UPDATED,
            targetType: AuditTarget.ATTRIBUTE_VALUE,
            targetId: id,
            targetLabel: value,
            summary: {
              attributeId: parentId ?? null,
              before: { value: before },
              after: { value },
            },
          },
          manager,
        );

        return { saved: updated, attributeId: parentId };
      },
    );

    await this.invalidate(attributeId);
    return saved;
  }

  /**
   * Delete an attribute, refusing while any of its values is on a variant.
   *
   * THE CHECK AND THE DELETE ARE ONE TRANSACTION. They used to be a cached read
   * followed by an unguarded `DELETE`, which is two defects in one: the read
   * came from `findOne` (an hour-old document, so a value added since was
   * invisible to the check) and the gap between check and delete let a variant
   * start using a value in between. `variant_product_attribute_value` is
   * `ON DELETE CASCADE`, so losing that race strips the options off live
   * variants.
   */
  async deleteAttribute(id: number, actor: AuditActor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProductAttribute);
      const attribute = await repo.findOne({
        where: { id },
        relations: { values: true },
      });
      if (!attribute)
        throw new NotFoundException(AttributeMessages.ATTRIBUTE_NOT_FOUND);

      const valueIds = (attribute.values ?? []).map((v) => v.id);
      const variantCount = valueIds.length
        ? await this.countVariantsUsingValues(manager, valueIds)
        : 0;

      if (variantCount > 0) {
        throw new ConflictException({
          error: AttributeErrorCodes.ATTRIBUTE_IN_USE,
          message: AttributeMessages.ATTRIBUTE_USED_IN_VARIANTS,
          attributeId: id,
          variantCount,
        });
      }

      await this.audit.record(
        {
          actor,
          action: AuditAction.ATTRIBUTE_DELETED,
          targetType: AuditTarget.ATTRIBUTE,
          targetId: id,
          targetLabel: attribute.name,
          summary: {
            before: {
              name: attribute.name,
              values: (attribute.values ?? []).map((v) => v.value),
            },
          },
        },
        manager,
      );

      await repo.delete(id);
    });

    // Unconditional. The previous version returned EARLY when the attribute had
    // no values, skipping invalidation entirely, so a deleted attribute went on
    // being served from `attribute:<id>` and from the cached list for an hour.
    await this.invalidate(id);
  }

  /** Same one-transaction contract as `deleteAttribute`. */
  async deleteAttributeValue(id: number, actor: AuditActor): Promise<void> {
    const attributeId = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProductAttributeValue);
      const attributeValue = await repo.findOne({
        where: { id },
        relations: { attribute: true },
      });
      if (!attributeValue)
        throw new NotFoundException(
          AttributeMessages.ATTRIBUTE_VALUE_NOT_FOUND,
        );

      const variantCount = await this.countVariantsUsingValues(manager, [id]);
      if (variantCount > 0) {
        throw new ConflictException({
          error: AttributeErrorCodes.ATTRIBUTE_IN_USE,
          message: AttributeMessages.ATTRIBUTE_VALUE_USED_IN_VARIANTS,
          attributeValueId: id,
          variantCount,
        });
      }

      const parentId = attributeValue.attribute?.id;

      await this.audit.record(
        {
          actor,
          action: AuditAction.ATTRIBUTE_VALUE_DELETED,
          targetType: AuditTarget.ATTRIBUTE_VALUE,
          targetId: id,
          targetLabel: attributeValue.value,
          summary: {
            attributeId: parentId ?? null,
            before: { value: attributeValue.value },
          },
        },
        manager,
      );

      await repo.delete(id);
      return parentId;
    });

    // The PARENT's detail key is invalidated too. Deleting a value never used
    // to touch it, so `GET /attributes/:id` kept listing the deleted value for
    // up to an hour and the product form kept offering it.
    await this.invalidate(attributeId);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Trim, drop blanks, and collapse the values that are THE SAME VALUE as far
   * as `uq_product_attribute_value_per_attribute_norm` is concerned.
   *
   * The key is `normaliseCatalogueTerm` — the TypeScript mirror of
   * `catalogue_norm()` — so `["کیف", "كيف", " کیف "]` becomes one value. The
   * FIRST spelling submitted is the one stored: the payload order is the only
   * signal available about which form the admin meant, and inventing a
   * canonical spelling would silently rewrite what they typed.
   *
   * Without this, a payload containing both spellings inserted one row and
   * then hit 23505 on the second, failing an otherwise valid request.
   */
  private dedupeValues(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const raw of values) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (!trimmed) continue;
      const key = normaliseCatalogueTerm(trimmed);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  }

  /**
   * How many DISTINCT variants use each of these values. One grouped query.
   *
   * `variant_product_attribute_value` is keyed on (variant, value), so a
   * variant cannot appear twice for one value; `DISTINCT` is stated anyway
   * because the count is used to refuse a delete and must not depend on a
   * primary key definition living in another file.
   */
  private async countVariantsPerValue(
    scope: DataSource | EntityManager,
    valueIds: number[],
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const ids = [...new Set(valueIds)].filter((n) => Number.isInteger(n));
    if (!ids.length) return out;

    const rows = await scope
      .createQueryBuilder()
      .select('vav."productAttributeValueId"', 'value_id')
      .addSelect('COUNT(DISTINCT vav."productVariantsId")', 'variant_count')
      .from('variant_product_attribute_value', 'vav')
      .where('vav."productAttributeValueId" IN (:...ids)', { ids })
      .groupBy('vav."productAttributeValueId"')
      .getRawMany<{
        value_id: number | string;
        variant_count: number | string;
      }>();

    for (const row of rows) {
      out.set(Number(row.value_id), Number(row.variant_count));
    }
    return out;
  }

  private async countVariantsUsingValues(
    manager: EntityManager,
    valueIds: number[],
  ): Promise<number> {
    const ids = [...new Set(valueIds)].filter((n) => Number.isInteger(n));
    if (!ids.length) return 0;

    const row = await manager
      .createQueryBuilder()
      .select('COUNT(DISTINCT vav."productVariantsId")', 'count')
      .from('variant_product_attribute_value', 'vav')
      .where('vav."productAttributeValueId" IN (:...ids)', { ids })
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0);
  }

  /**
   * Retire everything this service caches for one attribute.
   *
   * Both halves, always: the per-attribute detail key AND the namespace version
   * that keys the list document. Bumping only the version leaves
   * `attribute:<id>` (which is NOT versioned) serving a document that no longer
   * matches the database.
   */
  private async invalidate(attributeId?: number): Promise<void> {
    if (attributeId !== undefined) {
      await this.cacheService.invalidate(attributeKeys.detail(attributeId));
    }
    await this.cacheService.bumpVersion(CATALOG_NAMESPACES.ATTRIBUTES);
  }
}
