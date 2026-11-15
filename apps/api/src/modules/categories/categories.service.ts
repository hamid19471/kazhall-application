import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateCategoryDto } from './dto/create-category.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  CacheService,
  CATALOG_NAMESPACES,
  catalogKeys,
} from 'src/database/cache.service';
import {
  CategoryErrorCodes,
  CategoryMessages,
} from 'src/common/constants/categories.messages';
import {
  catalogueConflictOr,
  catalogueNormExpr,
  normaliseCatalogueTerm,
} from 'src/common/catalogue/catalogue-uniqueness';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { QueryCategoriesDto } from './dto/query-categories.dto';

const CATEGORY_LIST_TTL_SECONDS = 3600;
const CATEGORY_DETAIL_TTL_SECONDS = 3600;

/**
 * Category list/detail projection.
 *
 * Deliberately a COUNT, not the products themselves. The previous
 * implementation eager-loaded every `Category.products` row and cached the
 * result for an hour; with 544 products in a single category, `GET /categories`
 * serialised the entire catalog on every cold cache, and every product edit
 * silently invalidated nothing (the category cache is versioned on the
 * `categories` namespace, which product writes do not bump). Returning a count
 * removes both problems: the payload is bounded and it does not go stale when
 * a product changes.
 *
 * Callers that want the products of a category use
 * `GET /products?categoryId=<id>`, which is paginated.
 */
export interface CategoryView {
  id: number;
  title: string;
  productCount: number;
}

/** Admin row. Adds the creation timestamp the storefront has no use for. */
export interface AdminCategoryView extends CategoryView {
  createdAt: Date;
}

export interface PaginatedCategories {
  data: AdminCategoryView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface AdminCategoryRow {
  id: number | string;
  title: string;
  created_at: Date | string;
  product_count: number | string;
}

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    private readonly cacheService: CacheService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create, refusing a title that is already taken.
   *
   * TWO LAYERS, AND THEY AGREE BY CONSTRUCTION.
   *
   *  1. `assertTitleFree` — a pre-check that can name the title that clashed,
   *     so the admin gets "دسته‌ای با همین نام از قبل وجود دارد" instead of a
   *     database error. It is a SELECT-then-INSERT and therefore STILL has a
   *     TOCTOU window; it is not, and never was, a guarantee.
   *
   *  2. `uq_categories_title_norm` (migration 0025) — a unique index on
   *     `catalogue_norm(title)`. THIS is what makes the duplicate impossible.
   *     Two concurrent creates now end as exactly one 201 and one 409, and the
   *     loser's 23505 is translated into the identical refusal by
   *     `catalogueConflictOr`, so the race is invisible to the client.
   *
   * Both layers compare through the SAME PostgreSQL function, so the pre-check
   * cannot refuse what the index would allow (or vice versa, which would
   * surface as a 500). Titles are compared with ک/ك and ی/ي folded together,
   * ends trimmed and case ignored — see
   * `src/common/catalogue/catalogue-uniqueness.ts`.
   *
   * The whole act runs in one transaction so the audit row commits with the
   * category: "a category appeared and nobody knows who added it" is not a
   * representable state.
   */
  async create(
    createCategoryDto: CreateCategoryDto,
    actor: AuditActor,
  ): Promise<Category> {
    // The DTO already trimmed it; repeated here because a caller that reaches
    // the service directly (a seeder, another service) bypasses the pipe.
    const title = createCategoryDto.title.trim();

    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Category);
      await this.assertTitleFree(manager, title);

      const created = await repo
        .save(repo.create({ ...createCategoryDto, title }))
        .catch((error: unknown) => {
          throw catalogueConflictOr(error, { title });
        });

      await this.audit.record(
        {
          actor,
          action: AuditAction.CATEGORY_CREATED,
          targetType: AuditTarget.CATEGORY,
          targetId: created.id,
          targetLabel: created.title,
          summary: { after: { title: created.title } },
        },
        manager,
      );

