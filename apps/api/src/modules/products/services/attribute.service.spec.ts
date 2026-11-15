import { DataSource, DeleteResult, EntityManager, Repository } from 'typeorm';
import { ProductAttributeValue } from '../entities/product-attribute-value.entity';
import { ProductAttribute } from '../entities/product-attribute.entity';
import { AttributeService } from './attribute.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { CreateAttributeDto } from '../dto/create-attribute.dto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CacheService } from 'src/database/cache.service';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';

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

/** Every write path now runs inside `dataSource.transaction`, so the audit row
 * commits with the change. The fake manager dispatches `getRepository` to the
 * same mocks the service used to reach directly, which keeps these assertions
 * about BEHAVIOUR rather than about which object the call went through. */
const ACTOR: AuditActor = {
  userId: 1,
  display: 'admin',
  audience: 'admin',
  requestId: null,
};

describe('AttributeService', () => {
  let service: AttributeService;
  let productAttributeRepository: jest.Mocked<Repository<ProductAttribute>>;
  let productAttributeValueRepository: jest.Mocked<
    Repository<ProductAttributeValue>
  >;
  let cacheService: jest.Mocked<CacheService>;
  let audit: jest.Mocked<AuditService>;
  /** Rows the in-use count query answers with. */
  let variantUsageCount: string;
  /**
   * Hoisted out of `beforeEach` so a case can both DRIVE it
   * (`getExists.mockResolvedValue(true)`) and ASSERT on it: the duplicate
   * probes are query builders now, because they compare through
   * `catalogue_norm()` rather than by exact match.
   */
  let queryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    from: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
    getRawOne: jest.Mock;
    getRawMany: jest.Mock;
    getExists: jest.Mock;
  };

  beforeEach(async () => {
    variantUsageCount = '0';

    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(() => Promise.resolve({ count: variantUsageCount })),
      getRawMany: jest.fn(() => Promise.resolve([])),
      getExists: jest.fn(() => Promise.resolve(false)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AttributeService,
        {
          provide: getRepositoryToken(ProductAttribute),
          useValue: {
            findOne: jest.fn(),
            findOneOrFail: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
        {
          provide: getRepositoryToken(ProductAttributeValue),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
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
        {
          provide: AuditService,
          useValue: { record: jest.fn(), recordDetached: jest.fn() },
        },
        {
          provide: DataSource,
          useValue: {
            createQueryBuilder: jest.fn(() => queryBuilder),
            transaction: jest.fn(
              (cb: (manager: EntityManager) => Promise<unknown>) => {
                const manager = {
                  getRepository: (entity: unknown) =>
                    entity === ProductAttribute
                      ? productAttributeRepository
                      : productAttributeValueRepository,
                  createQueryBuilder: () => queryBuilder,
                } as unknown as EntityManager;
                return cb(manager);
              },
            ),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AttributeService);
    productAttributeRepository = moduleRef.get(
      getRepositoryToken(ProductAttribute),
    );
    productAttributeValueRepository = moduleRef.get(
      getRepositoryToken(ProductAttributeValue),
    );
    cacheService = moduleRef.get(CacheService);
    audit = moduleRef.get(AuditService);
  });

  describe('create', () => {
    it('should create an attribute with its values and RETURN it', async () => {
      // Arrange
      const createAttributeDto: CreateAttributeDto = {
        name: 'color',
        values: ['red', 'blue'],
      };

      const newAttribute = {
        id: 1,
        name: 'color',
        values: [{ value: 'red' }, { value: 'blue' }],
      } as ProductAttribute;

      productAttributeRepository.create.mockReturnValue(newAttribute);
      productAttributeRepository.save.mockResolvedValue(newAttribute);

      // Act
      const result = await service.create(createAttributeDto, ACTOR);

      // Assert
      //
      // The name probe is now a query builder comparing through
      // `catalogue_norm` on BOTH sides — the same expression
      // `uq_product_attribute_name_norm` is built on — rather than
      // `findOne({ where: { name } })`, which was exact-match and therefore
      // accepted «كيف» beside «کیف» only to be refused by the index.
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'catalogue_norm(a.name) = catalogue_norm(:name)',
        { name: createAttributeDto.name },
      );
      // THE GLOBAL VALUE LOOKUP IS GONE. Values are unique WITHIN ONE
      // ATTRIBUTE, so a brand-new attribute has nothing to collide with except
      // its own payload (see the de-duplication case below).
      expect(productAttributeValueRepository.find).not.toHaveBeenCalled();
      expect(productAttributeRepository.create).toHaveBeenCalledWith({
        name: createAttributeDto.name,
        values: [{ value: 'red' }, { value: 'blue' }],
      });
      expect(productAttributeRepository.save).toHaveBeenCalledWith(
        newAttribute,
      );
      expect(cacheService.bumpVersion).toHaveBeenCalledWith('attributes');
      // It used to return undefined, so the controller answered
      // `{ data: undefined }` and the caller had no id to follow up with.
      expect(result).toEqual(newAttribute);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'attribute.created' }),
        expect.anything(),
      );
    });

    /**
     * WAS "should throw BadRequestException if attribute name already exists".
     *
     * The refusal is the same; its STATUS is not. `renameAttribute` already
     * answered 409 `ATTRIBUTE_ALREADY_EXISTS` for the identical situation, so
     * a client could not branch on "this name is taken" without also knowing
     * which endpoint it had called. Create now agrees with rename.
     */
    it('refuses a taken attribute name with 409 ATTRIBUTE_ALREADY_EXISTS', async () => {
      // Arrange: the normalised collision probe says the name is taken.
      queryBuilder.getExists.mockResolvedValue(true);

      // Act & Assert
      await expect(
        service.create({ name: 'color', values: ['red'] }, ACTOR),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          error: 'ATTRIBUTE_ALREADY_EXISTS',
        }),
      });

      expect(productAttributeRepository.create).not.toHaveBeenCalled();
      expect(productAttributeRepository.save).not.toHaveBeenCalled();
    });

    /**
     * WAS "should throw BadRequestException if some attribute values already
     * exist" — a GLOBAL check that has been deliberately removed. Values are
     * unique WITHIN ONE ATTRIBUTE («قرمز» may belong to both «رنگ» and «رنگ
     * آستر»), which is what `addValues` always promised and what migration
     * 0025 enforces.
     *
     * What replaces it: the payload's own duplicates are COLLAPSED, using the
     * same normalisation as the index. Submitting both spellings of one word
     * used to insert one row and then die on 23505 for the other.
     */
    it('collapses values that normalise to the same term, keeping the first spelling', async () => {
      const created = { id: 1, name: 'color', values: [] } as ProductAttribute;
      productAttributeRepository.create.mockReturnValue(created);
      productAttributeRepository.save.mockResolvedValue(created);

      // "کیف" (Persian keheh + yeh), "كيف" (Arabic kaf + yeh) and "  کیف  "
      // are ONE value; "Red" and "red" are one value too.
      await service.create(
        {
          name: 'color',
          values: [
            '\u06a9\u06cc\u0641',
            '\u0643\u064a\u0641',
            '  \u06a9\u06cc\u0641  ',
            'Red',
            'red',
          ],
        },
        ACTOR,
      );

      expect(productAttributeRepository.create).toHaveBeenCalledWith({
        name: 'color',
        values: [{ value: '\u06a9\u06cc\u0641' }, { value: 'Red' }],
      });
    });

    it('refuses a payload whose values are all blank', async () => {
      await expect(
        service.create({ name: 'color', values: ['   ', ''] }, ACTOR),
      ).rejects.toThrow(BadRequestException);

      expect(productAttributeRepository.save).not.toHaveBeenCalled();
    });
  });
  describe('findAll', () => {
    it('should return all attributes with their values', async () => {
      // Arrange
      const fakeAttributes = [
        { id: 1, name: 'color', values: [] },
        { id: 2, name: 'size', values: [] },
      ] as ProductAttribute[];

      productAttributeRepository.find.mockResolvedValue(fakeAttributes);

      // Act
      const result = await service.findAll();

      // Assert
      expect(cacheService.getVersion).toHaveBeenCalledWith('attributes');
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        'attributes:list:v1',
        3600,
        expect.any(Function),
      );
      expect(productAttributeRepository.find).toHaveBeenCalledWith({
        // Object relations form, matching AttributeService.
        relations: { values: true },
      });
      expect(result).toEqual(fakeAttributes);
    });
  });
  describe('findOne', () => {
    it('should return the attribute by id successfully', async () => {
      // Arrange
      const attributeId = 1;
      const fakeAttribute = {
        id: attributeId,
        name: 'color',
        values: [{ id: 1, value: 'red' }],
      } as ProductAttribute;

      productAttributeRepository.findOne.mockResolvedValue(fakeAttribute);

      // Act
      const result = await service.findOne(attributeId);

      // Assert
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        `attribute:${attributeId}`,
        3600,
        expect.any(Function),
      );
      expect(productAttributeRepository.findOne).toHaveBeenCalledWith({
        where: { id: attributeId },
        // Object relations form, matching AttributeService.
        relations: { values: true },
      });
      expect(result).toEqual(fakeAttribute);
    });

    it('should throw NotFoundException if attribute is not found', async () => {
      // Arrange
      const attributeId = 1;

      productAttributeRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.findOne(attributeId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  describe('deleteAttribute', () => {
    it('INVALIDATES the cache even when the attribute had no values', async () => {
      // Arrange
      const attributeId = 1;
      const fakeAttribute = {
        id: attributeId,
        name: 'color',
        values: [],
      } as unknown as ProductAttribute;

      productAttributeRepository.findOne.mockResolvedValue(fakeAttribute);
      productAttributeRepository.delete.mockResolvedValue({
        affected: 1,
        raw: [],
      } as DeleteResult);

      // Act
      await service.deleteAttribute(attributeId, ACTOR);

      // Assert
      expect(productAttributeRepository.delete).toHaveBeenCalledWith(
        attributeId,
      );
      // REGRESSION GUARD. This branch used to return early WITHOUT
      // invalidating, so a deleted attribute went on being served from
      // `attribute:<id>` and from the cached list for a full hour.
      expect(cacheService.invalidate).toHaveBeenCalledWith(
        `attribute:${attributeId}`,
      );
      expect(cacheService.bumpVersion).toHaveBeenCalledWith('attributes');
    });

    it('should delete the attribute and its values when none of them are used in a variant', async () => {
      // Arrange
      const attributeId = 1;
      const fakeAttribute = {
        id: attributeId,
        name: 'color',
        values: [
          { id: 10, value: 'red' },
          { id: 11, value: 'blue' },
        ],
      } as ProductAttribute;

      productAttributeRepository.findOne.mockResolvedValue(fakeAttribute);
      variantUsageCount = '0';
      productAttributeRepository.delete.mockResolvedValue({
        affected: 1,
        raw: [],
      } as DeleteResult);

      // Act
      await service.deleteAttribute(attributeId, ACTOR);

      // Assert
      expect(productAttributeRepository.delete).toHaveBeenCalledWith(
        attributeId,
      );
      expect(cacheService.invalidate).toHaveBeenCalledWith(
        `attribute:${attributeId}`,
      );
      expect(cacheService.bumpVersion).toHaveBeenCalledWith('attributes');
    });

    it('should throw ConflictException carrying the variant count when the attribute is in use', async () => {
      // Arrange
      const attributeId = 1;
      const fakeAttribute = {
        id: attributeId,
        name: 'color',
        values: [{ id: 10, value: 'red' }],
      } as ProductAttribute;

      productAttributeRepository.findOne.mockResolvedValue(fakeAttribute);
      variantUsageCount = '3';

      // Act & Assert
      // 409, not 400: the request is well-formed and the refusal is about the
      // state of the catalogue, which is what a client needs to branch on.
      await expect(
        service.deleteAttribute(attributeId, ACTOR),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          error: 'ATTRIBUTE_IN_USE',
          variantCount: 3,
        }),
      });
      await expect(service.deleteAttribute(attributeId, ACTOR)).rejects.toThrow(
        ConflictException,
      );

      expect(productAttributeRepository.delete).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if attribute does not exist', async () => {
      // Arrange
      const attributeId = 1;

      productAttributeRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.deleteAttribute(attributeId, ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expect(productAttributeRepository.delete).not.toHaveBeenCalled();
    });
  });
  describe('deleteAttributeValue', () => {
    it('should delete the value and invalidate the PARENT attribute document', async () => {
      // Arrange
      const attributeValueId = 10;
      const fakeAttributeValue = {
        id: attributeValueId,
        value: 'red',
        attribute: { id: 7, name: 'color' },
      } as ProductAttributeValue;

      productAttributeValueRepository.findOne.mockResolvedValue(
        fakeAttributeValue,
      );
      variantUsageCount = '0';
      productAttributeValueRepository.delete.mockResolvedValue({
        affected: 1,
        raw: [],
      } as DeleteResult);

      // Act
      await service.deleteAttributeValue(attributeValueId, ACTOR);

      // Assert
      expect(productAttributeValueRepository.findOne).toHaveBeenCalledWith({
        where: { id: attributeValueId },
        relations: { attribute: true },
      });
      expect(productAttributeValueRepository.delete).toHaveBeenCalledWith(
        attributeValueId,
      );
      // REGRESSION GUARD. Deleting a value never used to touch the parent's
      // detail key, so `GET /attributes/7` kept offering the deleted value.
      expect(cacheService.invalidate).toHaveBeenCalledWith('attribute:7');
      expect(cacheService.bumpVersion).toHaveBeenCalledWith('attributes');
    });

    it('should throw NotFoundException if attribute value is not found', async () => {
      // Arrange
      const attributeValueId = 10;

      productAttributeValueRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(
        service.deleteAttributeValue(attributeValueId, ACTOR),
      ).rejects.toThrow(NotFoundException);

      expect(productAttributeValueRepository.delete).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if attribute value is used in a variant', async () => {
      // Arrange
      const attributeValueId = 10;
      const fakeAttributeValue = {
        id: attributeValueId,
        value: 'red',
        attribute: { id: 7, name: 'color' },
      } as ProductAttributeValue;

      productAttributeValueRepository.findOne.mockResolvedValue(
        fakeAttributeValue,
      );
      variantUsageCount = '2';

      // Act & Assert
      await expect(
        service.deleteAttributeValue(attributeValueId, ACTOR),
      ).rejects.toThrow(ConflictException);

      expect(productAttributeValueRepository.delete).not.toHaveBeenCalled();
    });
  });
});
