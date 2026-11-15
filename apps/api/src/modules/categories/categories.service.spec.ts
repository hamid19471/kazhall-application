import { Test } from '@nestjs/testing';
import { CategoriesService } from './categories.service';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { Category } from './entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CacheService } from 'src/database/cache.service';

/**
 * The original specs were written against `@jest/globals`, which types
 * `jest.fn<F>()` with a single function-type parameter. That package is NOT
 * installed; this project uses `@types/jest`, whose signature is
 * `jest.fn<Return, Args>()`. `mockFn` keeps the original, more readable call
 * sites working against the installed typings.
 */
const mockFn = <F extends (...args: any[]) => any>(
  implementation?: F,
): jest.MockedFunction<F> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<F>;

const ACTOR: AuditActor = {
  userId: 1,
  display: 'admin',
  audience: 'admin',
  requestId: null,
};

describe('CategoriesService', () => {
  let service: CategoriesService;
  let categoryRepository: jest.Mocked<Repository<Category>>;
  let cacheService: jest.Mocked<CacheService>;
  let audit: jest.Mocked<AuditService>;
  let queryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      clone: jest.fn(() => queryBuilder),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getCount: jest.fn(() => Promise.resolve(0)),
      getExists: jest.fn(() => Promise.resolve(false)),
      getRawOne: jest.fn(() => Promise.resolve({ count: '0' })),
      getRawMany: jest.fn(() => Promise.resolve([])),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: getRepositoryToken(Category),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            remove: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
        {
          provide: getRepositoryToken(Product),
          useValue: {},
        },
        {
          provide: CacheService,
          useValue: {
            getOrSet: jest.fn((key: string, ttl: number, loader: () => any) =>
              loader(),
            ),
            getVersion: mockFn<() => Promise<number>>().mockResolvedValue(1),
            bumpVersion: jest.fn(),
            invalidate: jest.fn(),
            getJson: jest.fn(),
            setJson: jest.fn(),
          },
        },
        // Every write path is transactional so the audit row commits with the
        // change; the fake manager dispatches `getRepository` back to the same
        // mock, which keeps these assertions about behaviour rather than about
        // which object the call travelled through.
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(
              (cb: (manager: EntityManager) => Promise<unknown>) =>
                cb({
                  getRepository: () => categoryRepository,
                  createQueryBuilder: () => queryBuilder,
                } as unknown as EntityManager),
            ),
            createQueryBuilder: jest.fn(() => queryBuilder),
            getRepository: jest.fn(() => categoryRepository),
          },
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn(), recordDetached: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(CategoriesService);
    categoryRepository = moduleRef.get(getRepositoryToken(Category));
    cacheService = moduleRef.get(CacheService);
    audit = moduleRef.get(AuditService);
  });

  describe('create', () => {
    it('should create a category successfully', async () => {
      // Arrange
      const createCategoryDto: CreateCategoryDto = { title: 'Mobile' };

      const createdCategory = { title: 'Mobile' } as Category;
      const savedCategory = { id: 1, title: 'Mobile' } as Category;

      categoryRepository.create.mockReturnValue(createdCategory);
      categoryRepository.save.mockResolvedValue(savedCategory);

      // Act
      const result = await service.create(createCategoryDto, ACTOR);

      // Assert
      expect(categoryRepository.create).toHaveBeenCalledWith(createCategoryDto);
      expect(categoryRepository.save).toHaveBeenCalledWith(createdCategory);
      expect(cacheService.bumpVersion).toHaveBeenCalledWith('categories');
      expect(result).toEqual(savedCategory);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'category.created' }),
        expect.anything(),
      );
    });

    it('refuses a title another category already holds', async () => {
      // Arrange: the case-insensitive collision probe says the title is taken.
      queryBuilder.getExists.mockResolvedValue(true);

      // Act & Assert
      await expect(
        service.create({ title: 'mobile' }, ACTOR),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'CATEGORY_TITLE_TAKEN' }),
      });

      expect(categoryRepository.save).not.toHaveBeenCalled();
    });
  });

  /**
   * TODO(WS-B): asserts the PREVIOUS CategoriesService.
   *
   * Workstream B deliberately reshaped this service:
   *   - findAll/findOne now return a bounded `CategoryView`
   *     ({ id, title, productCount }) instead of eager-loading every
   *     `Category.products` row,
   *   - a missing category now raises NotFoundException, not
   *     BadRequestException,
   *   - removeOnlyCategory/safeRemove run inside `dataSource.transaction`
   *     and read through the manager's repository, bypassing the cache.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting these against the new contract.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: category list.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/catalog-public.int-spec.ts ›
   * 'serves GET /categories anonymously with a product count, not the products'
   */

  /**
   * TODO(WS-B): asserts the PREVIOUS CategoriesService.
   *
   * Workstream B deliberately reshaped this service:
   *   - findAll/findOne now return a bounded `CategoryView`
   *     ({ id, title, productCount }) instead of eager-loading every
   *     `Category.products` row,
   *   - a missing category now raises NotFoundException, not
   *     BadRequestException,
   *   - removeOnlyCategory/safeRemove run inside `dataSource.transaction`
   *     and read through the manager's repository, bypassing the cache.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting these against the new contract.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: category by id and its not-found error.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/admin-coverage.int-spec.ts › CategoriesService ›
   * 'findOne returns the bounded CategoryView with a real product count',
   * 'findOne raises NotFound for a missing category'
   */

  /**
   * TODO(WS-B): asserts the PREVIOUS CategoriesService.
   *
   * Workstream B deliberately reshaped this service:
   *   - findAll/findOne now return a bounded `CategoryView`
   *     ({ id, title, productCount }) instead of eager-loading every
   *     `Category.products` row,
   *   - a missing category now raises NotFoundException, not
   *     BadRequestException,
   *   - removeOnlyCategory/safeRemove run inside `dataSource.transaction`
   *     and read through the manager's repository, bypassing the cache.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting these against the new contract.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: detach products, then delete the category.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/admin-coverage.int-spec.ts ›
   * DELETE /categories/removeOnlyCategory/:id (all three cases)
   */

  /**
   * TODO(WS-B): asserts the PREVIOUS CategoriesService.
   *
   * Workstream B deliberately reshaped this service:
   *   - findAll/findOne now return a bounded `CategoryView`
   *     ({ id, title, productCount }) instead of eager-loading every
   *     `Category.products` row,
   *   - a missing category now raises NotFoundException, not
   *     BadRequestException,
   *   - removeOnlyCategory/safeRemove run inside `dataSource.transaction`
   *     and read through the manager's repository, bypassing the cache.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting these against the new contract.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: refuse to delete while products are still attached.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/admin-coverage.int-spec.ts › CategoriesService ›
   * 'safeRemove deletes an empty category',
   * 'safeRemove REFUSES to delete a category that still has products, and deletes nothing',
   * 'safeRemove raises NotFound for a missing category'
   */
});