      return created;
    });

    await this.cacheService.bumpVersion(CATALOG_NAMESPACES.CATEGORIES);
    return saved;
  }

  /** Public. Bounded payload: id, title and a product COUNT. */
  async findAll(): Promise<CategoryView[]> {
    const version = await this.cacheService.getVersion(
      CATALOG_NAMESPACES.CATEGORIES,
    );
    return this.cacheService.getOrSet(
      catalogKeys.categoryList(version),
      CATEGORY_LIST_TTL_SECONDS,
      async () => {
        const rows = await this.categoryRepository
          .createQueryBuilder('c')
          .select('c.id', 'id')
          .addSelect('c.title', 'title')
          .addSelect(
            `(SELECT COUNT(*) FROM "product_category" pc
               WHERE pc."category_id" = c."id")`,
            'product_count',
          )
          .orderBy('c.title', 'ASC')
          .getRawMany<{
            id: number | string;
            title: string;
            product_count: number | string;
          }>();

        return rows.map((r) => ({
          id: Number(r.id),
          title: r.title,
          productCount: Number(r.product_count),
        }));
      },
    );
  }

  /**
   * ADMIN list. Paginated, searchable, NOT cached.
   *
   * Not cached on purpose: this is the screen an admin refreshes straight
   * after creating or deleting a category, and the public list's hour-long TTL
   * would show them their own write missing. The public route keeps its cache.
   *
   * The product count is ONE grouped subquery evaluated by the same statement
   * that paginates — not a count per row. Ordering is `title ASC, id ASC`: the
   * id tiebreaker is kept even though titles are unique since migration 0025,
   * because an ordering whose determinism depends on a constraint declared in
   * another file breaks silently the day that constraint moves.
   */
  async findAllAdmin(query: QueryCategoriesDto): Promise<PaginatedCategories> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const base = this.categoryRepository.createQueryBuilder('c');
    if (query.search) {
      base.andWhere('LOWER(c.title) LIKE :search', {
        search: `%${query.search.toLowerCase()}%`,
      });
    }

    const total = await base.getCount();
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    if (total === 0 || (page - 1) * limit >= total) {
      return { data: [], total, page, limit, totalPages };
    }

    const rows = await base
      .clone()
      .select('c.id', 'id')
      .addSelect('c.title', 'title')
      .addSelect('c.created_at', 'created_at')
      .addSelect(
        `(SELECT COUNT(*) FROM "product_category" pc
           WHERE pc."category_id" = c."id")`,
        'product_count',
      )
      .orderBy('c.title', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<AdminCategoryRow>();

    return {
      data: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        productCount: Number(r.product_count),
        createdAt: new Date(r.created_at),
      })),
      total,
      page,
      limit,
      totalPages,
    };
  }

  async findOne(id: number): Promise<CategoryView> {
    return this.cacheService.getOrSet(
      catalogKeys.categoryDetail(id),
      CATEGORY_DETAIL_TTL_SECONDS,
      async () => {
        const category = await this.categoryRepository.findOne({
          where: { id },
          select: { id: true, title: true },
        });
        if (!category)
          throw new NotFoundException(CategoryMessages.CATEGORY_NOT_FOUND);

        return {
          id: category.id,
          title: category.title,
          productCount: await this.countProducts(id),
        };
      },
    );
  }

  /**
   * Rename. Membership is untouched — see `UpdateCategoryDto`.
   *
   * The read that feeds the write BYPASSES THE CACHE: writing back a value
   * taken from the cached document would let an hour-old title win over the
   * authoritative row.
   */
  async rename(
    id: number,
    rawTitle: string,
    actor: AuditActor,
  ): Promise<Category> {
    const title = rawTitle.trim();

    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Category);
      const category = await repo.findOne({ where: { id } });
      if (!category)
        throw new NotFoundException(CategoryMessages.CATEGORY_NOT_FOUND);

      const before = category.title;
      // THE RENAME PATH IS COVERED TOO, not just create: renaming INTO an
      // existing title produces exactly the duplicate the create check exists
      // to prevent, and two concurrent renames onto the same new title race
      // each other in precisely the same way. `assertTitleFree` is the good
      // message; `uq_categories_title_norm` is the guarantee, and the `.catch`
      // below turns its 23505 into the same 409.
      //
      // The "did it actually change" test uses the SAME normalisation as the
      // index — comparing with `toLowerCase()` alone would skip the pre-check
      // when only a ک/ك differed and let a needless probe through.
      if (normaliseCatalogueTerm(before) !== normaliseCatalogueTerm(title)) {
        await this.assertTitleFree(manager, title, id);
      }

      category.title = title;
      const updated = await repo.save(category).catch((error: unknown) => {
        throw catalogueConflictOr(error, { title });
      });

      await this.audit.record(
        {
          actor,
          action: AuditAction.CATEGORY_UPDATED,
          targetType: AuditTarget.CATEGORY,
          targetId: id,
          targetLabel: updated.title,
          summary: { before: { title: before }, after: { title } },
        },
        manager,
      );

      return updated;
    });

    await this.invalidate(id);
    return saved;
  }

  /**
   * THE delete. Refuses while any product is still attached.
   *
   * The count is taken INSIDE the transaction, through the caller's manager,
   * so it sees the same snapshot the DELETE will run against; counting outside
   * would leave a window in which the last product is attached between the
   * check and the delete.
   *
   * Refusing (409) rather than detaching is the whole point: a category is
   * navigation, and a delete that silently strips `product_category` rows loses
   * catalogue structure that nothing records and nobody can reconstruct.
   */
  async safeRemove(id: number, actor: AuditActor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Category);
      const category = await repo.findOne({ where: { id } });
      if (!category)
        throw new NotFoundException(CategoryMessages.CATEGORY_NOT_FOUND);

      const productCount = await this.countProducts(id, manager);
      if (productCount > 0) {
        throw new ConflictException({
          error: CategoryErrorCodes.CATEGORY_IN_USE,
          message: CategoryMessages.CATEGORY_HAS_PRODUCTS,
          categoryId: id,
          productCount,
        });
      }

      await this.audit.record(
        {
          actor,
          action: AuditAction.CATEGORY_DELETED,
          targetType: AuditTarget.CATEGORY,
          targetId: id,
          targetLabel: category.title,
          summary: { before: { title: category.title, productCount: 0 } },
        },
        manager,
      );

      await repo.remove(category);
    });

    await this.invalidate(id);
  }

  /**
   * Title collision pre-check, through the SAME `catalogue_norm()` the unique
   * index is built on.
   *
   * Written as `catalogue_norm(c.title) = catalogue_norm(:title)` rather than
   * `LOWER(...) = LOWER(...)`: with the old comparison the application would
   * have accepted «كيف» beside «کیف» and then been refused by the index with a
   * raw 500. Two sides, one definition, no disagreement possible.
   *
   * The index — not this — is the guarantee; see `create`.
   */
  private async assertTitleFree(
    manager: EntityManager,
    title: string,
    exceptId?: number,
  ): Promise<void> {
    const qb = manager
      .getRepository(Category)
      .createQueryBuilder('c')
      .where(
        `${catalogueNormExpr('c.title')} = ${catalogueNormExpr(':title')}`,
        { title },
      );
    if (exceptId !== undefined) {
      qb.andWhere('c.id <> :exceptId', { exceptId });
    }

    if (await qb.getExists()) {
      throw new ConflictException({
        error: CategoryErrorCodes.CATEGORY_TITLE_TAKEN,
        message: CategoryMessages.CATEGORY_TITLE_TAKEN,
        title,
      });
    }
  }

  private async countProducts(
    categoryId: number,
    scope: DataSource | EntityManager = this.dataSource,
  ): Promise<number> {
    const row = await scope
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from('product_category', 'pc')
      .where('pc.category_id = :categoryId', { categoryId })
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0);
  }

  private async invalidate(id: number): Promise<void> {
    await this.cacheService.invalidate(catalogKeys.categoryDetail(id));
    await this.cacheService.bumpVersion(CATALOG_NAMESPACES.CATEGORIES);
    // A category deletion changes product_category, so product list pages
    // filtered by category are stale too.
    await this.cacheService.bumpVersion(CATALOG_NAMESPACES.PRODUCTS);
  }
}
