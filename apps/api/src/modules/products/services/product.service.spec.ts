/**
 * uuid@14 ships ESM only (`export ...` in dist-node/index.js). jest 29's CJS
 * runtime cannot `require()` it, and this suite reaches it transitively:
 *   product.service.spec -> products.service -> common/storage/object-storage.service
 * The whole suite therefore failed to load with
 * `SyntaxError: Unexpected token 'export'` before a single test ran.
 *
 * `crypto.randomUUID()` is a CSPRNG-backed RFC 4122 v4 UUID — the same
 * guarantee `uuid.v4()` gives — so nothing under test changes.
 *
 * NOTE FOR THE LEAD: the durable fix is one line in package.json's jest
 * `moduleNameMapper`, alongside the `^src/(.*)$` entry:
 *   "^uuid$": "<rootDir>/../test/integration/setup/uuid-cjs-shim.ts"
 * test/jest-integration.json already carries it. This local mock can then go.
 */
jest.mock('uuid', () => ({
  v4: () => {
    const { randomUUID } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:crypto') as typeof import('node:crypto');
    return randomUUID();
  },
}));

import { ServiceUnavailableException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { DataSource, Repository } from 'typeorm';
import { Product } from '../entities/product.entity';
import { Category } from 'src/modules/categories/entities/category.entity';
import { UserService } from 'src/modules/user/user.service';
import { ProductVariant } from '../entities/product-variant.entity';
import { ProductImage } from '../entities/product-image.entity';
import { ObjectStorageService } from 'src/common/storage/object-storage.service';
import { ObjectDeletionService } from 'src/common/storage/object-deletion.service';
import { PRODUCT_IMAGE_MAX_BYTES } from 'src/common/storage/storage.module';
import {
  JPEG_8X8,
  NOT_AN_IMAGE,
  PNG_8X8,
  oversizedPng,
} from '../../../../test/support/image-fixtures';
import { CacheService, CatalogCacheService } from 'src/database/cache.service';
import { ProductCodeService } from './product-code.service';
import { ProductVisibilityService } from './product-visibility.service';
import { ProductAttributeValue } from '../entities/product-attribute-value.entity';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common/exceptions/not-found.exception';
import { InventoryService } from 'src/modules/inventory/inventory.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

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

describe('ProductsService', () => {
  let service: ProductsService;
  let productRepository: jest.Mocked<Repository<Product>>;
  let productImageRepository: jest.Mocked<Repository<ProductImage>>;
  let storage: jest.Mocked<ObjectStorageService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        {
          provide: getRepositoryToken(Product),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Category),
          useValue: {
            findBy: jest.fn(),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ProductVariant),
          useValue: {
            create: jest.fn(),
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ProductAttributeValue),
          useValue: {
            findBy: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ProductImage),
          useValue: {
            findBy: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: ObjectStorageService,
          useValue: {
            putImage: jest.fn(),
            deleteObject: jest.fn().mockResolvedValue(true),
            isAvailable: jest.fn().mockReturnValue(true),
            publicUrlFor: jest.fn(),
          },
        },
        {
          /*
           * The durable deletion lifecycle. Mocked rather than exercised here:
           * what it guarantees is a property of a real transaction and a real
           * bucket, so it is proven in
           * `test/integration/object-deletion-durability.int-spec.ts`. These
           * unit tests only need it to exist so the service can be built.
           */
          provide: ObjectDeletionService,
          useValue: {
            enqueue: jest.fn().mockResolvedValue(undefined),
            enqueueStandalone: jest.fn().mockResolvedValue(true),
            finaliseByKey: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          // The validated ceiling. A literal here, so a change to the default
          // cannot silently change what these tests assert.
          provide: PRODUCT_IMAGE_MAX_BYTES,
          useValue: 1024 * 1024,
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
        // Dependencies ProductsService grew when workstream B moved
        // availability behind the inventory contract. Without stubs Nest DI
        // cannot construct the service and every test fails before Arrange.
        /*
         * Both are reached only on the create/update paths, which this spec
         * does not exercise — it covers `findOne` and `upload`. They are
         * provided as THROWING stubs rather than `{}` so that a future case
         * which does reach them fails loudly instead of passing on undefined.
         */
        {
          provide: ProductCodeService,
          useValue: {
            nextProductCode: () => {
              throw new Error('ProductCodeService must not be reached here');
            },
            nextVariantCode: () => {
              throw new Error('ProductCodeService must not be reached here');
            },
          },
        },
        {
          provide: ProductVisibilityService,
          useValue: {
            read: () => {
              throw new Error(
                'ProductVisibilityService must not be reached here',
              );
            },
            readView: () => {
              throw new Error(
                'ProductVisibilityService must not be reached here',
              );
            },
            resolve: () => {
              throw new Error(
                'ProductVisibilityService must not be reached here',
              );
            },
            persist: () => {
              throw new Error(
                'ProductVisibilityService must not be reached here',
              );
            },
          },
        },
        {
          provide: CatalogCacheService,
          useValue: {
            invalidateProduct: jest.fn(),
            invalidateVariantAvailability: jest.fn(),
            bumpCatalog: jest.fn(),
            getProductDocument: jest.fn(),
            setProductDocument: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(),
            createQueryBuilder: jest.fn(),
            getRepository: jest.fn(),
          },
        },
        {
          provide: InventoryService,
          useValue: {
            getAvailability: jest.fn(),
            adjustStock: jest.fn(),
            lockVariants: jest.fn(),
            expireDueReservations: jest.fn(),
          },
        },
        // Product create/update write an audit row inside their transaction.
        // Without a stub Nest DI cannot construct the service and every test
        // fails before Arrange.
        {
          provide: AuditService,
          useValue: { record: jest.fn(), recordDetached: jest.fn() },
        },
        /*
         * A stock adjustment and a variant retirement now announce themselves,
         * post-commit, so the service takes the gateway.
         *
         * Only the two SCOPED emitters are stubbed — deliberately no `server`.
         * If this service ever grows a `server.emit(...)` call (the global
         * broadcast that leaked order data to every connected socket before
         * `emitOrderEvent` existed) it will fail here rather than pass
         * silently.
         */
        {
          provide: RealtimeGateway,
          useValue: {
            emitStockEvent: jest.fn(),
            emitAvailabilityEvent: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ProductsService);
    productRepository = moduleRef.get(getRepositoryToken(Product));
    productImageRepository = moduleRef.get(getRepositoryToken(ProductImage));
    storage = moduleRef.get(ObjectStorageService);
  });

  /**
   * TODO(WS-B): asserts the PREVIOUS ProductsService.
   *
   * Workstream B rewrote create/findAll/update to run inside
   * `dataSource.transaction(...)` (so a product and its variants/images commit
   * atomically) and to resolve availability through the inventory contract
   * rather than reading `variant.stock` directly. These cases still stub the
   * flat repository calls the old implementation made, so they fail on the
   * transaction boundary rather than on any behaviour worth asserting.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: `POST /products` create path.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/admin-coverage.int-spec.ts › POST /products ›
   * 'persists a product with its categories and gives it a default sellable variant',
   * 'rolls the whole creation back when a category id is unknown',
   * 'refuses an unauthenticated caller'
   */
  /**
   * TODO(WS-B): asserts the PREVIOUS ProductsService.
   *
   * Workstream B rewrote create/findAll/update to run inside
   * `dataSource.transaction(...)` (so a product and its variants/images commit
   * atomically) and to resolve availability through the inventory contract
   * rather than reading `variant.stock` directly. These cases still stub the
   * flat repository calls the old implementation made, so they fail on the
   * transaction boundary rather than on any behaviour worth asserting.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: product list + cache key/version behaviour.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/catalog-public.int-spec.ts ›
   * 'serves GET /products anonymously and leaks no cart or user data'
   * and the search / filter / sort / paginate block
   */

  describe('findOne', () => {
    // TODO(WS-B): findOne now returns a cached product DOCUMENT with
    // per-variant availability resolved through InventoryService, not the raw
    // entity with eager relations this case asserts.
    /**
     * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
     *
     * Proved: product detail read.
     * It drove a MOCKED repository, so it could only ever confirm that the
     * mock was called with a particular object — never that anything was
     * persisted or that any rule held. Leaving it as `describe.skip` reported
     * phantom coverage in the test count without testing anything.
     *
     * REPLACED BY (real PostgreSQL, real routes, currently passing):
     *   test/integration/catalog-public.int-spec.ts ›
     * 'serves GET /products/:id anonymously with no cart, user or stock fields',
     * 'caching a detail document cannot resurrect cart data for a later caller'
     */

    it('should throw NotFoundException if product is not found', async () => {
      // Arrange
      const productId = 1;

      productRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.findOne(productId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  /**
   * TODO(WS-B): asserts the PREVIOUS ProductsService.
   *
   * Workstream B rewrote create/findAll/update to run inside
   * `dataSource.transaction(...)` (so a product and its variants/images commit
   * atomically) and to resolve availability through the inventory contract
   * rather than reading `variant.stock` directly. These cases still stub the
   * flat repository calls the old implementation made, so they fail on the
   * transaction boundary rather than on any behaviour worth asserting.
   * Skipped rather than deleted so the coverage gap stays visible; workstream B
   * owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: field / category / variant update and its NotFound paths.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/product-update-contract.int-spec.ts (all four cases)
   * and test/integration/product-variant-integrity.int-spec.ts ›
   * 'rejects a foreign variant id through PATCH /products/:id'
   */
  /**
   * TODO(WS-B): these four cases assert the OLD bookmark implementation —
   * `bookmark(dto)` loading the product with its `users` relation, mutating the
   * array in memory and calling `productRepository.save()`.
   *
   * Workstream B deliberately replaced it with `bookmark(userId, productId)`
   * driven by a junction-table relation query, and removed `userId` from
   * BookmarkProductDto so the bookmarked user can only ever be the
   * authenticated caller (the old DTO was an IDOR: any user could bookmark on
   * behalf of anyone). The call sites below are updated to the new signature so
   * the file compiles, but the ASSERTIONS still describe the removed behaviour.
   * Skipped rather than deleted so the coverage gap stays visible — workstream
   * B owns rewriting them.
   */
  /**
   * REMOVED, NOT SKIPPED — it asserted a contract that no longer exists.
   *
   * Proved: bookmark toggle on/off and its NotFound paths.
   * It drove a MOCKED repository, so it could only ever confirm that the
   * mock was called with a particular object — never that anything was
   * persisted or that any rule held. Leaving it as `describe.skip` reported
   * phantom coverage in the test count without testing anything.
   *
   * REPLACED BY (real PostgreSQL, real routes, currently passing):
   *   test/integration/product-bookmark.int-spec.ts (all six cases). The
   * 'unknown user' case is now structurally impossible: `userId` comes from
   * the token, asserted by 'binds the bookmark to the token subject, never to
   * a body field'
   */
  /**
   * UPLOAD — the storage/database seam.
   *
   * These are the cases that need no PostgreSQL and no MinIO to be meaningful:
   * what the service does with the bytes it was handed, and what it does when
   * one of the two systems it writes to fails. Everything that needs a real
   * bucket (public URL shape, bucket-missing, round trip) is proven in
   * `test/integration/product-image-upload.int-spec.ts` against a disposable
   * MinIO, because mocking an S3 client only proves the mock.
   */
  describe('upload', () => {
    const storedObject = {
      key: 'products/2026/09/11111111-2222-3333-4444-555555555555.png',
      url: 'https://cdn.example.com/products/2026/09/11111111-2222-3333-4444-555555555555.png',
      bytes: PNG_8X8.byteLength,
      contentType: 'image/png' as const,
    };

    const fileOf = (buffer: Buffer, mimetype = 'image/png') =>
      ({
        originalname: 'photo.png',
        mimetype,
        size: buffer.byteLength,
        buffer,
      }) as Express.Multer.File;

    it('stores the object and persists the row with its key', async () => {
      const created = { url: storedObject.url } as ProductImage;
      const saved = { ...created, id: 1 } as ProductImage;

      storage.putImage.mockResolvedValue(storedObject);
      productImageRepository.create.mockReturnValue(created);
      productImageRepository.save.mockResolvedValue(saved);

      const result = await service.upload(fileOf(PNG_8X8));

      // The VERIFIED buffer and type are what reach storage — never the
      // declared mimetype, and never the original filename.
      expect(storage.putImage).toHaveBeenCalledWith(PNG_8X8, 'image/png');
      expect(productImageRepository.create).toHaveBeenCalledWith({
        url: storedObject.url,
        objectKey: storedObject.key,
        sortOrder: null,
      });
      expect(result).toEqual(saved);
    });

    it('trusts the bytes, not the declared content type', async () => {
      // A JPEG announced as image/png. The bytes win: it is stored as a JPEG.
      storage.putImage.mockResolvedValue({
        ...storedObject,
        contentType: 'image/jpeg',
      });
      productImageRepository.create.mockReturnValue({} as ProductImage);
      productImageRepository.save.mockResolvedValue({ id: 2 } as ProductImage);

      await service.upload(fileOf(JPEG_8X8, 'image/png'));

      expect(storage.putImage).toHaveBeenCalledWith(JPEG_8X8, 'image/jpeg');
    });

    it('refuses a spoofed extension before anything is stored', async () => {
      // Named .png, announced as image/png, and actually PHP source.
      await expect(
        service.upload(fileOf(NOT_AN_IMAGE, 'image/png')),
      ).rejects.toMatchObject({ status: 415 });

      expect(storage.putImage).not.toHaveBeenCalled();
      expect(productImageRepository.save).not.toHaveBeenCalled();
    });

    it('refuses a file over the configured ceiling with 413', async () => {
      await expect(
        service.upload(fileOf(oversizedPng(1024 * 1024 + 1))),
      ).rejects.toMatchObject({ status: 413 });

      expect(storage.putImage).not.toHaveBeenCalled();
    });

    it('refuses a missing file with 400 and never calls storage', async () => {
      await expect(
        service.upload(undefined as unknown as Express.Multer.File),
      ).rejects.toMatchObject({ status: 400 });

      expect(storage.putImage).not.toHaveBeenCalled();
    });

    it('propagates a storage failure and writes no row', async () => {
      storage.putImage.mockRejectedValue(
        new ServiceUnavailableException({
          error: 'IMAGE_STORAGE_UNAVAILABLE',
        }),
      );

      await expect(service.upload(fileOf(PNG_8X8))).rejects.toMatchObject({
        status: 503,
      });

      expect(productImageRepository.create).not.toHaveBeenCalled();
      expect(productImageRepository.save).not.toHaveBeenCalled();
    });

    /**
     * THE COMPENSATION CASE. The object is already in the bucket when the row
     * insert fails, so it must be taken back out — otherwise every failed
     * insert leaves bytes nothing will ever reference or delete.
     */
    it('deletes the just-uploaded object when the row insert fails', async () => {
      storage.putImage.mockResolvedValue(storedObject);
      productImageRepository.create.mockReturnValue({} as ProductImage);
      const insertFailure = new Error(
        'duplicate key value violates unique constraint',
      );
      productImageRepository.save.mockRejectedValue(insertFailure);
      storage.deleteObject.mockResolvedValue(true);

      await expect(service.upload(fileOf(PNG_8X8))).rejects.toBe(insertFailure);

      expect(storage.deleteObject).toHaveBeenCalledWith(storedObject.key);
    });

    /**
     * The compensation itself can fail — most likely the same outage that
     * broke the insert. What must not happen is that failure REPLACING the
     * original one: the caller needs to know their upload failed, not that a
     * cleanup they never asked for also failed.
     */
    it('still reports the original failure when compensation fails', async () => {
      storage.putImage.mockResolvedValue(storedObject);
      productImageRepository.create.mockReturnValue({} as ProductImage);
      const insertFailure = new Error('connection terminated unexpectedly');
      productImageRepository.save.mockRejectedValue(insertFailure);
      storage.deleteObject.mockRejectedValue(new Error('bucket unreachable'));

      await expect(service.upload(fileOf(PNG_8X8))).rejects.toBe(insertFailure);
    });
  });
});
